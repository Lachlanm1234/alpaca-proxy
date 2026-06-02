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
const DISCORD_WEBHOOK  = process.env.DISCORD_WEBHOOK;  // Optional
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;   // Optional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Optional

const ALPACA_BASE  = 'https://paper-api.alpaca.markets';
const ALPACA_DATA  = 'https://data.alpaca.markets';

const INTEL_TIMES       = ['09:00', '15:30'];
const CATALYST_INTERVAL = 120;
const CRYPTO_INTERVAL   = 240;
const TRADE_CHECK_MINS  = 30;
const INFLUENCER_INTERVAL = 180; // Every 3 hours

const CRYPTO_SYMBOLS = ['BTC/USD','ETH/USD','SOL/USD','AVAX/USD','LINK/USD','DOGE/USD'];

// Tracked influencers with their known market impacts
const INFLUENCERS = [
  { name: 'Elon Musk',      handles: ['elonmusk'], sectors: ['EV','crypto','AI','space'], avgImpact: '+3.2%', lagHours: 2 },
  { name: 'Donald Trump',   handles: ['realDonaldTrump'], sectors: ['defense','energy','banking'], avgImpact: '+/-2.8%', lagHours: 1 },
  { name: 'Jerome Powell',  handles: [], sectors: ['financials','bonds','all'], avgImpact: '+/-1.9%', lagHours: 0.5 },
  { name: 'Cathie Wood',    handles: ['CathieDWood'], sectors: ['tech','genomics','fintech'], avgImpact: '+1.4%', lagHours: 4 },
  { name: 'Nancy Pelosi',   handles: [], sectors: ['tech','pharma'], avgImpact: '+2.1%', lagHours: 24 },
  { name: 'Michael Burry',  handles: ['michaeljburry'], sectors: ['value','shorts'], avgImpact: '+/-3.1%', lagHours: 12 },
  { name: 'Warren Buffett', handles: [], sectors: ['value','insurance','banks'], avgImpact: '+1.8%', lagHours: 6 },
];

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status: 'IDLE',
  lastIntel: null,
  lastCatalyst: null,
  lastCrypto: null,
  lastInfluencer: null,
  lastTradeCheck: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};

let decisionLog      = [];
let pendingQueue     = [];
let catalystSignals  = [];
let cryptoSignals    = [];
let influencerAlerts = [];
let watchlists       = {
  'Earnings Plays':       [],
  'Short Opportunities':  [],
  'Insider Accumulation': [],
  'Crypto Momentum':      [],
  'Influencer Plays':     [],
  'High Risk / Hype':     [],
};

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 500) decisionLog.length = 500;
  console.log('[' + type + '] ' + message);
  // Send important alerts
  if (['TRADE','RISK','PROFIT','INFLUENCER'].includes(type)) {
    sendAlert(type, message, data);
  }
}

// ── ALERTS (Discord + Telegram) ───────────────────────────────────
async function sendAlert(type, message, data) {
  const emoji = { TRADE:'💰', RISK:'🛑', PROFIT:'🎯', INFLUENCER:'⚡', CATALYST:'🔬', CRYPTO:'₿' }[type] || '📊';
  const color = { TRADE:3066993, RISK:15158332, PROFIT:3066993, INFLUENCER:16776960 }[type] || 3447003;

  // Discord
  if (DISCORD_WEBHOOK) {
    try {
      const fields = [];
      if (data?.ticker)       fields.push({ name: 'Ticker',     value: '`' + data.ticker + '`',           inline: true });
      if (data?.dollars)      fields.push({ name: 'Size',       value: '$' + parseFloat(data.dollars).toFixed(0), inline: true });
      if (data?.signalScore)  fields.push({ name: 'Score',      value: String(data.signalScore),           inline: true });
      if (data?.confidence)   fields.push({ name: 'Confidence', value: data.confidence + '%',              inline: true });
      if (data?.pnlPct)       fields.push({ name: 'P&L',        value: (data.pnlPct>=0?'+':'') + parseFloat(data.pnlPct).toFixed(2) + '%', inline: true });
      if (data?.catalyst)     fields.push({ name: 'Catalyst',   value: data.catalyst,                     inline: false });
      if (data?.thesis)       fields.push({ name: 'Thesis',     value: data.thesis,                       inline: false });
      if (data?.riskScore)    fields.push({ name: 'Risk Score', value: data.riskScore + '/100',            inline: true });
      await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: emoji + ' ' + type + ' — Market Intelligence',
            description: message,
            color,
            fields,
            footer: { text: 'Market Intelligence Agent • ' + new Date().toLocaleString() },
            timestamp: new Date().toISOString(),
          }]
        })
      });
    } catch(e) { console.error('Discord alert failed:', e.message); }
  }

  // Telegram
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const text = emoji + ' *' + type + '*\n' + message +
        (data?.ticker    ? '\nTicker: `' + data.ticker + '`' : '') +
        (data?.catalyst  ? '\nCatalyst: ' + data.catalyst : '') +
        (data?.thesis    ? '\nThesis: ' + data.thesis : '') +
        (data?.dollars   ? '\nSize: $' + parseFloat(data.dollars).toFixed(0) : '');
      await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
      });
    } catch(e) { console.error('Telegram alert failed:', e.message); }
  }
}

// ── ALPACA ────────────────────────────────────────────────────────
async function alpaca(path, opts) {
  opts = opts || {};
  const r = await fetch(ALPACA_BASE + path, {
    method: opts.method || 'GET',
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
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
    const r = await fetch(endpoint, { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } });
    const d = await r.json();
    if (isCrypto) { const q = d.quotes && d.quotes[ticker]; return parseFloat(q?.ap || q?.bp || 0); }
    return parseFloat(d.quote?.ap || d.quote?.bp || 0);
  } catch(e) { return 0; }
}

async function isShortable(ticker) {
  try { const a = await alpaca('/v2/assets/' + ticker); return a.shortable && a.easy_to_borrow; }
  catch(e) { return false; }
}

// ── CLAUDE ────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens) {
  maxTokens = maxTokens || 700;
  const fullSystem = systemPrompt + '\n\nCRITICAL: Return ONLY a valid JSON object. No text before or after. Start with { end with }.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system: fullSystem,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.content.map(b => b.type === 'text' ? b.text : '').join('');
  const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON: ' + text.substring(0,100));
  return JSON.parse(match[0]);
}

// ── RISK ENGINE ───────────────────────────────────────────────────
// Scores a signal for risk before execution. Returns 0-100 (higher = riskier).
function scoreRisk(signal) {
  let risk = 0;
  const score = signal.signalScore || 0;
  const conf = signal.confidence || 0;
  const detail = (signal.detail || '').toLowerCase();
  const catalyst = (signal.catalyst || '').toLowerCase();

  // Low confidence = higher risk
  if (conf < 60) risk += 30;
  else if (conf < 70) risk += 15;

  // Low signal score = higher risk
  if (score < 65) risk += 25;
  else if (score < 72) risk += 10;

  // Hype/pump keywords = higher risk
  const hyped = ['moon','rocket','squeeze','short squeeze','viral','trending','reddit','meme','yolo','to the moon'];
  if (hyped.some(w => detail.includes(w) || catalyst.includes(w))) risk += 25;

  // Rumor-based = higher risk
  if (detail.includes('rumor') || detail.includes('unconfirmed') || detail.includes('report') && !detail.includes('earnings report')) risk += 20;

  // Crypto = inherently more volatile
  if (signal.isCrypto) risk += 10;

  // Short selling = higher risk
  if (signal.signal === 'SHORT' || signal.type === 'SHORT') risk += 10;

  // Strong fundamentals = lower risk
  if (catalyst.includes('earnings beat') || catalyst.includes('eps beat')) risk -= 15;
  if (catalyst.includes('insider buy') || catalyst.includes('sec form 4')) risk -= 10;
  if (catalyst.includes('analyst upgrade')) risk -= 5;

  return Math.min(100, Math.max(0, risk));
}

function getRiskLabel(score) {
  if (score >= 70) return 'HIGH RISK';
  if (score >= 45) return 'MEDIUM RISK';
  return 'LOW RISK';
}

// ── WATCHLIST ENGINE ──────────────────────────────────────────────
function categoriseSignal(signal) {
  const catalyst = (signal.catalyst || '').toLowerCase();
  const detail   = (signal.detail || '').toLowerCase();
  const riskScore = signal.riskScore || 0;
  const isShort   = signal.signal === 'SHORT' || signal.type === 'SHORT';
  const isCrypto  = signal.isCrypto;

  if (isCrypto) return 'Crypto Momentum';
  if (isShort) return 'Short Opportunities';
  if (riskScore >= 70) return 'High Risk / Hype';
  if (catalyst.includes('insider') || detail.includes('form 4') || detail.includes('sec filing')) return 'Insider Accumulation';
  if (catalyst.includes('earnings') || catalyst.includes('eps')) return 'Earnings Plays';
  if (signal.discoveredFrom && signal.discoveredFrom.toLowerCase().includes('influencer')) return 'Influencer Plays';
  return 'Earnings Plays'; // default
}

function updateWatchlists(signal) {
  const category = categoriseSignal(signal);
  const ticker = signal.ticker || signal.symbol;
  if (!ticker) return;

  // Remove from all lists first
  Object.keys(watchlists).forEach(k => {
    watchlists[k] = watchlists[k].filter(s => s.ticker !== ticker);
  });

  // Add to correct category
  if (!watchlists[category]) watchlists[category] = [];
  watchlists[category].unshift({
    ticker,
    signal: signal.signal,
    signalScore: signal.signalScore,
    catalyst: signal.catalyst,
    riskScore: signal.riskScore,
    addedAt: new Date().toISOString(),
  });

  // Cap each list at 10
  Object.keys(watchlists).forEach(k => {
    if (watchlists[k].length > 10) watchlists[k] = watchlists[k].slice(0,10);
  });
}

// ── 1. INTEL SCAN ─────────────────────────────────────────────────
async function runIntelScan(timing) {
  state.status = 'INTEL_SCAN';
  state.lastIntel = new Date().toISOString();
  log('INTEL', '📰 Running ' + timing + ' intelligence scan');

  const prompt = `Market intelligence agent. Search for ONLY these price-moving events from last 12 hours:
- Earnings: EPS actual vs estimate, revenue vs estimate, guidance
- Fed/rates: decisions affecting markets
- Analyst upgrades/downgrades with price targets
- M&A announcements
- Insider buying/selling (SEC Form 4)
- Short squeeze setups
NO general news. Only events tied to specific stock price moves.
Return ONLY JSON:
{"timing":"${timing}","marketContext":"One sentence","actionableEvents":[{"ticker":"NVDA","event":"Earnings beat","detail":"EPS $5.16 vs $4.88 est (+5.7%). Revenue beat. Raised guidance.","impact":"BULLISH","urgency":"HIGH"}],"sectorRotation":"One sentence","keyRisks":"Main risk"}
Max 4 events. Return ONLY JSON.`;

  try {
    const intel = await callClaude(prompt, 'Search earnings vs EPS estimates, analyst actions, insider buys, Fed statements last 12 hours.', 600);
    log('INTEL', '🌍 ' + (intel.marketContext || ''), { marketContext: intel.marketContext });
    (intel.actionableEvents || []).forEach(ev => {
      log('INTEL', '📌 ' + ev.ticker + ' — ' + ev.event + ': ' + ev.detail, {
        ticker: ev.ticker, impact: ev.impact, urgency: ev.urgency, event: ev.event, detail: ev.detail,
      });
    });
    if (intel.sectorRotation) log('INTEL', '🔄 ' + intel.sectorRotation);
    if (intel.keyRisks) log('INTEL', '⚠️ Risk: ' + intel.keyRisks);
  } catch(e) { log('ERROR', 'Intel scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 2. INFLUENCER SCAN ────────────────────────────────────────────
// Tracks high-impact individuals and measures their market influence
async function runInfluencerScan() {
  state.status = 'INFLUENCER_SCAN';
  state.lastInfluencer = new Date().toISOString();
  log('INFLUENCER', '⚡ Scanning influencer activity — Musk, Trump, Powell, Wood, Pelosi...');

  const influencerList = INFLUENCERS.map(i => i.name).join(', ');
  const prompt = `Search for market-moving statements from these people in last 24hrs: ${influencerList}.
Return ONLY JSON (max 2 items, keep all strings under 100 chars):
{"influencerActivity":[{"person":"Elon Musk","platform":"X","action":"Posted about AI robots","relatedTickers":["NVDA","TSLA"],"relatedSectors":["AI"],"estimatedImpact":"+2-3%","impactLagHours":2,"confidence":75,"sentiment":"BULLISH","urgency":"MEDIUM","tradingImplication":"NVDA benefits from AI hardware demand"}]}
If nothing found: {"influencerActivity":[]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'Any market-moving news from Elon Musk, Trump, Powell, Cathie Wood, or Pelosi in last 24 hours?',
      650
    );

    const activities = result.influencerActivity || [];
    activities.forEach(activity => {
      // Add historical impact data from our INFLUENCERS config
      const known = INFLUENCERS.find(i => i.name === activity.person);
      if (known) {
        activity.historicalAvgImpact = known.avgImpact;
        activity.historicalLagHours = known.lagHours;
      }
      activity.foundAt = new Date().toISOString();

      // Store alert
      influencerAlerts.unshift(activity);
      if (influencerAlerts.length > 50) influencerAlerts.length = 50;

      const urgencyEmoji = activity.urgency === 'HIGH' ? '🚨' : '⚡';
      log('INFLUENCER', urgencyEmoji + ' ' + activity.person + ': ' + activity.action, {
        person: activity.person,
        platform: activity.platform,
        relatedTickers: activity.relatedTickers,
        estimatedImpact: activity.estimatedImpact,
        confidence: activity.confidence,
        sentiment: activity.sentiment,
        urgency: activity.urgency,
        tradingImplication: activity.tradingImplication,
      });

      // If high urgency influencer alert, create a trade signal
      if (activity.urgency === 'HIGH' && activity.confidence >= 75 && activity.relatedTickers?.length > 0) {
        const ticker = activity.relatedTickers[0];
        const isLong = activity.sentiment === 'BULLISH';
        const signal = {
          ticker,
          signal: isLong ? 'BUY' : 'SHORT',
          type: isLong ? 'LONG' : 'SHORT',
          signalScore: activity.confidence,
          confidence: activity.confidence - 5,
          catalyst: activity.person + ' — ' + activity.action,
          detail: activity.tradingImplication,
          thesis: 'Influencer signal: ' + activity.person + ' historically drives ' + (activity.historicalAvgImpact || activity.estimatedImpact) + ' move',
          discoveredFrom: 'Influencer: ' + activity.person,
          targetPrice: 0, // Will be set by trade check via live price
          stopLoss: 0,
          expectedReturn: activity.estimatedImpact,
          timeframe: activity.impactLagHours + '-' + (activity.impactLagHours * 3) + ' hours',
          foundAt: new Date().toISOString(),
          isInfluencerSignal: true,
        };
        signal.riskScore = scoreRisk(signal);
        if (signal.riskScore < 70) {
          const existing = catalystSignals.findIndex(s => s.ticker === ticker);
          if (existing >= 0) catalystSignals[existing] = signal;
          else catalystSignals.push(signal);
          updateWatchlists({ ...signal, category: 'Influencer Plays' });
          log('CATALYST', '⚡ Influencer-driven signal added: ' + ticker + ' [' + signal.catalyst + ']', signal);
        }
      }
    });

    log('INFLUENCER', '✅ Influencer scan complete — ' + activities.length + ' activity item(s) found');
  } catch(e) { log('ERROR', 'Influencer scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 3. CATALYST SCAN — STOCKS (every 2hrs) ────────────────────────
async function runCatalystScan() {
  state.status = 'CATALYST_SCAN';
  state.lastCatalyst = new Date().toISOString();
  log('CATALYST', '🔬 Running stock catalyst scan — longs AND shorts...');

  const prompt = `Quantitative trading agent. Find 1 strong LONG and 1 strong SHORT stock opportunity with hard data catalysts.
LONG: earnings beats (EPS > est 5%+), analyst upgrades, insider buying, unusual calls, short squeezes.
SHORT: earnings misses (EPS < est 5%+), guidance cuts, downgrades, insider selling, breakdowns.
For EVERY signal include a full factor breakdown explaining exactly why.
Return ONLY JSON:
{"catalysts":[{"ticker":"NVDA","companyName":"NVIDIA","type":"LONG","catalyst":"Earnings beat","detail":"Q1 EPS $5.16 beat $4.88 est by 5.7%. Revenue $26B beat $24.6B. Raised Q2 guidance above consensus.","signal":"BUY","signalScore":88,"confidence":82,"entryLogic":"Buy at open or dip below $870","targetPrice":950,"stopLoss":820,"expectedReturn":"+8.9%","timeframe":"5-15 days","thesis":"Earnings beat with raised guidance drives 8-12% move in first week historically","factorBreakdown":{"earningsFactor":90,"technicalFactor":75,"sentimentFactor":82,"optionsFactor":70,"insiderFactor":60},"uncertaintyScore":18,"volatilityEstimate":"HIGH"},{"ticker":"TSLA","companyName":"Tesla","type":"SHORT","catalyst":"Earnings miss","detail":"EPS $0.27 vs $0.41 est (-34%). Margin compressed. Lowered FY guidance. Competition rising.","signal":"SHORT","signalScore":81,"confidence":76,"entryLogic":"Short at market or bounce to $175","targetPrice":145,"stopLoss":185,"expectedReturn":"+14.2%","timeframe":"5-20 days","thesis":"Earnings miss with guidance cut drives 10-15% decline historically","factorBreakdown":{"earningsFactor":85,"technicalFactor":78,"sentimentFactor":72,"optionsFactor":65,"insiderFactor":55},"uncertaintyScore":24,"volatilityEstimate":"HIGH"}]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'Search for one strong LONG and one strong SHORT stock opportunity right now — earnings vs EPS estimates, analyst actions, insider activity, options flow.',
      1000
    );

    const newSignals = result.catalysts || [];
    newSignals.forEach(signal => {
      // Add risk scoring
      signal.riskScore = scoreRisk(signal);
      signal.riskLabel = getRiskLabel(signal.riskScore);
      signal.foundAt = new Date().toISOString();

      const existing = catalystSignals.findIndex(s => s.ticker === signal.ticker);
      if (existing >= 0) catalystSignals[existing] = signal;
      else catalystSignals.push(signal);

      updateWatchlists(signal);

      const emoji = signal.type === 'SHORT' ? '🔻' : '🔺';
      const riskWarning = signal.riskScore >= 70 ? ' ⚠️ HIGH RISK' : '';
      log('CATALYST', emoji + ' ' + signal.type + ': ' + signal.ticker + ' [' + signal.catalyst + '] Score:' + signal.signalScore + ' Risk:' + signal.riskScore + riskWarning, {
        ticker: signal.ticker, signal: signal.signal, type: signal.type,
        signalScore: signal.signalScore, confidence: signal.confidence,
        thesis: signal.thesis, catalyst: signal.catalyst, detail: signal.detail,
        entryLogic: signal.entryLogic, targetPrice: signal.targetPrice,
        stopLoss: signal.stopLoss, expectedReturn: signal.expectedReturn,
        factorBreakdown: signal.factorBreakdown,
        uncertaintyScore: signal.uncertaintyScore,
        riskScore: signal.riskScore, riskLabel: signal.riskLabel,
      });
    });

    if (catalystSignals.length > 20) catalystSignals = catalystSignals.slice(-20);
    state.scansCompleted++;
    log('CATALYST', '✅ Catalyst scan complete — ' + newSignals.length + ' signals');
  } catch(e) { log('ERROR', 'Catalyst scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 4. CRYPTO SCAN (every 4hrs, 24/7) ────────────────────────────
async function runCryptoScan() {
  state.status = 'CRYPTO_SCAN';
  state.lastCrypto = new Date().toISOString();
  log('CRYPTO', '₿ Running crypto scan...');

  const prompt = `Search crypto markets for the best trade right now. Pick ONE of: BTC/USD, ETH/USD, SOL/USD, AVAX/USD, LINK/USD, DOGE/USD.
Return this exact JSON with real data:
{"cryptoSignals":[{"symbol":"BTC/USD","name":"Bitcoin","signal":"BUY","signalScore":80,"confidence":74,"currentPrice":68500,"catalyst":"Short catalyst","detail":"Short detail under 80 chars","entryLogic":"Entry logic","targetPrice":75000,"stopLoss":64000,"expectedReturn":"+9%","timeframe":"3-7 days","thesis":"Short thesis","factorBreakdown":{"technicalFactor":78,"sentimentFactor":72,"flowsFactor":80},"riskScore":30}]}
If insufficient data found, return: {"cryptoSignals":[]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'What is the strongest crypto buy or sell signal right now? Check BTC ETH SOL price action and sentiment.',
      600
    );
    const newSignals = result.cryptoSignals || [];
    newSignals.forEach(signal => {
      signal.isCrypto = true;
      signal.ticker = signal.symbol;
      signal.riskScore = signal.riskScore || scoreRisk(signal);
      signal.riskLabel = getRiskLabel(signal.riskScore);
      signal.foundAt = new Date().toISOString();
      const existing = cryptoSignals.findIndex(s => s.symbol === signal.symbol);
      if (existing >= 0) cryptoSignals[existing] = signal;
      else cryptoSignals.push(signal);
      updateWatchlists(signal);
      const emoji = signal.signal === 'BUY' ? '🟢' : '🔴';
      log('CRYPTO', emoji + ' ' + signal.signal + ': ' + signal.symbol + ' — ' + signal.catalyst + ' [Risk: ' + signal.riskScore + ']', {
        ticker: signal.symbol, signal: signal.signal, signalScore: signal.signalScore,
        confidence: signal.confidence, thesis: signal.thesis, catalyst: signal.catalyst,
        targetPrice: signal.targetPrice, stopLoss: signal.stopLoss,
        expectedReturn: signal.expectedReturn, riskScore: signal.riskScore, isCrypto: true,
        factorBreakdown: signal.factorBreakdown,
      });
    });
    if (cryptoSignals.length > 10) cryptoSignals = cryptoSignals.slice(-10);
    log('CRYPTO', '✅ Crypto scan complete — ' + newSignals.length + ' signal(s)');
  } catch(e) { log('ERROR', 'Crypto scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 5. TRADE CHECK (every 30min, no Claude call) ──────────────────
async function runTradeCheck() {
  state.lastTradeCheck = new Date().toISOString();
  state.status = 'TRADE_CHECK';
  try {
    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);
    const positions = await alpaca('/v2/positions');
    await managePositions(positions);
    const isOpen = await checkMarket();
    if (isOpen && pendingQueue.length > 0) {
      buyingPower = await executePendingQueue(portfolio, buyingPower, positions);
    }
    const openCount = Array.isArray(positions) ? positions.length : 0;
    if (openCount >= 12) { log('TRADE', 'Max positions reached'); state.status = 'IDLE'; return; }

    const allSignals = [
      ...catalystSignals.map(s => ({ ...s, ticker: s.ticker })),
      ...cryptoSignals.map(s => ({ ...s, ticker: s.symbol })),
    ];

    if (!allSignals.length) { state.status = 'IDLE'; return; }
    log('TRADE', '💹 Trade check — ' + allSignals.length + ' signal(s) | ' + (isOpen ? 'Market OPEN' : 'Market CLOSED'));

    for (const signal of allSignals) {
      try {
        const ticker = signal.ticker;
        const isCrypto = signal.isCrypto || ticker.includes('/');
        const isShort = signal.signal === 'SHORT';
        if (!isCrypto && !isOpen) continue;

        const holding = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
        if (holding) continue;
        if (pendingQueue.find(p => p.ticker === ticker)) continue;

        // Block HIGH RISK signals
        if ((signal.riskScore || 0) >= 70) {
          log('RISK', '🛡️ Blocked HIGH RISK signal: ' + ticker + ' (risk score: ' + signal.riskScore + ')', { ticker, riskScore: signal.riskScore, riskLabel: signal.riskLabel });
          continue;
        }

        const maxAge = isCrypto ? 48*60*60*1000 : 24*60*60*1000;
        if (signal.foundAt && (Date.now()-new Date(signal.foundAt).getTime()) > maxAge) {
          log('TRADE', '🗑 Expired: ' + ticker);
          if (isCrypto) cryptoSignals = cryptoSignals.filter(s => s.symbol !== ticker);
          else catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);
          continue;
        }

        const livePrice = await getLivePrice(ticker);
        if (!livePrice) continue;

        const score = signal.signalScore || 0;
        const conf = signal.confidence || 0;
        const target = parseFloat(signal.targetPrice || 0);
        const stop = parseFloat(signal.stopLoss || 0);

        // For influencer signals with no price targets, set dynamic targets
        if (signal.isInfluencerSignal && !target) {
          signal.targetPrice = livePrice * 1.05;
          signal.stopLoss = livePrice * 0.95;
        }

        const longValid  = !isShort && livePrice > stop && livePrice < target;
        const shortValid = isShort && stop > 0 && livePrice < stop && livePrice > target;
        const cryptoValid = isCrypto && signal.signal === 'BUY' && livePrice > stop && livePrice < target;

        if (longValid || shortValid || cryptoValid) {
          if (isShort && !isCrypto && !(await isShortable(ticker))) {
            log('TRADE', '⏭ ' + ticker + ' not shortable'); continue;
          }
          const dollars = positionDollars(portfolio, score, conf);
          if (!dollars || dollars > buyingPower) continue;

          const side = isShort ? 'sell' : 'buy';
          const typeLabel = isCrypto ? 'CRYPTO' : isShort ? 'SHORT' : 'LONG';
          const emoji = isShort ? '🔻' : '🟢';

          // Build explainability string
          const fb = signal.factorBreakdown || {};
          const explanation = Object.keys(fb).length > 0
            ? 'Factors: ' + Object.entries(fb).map(([k,v]) => k.replace('Factor','') + ':' + v).join(' | ')
            : '';

          log('TRADE', emoji + ' EXECUTING ' + typeLabel + ': ' + ticker + ' @ $' + livePrice.toFixed(2) + ' $' + dollars.toFixed(0), {
            ticker, dollars, livePrice, side, typeLabel,
            signalScore: score, confidence: conf,
            thesis: signal.thesis, catalyst: signal.catalyst,
            factorBreakdown: signal.factorBreakdown,
            riskScore: signal.riskScore, isCrypto,
          });

          await placeOrder(ticker, dollars, side, signal, isCrypto);
          buyingPower -= dollars;
          if (isCrypto) cryptoSignals = cryptoSignals.filter(s => s.symbol !== ticker);
          else catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch(e) { log('ERROR', 'Trade check error ' + signal.ticker + ': ' + e.message); }
    }
  } catch(e) { log('ERROR', 'Trade check failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── POSITION SIZING ───────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c = score * 0.6 + confidence * 0.4;
  if (c >= 85) return portfolio * 0.08;
  if (c >= 78) return portfolio * 0.06;
  if (c >= 72) return portfolio * 0.04;
  if (c >= 65) return portfolio * 0.02;
  return 0;
}

// ── PLACE ORDER ───────────────────────────────────────────────────
async function placeOrder(ticker, dollars, side, analysis, isCrypto) {
  try {
    const positions = await alpaca('/v2/positions');
    const holding = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
    if (holding && side === 'buy') { log('TRADE', 'Already holding ' + ticker); return null; }
    const order = await alpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({ symbol: ticker, notional: dollars.toFixed(2), side, type: 'market', time_in_force: isCrypto ? 'gtc' : 'day' })
    });
    if (order.id) {
      state.tradesExecuted++;
      pendingQueue = pendingQueue.filter(p => p.ticker !== ticker);
      const typeLabel = isCrypto ? '₿ CRYPTO' : side === 'sell' ? '🔻 SHORT' : '🟢 LONG';
      log('TRADE', typeLabel + ' executed: ' + ticker + ' $' + dollars.toFixed(0), {
        ticker, side, dollars, orderId: order.id, isCrypto,
        thesis: analysis?.thesis, catalyst: analysis?.catalyst,
        factorBreakdown: analysis?.factorBreakdown,
      });
    } else {
      log('ERROR', 'Order rejected ' + ticker + ': ' + JSON.stringify(order).substring(0,150));
    }
    return order;
  } catch(e) { log('ERROR', 'Order failed ' + ticker + ': ' + e.message); return null; }
}

// Track last sell evaluation per ticker to avoid repeated calls
const sellEvalCache = {};

// Smart sell evaluation - asks Claude before closing a profitable position
async function shouldSell(ticker, pnlPct, entryPrice, currentPrice, isCrypto) {
  const cacheKey = ticker;
  const lastEval = sellEvalCache[cacheKey];
  const fourHours = 4 * 60 * 60 * 1000;
  // Only re-evaluate every 4 hours per position
  if (lastEval && (Date.now() - lastEval.timestamp) < fourHours) {
    return lastEval.decision;
  }
  try {
    const prompt = `Position analysis: ${ticker} is up +${pnlPct.toFixed(1)}% (entry $${entryPrice}, now $${currentPrice}). 
Should we SELL now to lock in profit, or HOLD for more upside? Consider current market conditions, momentum, and whether the original thesis still holds.
Return ONLY JSON: {"decision":"SELL","reason":"Short reason under 60 chars","confidence":80}
decision must be SELL or HOLD. Return ONLY JSON.`;
    // No web search for this - just reasoning (cheaper)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        system: prompt + '\n\nReturn ONLY valid JSON starting with {',
        messages: [{ role: 'user', content: 'Sell or hold ' + ticker + ' at +' + pnlPct.toFixed(1) + '%?' }]
      })
    });
    const d = await r.json();
    const text = d.content.map(b => b.type === 'text' ? b.text : '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      sellEvalCache[cacheKey] = { timestamp: Date.now(), decision: result.decision === 'SELL' };
      if (result.decision === 'HOLD') {
        log('PROFIT', '🤔 AI says HOLD ' + ticker + ' at +' + pnlPct.toFixed(1) + '% — ' + (result.reason || ''), { ticker, pnlPct });
      }
      return result.decision === 'SELL';
    }
  } catch(e) {
    log('ERROR', 'Sell evaluation failed for ' + ticker + ': ' + e.message);
  }
  return true; // Default to sell if evaluation fails
}

// ── MANAGE POSITIONS ──────────────────────────────────────────────
async function managePositions(positions) {
  if (!positions) positions = await alpaca('/v2/positions');
  if (!Array.isArray(positions) || !positions.length) return;
  for (const p of positions) {
    const pnl = parseFloat(p.unrealized_plpc) * 100;
    const isCrypto = p.asset_class === 'crypto';
    const isShort = parseFloat(p.qty) < 0;
    const stopThreshold = isCrypto ? -12 : -8;
    const profitWarning = isCrypto ? 18 : 15;  // Start evaluating here
    const profitHard = isCrypto ? 30 : 25;     // Hard exit regardless of AI opinion

    if (pnl <= stopThreshold) {
      // Hard stop loss — no AI evaluation, just exit immediately
      log('RISK', '🛑 Stop loss: ' + p.symbol + ' at ' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'STOP_LOSS', isShort, isCrypto });
      await alpaca('/v2/positions/' + encodeURIComponent(p.symbol), { method: 'DELETE' });
      delete sellEvalCache[p.symbol];

    } else if (pnl >= profitHard) {
      // Hard take profit ceiling — always exit
      log('PROFIT', '🎯 Hard take profit: ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT_HARD', isShort, isCrypto });
      await alpaca('/v2/positions/' + encodeURIComponent(p.symbol), { method: 'DELETE' });
      delete sellEvalCache[p.symbol];

    } else if (pnl >= profitWarning) {
      // Smart exit zone — ask Claude if we should sell or hold for more
      const entryPrice = parseFloat(p.avg_entry_price || 0);
      const currentPrice = parseFloat(p.current_price || 0);
      const sell = await shouldSell(p.symbol, pnl, entryPrice, currentPrice, isCrypto);
      if (sell) {
        log('PROFIT', '🎯 AI-confirmed sell: ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT_AI', isShort, isCrypto });
        await alpaca('/v2/positions/' + encodeURIComponent(p.symbol), { method: 'DELETE' });
        delete sellEvalCache[p.symbol];
      }
    }
  }
}

// ── EXECUTE PENDING QUEUE ─────────────────────────────────────────
async function executePendingQueue(portfolio, buyingPower, positions) {
  if (!pendingQueue.length) return buyingPower;
  log('TRADE', '⚡ Executing ' + pendingQueue.length + ' queued order(s)');
  for (const item of [...pendingQueue]) {
    try {
      const holding = Array.isArray(positions) && positions.find(p => p.symbol === item.ticker);
      if (holding) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      if ((item.riskScore || 0) >= 70) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      const dollars = positionDollars(portfolio, item.signalScore, item.confidence);
      if (!dollars || dollars > buyingPower) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      const side = item.signal === 'SHORT' ? 'sell' : 'buy';
      await placeOrder(item.ticker, dollars, side, item, item.isCrypto);
      buyingPower -= dollars;
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) { log('ERROR', 'Queue failed ' + item.ticker + ': ' + e.message); }
  }
  return buyingPower;
}

// ── SCHEDULER ─────────────────────────────────────────────────────
function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hhmm = et.getHours().toString().padStart(2,'0') + ':' + et.getMinutes().toString().padStart(2,'0');
  const day = et.getDay();
  const totalMins = et.getHours()*60 + et.getMinutes();
  const isMarket = day>=1 && day<=5 && totalMins>=9*60+30 && totalMins<=16*60;
  return { hhmm, isMarket };
}

function minsSince(iso) { return iso ? (Date.now()-new Date(iso).getTime())/60000 : 9999; }

async function scheduler() {
  if (!['IDLE','MARKET_CLOSED'].includes(state.status)) return;
  const { hhmm, isMarket } = getETTime();

  if (INTEL_TIMES.includes(hhmm)) {
    await runIntelScan(hhmm < '12:00' ? 'pre-market' : 'pre-close'); return;
  }
  if (minsSince(state.lastCrypto) >= CRYPTO_INTERVAL) { await runCryptoScan(); return; }
  if (minsSince(state.lastInfluencer) >= INFLUENCER_INTERVAL) { await runInfluencerScan(); return; }

  if (isMarket) {
    state.isMarketOpen = true;
    if (minsSince(state.lastCatalyst) >= CATALYST_INTERVAL) { await runCatalystScan(); }
    else if (minsSince(state.lastTradeCheck) >= TRADE_CHECK_MINS) { await runTradeCheck(); }
  } else {
    state.isMarketOpen = false;
    state.status = 'MARKET_CLOSED';
    if (cryptoSignals.length > 0 && minsSince(state.lastTradeCheck) >= TRADE_CHECK_MINS) { await runTradeCheck(); }
  }
}

setInterval(scheduler, 5 * 60 * 1000);
log('AGENT', '🤖 Agent v3 — Intel:9am+3:30pm | Catalyst:2hr | Crypto:4hr | Influencer:3hr | Trade:30min | Discord+Telegram alerts enabled');

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/alpaca', async (req, res) => {
  const base = req.headers['x-alpaca-mode'] === 'live' ? 'https://api.alpaca.markets' : ALPACA_BASE;
  try {
    const r = await fetch(base + req.url, {
      method: req.method,
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => res.json({
  ...state,
  pendingCount: pendingQueue.length,
  activeSignals: catalystSignals.length + cryptoSignals.length,
  stockSignals: catalystSignals.length,
  cryptoSignalCount: cryptoSignals.length,
  influencerAlertCount: influencerAlerts.length,
}));

app.get('/log',         (req, res) => res.json(decisionLog.slice(0, 100)));
app.get('/pending',     (req, res) => res.json(pendingQueue));
app.get('/signals',     (req, res) => res.json([...catalystSignals, ...cryptoSignals]));
app.get('/influencers', (req, res) => res.json(influencerAlerts.slice(0, 20)));
app.get('/watchlists',  (req, res) => res.json(watchlists));
app.get('/health',      (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/scan-now',       (req, res) => { res.json({ message: 'Catalyst scan triggered' }); runCatalystScan(); });
app.post('/crypto-now',     (req, res) => { res.json({ message: 'Crypto scan triggered' }); runCryptoScan(); });
app.post('/intel-now',      (req, res) => { res.json({ message: 'Intel scan triggered' }); runIntelScan('manual'); });
app.post('/influencer-now', (req, res) => { res.json({ message: 'Influencer scan triggered' }); runInfluencerScan(); });
app.post('/trade-now',      (req, res) => { res.json({ message: 'Trade check triggered' }); runTradeCheck(); });
app.post('/clear-queue',    (req, res) => {
  const n = pendingQueue.length; pendingQueue = [];
  log('AGENT', '🗑 Queue cleared (' + n + ' removed)');
  res.json({ cleared: n });
});

app.use(express.static(__dirname));

app.listen(3001, () => {
  log('AGENT', '🤖 Market Intelligence Agent v3 running on port 3001');
  setTimeout(runCryptoScan, 15000);
  setTimeout(runInfluencerScan, 45000);
  setTimeout(runCatalystScan, 90000);
});
