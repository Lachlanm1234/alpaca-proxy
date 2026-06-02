const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG ────────────────────────────────────────────────────────
const ALPACA_KEY       = process.env.ALPACA_KEY;
const ALPACA_SECRET    = process.env.ALPACA_SECRET;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_KEY;
const DISCORD_WEBHOOK  = process.env.DISCORD_WEBHOOK;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALPACA_BASE      = 'https://paper-api.alpaca.markets';
const ALPACA_DATA      = 'https://data.alpaca.markets';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const INTEL_TIMES         = ['09:00', '15:30'];
const CATALYST_INTERVAL   = 120;
const CRYPTO_INTERVAL     = 240;
const INFLUENCER_INTERVAL = 180;
const TRADE_CHECK_MINS    = 30;

const INFLUENCERS = [
  { name: 'Elon Musk',      sectors: ['EV','crypto','AI','space'],     avgImpact: '+3.2%', lagHours: 2  },
  { name: 'Donald Trump',   sectors: ['defense','energy','banking'],   avgImpact: '+/-2.8%', lagHours: 1 },
  { name: 'Jerome Powell',  sectors: ['financials','bonds','all'],     avgImpact: '+/-1.9%', lagHours: 0.5 },
  { name: 'Cathie Wood',    sectors: ['tech','genomics','fintech'],    avgImpact: '+1.4%', lagHours: 4  },
  { name: 'Nancy Pelosi',   sectors: ['tech','pharma'],                avgImpact: '+2.1%', lagHours: 24 },
  { name: 'Michael Burry',  sectors: ['value','shorts'],               avgImpact: '+/-3.1%', lagHours: 12 },
  { name: 'Warren Buffett', sectors: ['value','insurance','banks'],    avgImpact: '+1.8%', lagHours: 6  },
];

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status: 'IDLE', lastIntel: null, lastCatalyst: null, lastCrypto: null,
  lastInfluencer: null, lastTradeCheck: null,
  scansCompleted: 0, tradesExecuted: 0, isMarketOpen: false,
};
let decisionLog      = [];
let pendingQueue     = [];
let catalystSignals  = [];
let cryptoSignals    = [];
let influencerAlerts = [];
let tradeDNA         = []; // Every completed trade with outcome
let morningBriefing  = null;
let watchlists       = {
  'Earnings Plays': [], 'Short Opportunities': [], 'Insider Accumulation': [],
  'Crypto Momentum': [], 'Influencer Plays': [], 'High Risk / Hype': [],
};
const sellEvalCache  = {};

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 500) decisionLog.length = 500;
  console.log('[' + type + '] ' + message);
  if (['TRADE','RISK','PROFIT','INFLUENCER'].includes(type)) sendAlert(type, message, data);
  // Write to Supabase async (fire and forget — don't block agent)
  if (SUPABASE_URL && type !== 'DNA') {
    dbInsert('decision_log', {
      type, message,
      ticker: data?.ticker || null,
      signal_score: data?.signalScore || null,
      confidence: data?.confidence || null,
      dollars: data?.dollars || null,
      pnl_pct: data?.pnlPct || null,
      catalyst: data?.catalyst || null,
      thesis: data?.thesis || null,
      agent_votes: data?.agentVotes ? JSON.stringify(data.agentVotes) : null,
      factor_breakdown: data?.factorBreakdown ? JSON.stringify(data.factorBreakdown) : null,
      risk_score: data?.riskScore || null,
      is_crypto: data?.isCrypto || false,
    }).catch(() => {});
  }
}

// ── ALERTS ────────────────────────────────────────────────────────
async function sendAlert(type, message, data) {
  const emoji = { TRADE:'💰', RISK:'🛑', PROFIT:'🎯', INFLUENCER:'⚡' }[type] || '📊';
  const color = { TRADE:3066993, RISK:15158332, PROFIT:3066993, INFLUENCER:16776960 }[type] || 3447003;
  if (DISCORD_WEBHOOK) {
    try {
      const fields = [];
      if (data?.ticker)      fields.push({ name:'Ticker',     value:'`'+data.ticker+'`', inline:true });
      if (data?.dollars)     fields.push({ name:'Size',       value:'$'+parseFloat(data.dollars).toFixed(0), inline:true });
      if (data?.probability) fields.push({ name:'Probability',value:data.probability+'%', inline:true });
      if (data?.expectedReturn) fields.push({ name:'Expected', value:data.expectedReturn, inline:true });
      if (data?.catalyst)    fields.push({ name:'Catalyst',   value:data.catalyst, inline:false });
      if (data?.agentVotes)  fields.push({ name:'Agent Votes',value:data.agentVotes, inline:false });
      await fetch(DISCORD_WEBHOOK, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ embeds:[{ title: emoji+' '+type+' — Market Intelligence', description:message, color, fields, footer:{ text:'Agent v4 • '+new Date().toLocaleString() }, timestamp:new Date().toISOString() }] })
      });
    } catch(e) { console.error('Discord failed:', e.message); }
  }
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const text = emoji+' *'+type+'*\n'+message+(data?.ticker?'\nTicker: `'+data.ticker+'`':'')+(data?.catalyst?'\n'+data.catalyst:'');
      await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/sendMessage', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:'Markdown' })
      });
    } catch(e) {}
  }
}

// ── ALPACA ────────────────────────────────────────────────────────
async function alpaca(path, opts) {
  opts = opts || {};
  const r = await fetch(ALPACA_BASE + path, {
    method: opts.method || 'GET',
    headers: { 'APCA-API-KEY-ID':ALPACA_KEY, 'APCA-API-SECRET-KEY':ALPACA_SECRET, 'Content-Type':'application/json' },
    body: opts.body || undefined,
  });
  return r.json();
}

async function checkMarket() {
  try { const c = await alpaca('/v2/clock'); state.isMarketOpen = c.is_open; return c.is_open; }
  catch(e) { return false; }
}

async function getLivePrice(ticker) {
  try {
    const isCrypto = ticker.includes('/');
    const endpoint = isCrypto
      ? `${ALPACA_DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(ticker)}`
      : `${ALPACA_DATA}/v2/stocks/${ticker}/quotes/latest`;
    const r = await fetch(endpoint, { headers:{ 'APCA-API-KEY-ID':ALPACA_KEY, 'APCA-API-SECRET-KEY':ALPACA_SECRET } });
    const d = await r.json();
    if (isCrypto) { const q = d.quotes&&d.quotes[ticker]; return parseFloat(q?.ap||q?.bp||0); }
    return parseFloat(d.quote?.ap||d.quote?.bp||0);
  } catch(e) { return 0; }
}

async function isShortable(ticker) {
  try { const a = await alpaca('/v2/assets/'+ticker); return a.shortable && a.easy_to_borrow; }
  catch(e) { return false; }
}

// ── CLAUDE HELPERS ────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens, useWebSearch) {
  maxTokens = maxTokens || 700;
  useWebSearch = useWebSearch !== false;
  const fullSystem = systemPrompt + '\n\nCRITICAL: Return ONLY a valid JSON object. No text before or after. Start with { end with }.';
  const body = {
    model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system: fullSystem,
    messages: [{ role:'user', content:userContent }]
  };
  if (useWebSearch) body.tools = [{ type:'web_search_20250305', name:'web_search' }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.content.map(b => b.type==='text'?b.text:'').join('');
  const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON: '+text.substring(0,100));
  return JSON.parse(match[0]);
}

// ── RISK ENGINE ───────────────────────────────────────────────────
function scoreRisk(signal) {
  let risk = 0;
  const score = signal.signalScore||0, conf = signal.confidence||0;
  const detail = (signal.detail||'').toLowerCase(), catalyst = (signal.catalyst||'').toLowerCase();
  if (conf < 60) risk += 30; else if (conf < 70) risk += 15;
  if (score < 65) risk += 25; else if (score < 72) risk += 10;
  const hyped = ['moon','rocket','squeeze','viral','trending','meme','yolo'];
  if (hyped.some(w => detail.includes(w)||catalyst.includes(w))) risk += 25;
  if (detail.includes('rumor')||detail.includes('unconfirmed')) risk += 20;
  if (signal.isCrypto) risk += 10;
  if (signal.signal==='SHORT'||signal.type==='SHORT') risk += 10;
  if (catalyst.includes('earnings beat')||catalyst.includes('eps beat')) risk -= 15;
  if (catalyst.includes('insider buy')) risk -= 10;
  if (catalyst.includes('analyst upgrade')) risk -= 5;
  return Math.min(100, Math.max(0, risk));
}
function getRiskLabel(s) { return s>=70?'HIGH RISK':s>=45?'MEDIUM RISK':'LOW RISK'; }

// ── WATCHLIST ─────────────────────────────────────────────────────
function categoriseSignal(signal) {
  const catalyst=(signal.catalyst||'').toLowerCase(), detail=(signal.detail||'').toLowerCase();
  if (signal.isCrypto) return 'Crypto Momentum';
  if (signal.signal==='SHORT'||signal.type==='SHORT') return 'Short Opportunities';
  if ((signal.riskScore||0)>=70) return 'High Risk / Hype';
  if (catalyst.includes('insider')||detail.includes('form 4')) return 'Insider Accumulation';
  if (signal.isInfluencerSignal) return 'Influencer Plays';
  return 'Earnings Plays';
}
function updateWatchlists(signal) {
  const category = categoriseSignal(signal);
  const ticker = signal.ticker||signal.symbol;
  if (!ticker) return;
  Object.keys(watchlists).forEach(k => { watchlists[k]=watchlists[k].filter(s=>s.ticker!==ticker); });
  if (!watchlists[category]) watchlists[category]=[];
  watchlists[category].unshift({ ticker, signal:signal.signal, signalScore:signal.signalScore, catalyst:signal.catalyst, riskScore:signal.riskScore, addedAt:new Date().toISOString() });
  Object.keys(watchlists).forEach(k => { if (watchlists[k].length>10) watchlists[k]=watchlists[k].slice(0,10); });
}

// ── TRADE DNA ─────────────────────────────────────────────────────
function recordTradeOutcome(ticker, entryPrice, exitPrice, catalyst, signalScore, reason) {
  const returnPct = entryPrice > 0 ? ((exitPrice-entryPrice)/entryPrice)*100 : 0;
  const record = { ticker, entryPrice, exitPrice, catalyst, signalScore, returnPct: parseFloat(returnPct.toFixed(2)), profitable: returnPct > 0, reason, date: new Date().toISOString() };
  tradeDNA.push(record);
  if (tradeDNA.length > 200) tradeDNA.shift();
  log('DNA', '📊 Trade recorded: '+ticker+' '+returnPct.toFixed(1)+'% ['+reason+']', { ticker, returnPct, profitable: returnPct>0 });
  // Persist to Supabase
  dbInsert('trade_dna', { ticker, entry_price:entryPrice, exit_price:exitPrice, return_pct:record.returnPct, profitable:record.profitable, catalyst, signal_score:signalScore, reason }).catch(()=>{});
}

function getTradeDNASummary() {
  if (tradeDNA.length < 3) return 'Building trade history...';
  const wins = tradeDNA.filter(t=>t.profitable).length;
  const winRate = (wins/tradeDNA.length*100).toFixed(0);
  const avgReturn = (tradeDNA.reduce((s,t)=>s+t.returnPct,0)/tradeDNA.length).toFixed(1);
  const bestCatalysts = {};
  tradeDNA.forEach(t => {
    const key = (t.catalyst||'unknown').split(' ')[0];
    if (!bestCatalysts[key]) bestCatalysts[key]={count:0,wins:0};
    bestCatalysts[key].count++;
    if (t.profitable) bestCatalysts[key].wins++;
  });
  const topCatalyst = Object.entries(bestCatalysts).sort((a,b)=>b[1].wins-a[1].wins)[0];
  return `Win rate: ${winRate}% (${wins}/${tradeDNA.length} trades). Avg return: ${avgReturn}%. Best catalyst type: ${topCatalyst?topCatalyst[0]:'unknown'}.`;
}

// ── MULTI-AGENT ANALYST TEAM ──────────────────────────────────────
// 5 competing AI agents vote on every signal. No web search = very cheap.
async function runMultiAgentAnalysis(signal) {
  const ticker = signal.ticker||signal.symbol;
  const context = `Stock: ${ticker}\nCatalyst: ${signal.catalyst||''}\nDetail: ${signal.detail||''}\nSignal score: ${signal.signalScore} Confidence: ${signal.confidence}%\nThesis: ${signal.thesis||''}`;

  const agents = [
    { name:'Momentum', focus:'price momentum, volume trend, RSI, moving averages, technical pattern only. Ignore fundamentals.' },
    { name:'Earnings',  focus:'EPS vs estimate, revenue beat/miss, guidance changes, analyst revisions only. Ignore technicals.' },
    { name:'Macro',     focus:'Fed policy, sector rotation, economic cycle, market regime, macro risks only.' },
    { name:'Sentiment', focus:'social buzz, options flow sentiment, retail positioning, fear/greed only.' },
    { name:'Risk',      focus:'finding reasons NOT to trade. Be skeptical. What could go wrong? Downside risks only.' },
  ];

  const votes = await Promise.all(agents.map(async agent => {
    try {
      const prompt = `You are the ${agent.name} Agent on an AI investment committee. Analyze ONLY: ${agent.focus}
Context: ${context}
Vote BUY, HOLD, or SELL. Give ONE short reason (max 60 chars).
Return ONLY JSON: {"agent":"${agent.name}","vote":"BUY","reason":"Short reason here","conviction":75}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:120, system:prompt+'\n\nReturn ONLY JSON.', messages:[{ role:'user', content:'Vote on '+ticker }] })
      });
      const d = await r.json();
      if (d.error) return { agent:agent.name, vote:'HOLD', reason:'Analysis unavailable', conviction:50 };
      const text = d.content.map(b=>b.type==='text'?b.text:'').join('');
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { agent:agent.name, vote:'HOLD', reason:'Parse error', conviction:50 };
    } catch(e) {
      return { agent:agent.name, vote:'HOLD', reason:'Error', conviction:50 };
    }
  }));

  return votes;
}

// ── CONVICTION ENGINE ─────────────────────────────────────────────
// Transforms signal scores into probability-style conviction metrics
function buildConviction(signal, agentVotes) {
  const buyCount  = agentVotes.filter(v=>v.vote==='BUY').length;
  const sellCount = agentVotes.filter(v=>v.vote==='SELL').length;
  const total     = agentVotes.length;
  const isShort   = signal.signal==='SHORT'||signal.type==='SHORT';

  // Probability = blend of signal confidence + agent consensus
  const agentConsensus = isShort ? (sellCount/total)*100 : (buyCount/total)*100;
  const probability = Math.round((signal.confidence||70)*0.65 + agentConsensus*0.35);

  // Expected return from signal
  const entry  = parseFloat(signal.currentPrice||0);
  const target = parseFloat(signal.targetPrice||0);
  const stop   = parseFloat(signal.stopLoss||0);
  const expectedReturn = (entry>0&&target>0) ? ((target-entry)/entry*100).toFixed(1)+'%' : (signal.expectedReturn||'—');
  const worstCase      = (entry>0&&stop>0)   ? ((stop-entry)/entry*100).toFixed(1)+'%'   : (isShort?'+5%':'-8%');

  // Risk/reward ratio
  const upside   = target&&entry ? Math.abs(target-entry) : 0;
  const downside = stop&&entry   ? Math.abs(stop-entry)   : 1;
  const riskReward = downside > 0 ? (upside/downside).toFixed(1)+':1' : '—';

  // DNA adjustment
  const dnaSummary = getTradeDNASummary();

  return {
    probability,
    expectedReturn,
    worstCase,
    riskReward,
    agentConsensus: Math.round(agentConsensus),
    buyVotes: buyCount,
    sellVotes: sellCount,
    holdVotes: total-buyCount-sellCount,
    agentVoteSummary: buyCount+'/'+total+' agents '+(isShort?'bearish':'bullish'),
    dnaSummary,
    agentVotes,
  };
}

// ── 1. MORNING BRIEFING (replaces 9am intel scan) ─────────────────
async function runMorningBriefing() {
  state.status = 'MORNING_BRIEFING';
  state.lastIntel = new Date().toISOString();
  log('INTEL', '☀️ Generating morning briefing...');

  const dna = getTradeDNASummary();
  const prompt = `You are an AI Portfolio Manager giving a pre-market briefing. Search for overnight news, futures, and key market themes.
Trade history context: ${dna}
Return ONLY JSON:
{"greeting":"Good morning. [One sentence with key overnight development]","marketRegime":"RISK_ON or RISK_OFF or MIXED","futuresSnapshot":"Brief futures direction","topWatches":[{"ticker":"NVDA","reason":"Why watch today","bias":"BULLISH"},{"ticker":"SPY","reason":"Why watch","bias":"NEUTRAL"}],"sectorFocus":"Which sector is most interesting today and why","keyRisk":"Single biggest risk to watch","topIdea":{"ticker":"AAPL","catalyst":"Why this is the best trade today","action":"BUY or SHORT"}}
Keep all strings under 100 chars. Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt, 'Search overnight futures, pre-market movers, and key catalysts for today\'s trading session.', 700, true);
    morningBriefing = { ...result, generatedAt: new Date().toISOString() };
    log('INTEL', '☀️ ' + (result.greeting||'Morning briefing ready'), { marketRegime:result.marketRegime, sectorFocus:result.sectorFocus });
    if (result.topIdea) {
      log('INTEL', '💡 Top idea: ' + result.topIdea.ticker + ' — ' + result.topIdea.catalyst, { ticker:result.topIdea.ticker });
    }
    (result.topWatches||[]).forEach(w => {
      log('INTEL', '👀 Watch: ' + w.ticker + ' — ' + w.reason, { ticker:w.ticker, bias:w.bias });
    });
  } catch(e) { log('ERROR', 'Morning briefing failed: '+e.message); }
  state.status = 'IDLE';
}

// ── 2. PRE-CLOSE BRIEFING (3:30pm) ───────────────────────────────
async function runPreCloseBriefing() {
  state.status = 'INTEL_SCAN';
  state.lastIntel = new Date().toISOString();
  log('INTEL', '🔔 Running pre-close briefing...');

  const prompt = `Pre-market close briefing. Search today's market action and overnight positioning.
Return ONLY JSON:
{"summary":"One sentence on today's session","actionableEvents":[{"ticker":"NVDA","event":"Event","detail":"Short detail","impact":"BULLISH","urgency":"HIGH"}],"overnightWatches":["TICKER1","TICKER2"],"closingNote":"One sentence outlook for tomorrow"}
Max 3 events. Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt, 'Search today\'s market movers, earnings, and news. What should traders watch overnight?', 500, true);
    log('INTEL', '🔔 ' + (result.summary||''), { summary:result.summary });
    (result.actionableEvents||[]).forEach(ev => {
      log('INTEL', '📌 ' + ev.ticker + ' — ' + ev.event + ': ' + ev.detail, { ticker:ev.ticker, impact:ev.impact, urgency:ev.urgency });
    });
    if (result.closingNote) log('INTEL', '📝 ' + result.closingNote);
    if (result.overnightWatches?.length) log('INTEL', '🌙 Watch overnight: ' + result.overnightWatches.join(', '));
  } catch(e) { log('ERROR', 'Pre-close briefing failed: '+e.message); }
  state.status = 'IDLE';
}

// ── 3. INFLUENCER SCAN ────────────────────────────────────────────
async function runInfluencerScan() {
  state.status = 'INFLUENCER_SCAN';
  state.lastInfluencer = new Date().toISOString();
  log('INFLUENCER', '⚡ Scanning Musk, Trump, Powell, Wood, Pelosi, Burry, Buffett...');

  const names = INFLUENCERS.map(i=>i.name).join(', ');
  const prompt = `Search for market-moving statements from: ${names} in last 24hrs. Also check congressional stock disclosures (STOCK Act filings) and major hedge fund moves.
Return ONLY JSON (max 2 items, all strings under 100 chars):
{"influencerActivity":[{"person":"Elon Musk","platform":"X","action":"Posted about AI robots","relatedTickers":["NVDA","TSLA"],"relatedSectors":["AI"],"estimatedImpact":"+2-3%","impactLagHours":2,"confidence":75,"sentiment":"BULLISH","urgency":"MEDIUM","tradingImplication":"NVDA benefits from AI demand"}]}
If nothing found: {"influencerActivity":[]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt, 'Any market-moving news from Musk, Trump, Powell, Wood, Pelosi, Burry in last 24 hours? Any congressional stock trades disclosed?', 650, true);
    const activities = result.influencerActivity||[];
    activities.forEach(activity => {
      const known = INFLUENCERS.find(i=>i.name===activity.person);
      if (known) { activity.historicalAvgImpact=known.avgImpact; activity.historicalLagHours=known.lagHours; }
      activity.foundAt = new Date().toISOString();
      influencerAlerts.unshift(activity);
      if (influencerAlerts.length>50) influencerAlerts.length=50;
      // Persist to Supabase
      dbInsert('influencer_alerts', { person:activity.person, platform:activity.platform, action:activity.action, related_tickers:activity.relatedTickers||[], estimated_impact:activity.estimatedImpact, confidence:activity.confidence, sentiment:activity.sentiment, urgency:activity.urgency, trading_implication:activity.tradingImplication }).catch(()=>{});
      const urgEmoji = activity.urgency==='HIGH'?'🚨':'⚡';
      log('INFLUENCER', urgEmoji+' '+activity.person+': '+activity.action, {
        person:activity.person, platform:activity.platform, relatedTickers:activity.relatedTickers,
        estimatedImpact:activity.estimatedImpact, confidence:activity.confidence, sentiment:activity.sentiment, urgency:activity.urgency, tradingImplication:activity.tradingImplication,
      });
      if (activity.urgency==='HIGH' && activity.confidence>=75 && activity.relatedTickers?.length) {
        const ticker = activity.relatedTickers[0];
        const isLong = activity.sentiment==='BULLISH';
        const signal = {
          ticker, signal:isLong?'BUY':'SHORT', type:isLong?'LONG':'SHORT',
          signalScore:activity.confidence, confidence:activity.confidence-5,
          catalyst:activity.person+' — '+activity.action, detail:activity.tradingImplication,
          thesis:'Influencer: '+activity.person+' historically drives '+(activity.historicalAvgImpact||activity.estimatedImpact),
          discoveredFrom:'Influencer: '+activity.person, isInfluencerSignal:true, foundAt:new Date().toISOString(),
        };
        signal.riskScore = scoreRisk(signal);
        if (signal.riskScore<70) {
          const existing = catalystSignals.findIndex(s=>s.ticker===ticker);
          if (existing>=0) catalystSignals[existing]=signal; else catalystSignals.push(signal);
          updateWatchlists({...signal, category:'Influencer Plays'});
        }
      }
    });
    log('INFLUENCER', '✅ Influencer scan complete — '+activities.length+' item(s)');
  } catch(e) { log('ERROR', 'Influencer scan failed: '+e.message); }
  state.status = 'IDLE';
}

// ── 4. CATALYST SCAN + MULTI-AGENT + CONVICTION ───────────────────
async function runCatalystScan() {
  state.status = 'CATALYST_SCAN';
  state.lastCatalyst = new Date().toISOString();
  const dna = getTradeDNASummary();
  log('CATALYST', '🔬 Running catalyst scan with multi-agent analysis...');

  const prompt = `Quantitative trading agent. Find 1 LONG and 1 SHORT opportunity with hard data catalysts.
Past performance context: ${dna}
LONG signals: earnings beats (EPS>est 5%+), analyst upgrades, insider buying, unusual calls.
SHORT signals: earnings misses (EPS<est 5%+), guidance cuts, downgrades, insider selling.
Return ONLY JSON:
{"catalysts":[{"ticker":"NVDA","companyName":"NVIDIA","type":"LONG","catalyst":"Earnings beat","detail":"Q1 EPS $5.16 beat $4.88 est by 5.7%. Revenue beat. Raised guidance.","signal":"BUY","signalScore":88,"confidence":82,"currentPrice":875,"entryLogic":"Buy at open or dip below $870","targetPrice":950,"stopLoss":820,"expectedReturn":"+8.9%","timeframe":"5-15 days","thesis":"Earnings beat with raised guidance drives 8-12% move historically","factorBreakdown":{"earningsFactor":90,"technicalFactor":75,"sentimentFactor":82,"optionsFactor":70}},{"ticker":"TSLA","companyName":"Tesla","type":"SHORT","catalyst":"Earnings miss","detail":"EPS $0.27 vs $0.41 est. Margin compressed. Lowered guidance.","signal":"SHORT","signalScore":81,"confidence":76,"currentPrice":175,"entryLogic":"Short at market","targetPrice":145,"stopLoss":190,"expectedReturn":"+14%","timeframe":"5-20 days","thesis":"Earnings miss drives 10-15% decline","factorBreakdown":{"earningsFactor":85,"technicalFactor":78,"sentimentFactor":72,"optionsFactor":65}}]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt, 'Find one strong LONG and one SHORT catalyst right now — earnings vs estimates, insider activity, analyst actions.', 1000, true);
    const newSignals = result.catalysts||[];

    for (const signal of newSignals) {
      signal.riskScore = scoreRisk(signal);
      signal.riskLabel = getRiskLabel(signal.riskScore);
      signal.foundAt = new Date().toISOString();

      // Run 5-agent analysis in parallel (no web search = cheap)
      log('CATALYST', '🤖 Running 5-agent analysis for '+signal.ticker+'...');
      const agentVotes = await runMultiAgentAnalysis(signal);
      const conviction = buildConviction(signal, agentVotes);
      signal.conviction = conviction;

      const existing = catalystSignals.findIndex(s=>s.ticker===signal.ticker);
      if (existing>=0) catalystSignals[existing]=signal; else catalystSignals.push(signal);
      updateWatchlists(signal);
      // Persist signal to Supabase
      dbUpsert('active_signals', { ticker:signal.ticker, signal:signal.signal, type:signal.type, signal_score:signal.signalScore, confidence:signal.confidence, catalyst:signal.catalyst, detail:signal.detail, thesis:signal.thesis, target_price:signal.targetPrice, stop_loss:signal.stopLoss, expected_return:signal.expectedReturn, timeframe:signal.timeframe, factor_breakdown:signal.factorBreakdown?JSON.stringify(signal.factorBreakdown):null, conviction:signal.conviction?JSON.stringify(signal.conviction):null, risk_score:signal.riskScore, is_crypto:false, found_at:signal.foundAt, updated_at:new Date().toISOString() }).catch(()=>{});

      const emoji = signal.type==='SHORT'?'🔻':'🔺';
      const agentSummary = agentVotes.map(v=>v.agent+':'+v.vote).join(' | ');
      log('CATALYST', emoji+' '+signal.type+': '+signal.ticker+' | Prob:'+conviction.probability+'% | RR:'+conviction.riskReward+' | Agents: '+agentSummary, {
        ticker:signal.ticker, signal:signal.signal, type:signal.type,
        signalScore:signal.signalScore, confidence:signal.confidence,
        probability:conviction.probability, expectedReturn:conviction.expectedReturn,
        worstCase:conviction.worstCase, riskReward:conviction.riskReward,
        thesis:signal.thesis, catalyst:signal.catalyst, detail:signal.detail,
        entryLogic:signal.entryLogic, targetPrice:signal.targetPrice, stopLoss:signal.stopLoss,
        factorBreakdown:signal.factorBreakdown, riskScore:signal.riskScore, riskLabel:signal.riskLabel,
        agentVotes, agentVoteSummary:agentSummary,
      });
    }

    if (catalystSignals.length>20) catalystSignals=catalystSignals.slice(-20);
    state.scansCompleted++;
    log('CATALYST', '✅ Catalyst scan complete — '+newSignals.length+' signals with agent analysis');
  } catch(e) { log('ERROR', 'Catalyst scan failed: '+e.message); }
  state.status = 'IDLE';
}

// ── 5. CRYPTO SCAN ────────────────────────────────────────────────
async function runCryptoScan() {
  state.status = 'CRYPTO_SCAN';
  state.lastCrypto = new Date().toISOString();
  log('CRYPTO', '₿ Running crypto scan...');

  const prompt = `Search crypto markets for the best trade right now. Pick ONE of: BTC/USD, ETH/USD, SOL/USD, AVAX/USD, LINK/USD, DOGE/USD.
Return this exact JSON with real current data:
{"cryptoSignals":[{"symbol":"BTC/USD","name":"Bitcoin","signal":"BUY","signalScore":80,"confidence":74,"currentPrice":68500,"catalyst":"Short catalyst under 60 chars","detail":"Short detail under 80 chars","entryLogic":"Entry logic","targetPrice":75000,"stopLoss":64000,"expectedReturn":"+9%","timeframe":"3-7 days","thesis":"Short thesis","factorBreakdown":{"technicalFactor":78,"sentimentFactor":72,"flowsFactor":80},"riskScore":30}]}
If insufficient data: {"cryptoSignals":[]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt, 'Strongest crypto signal right now — BTC ETH SOL price action and sentiment?', 600, true);
    const newSignals = result.cryptoSignals||[];
    for (const signal of newSignals) {
      signal.isCrypto = true; signal.ticker = signal.symbol;
      signal.riskScore = signal.riskScore||scoreRisk(signal);
      signal.riskLabel = getRiskLabel(signal.riskScore);
      signal.foundAt = new Date().toISOString();
      const existing = cryptoSignals.findIndex(s=>s.symbol===signal.symbol);
      if (existing>=0) cryptoSignals[existing]=signal; else cryptoSignals.push(signal);
      updateWatchlists(signal);
      // Persist crypto signal to Supabase
      dbUpsert('active_signals', { ticker:signal.symbol, signal:signal.signal, type:'CRYPTO', signal_score:signal.signalScore, confidence:signal.confidence, catalyst:signal.catalyst, detail:signal.detail, thesis:signal.thesis, target_price:signal.targetPrice, stop_loss:signal.stopLoss, expected_return:signal.expectedReturn, timeframe:signal.timeframe, factor_breakdown:signal.factorBreakdown?JSON.stringify(signal.factorBreakdown):null, risk_score:signal.riskScore, is_crypto:true, found_at:signal.foundAt, updated_at:new Date().toISOString() }).catch(()=>{});
      log('CRYPTO', (signal.signal==='BUY'?'🟢':'🔴')+' '+signal.signal+': '+signal.symbol+' — '+signal.catalyst, {
        ticker:signal.symbol, signal:signal.signal, signalScore:signal.signalScore,
        confidence:signal.confidence, thesis:signal.thesis, catalyst:signal.catalyst,
        targetPrice:signal.targetPrice, stopLoss:signal.stopLoss, riskScore:signal.riskScore, isCrypto:true,
      });
    }
    if (cryptoSignals.length>10) cryptoSignals=cryptoSignals.slice(-10);
    log('CRYPTO', '✅ Crypto scan complete — '+newSignals.length+' signal(s)');
  } catch(e) { log('ERROR', 'Crypto scan failed: '+e.message); }
  state.status = 'IDLE';
}

// ── 6. SMART SELL EVALUATION ──────────────────────────────────────
async function shouldSell(ticker, pnlPct, entry, current, isCrypto) {
  const lastEval = sellEvalCache[ticker];
  if (lastEval && (Date.now()-lastEval.timestamp)<4*60*60*1000) return lastEval.decision;
  try {
    const prompt = `Position: ${ticker} up +${pnlPct.toFixed(1)}% (entry $${entry}, now $${current}). SELL to lock profit or HOLD for more upside?
Return ONLY JSON: {"decision":"SELL","reason":"Short reason under 60 chars","confidence":80}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:100, system:prompt+'\n\nReturn ONLY JSON.', messages:[{role:'user',content:'Sell or hold '+ticker+'?'}] })
    });
    const d = await r.json();
    const text = d.content.map(b=>b.type==='text'?b.text:'').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const res = JSON.parse(match[0]);
      sellEvalCache[ticker] = { timestamp:Date.now(), decision:res.decision==='SELL' };
      if (res.decision==='HOLD') log('PROFIT', '🤔 AI says HOLD '+ticker+' at +'+pnlPct.toFixed(1)+'% — '+(res.reason||''), { ticker, pnlPct });
      return res.decision==='SELL';
    }
  } catch(e) { log('ERROR', 'Sell eval failed: '+e.message); }
  return true;
}

// ── 7. POSITION MANAGEMENT ────────────────────────────────────────
async function managePositions(positions) {
  if (!positions) positions = await alpaca('/v2/positions');
  if (!Array.isArray(positions)||!positions.length) return;
  for (const p of positions) {
    const pnl = parseFloat(p.unrealized_plpc)*100;
    const isCrypto = p.asset_class==='crypto';
    const isShort = parseFloat(p.qty)<0;
    const stopThreshold  = isCrypto?-12:-8;
    const profitWarning  = isCrypto?18:15;
    const profitHard     = isCrypto?30:25;
    const entry   = parseFloat(p.avg_entry_price||0);
    const current = parseFloat(p.current_price||0);

    if (pnl<=stopThreshold) {
      log('RISK', '🛑 Stop loss: '+p.symbol+' at '+pnl.toFixed(1)+'%', { ticker:p.symbol, pnlPct:pnl, reason:'STOP_LOSS', isShort, isCrypto });
      await alpaca('/v2/positions/'+encodeURIComponent(p.symbol), {method:'DELETE'});
      recordTradeOutcome(p.symbol, entry, current, 'stop loss', 0, 'STOP_LOSS');
      delete sellEvalCache[p.symbol];
    } else if (pnl>=profitHard) {
      log('PROFIT', '🎯 Hard take profit: '+p.symbol+' at +'+pnl.toFixed(1)+'%', { ticker:p.symbol, pnlPct:pnl, reason:'TAKE_PROFIT_HARD', isShort, isCrypto });
      await alpaca('/v2/positions/'+encodeURIComponent(p.symbol), {method:'DELETE'});
      recordTradeOutcome(p.symbol, entry, current, 'hard take profit', 0, 'TAKE_PROFIT_HARD');
      delete sellEvalCache[p.symbol];
    } else if (pnl>=profitWarning) {
      const sell = await shouldSell(p.symbol, pnl, entry, current, isCrypto);
      if (sell) {
        log('PROFIT', '🎯 AI-confirmed sell: '+p.symbol+' at +'+pnl.toFixed(1)+'%', { ticker:p.symbol, pnlPct:pnl, reason:'TAKE_PROFIT_AI', isShort, isCrypto });
        await alpaca('/v2/positions/'+encodeURIComponent(p.symbol), {method:'DELETE'});
        recordTradeOutcome(p.symbol, entry, current, 'AI take profit', 0, 'TAKE_PROFIT_AI');
        delete sellEvalCache[p.symbol];
      }
    }
  }
}

// ── 8. POSITION SIZING ────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c = score*0.6+confidence*0.4;
  if (c>=85) return portfolio*0.08;
  if (c>=78) return portfolio*0.06;
  if (c>=72) return portfolio*0.04;
  if (c>=65) return portfolio*0.02;
  return 0;
}

// ── 9. PLACE ORDER ────────────────────────────────────────────────
async function placeOrder(ticker, dollars, side, analysis, isCrypto) {
  try {
    const positions = await alpaca('/v2/positions');
    const holding = Array.isArray(positions)&&positions.find(p=>p.symbol===ticker);
    if (holding&&side==='buy') { log('TRADE','Already holding '+ticker); return null; }
    const order = await alpaca('/v2/orders', {
      method:'POST', body:JSON.stringify({ symbol:ticker, notional:dollars.toFixed(2), side, type:'market', time_in_force:isCrypto?'gtc':'day' })
    });
    if (order.id) {
      state.tradesExecuted++;
      pendingQueue=pendingQueue.filter(p=>p.ticker!==ticker);
      dbDelete('pending_queue', 'ticker=eq.'+ticker).catch(()=>{});
      const typeLabel=isCrypto?'₿ CRYPTO':side==='sell'?'🔻 SHORT':'🟢 LONG';
      const conviction = analysis?.conviction;
      log('TRADE', typeLabel+' executed: '+ticker+' $'+dollars.toFixed(0)+(conviction?' | Prob:'+conviction.probability+'% RR:'+conviction.riskReward:''), {
        ticker, side, dollars, orderId:order.id, isCrypto,
        thesis:analysis?.thesis, catalyst:analysis?.catalyst,
        probability:conviction?.probability, expectedReturn:conviction?.expectedReturn,
        agentVotes:conviction?.agentVoteSummary, riskReward:conviction?.riskReward,
      });
    } else { log('ERROR','Order rejected '+ticker+': '+JSON.stringify(order).substring(0,150)); }
    return order;
  } catch(e) { log('ERROR','Order failed '+ticker+': '+e.message); return null; }
}

// ── 10. TRADE CHECK ───────────────────────────────────────────────
async function runTradeCheck() {
  state.lastTradeCheck = new Date().toISOString();
  state.status = 'TRADE_CHECK';
  try {
    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value||100000);
    let buyingPower = parseFloat(account.buying_power||0);
    const positions = await alpaca('/v2/positions');
    await managePositions(positions);
    const isOpen = await checkMarket();
    if (isOpen && pendingQueue.length>0) buyingPower = await executePendingQueue(portfolio, buyingPower, positions);
    const openCount = Array.isArray(positions)?positions.length:0;
    if (openCount>=12) { log('TRADE','Max positions reached'); state.status='IDLE'; return; }

    const allSignals = [...catalystSignals, ...cryptoSignals.map(s=>({...s,ticker:s.symbol}))];
    if (!allSignals.length) { state.status='IDLE'; return; }
    log('TRADE', '💹 Trade check — '+allSignals.length+' signal(s) | '+(isOpen?'Market OPEN':'CLOSED'));

    for (const signal of allSignals) {
      try {
        const ticker = signal.ticker;
        const isCrypto = signal.isCrypto||ticker.includes('/');
        const isShort = signal.signal==='SHORT';
        if (!isCrypto&&!isOpen) continue;
        const holding = Array.isArray(positions)&&positions.find(p=>p.symbol===ticker);
        if (holding) continue;
        if (pendingQueue.find(p=>p.ticker===ticker)) continue;
        if ((signal.riskScore||0)>=70) { log('RISK','🛡️ Blocked HIGH RISK: '+ticker+' (risk:'+signal.riskScore+')',{ticker,riskScore:signal.riskScore}); continue; }

        const maxAge = isCrypto?48*60*60*1000:24*60*60*1000;
        if (signal.foundAt&&(Date.now()-new Date(signal.foundAt).getTime())>maxAge) {
          log('TRADE','🗑 Expired: '+ticker);
          if (isCrypto) cryptoSignals=cryptoSignals.filter(s=>s.symbol!==ticker);
          else catalystSignals=catalystSignals.filter(s=>s.ticker!==ticker);
          dbDelete('active_signals', 'ticker=eq.'+ticker).catch(()=>{});
          continue;
        }

        const livePrice = await getLivePrice(ticker);
        if (!livePrice) continue;
        const score=signal.signalScore||0, conf=signal.confidence||0;
        const target=parseFloat(signal.targetPrice||0), stop=parseFloat(signal.stopLoss||0);
        const longValid  = !isShort&&livePrice>stop&&livePrice<target;
        const shortValid = isShort&&stop>0&&livePrice<stop&&livePrice>target;
        const cryptoValid = isCrypto&&signal.signal==='BUY'&&livePrice>stop&&livePrice<target;

        if (longValid||shortValid||cryptoValid) {
          if (isShort&&!isCrypto&&!(await isShortable(ticker))) { log('TRADE','⏭ '+ticker+' not shortable'); continue; }
          const dollars = positionDollars(portfolio, score, conf);
          if (!dollars||dollars>buyingPower) continue;
          const side = isShort?'sell':'buy';
          const typeLabel = isCrypto?'CRYPTO':isShort?'SHORT':'LONG';
          const conviction = signal.conviction;
          log('TRADE', (isShort?'🔻':'🟢')+' EXECUTING '+typeLabel+': '+ticker+' @ $'+livePrice.toFixed(2)+' $'+dollars.toFixed(0)+(conviction?' | Prob:'+conviction.probability+'%':''), {
            ticker, dollars, livePrice, side, typeLabel,
            signalScore:score, confidence:conf, probability:conviction?.probability,
            thesis:signal.thesis, catalyst:signal.catalyst, isCrypto,
            agentVotes:conviction?.agentVoteSummary,
          });
          await placeOrder(ticker, dollars, side, signal, isCrypto);
          buyingPower-=dollars;
          if (isCrypto) cryptoSignals=cryptoSignals.filter(s=>s.symbol!==ticker);
          else catalystSignals=catalystSignals.filter(s=>s.ticker!==ticker);
        }
        await new Promise(r=>setTimeout(r,1000));
      } catch(e) { log('ERROR','Trade check error '+signal.ticker+': '+e.message); }
    }
  } catch(e) { log('ERROR','Trade check failed: '+e.message); }
  state.status='IDLE';
}

// ── PENDING QUEUE ─────────────────────────────────────────────────
async function executePendingQueue(portfolio, buyingPower, positions) {
  if (!pendingQueue.length) return buyingPower;
  log('TRADE','⚡ Executing '+pendingQueue.length+' queued order(s)');
  for (const item of [...pendingQueue]) {
    try {
      const holding=Array.isArray(positions)&&positions.find(p=>p.symbol===item.ticker);
      if (holding||(item.riskScore||0)>=70) { pendingQueue=pendingQueue.filter(p=>p.ticker!==item.ticker); continue; }
      const dollars=positionDollars(portfolio,item.signalScore,item.confidence);
      if (!dollars||dollars>buyingPower) { pendingQueue=pendingQueue.filter(p=>p.ticker!==item.ticker); continue; }
      const side=item.signal==='SHORT'?'sell':'buy';
      await placeOrder(item.ticker,dollars,side,item,item.isCrypto);
      buyingPower-=dollars;
      await new Promise(r=>setTimeout(r,2000));
    } catch(e) { log('ERROR','Queue failed '+item.ticker+': '+e.message); }
  }
  return buyingPower;
}

// ── SCHEDULER ─────────────────────────────────────────────────────
function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
  const hhmm = et.getHours().toString().padStart(2,'0')+':'+et.getMinutes().toString().padStart(2,'0');
  const day = et.getDay(), total = et.getHours()*60+et.getMinutes();
  const isMarket = day>=1&&day<=5&&total>=9*60+30&&total<=16*60;
  return { hhmm, isMarket };
}
function minsSince(iso) { return iso?(Date.now()-new Date(iso).getTime())/60000:9999; }

async function scheduler() {
  if (!['IDLE','MARKET_CLOSED'].includes(state.status)) return;
  const { hhmm, isMarket } = getETTime();

  // Morning briefing at 9am
  if (hhmm==='09:00') { await runMorningBriefing(); return; }
  // Pre-close at 3:30pm
  if (hhmm==='15:30') { await runPreCloseBriefing(); return; }
  // Crypto 24/7
  if (minsSince(state.lastCrypto)>=CRYPTO_INTERVAL) { await runCryptoScan(); return; }
  // Influencer scan
  if (minsSince(state.lastInfluencer)>=INFLUENCER_INTERVAL) { await runInfluencerScan(); return; }

  if (isMarket) {
    state.isMarketOpen = true;
    if (minsSince(state.lastCatalyst)>=CATALYST_INTERVAL) await runCatalystScan();
    else if (minsSince(state.lastTradeCheck)>=TRADE_CHECK_MINS) await runTradeCheck();
  } else {
    state.isMarketOpen = false;
    state.status = 'MARKET_CLOSED';
    if (cryptoSignals.length>0&&minsSince(state.lastTradeCheck)>=TRADE_CHECK_MINS) await runTradeCheck();
  }
}

setInterval(scheduler, 5*60*1000);
log('AGENT','🤖 Agent v4 — Morning briefing | Multi-agent analysis | Conviction engine | Trade DNA | Whale tracking');

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/alpaca', async (req, res) => {
  const base = req.headers['x-alpaca-mode']==='live'?'https://api.alpaca.markets':ALPACA_BASE;
  try {
    const r = await fetch(base+req.url, { method:req.method, headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET,'Content-Type':'application/json'}, body:['GET','HEAD'].includes(req.method)?undefined:JSON.stringify(req.body) });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/status', (req,res) => res.json({...state, pendingCount:pendingQueue.length, activeSignals:catalystSignals.length+cryptoSignals.length, stockSignals:catalystSignals.length, cryptoSignalCount:cryptoSignals.length, influencerAlertCount:influencerAlerts.length}));
app.get('/log',         (req,res) => res.json(decisionLog.slice(0,100)));
app.get('/pending',     (req,res) => res.json(pendingQueue));
app.get('/signals',     (req,res) => res.json([...catalystSignals,...cryptoSignals]));
app.get('/influencers', (req,res) => res.json(influencerAlerts.slice(0,20)));
app.get('/watchlists',  (req,res) => res.json(watchlists));
app.get('/briefing',    (req,res) => res.json(morningBriefing||{message:'No briefing generated yet. Runs at 9am ET.'}));
app.get('/tradedna',    (req,res) => res.json({ summary:getTradeDNASummary(), trades:tradeDNA.slice(-50), totalTrades:tradeDNA.length, winRate:tradeDNA.length>0?Math.round(tradeDNA.filter(t=>t.profitable).length/tradeDNA.length*100):0 }));
app.get('/health',      (req,res) => res.json({ok:true,uptime:process.uptime()}));

app.post('/scan-now',       (req,res) => { res.json({message:'Catalyst scan triggered'}); runCatalystScan(); });
app.post('/crypto-now',     (req,res) => { res.json({message:'Crypto scan triggered'}); runCryptoScan(); });
app.post('/intel-now',      (req,res) => { res.json({message:'Morning briefing triggered'}); runMorningBriefing(); });
app.post('/influencer-now', (req,res) => { res.json({message:'Influencer scan triggered'}); runInfluencerScan(); });
app.post('/trade-now',      (req,res) => { res.json({message:'Trade check triggered'}); runTradeCheck(); });
app.post('/clear-queue',    (req,res) => { const n=pendingQueue.length; pendingQueue=[]; log('AGENT','🗑 Queue cleared ('+n+' removed)'); res.json({cleared:n}); });

app.use(express.static(__dirname));
app.listen(3001, () => {
  log('AGENT','🤖 Market Intelligence Agent v4 running on port 3001');
  // Restore from Supabase first, then start scans
  initFromDB().then(() => {
    setTimeout(runCryptoScan, 20000);
    setTimeout(runInfluencerScan, 50000);
    setTimeout(runCatalystScan, 100000);
  }).catch(() => {
    setTimeout(runCryptoScan, 20000);
    setTimeout(runInfluencerScan, 50000);
    setTimeout(runCatalystScan, 100000);
  });
});
