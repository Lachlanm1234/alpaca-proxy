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
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const FINNHUB_KEY      = process.env.FINNHUB_KEY;
const MASSIVE_KEY      = process.env.MASSIVE_KEY;
const ALPACA_BASE      = 'https://paper-api.alpaca.markets';
const ALPACA_DATA      = 'https://data.alpaca.markets';
const FINNHUB_BASE     = 'https://finnhub.io/api/v1';
const MASSIVE_BASE     = 'https://api.massiveapi.com/v1';

const INTEL_TIMES         = ['09:00', '15:30'];
const CATALYST_INTERVAL   = 120;
const CRYPTO_INTERVAL     = 240;
const INFLUENCER_INTERVAL = 180;
const TRADE_CHECK_MINS    = 30;

const INFLUENCERS = [
  { name:'Elon Musk',      sectors:['EV','crypto','AI','space'],   avgImpact:'+3.2%', lagHours:2  },
  { name:'Donald Trump',   sectors:['defense','energy','banking'], avgImpact:'+/-2.8%',lagHours:1  },
  { name:'Jerome Powell',  sectors:['financials','bonds','all'],   avgImpact:'+/-1.9%',lagHours:0.5},
  { name:'Cathie Wood',    sectors:['tech','genomics','fintech'],  avgImpact:'+1.4%', lagHours:4  },
  { name:'Nancy Pelosi',   sectors:['tech','pharma'],              avgImpact:'+2.1%', lagHours:24 },
  { name:'Michael Burry',  sectors:['value','shorts'],             avgImpact:'+/-3.1%',lagHours:12 },
  { name:'Warren Buffett', sectors:['value','insurance','banks'],  avgImpact:'+1.8%', lagHours:6  },
];

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status:'IDLE', lastIntel:null, lastCatalyst:null, lastCrypto:null,
  lastInfluencer:null, lastTradeCheck:null,
  scansCompleted:0, tradesExecuted:0, isMarketOpen:false,
};
let decisionLog      = [];
let pendingQueue     = [];
let catalystSignals  = [];
let cryptoSignals    = [];
let influencerAlerts = [];
let tradeDNA         = [];
let morningBriefing  = null;
let watchlists       = {
  'Earnings Plays':[], 'Short Opportunities':[], 'Insider Accumulation':[],
  'Crypto Momentum':[], 'Influencer Plays':[], 'High Risk / Hype':[],
};
const sellEvalCache = {};

// ── SUPABASE ──────────────────────────────────────────────────────
const DB = SUPABASE_URL && SUPABASE_KEY;

async function dbInsert(table, data) {
  if (!DB) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:'POST',
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify(data)
    });
    return r.ok;
  } catch(e) { return false; }
}

async function dbUpsert(table, data) {
  if (!DB) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:'POST',
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify(data)
    });
    return r.ok;
  } catch(e) { return false; }
}

async function dbSelect(table, query) {
  if (!DB) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query?'?'+query:''}`, {
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}
    });
    return r.ok ? r.json() : [];
  } catch(e) { return []; }
}

async function dbDelete(table, filter) {
  if (!DB) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method:'DELETE',
      headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Prefer':'return=minimal'}
    });
    return r.ok;
  } catch(e) { return false; }
}

// ── FINNHUB HELPERS ───────────────────────────────────────────────
async function finnhub(path) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(`${FINNHUB_BASE}${path}&token=${FINNHUB_KEY}`);
    if (!r.ok) return null;
    return r.json();
  } catch(e) { return null; }
}

// Real EPS vs estimate — actual hard numbers
async function getEPSSurprise(ticker) {
  const data = await finnhub(`/stock/earnings?symbol=${ticker}&limit=4`);
  if (!data || !data.length) return null;
  const latest = data[0];
  if (!latest.actual && latest.actual !== 0) return null;
  const surprise = latest.estimate ? ((latest.actual - latest.estimate) / Math.abs(latest.estimate) * 100) : 0;
  return {
    ticker,
    period: latest.period,
    epsActual: latest.actual,
    epsEstimate: latest.estimate,
    surprisePct: parseFloat(surprise.toFixed(2)),
    revenueActual: latest.revenueActual || null,
    revenueEstimate: latest.revenueEstimate || null,
    beat: surprise > 0,
    strongBeat: surprise > 5,
    strongMiss: surprise < -5,
  };
}

// Analyst consensus ratings
async function getAnalystRatings(ticker) {
  const data = await finnhub(`/stock/recommendation?symbol=${ticker}`);
  if (!data || !data.length) return null;
  const latest = data[0];
  const total = (latest.buy||0) + (latest.hold||0) + (latest.sell||0) + (latest.strongBuy||0) + (latest.strongSell||0);
  if (!total) return null;
  const bullish = ((latest.buy||0) + (latest.strongBuy||0)) / total * 100;
  return {
    ticker,
    period: latest.period,
    buy: latest.buy || 0,
    strongBuy: latest.strongBuy || 0,
    hold: latest.hold || 0,
    sell: latest.sell || 0,
    strongSell: latest.strongSell || 0,
    bullishPct: Math.round(bullish),
    consensus: bullish > 65 ? 'BUY' : bullish < 35 ? 'SELL' : 'HOLD',
  };
}

// Real insider transactions from SEC filings
async function getInsiderActivity(ticker) {
  const data = await finnhub(`/stock/insider-transactions?symbol=${ticker}`);
  if (!data || !data.data || !data.data.length) return null;
  const recent = data.data.slice(0, 10);
  const buys = recent.filter(t => t.transactionType === 'P - Purchase' || t.change > 0);
  const sells = recent.filter(t => t.transactionType === 'S - Sale' || t.change < 0);
  const netShares = recent.reduce((s, t) => s + (t.change || 0), 0);
  return {
    ticker,
    recentBuys: buys.length,
    recentSells: sells.length,
    netShares,
    netActivity: netShares > 0 ? 'NET_BUYING' : netShares < 0 ? 'NET_SELLING' : 'NEUTRAL',
    transactions: recent.slice(0, 3).map(t => ({
      name: t.name,
      shares: Math.abs(t.change || 0),
      type: t.change > 0 ? 'BUY' : 'SELL',
      date: t.transactionDate,
    })),
  };
}

// Upcoming earnings calendar for next N days
async function getUpcomingEarnings(days) {
  days = days || 2;
  const today = new Date();
  const future = new Date(today);
  future.setDate(future.getDate() + days);
  const from = today.toISOString().split('T')[0];
  const to = future.toISOString().split('T')[0];
  const data = await finnhub(`/calendar/earnings?from=${from}&to=${to}`);
  if (!data || !data.earningsCalendar) return [];
  return data.earningsCalendar
    .filter(e => e.symbol && e.epsEstimate)
    .map(e => ({
      ticker: e.symbol,
      date: e.date,
      time: e.hour || 'unknown',
      epsEstimate: e.epsEstimate,
      revenueEstimate: e.revenueEstimate || null,
    }));
}

// Company news sentiment from Finnhub
async function getCompanyNews(ticker) {
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
  const data = await finnhub(`/company-news?symbol=${ticker}&from=${from}&to=${to}`);
  if (!data || !data.length) return [];
  return data.slice(0, 5).map(n => ({ headline: n.headline, source: n.source, url: n.url, datetime: n.datetime }));
}

// Basic financials / valuation metrics
async function getMetrics(ticker) {
  const data = await finnhub(`/stock/metric?symbol=${ticker}&metric=all`);
  if (!data || !data.metric) return null;
  const m = data.metric;
  return {
    ticker,
    pe: m.peNormalizedAnnual || m.peTTM || null,
    eps: m.epsTTM || null,
    revenueGrowth: m.revenueGrowthTTMYoy || null,
    grossMargin: m.grossMarginTTM || null,
    beta: m.beta || null,
    week52High: m['52WeekHigh'] || null,
    week52Low: m['52WeekLow'] || null,
  };
}

// ── MASSIVE HELPERS ───────────────────────────────────────────────
async function massiveGet(path) {
  if (!MASSIVE_KEY) return null;
  try {
    const r = await fetch(`${MASSIVE_BASE}${path}`, {
      headers: { 'Authorization': 'Bearer ' + MASSIVE_KEY, 'Content-Type': 'application/json' }
    });
    if (!r.ok) return null;
    return r.json();
  } catch(e) { return null; }
}

// Get real-time quote from Massive (fallback to Alpaca if unavailable)
async function getRealTimeQuote(ticker) {
  if (MASSIVE_KEY) {
    const data = await massiveGet(`/quotes/${ticker}`);
    if (data && data.price) return { price: data.price, change: data.change, changePct: data.changePct, volume: data.volume };
  }
  // Fallback to Alpaca data
  const price = await getLivePrice(ticker);
  return price ? { price, change: null, changePct: null, volume: null } : null;
}

async function initFromDB() {
  if (!DB) { console.log('[AGENT] Supabase not configured — running in-memory only'); return; }
  try {
    console.log('[AGENT] Restoring state from Supabase...');

    const dnaRows = await dbSelect('trade_dna','order=created_at.asc&limit=200');
    if (Array.isArray(dnaRows) && dnaRows.length) {
      tradeDNA = dnaRows.map(r=>({ticker:r.ticker,entryPrice:r.entry_price,exitPrice:r.exit_price,returnPct:r.return_pct,profitable:r.profitable,catalyst:r.catalyst,signalScore:r.signal_score,reason:r.reason,date:r.created_at}));
      console.log('[AGENT] Restored '+tradeDNA.length+' trade DNA records');
    }

    const sigRows = await dbSelect('active_signals','order=updated_at.desc&limit=20');
    if (Array.isArray(sigRows) && sigRows.length) {
      sigRows.forEach(r=>{
        const s={ticker:r.ticker,signal:r.signal,type:r.type,signalScore:r.signal_score,confidence:r.confidence,catalyst:r.catalyst,detail:r.detail,thesis:r.thesis,targetPrice:r.target_price,stopLoss:r.stop_loss,expectedReturn:r.expected_return,timeframe:r.timeframe,factorBreakdown:r.factor_breakdown,conviction:r.conviction,riskScore:r.risk_score,isCrypto:r.is_crypto,foundAt:r.found_at};
        if (r.is_crypto){s.symbol=r.ticker;cryptoSignals.push(s);}
        else catalystSignals.push(s);
      });
      console.log('[AGENT] Restored '+sigRows.length+' signals');
    }

    const qRows = await dbSelect('pending_queue','order=created_at.asc');
    if (Array.isArray(qRows) && qRows.length) {
      pendingQueue = qRows.map(r=>({ticker:r.ticker,signal:r.signal,dollars:r.dollars,signalScore:r.signal_score,confidence:r.confidence,catalyst:r.catalyst,thesis:r.thesis,queuedAt:r.queued_at,isCrypto:r.is_crypto}));
      console.log('[AGENT] Restored '+pendingQueue.length+' queued orders');
    }

    const logRows = await dbSelect('decision_log','order=created_at.desc&limit=100');
    if (Array.isArray(logRows) && logRows.length) {
      const restored = logRows.map(r=>({timestamp:r.created_at,type:r.type,message:r.message,ticker:r.ticker,signalScore:r.signal_score,confidence:r.confidence,dollars:r.dollars,pnlPct:r.pnl_pct,catalyst:r.catalyst,thesis:r.thesis,agentVotes:r.agent_votes,factorBreakdown:r.factor_breakdown,riskScore:r.risk_score}));
      decisionLog = [...restored,...decisionLog];
      if (decisionLog.length>500) decisionLog.length=500;
      console.log('[AGENT] Restored '+logRows.length+' log entries');
    }

    const infRows = await dbSelect('influencer_alerts','order=created_at.desc&limit=50');
    if (Array.isArray(infRows) && infRows.length) {
      influencerAlerts = infRows.map(r=>({person:r.person,platform:r.platform,action:r.action,relatedTickers:r.related_tickers,estimatedImpact:r.estimated_impact,confidence:r.confidence,sentiment:r.sentiment,urgency:r.urgency,tradingImplication:r.trading_implication,foundAt:r.created_at}));
      console.log('[AGENT] Restored '+influencerAlerts.length+' influencer alerts');
    }

    console.log('[AGENT] Database restore complete');
  } catch(e) { console.error('[AGENT] DB restore failed:', e.message); }
}

// ── LOG ───────────────────────────────────────────────────────────
function log(type, message, data) {
  const entry = { timestamp:new Date().toISOString(), type, message, ...(data||{}) };
  decisionLog.unshift(entry);
  if (decisionLog.length>500) decisionLog.length=500;
  console.log('['+type+'] '+message);
  if (['TRADE','RISK','PROFIT','INFLUENCER'].includes(type)) sendAlert(type, message, data);
  if (DB && type!=='DNA') {
    dbInsert('decision_log',{type,message,ticker:data?.ticker||null,signal_score:data?.signalScore||null,confidence:data?.confidence||null,dollars:data?.dollars||null,pnl_pct:data?.pnlPct||null,catalyst:data?.catalyst||null,thesis:data?.thesis||null,agent_votes:data?.agentVotes?JSON.stringify(data.agentVotes):null,factor_breakdown:data?.factorBreakdown?JSON.stringify(data.factorBreakdown):null,risk_score:data?.riskScore||null,is_crypto:data?.isCrypto||false}).catch(()=>{});
  }
}

// ── ALERTS ────────────────────────────────────────────────────────
async function sendAlert(type, message, data) {
  const emoji={TRADE:'💰',RISK:'🛑',PROFIT:'🎯',INFLUENCER:'⚡'}[type]||'📊';
  const color={TRADE:3066993,RISK:15158332,PROFIT:3066993,INFLUENCER:16776960}[type]||3447003;
  if (DISCORD_WEBHOOK) {
    try {
      const fields=[];
      if(data?.ticker)       fields.push({name:'Ticker',value:'`'+data.ticker+'`',inline:true});
      if(data?.dollars)      fields.push({name:'Size',value:'$'+parseFloat(data.dollars).toFixed(0),inline:true});
      if(data?.probability)  fields.push({name:'Probability',value:data.probability+'%',inline:true});
      if(data?.expectedReturn) fields.push({name:'Expected',value:data.expectedReturn,inline:true});
      if(data?.catalyst)     fields.push({name:'Catalyst',value:data.catalyst,inline:false});
      await fetch(DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embeds:[{title:emoji+' '+type+' — Market Intelligence',description:message,color,fields,footer:{text:'Agent v4 • '+new Date().toLocaleString()},timestamp:new Date().toISOString()}]})});
    } catch(e){}
  }
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const text=emoji+' *'+type+'*\n'+message+(data?.ticker?'\nTicker: `'+data.ticker+'`':'')+(data?.catalyst?'\n'+data.catalyst:'');
      await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:'Markdown'})});
    } catch(e){}
  }
}

// ── ALPACA ────────────────────────────────────────────────────────
async function alpaca(path, opts) {
  opts=opts||{};
  const r=await fetch(ALPACA_BASE+path,{method:opts.method||'GET',headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET,'Content-Type':'application/json'},body:opts.body||undefined});
  return r.json();
}
async function checkMarket() {
  try{const c=await alpaca('/v2/clock');state.isMarketOpen=c.is_open;return c.is_open;}catch(e){return false;}
}
async function getLivePrice(ticker) {
  try{
    const isCrypto=ticker.includes('/');
    const ep=isCrypto?`${ALPACA_DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(ticker)}`:`${ALPACA_DATA}/v2/stocks/${ticker}/quotes/latest`;
    const r=await fetch(ep,{headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET}});
    const d=await r.json();
    if(isCrypto){const q=d.quotes&&d.quotes[ticker];return parseFloat(q?.ap||q?.bp||0);}
    return parseFloat(d.quote?.ap||d.quote?.bp||0);
  }catch(e){return 0;}
}
async function isShortable(ticker) {
  try{const a=await alpaca('/v2/assets/'+ticker);return a.shortable&&a.easy_to_borrow;}catch(e){return false;}
}

// ── CLAUDE ────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens, useWebSearch) {
  maxTokens=maxTokens||700;
  useWebSearch=useWebSearch!==false;
  const fullSystem=systemPrompt+'\n\nCRITICAL: Return ONLY a valid JSON object. No text before or after. Start with { end with }.';
  const body={model:'claude-haiku-4-5-20251001',max_tokens:maxTokens,system:fullSystem,messages:[{role:'user',content:userContent}]};
  if(useWebSearch) body.tools=[{type:'web_search_20250305',name:'web_search'}];
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.error) throw new Error(d.error.message);
  const text=d.content.map(b=>b.type==='text'?b.text:'').join('');
  const match=text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
  if(!match) throw new Error('No JSON: '+text.substring(0,100));
  return JSON.parse(match[0]);
}

// ── RISK ENGINE ───────────────────────────────────────────────────
function scoreRisk(signal) {
  let risk=0;
  const score=signal.signalScore||0,conf=signal.confidence||0;
  const detail=(signal.detail||'').toLowerCase(),catalyst=(signal.catalyst||'').toLowerCase();
  if(conf<60)risk+=30;else if(conf<70)risk+=15;
  if(score<65)risk+=25;else if(score<72)risk+=10;
  const hyped=['moon','rocket','squeeze','viral','trending','meme','yolo'];
  if(hyped.some(w=>detail.includes(w)||catalyst.includes(w)))risk+=25;
  if(detail.includes('rumor')||detail.includes('unconfirmed'))risk+=20;
  if(signal.isCrypto)risk+=10;
  if(signal.signal==='SHORT'||signal.type==='SHORT')risk+=10;
  if(catalyst.includes('earnings beat')||catalyst.includes('eps beat'))risk-=15;
  if(catalyst.includes('insider buy'))risk-=10;
  if(catalyst.includes('analyst upgrade'))risk-=5;
  return Math.min(100,Math.max(0,risk));
}
function getRiskLabel(s){return s>=70?'HIGH RISK':s>=45?'MEDIUM RISK':'LOW RISK';}

// ── WATCHLISTS ────────────────────────────────────────────────────
function categoriseSignal(signal) {
  const catalyst=(signal.catalyst||'').toLowerCase(),detail=(signal.detail||'').toLowerCase();
  if(signal.isCrypto) return 'Crypto Momentum';
  if(signal.signal==='SHORT'||signal.type==='SHORT') return 'Short Opportunities';
  if((signal.riskScore||0)>=70) return 'High Risk / Hype';
  if(catalyst.includes('insider')||detail.includes('form 4')) return 'Insider Accumulation';
  if(signal.isInfluencerSignal) return 'Influencer Plays';
  return 'Earnings Plays';
}
function updateWatchlists(signal) {
  const cat=categoriseSignal(signal),ticker=signal.ticker||signal.symbol;
  if(!ticker) return;
  Object.keys(watchlists).forEach(k=>{watchlists[k]=watchlists[k].filter(s=>s.ticker!==ticker);});
  if(!watchlists[cat]) watchlists[cat]=[];
  watchlists[cat].unshift({ticker,signal:signal.signal,signalScore:signal.signalScore,catalyst:signal.catalyst,riskScore:signal.riskScore,addedAt:new Date().toISOString()});
  Object.keys(watchlists).forEach(k=>{if(watchlists[k].length>10)watchlists[k]=watchlists[k].slice(0,10);});
}

// ── TRADE DNA ─────────────────────────────────────────────────────
function recordTradeOutcome(ticker, entryPrice, exitPrice, catalyst, signalScore, reason) {
  const returnPct=entryPrice>0?((exitPrice-entryPrice)/entryPrice)*100:0;
  const record={ticker,entryPrice,exitPrice,catalyst,signalScore,returnPct:parseFloat(returnPct.toFixed(2)),profitable:returnPct>0,reason,date:new Date().toISOString()};
  tradeDNA.push(record);
  if(tradeDNA.length>200) tradeDNA.shift();
  log('DNA','📊 Trade recorded: '+ticker+' '+returnPct.toFixed(1)+'% ['+reason+']',{ticker,returnPct,profitable:returnPct>0});
  dbInsert('trade_dna',{ticker,entry_price:entryPrice,exit_price:exitPrice,return_pct:record.returnPct,profitable:record.profitable,catalyst,signal_score:signalScore,reason}).catch(()=>{});
}

function getTradeDNASummary() {
  if(tradeDNA.length<3) return 'Building trade history...';
  const wins=tradeDNA.filter(t=>t.profitable).length;
  const winRate=(wins/tradeDNA.length*100).toFixed(0);
  const avgReturn=(tradeDNA.reduce((s,t)=>s+t.returnPct,0)/tradeDNA.length).toFixed(1);
  const bestCat={};
  tradeDNA.forEach(t=>{const k=(t.catalyst||'unknown').split(' ')[0];if(!bestCat[k])bestCat[k]={count:0,wins:0};bestCat[k].count++;if(t.profitable)bestCat[k].wins++;});
  const top=Object.entries(bestCat).sort((a,b)=>b[1].wins-a[1].wins)[0];
  return `Win rate: ${winRate}% (${wins}/${tradeDNA.length} trades). Avg return: ${avgReturn}%. Best: ${top?top[0]:'unknown'}.`;
}

// ── MULTI-AGENT ANALYST ───────────────────────────────────────────
async function runMultiAgentAnalysis(signal) {
  const ticker=signal.ticker||signal.symbol;
  const ctx=`Stock: ${ticker}\nCatalyst: ${signal.catalyst||''}\nDetail: ${signal.detail||''}\nScore: ${signal.signalScore} Conf: ${signal.confidence}%\nThesis: ${signal.thesis||''}`;
  const agents=[
    {name:'Momentum',focus:'price momentum, volume, RSI, moving averages only'},
    {name:'Earnings', focus:'EPS vs estimate, revenue, guidance, analyst revisions only'},
    {name:'Macro',    focus:'Fed policy, sector rotation, economic cycle, macro risks only'},
    {name:'Sentiment',focus:'social buzz, options flow, retail positioning only'},
    {name:'Risk',     focus:'finding reasons NOT to trade — risks and red flags only'},
  ];
  const votes=await Promise.all(agents.map(async agent=>{
    try{
      const prompt=`You are the ${agent.name} Agent. Analyze ONLY: ${agent.focus}\nContext: ${ctx}\nVote BUY, HOLD, or SELL. One short reason max 60 chars.\nReturn ONLY JSON: {"agent":"${agent.name}","vote":"BUY","reason":"Short reason","conviction":75}`;
      const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:120,system:prompt+'\n\nReturn ONLY JSON.',messages:[{role:'user',content:'Vote on '+ticker}]})});
      const d=await r.json();
      if(d.error) return {agent:agent.name,vote:'HOLD',reason:'Unavailable',conviction:50};
      const text=d.content.map(b=>b.type==='text'?b.text:'').join('');
      const match=text.match(/\{[\s\S]*\}/);
      return match?JSON.parse(match[0]):{agent:agent.name,vote:'HOLD',reason:'Parse error',conviction:50};
    }catch(e){return {agent:agent.name,vote:'HOLD',reason:'Error',conviction:50};}
  }));
  return votes;
}

// ── CONVICTION ENGINE ─────────────────────────────────────────────
function buildConviction(signal, agentVotes) {
  const isShort=signal.signal==='SHORT'||signal.type==='SHORT';
  const buyCount=agentVotes.filter(v=>v.vote==='BUY').length;
  const sellCount=agentVotes.filter(v=>v.vote==='SELL').length;
  const total=agentVotes.length;
  const consensus=isShort?(sellCount/total)*100:(buyCount/total)*100;
  const probability=Math.round((signal.confidence||70)*0.65+consensus*0.35);
  const entry=parseFloat(signal.currentPrice||0);
  const target=parseFloat(signal.targetPrice||0);
  const stop=parseFloat(signal.stopLoss||0);
  const expectedReturn=(entry>0&&target>0)?((target-entry)/entry*100).toFixed(1)+'%':(signal.expectedReturn||'—');
  const worstCase=(entry>0&&stop>0)?((stop-entry)/entry*100).toFixed(1)+'%':(isShort?'+5%':'-8%');
  const upside=target&&entry?Math.abs(target-entry):0;
  const downside=stop&&entry?Math.abs(stop-entry):1;
  const riskReward=downside>0?(upside/downside).toFixed(1)+':1':'—';
  return {probability,expectedReturn,worstCase,riskReward,agentConsensus:Math.round(consensus),buyVotes:buyCount,sellVotes:sellCount,holdVotes:total-buyCount-sellCount,agentVoteSummary:buyCount+'/'+total+' agents '+(isShort?'bearish':'bullish'),dnaSummary:getTradeDNASummary(),agentVotes};
}

// ── POSITION SIZING ───────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c=score*0.6+confidence*0.4;
  if(c>=85) return portfolio*0.08;
  if(c>=78) return portfolio*0.06;
  if(c>=72) return portfolio*0.04;
  if(c>=65) return portfolio*0.02;
  return 0;
}

// ── PLACE ORDER ───────────────────────────────────────────────────
async function placeOrder(ticker, dollars, side, analysis, isCrypto) {
  try{
    const positions=await alpaca('/v2/positions');
    const holding=Array.isArray(positions)&&positions.find(p=>p.symbol===ticker);
    if(holding&&side==='buy'){log('TRADE','Already holding '+ticker);return null;}
    const order=await alpaca('/v2/orders',{method:'POST',body:JSON.stringify({symbol:ticker,notional:dollars.toFixed(2),side,type:'market',time_in_force:isCrypto?'gtc':'day'})});
    if(order.id){
      state.tradesExecuted++;
      pendingQueue=pendingQueue.filter(p=>p.ticker!==ticker);
      dbDelete('pending_queue','ticker=eq.'+ticker).catch(()=>{});
      const typeLabel=isCrypto?'₿ CRYPTO':side==='sell'?'🔻 SHORT':'🟢 LONG';
      const conv=analysis?.conviction;
      log('TRADE',typeLabel+' executed: '+ticker+' $'+dollars.toFixed(0)+(conv?' | Prob:'+conv.probability+'% RR:'+conv.riskReward:''),{ticker,side,dollars,orderId:order.id,isCrypto,thesis:analysis?.thesis,catalyst:analysis?.catalyst,probability:conv?.probability,expectedReturn:conv?.expectedReturn,agentVotes:conv?.agentVoteSummary,riskReward:conv?.riskReward});
      // Remove from active signals in DB
      dbDelete('active_signals','ticker=eq.'+ticker).catch(()=>{});
    }else{log('ERROR','Order rejected '+ticker+': '+JSON.stringify(order).substring(0,150));}
    return order;
  }catch(e){log('ERROR','Order failed '+ticker+': '+e.message);return null;}
}

// ── SMART SELL EVALUATION ─────────────────────────────────────────
async function shouldSell(ticker, pnlPct, entry, current, isCrypto) {
  const lastEval=sellEvalCache[ticker];
  if(lastEval&&(Date.now()-lastEval.timestamp)<4*60*60*1000) return lastEval.decision;
  try{
    const prompt=`Position: ${ticker} up +${pnlPct.toFixed(1)}% (entry $${entry}, now $${current}). SELL to lock profit or HOLD for more upside?\nReturn ONLY JSON: {"decision":"SELL","reason":"Short reason under 60 chars","confidence":80}`;
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:100,system:prompt+'\n\nReturn ONLY JSON.',messages:[{role:'user',content:'Sell or hold '+ticker+'?'}]})});
    const d=await r.json();
    const text=d.content.map(b=>b.type==='text'?b.text:'').join('');
    const match=text.match(/\{[\s\S]*\}/);
    if(match){
      const res=JSON.parse(match[0]);
      sellEvalCache[ticker]={timestamp:Date.now(),decision:res.decision==='SELL'};
      if(res.decision==='HOLD') log('PROFIT','🤔 AI says HOLD '+ticker+' at +'+pnlPct.toFixed(1)+'% — '+(res.reason||''),{ticker,pnlPct});
      return res.decision==='SELL';
    }
  }catch(e){log('ERROR','Sell eval failed: '+e.message);}
  return true;
}

// ── MANAGE POSITIONS ──────────────────────────────────────────────
async function managePositions(positions) {
  if(!positions) positions=await alpaca('/v2/positions');
  if(!Array.isArray(positions)||!positions.length) return;
  for(const p of positions){
    const pnl=parseFloat(p.unrealized_plpc)*100;
    const isCrypto=p.asset_class==='crypto',isShort=parseFloat(p.qty)<0;
    const stopT=isCrypto?-12:-8,warnT=isCrypto?18:15,hardT=isCrypto?30:25;
    const entry=parseFloat(p.avg_entry_price||0),current=parseFloat(p.current_price||0);
    if(pnl<=stopT){
      log('RISK','🛑 Stop loss: '+p.symbol+' at '+pnl.toFixed(1)+'%',{ticker:p.symbol,pnlPct:pnl,reason:'STOP_LOSS',isShort,isCrypto});
      await alpaca('/v2/positions/'+encodeURIComponent(p.symbol),{method:'DELETE'});
      recordTradeOutcome(p.symbol,entry,current,'stop loss',0,'STOP_LOSS');
      delete sellEvalCache[p.symbol];
    }else if(pnl>=hardT){
      log('PROFIT','🎯 Hard take profit: '+p.symbol+' at +'+pnl.toFixed(1)+'%',{ticker:p.symbol,pnlPct:pnl,reason:'TAKE_PROFIT_HARD',isShort,isCrypto});
      await alpaca('/v2/positions/'+encodeURIComponent(p.symbol),{method:'DELETE'});
      recordTradeOutcome(p.symbol,entry,current,'hard take profit',0,'TAKE_PROFIT_HARD');
      delete sellEvalCache[p.symbol];
    }else if(pnl>=warnT){
      const sell=await shouldSell(p.symbol,pnl,entry,current,isCrypto);
      if(sell){
        log('PROFIT','🎯 AI-confirmed sell: '+p.symbol+' at +'+pnl.toFixed(1)+'%',{ticker:p.symbol,pnlPct:pnl,reason:'TAKE_PROFIT_AI',isShort,isCrypto});
        await alpaca('/v2/positions/'+encodeURIComponent(p.symbol),{method:'DELETE'});
        recordTradeOutcome(p.symbol,entry,current,'AI take profit',0,'TAKE_PROFIT_AI');
        delete sellEvalCache[p.symbol];
      }
    }
  }
}

// ── EXECUTE PENDING QUEUE ─────────────────────────────────────────
async function executePendingQueue(portfolio, buyingPower, positions) {
  if(!pendingQueue.length) return buyingPower;
  log('TRADE','⚡ Executing '+pendingQueue.length+' queued order(s)');
  for(const item of [...pendingQueue]){
    try{
      const holding=Array.isArray(positions)&&positions.find(p=>p.symbol===item.ticker);
      if(holding||(item.riskScore||0)>=70){pendingQueue=pendingQueue.filter(p=>p.ticker!==item.ticker);continue;}
      const dollars=positionDollars(portfolio,item.signalScore,item.confidence);
      if(!dollars||dollars>buyingPower){pendingQueue=pendingQueue.filter(p=>p.ticker!==item.ticker);continue;}
      const side=item.signal==='SHORT'?'sell':'buy';
      await placeOrder(item.ticker,dollars,side,item,item.isCrypto);
      buyingPower-=dollars;
      await new Promise(r=>setTimeout(r,2000));
    }catch(e){log('ERROR','Queue failed '+item.ticker+': '+e.message);}
  }
  return buyingPower;
}

// ── MORNING BRIEFING ──────────────────────────────────────────────
async function runMorningBriefing() {
  state.status='MORNING_BRIEFING';state.lastIntel=new Date().toISOString();
  log('INTEL','☀️ Generating morning briefing...');
  const dna=getTradeDNASummary();
  const prompt=`AI Portfolio Manager giving pre-market briefing. Search overnight news, futures, key themes. Trade history: ${dna}
Return ONLY JSON:
{"greeting":"Good morning. [One sentence key overnight development]","marketRegime":"RISK_ON","futuresSnapshot":"Brief futures direction","topWatches":[{"ticker":"NVDA","reason":"Why watch today","bias":"BULLISH"}],"sectorFocus":"Interesting sector and why","keyRisk":"Biggest risk today","topIdea":{"ticker":"AAPL","catalyst":"Why best trade today","action":"BUY"}}
Keep all strings under 100 chars. Return ONLY JSON.`;
  try{
    const result=await callClaude(prompt,'Search overnight futures and pre-market catalysts for today.',700,true);
    morningBriefing={...result,generatedAt:new Date().toISOString()};
    log('INTEL','☀️ '+(result.greeting||'Morning briefing ready'),{marketRegime:result.marketRegime});
    if(result.topIdea) log('INTEL','💡 Top idea: '+result.topIdea.ticker+' — '+result.topIdea.catalyst,{ticker:result.topIdea.ticker});
    (result.topWatches||[]).forEach(w=>log('INTEL','👀 Watch: '+w.ticker+' — '+w.reason,{ticker:w.ticker,bias:w.bias}));
  }catch(e){log('ERROR','Morning briefing failed: '+e.message);}
  state.status='IDLE';
}

async function runPreCloseBriefing() {
  state.status='INTEL_SCAN';state.lastIntel=new Date().toISOString();
  log('INTEL','🔔 Running pre-close briefing...');
  const prompt=`Pre-close briefing. Search today's market action.
Return ONLY JSON:
{"summary":"One sentence on today's session","actionableEvents":[{"ticker":"NVDA","event":"Event","detail":"Short detail","impact":"BULLISH","urgency":"HIGH"}],"overnightWatches":["TICKER1"],"closingNote":"Outlook for tomorrow"}
Max 3 events. Return ONLY JSON.`;
  try{
    const result=await callClaude(prompt,"Search today's market movers, earnings, news. What to watch overnight?",500,true);
    log('INTEL','🔔 '+(result.summary||''));
    (result.actionableEvents||[]).forEach(ev=>log('INTEL','📌 '+ev.ticker+' — '+ev.event+': '+ev.detail,{ticker:ev.ticker,impact:ev.impact,urgency:ev.urgency}));
    if(result.closingNote) log('INTEL','📝 '+result.closingNote);
    if(result.overnightWatches?.length) log('INTEL','🌙 Watch overnight: '+result.overnightWatches.join(', '));
  }catch(e){log('ERROR','Pre-close briefing failed: '+e.message);}
  state.status='IDLE';
}

// ── INFLUENCER SCAN ───────────────────────────────────────────────
async function runInfluencerScan() {
  state.status='INFLUENCER_SCAN';state.lastInfluencer=new Date().toISOString();
  log('INFLUENCER','⚡ Scanning Musk, Trump, Powell, Wood, Pelosi, Burry, Buffett...');
  const names=INFLUENCERS.map(i=>i.name).join(', ');
  const prompt=`Search for market-moving statements from: ${names} in last 24hrs. Also check congressional stock disclosures.
Return ONLY JSON (max 2 items, all strings under 100 chars):
{"influencerActivity":[{"person":"Elon Musk","platform":"X","action":"Posted about AI robots","relatedTickers":["NVDA","TSLA"],"relatedSectors":["AI"],"estimatedImpact":"+2-3%","impactLagHours":2,"confidence":75,"sentiment":"BULLISH","urgency":"MEDIUM","tradingImplication":"NVDA benefits from AI demand"}]}
If nothing found: {"influencerActivity":[]}
Return ONLY JSON.`;
  try{
    const result=await callClaude(prompt,'Any market-moving news from Musk, Trump, Powell, Wood, Pelosi, Burry in last 24 hours?',650,true);
    const activities=result.influencerActivity||[];
    activities.forEach(activity=>{
      const known=INFLUENCERS.find(i=>i.name===activity.person);
      if(known){activity.historicalAvgImpact=known.avgImpact;activity.historicalLagHours=known.lagHours;}
      activity.foundAt=new Date().toISOString();
      influencerAlerts.unshift(activity);
      if(influencerAlerts.length>50) influencerAlerts.length=50;
      dbInsert('influencer_alerts',{person:activity.person,platform:activity.platform,action:activity.action,related_tickers:activity.relatedTickers||[],estimated_impact:activity.estimatedImpact,confidence:activity.confidence,sentiment:activity.sentiment,urgency:activity.urgency,trading_implication:activity.tradingImplication}).catch(()=>{});
      const urgEmoji=activity.urgency==='HIGH'?'🚨':'⚡';
      log('INFLUENCER',urgEmoji+' '+activity.person+': '+activity.action,{person:activity.person,platform:activity.platform,relatedTickers:activity.relatedTickers,estimatedImpact:activity.estimatedImpact,confidence:activity.confidence,sentiment:activity.sentiment,urgency:activity.urgency,tradingImplication:activity.tradingImplication});
      if(activity.urgency==='HIGH'&&activity.confidence>=75&&activity.relatedTickers?.length){
        const ticker=activity.relatedTickers[0];
        const isLong=activity.sentiment==='BULLISH';
        const signal={ticker,signal:isLong?'BUY':'SHORT',type:isLong?'LONG':'SHORT',signalScore:activity.confidence,confidence:activity.confidence-5,catalyst:activity.person+' — '+activity.action,detail:activity.tradingImplication,thesis:'Influencer: '+activity.person+' historically drives '+(activity.historicalAvgImpact||activity.estimatedImpact),discoveredFrom:'Influencer: '+activity.person,isInfluencerSignal:true,foundAt:new Date().toISOString()};
        signal.riskScore=scoreRisk(signal);
        if(signal.riskScore<70){
          const existing=catalystSignals.findIndex(s=>s.ticker===ticker);
          if(existing>=0)catalystSignals[existing]=signal;else catalystSignals.push(signal);
          updateWatchlists({...signal,category:'Influencer Plays'});
        }
      }
    });
    log('INFLUENCER','✅ Influencer scan complete — '+activities.length+' item(s)');
  }catch(e){log('ERROR','Influencer scan failed: '+e.message);}
  state.status='IDLE';
}

// ── CATALYST SCAN ─────────────────────────────────────────────────
async function runCatalystScan() {
  state.status='CATALYST_SCAN';state.lastCatalyst=new Date().toISOString();
  const dna=getTradeDNASummary();
  log('CATALYST','🔬 Running catalyst scan with multi-agent analysis...');
  const prompt=`Quantitative trading agent. Find 1 LONG and 1 SHORT with hard data catalysts. Past performance: ${dna}
LONG: earnings beats (EPS>est 5%+), analyst upgrades, insider buying.
SHORT: earnings misses (EPS<est 5%+), guidance cuts, downgrades.
Return ONLY JSON:
{"catalysts":[{"ticker":"NVDA","companyName":"NVIDIA","type":"LONG","catalyst":"Earnings beat","detail":"Q1 EPS $5.16 beat $4.88 est by 5.7%. Revenue beat. Raised guidance.","signal":"BUY","signalScore":88,"confidence":82,"currentPrice":875,"entryLogic":"Buy at open or dip below $870","targetPrice":950,"stopLoss":820,"expectedReturn":"+8.9%","timeframe":"5-15 days","thesis":"Earnings beat with raised guidance drives 8-12% move","factorBreakdown":{"earningsFactor":90,"technicalFactor":75,"sentimentFactor":82,"optionsFactor":70}},{"ticker":"TSLA","companyName":"Tesla","type":"SHORT","catalyst":"Earnings miss","detail":"EPS $0.27 vs $0.41 est. Margin compressed. Lowered guidance.","signal":"SHORT","signalScore":81,"confidence":76,"currentPrice":175,"entryLogic":"Short at market","targetPrice":145,"stopLoss":190,"expectedReturn":"+14%","timeframe":"5-20 days","thesis":"Earnings miss drives 10-15% decline","factorBreakdown":{"earningsFactor":85,"technicalFactor":78,"sentimentFactor":72,"optionsFactor":65}}]}
Return ONLY JSON.`;
  try{
    const result=await callClaude(prompt,'Find one strong LONG and one SHORT catalyst right now — earnings vs estimates, analyst actions, insider activity.',1000,true);
    const newSignals=result.catalysts||[];
    for(let signal of newSignals){
      signal.riskScore=scoreRisk(signal);signal.riskLabel=getRiskLabel(signal.riskScore);signal.foundAt=new Date().toISOString();
      log('CATALYST','🤖 Running 5-agent analysis for '+signal.ticker+'...');
      const agentVotes=await runMultiAgentAnalysis(signal);
      const conviction=buildConviction(signal,agentVotes);
      signal.conviction=conviction;
      // Enrich with real Finnhub data before storing
      signal = await enrichSignalWithRealData(signal);
      const existing=catalystSignals.findIndex(s=>s.ticker===signal.ticker);
      if(existing>=0)catalystSignals[existing]=signal;else catalystSignals.push(signal);
      updateWatchlists(signal);
      dbUpsert('active_signals',{ticker:signal.ticker,signal:signal.signal,type:signal.type,signal_score:signal.signalScore,confidence:signal.confidence,catalyst:signal.catalyst,detail:signal.detail,thesis:signal.thesis,target_price:signal.targetPrice,stop_loss:signal.stopLoss,expected_return:signal.expectedReturn,timeframe:signal.timeframe,factor_breakdown:signal.factorBreakdown?JSON.stringify(signal.factorBreakdown):null,conviction:signal.conviction?JSON.stringify(signal.conviction):null,risk_score:signal.riskScore,is_crypto:false,found_at:signal.foundAt,updated_at:new Date().toISOString()}).catch(()=>{});
      const emoji=signal.type==='SHORT'?'🔻':'🔺';
      const agentSummary=agentVotes.map(v=>v.agent+':'+v.vote).join(' | ');
      log('CATALYST',emoji+' '+signal.type+': '+signal.ticker+' | Prob:'+conviction.probability+'% | RR:'+conviction.riskReward+' | '+agentSummary,{ticker:signal.ticker,signal:signal.signal,type:signal.type,signalScore:signal.signalScore,confidence:signal.confidence,probability:conviction.probability,expectedReturn:conviction.expectedReturn,worstCase:conviction.worstCase,riskReward:conviction.riskReward,thesis:signal.thesis,catalyst:signal.catalyst,detail:signal.detail,entryLogic:signal.entryLogic,targetPrice:signal.targetPrice,stopLoss:signal.stopLoss,factorBreakdown:signal.factorBreakdown,riskScore:signal.riskScore,riskLabel:signal.riskLabel,agentVotes,agentVoteSummary:agentSummary});
    }
    if(catalystSignals.length>20) catalystSignals=catalystSignals.slice(-20);
    state.scansCompleted++;
    log('CATALYST','✅ Catalyst scan complete — '+newSignals.length+' signals with agent analysis');
  }catch(e){log('ERROR','Catalyst scan failed: '+e.message);}
  state.status='IDLE';
}

// ── CRYPTO SCAN ───────────────────────────────────────────────────
async function runCryptoScan() {
  state.status='CRYPTO_SCAN';state.lastCrypto=new Date().toISOString();
  log('CRYPTO','₿ Running crypto scan...');
  const prompt=`You must respond with ONLY a JSON object, nothing else. No explanation, no preamble.
Find the best crypto trade now from: BTC/USD, ETH/USD, SOL/USD, AVAX/USD, LINK/USD, DOGE/USD.
Your entire response must be exactly this structure:
{"cryptoSignals":[{"symbol":"BTC/USD","name":"Bitcoin","signal":"BUY","signalScore":80,"confidence":74,"currentPrice":68500,"catalyst":"ETF inflows surge","detail":"RSI 58, breaking resistance","entryLogic":"Buy now","targetPrice":75000,"stopLoss":64000,"expectedReturn":"+9%","timeframe":"3-7 days","thesis":"Bullish breakout","factorBreakdown":{"technicalFactor":78,"sentimentFactor":72,"flowsFactor":80},"riskScore":30}]}
If no clear signal exists respond with exactly: {"cryptoSignals":[]}`;
  try{
    const result=await callClaude(prompt,'What is the single best crypto trade right now? BTC ETH SOL AVAX LINK DOGE.',600,true);
    const newSignals=result.cryptoSignals||[];
    for(const signal of newSignals){
      signal.isCrypto=true;signal.ticker=signal.symbol;
      signal.riskScore=signal.riskScore||scoreRisk(signal);signal.riskLabel=getRiskLabel(signal.riskScore);signal.foundAt=new Date().toISOString();
      const existing=cryptoSignals.findIndex(s=>s.symbol===signal.symbol);
      if(existing>=0)cryptoSignals[existing]=signal;else cryptoSignals.push(signal);
      updateWatchlists(signal);
      dbUpsert('active_signals',{ticker:signal.symbol,signal:signal.signal,type:'CRYPTO',signal_score:signal.signalScore,confidence:signal.confidence,catalyst:signal.catalyst,detail:signal.detail,thesis:signal.thesis,target_price:signal.targetPrice,stop_loss:signal.stopLoss,expected_return:signal.expectedReturn,timeframe:signal.timeframe,factor_breakdown:signal.factorBreakdown?JSON.stringify(signal.factorBreakdown):null,risk_score:signal.riskScore,is_crypto:true,found_at:signal.foundAt,updated_at:new Date().toISOString()}).catch(()=>{});
      log('CRYPTO',(signal.signal==='BUY'?'🟢':'🔴')+' '+signal.signal+': '+signal.symbol+' — '+signal.catalyst,{ticker:signal.symbol,signal:signal.signal,signalScore:signal.signalScore,confidence:signal.confidence,thesis:signal.thesis,catalyst:signal.catalyst,targetPrice:signal.targetPrice,stopLoss:signal.stopLoss,riskScore:signal.riskScore,isCrypto:true});
    }
    if(cryptoSignals.length>10) cryptoSignals=cryptoSignals.slice(-10);
    log('CRYPTO','✅ Crypto scan complete — '+newSignals.length+' signal(s)');
  }catch(e){log('ERROR','Crypto scan failed: '+e.message);}
  state.status='IDLE';
}

// ── TRADE CHECK ───────────────────────────────────────────────────
async function runTradeCheck() {
  state.lastTradeCheck=new Date().toISOString();state.status='TRADE_CHECK';
  try{
    const account=await alpaca('/v2/account');
    const portfolio=parseFloat(account.portfolio_value||100000);
    let buyingPower=parseFloat(account.buying_power||0);
    const positions=await alpaca('/v2/positions');
    await managePositions(positions);
    const isOpen=await checkMarket();
    if(isOpen&&pendingQueue.length>0) buyingPower=await executePendingQueue(portfolio,buyingPower,positions);
    const openCount=Array.isArray(positions)?positions.length:0;
    if(openCount>=12){log('TRADE','Max positions reached');state.status='IDLE';return;}
    const allSignals=[...catalystSignals,...cryptoSignals.map(s=>({...s,ticker:s.symbol}))];
    if(!allSignals.length){state.status='IDLE';return;}
    log('TRADE','💹 Trade check — '+allSignals.length+' signal(s) | '+(isOpen?'Market OPEN':'CLOSED'));
    for(const signal of allSignals){
      try{
        const ticker=signal.ticker;
        const isCrypto=signal.isCrypto||ticker.includes('/');
        const isShort=signal.signal==='SHORT';
        if(!isCrypto&&!isOpen) continue;
        const holding=Array.isArray(positions)&&positions.find(p=>p.symbol===ticker);
        if(holding) continue;
        if(pendingQueue.find(p=>p.ticker===ticker)) continue;
        if((signal.riskScore||0)>=70){log('RISK','🛡️ Blocked HIGH RISK: '+ticker+' (risk:'+signal.riskScore+')',{ticker,riskScore:signal.riskScore});continue;}
        const maxAge=isCrypto?48*60*60*1000:24*60*60*1000;
        if(signal.foundAt&&(Date.now()-new Date(signal.foundAt).getTime())>maxAge){
          log('TRADE','🗑 Expired: '+ticker);
          if(isCrypto)cryptoSignals=cryptoSignals.filter(s=>s.symbol!==ticker);
          else catalystSignals=catalystSignals.filter(s=>s.ticker!==ticker);
          dbDelete('active_signals','ticker=eq.'+ticker).catch(()=>{});
          continue;
        }
        const livePrice=await getLivePrice(ticker);if(!livePrice) continue;
        const score=signal.signalScore||0,conf=signal.confidence||0;
        const target=parseFloat(signal.targetPrice||0),stop=parseFloat(signal.stopLoss||0);
        const longValid=!isShort&&livePrice>stop&&livePrice<target;
        const shortValid=isShort&&stop>0&&livePrice<stop&&livePrice>target;
        const cryptoValid=isCrypto&&signal.signal==='BUY'&&livePrice>stop&&livePrice<target;
        if(longValid||shortValid||cryptoValid){
          if(isShort&&!isCrypto&&!(await isShortable(ticker))){log('TRADE','⏭ '+ticker+' not shortable');continue;}
          const dollars=positionDollars(portfolio,score,conf);
          if(!dollars||dollars>buyingPower) continue;
          const side=isShort?'sell':'buy';
          const typeLabel=isCrypto?'CRYPTO':isShort?'SHORT':'LONG';
          const conv=signal.conviction;
          log('TRADE',(isShort?'🔻':'🟢')+' EXECUTING '+typeLabel+': '+ticker+' @ $'+livePrice.toFixed(2)+' $'+dollars.toFixed(0)+(conv?' | Prob:'+conv.probability+'%':''),{ticker,dollars,livePrice,side,typeLabel,signalScore:score,confidence:conf,probability:conv?.probability,thesis:signal.thesis,catalyst:signal.catalyst,isCrypto,agentVotes:conv?.agentVoteSummary});
          await placeOrder(ticker,dollars,side,signal,isCrypto);
          buyingPower-=dollars;
          if(isCrypto)cryptoSignals=cryptoSignals.filter(s=>s.symbol!==ticker);
          else catalystSignals=catalystSignals.filter(s=>s.ticker!==ticker);
        }
        await new Promise(r=>setTimeout(r,1000));
      }catch(e){log('ERROR','Trade check error '+signal.ticker+': '+e.message);}
    }
  }catch(e){log('ERROR','Trade check failed: '+e.message);}
  state.status='IDLE';
}

// ── EARNINGS PRE-POSITIONING SCAN ────────────────────────────────
// Runs at 6pm ET — finds tomorrow's earnings, builds thesis overnight,
// queues trades ready for market open. Uses REAL Finnhub data.
async function runEarningsPrePositioning() {
  state.status = 'EARNINGS_SCAN';
  log('CATALYST', '📅 Running earnings pre-positioning scan — finding tomorrows catalysts...');

  try {
    const upcoming = await getUpcomingEarnings(2);
    if (!upcoming.length) {
      log('CATALYST', '📅 No earnings found for next 2 days');
      state.status = 'IDLE';
      return;
    }

    log('CATALYST', '📅 Found '+upcoming.length+' upcoming earnings — ' + upcoming.map(e=>e.ticker).join(', '));

    // Save ALL upcoming earnings to DB so calendar is always populated
    for (const e of upcoming) {
      dbUpsert('earnings_calendar', {
        ticker: e.ticker,
        report_date: e.date,
        report_time: e.time || 'unknown',
        eps_estimate: e.epsEstimate || null,
        revenue_estimate: e.revenueEstimate || null,
      }).catch(()=>{});
    }

    // Analyse top 3 most significant upcoming earnings
    const toAnalyse = upcoming.slice(0, 3);

    for (const earning of toAnalyse) {
      try {
        const ticker = earning.ticker;

        // Get real data from Finnhub
        const [ratings, insider, metrics, news] = await Promise.all([
          getAnalystRatings(ticker),
          getInsiderActivity(ticker),
          getMetrics(ticker),
          getCompanyNews(ticker),
        ]);

        // Build context from real data
        const analystContext = ratings
          ? `Analyst consensus: ${ratings.consensus} (${ratings.bullishPct}% bullish, ${ratings.buy+ratings.strongBuy} buys vs ${ratings.sell+ratings.strongSell} sells)`
          : 'No analyst data';
        const insiderContext = insider
          ? `Insider activity: ${insider.netActivity} (${insider.recentBuys} buys, ${insider.recentSells} sells in recent filings)`
          : 'No insider data';
        const metricsContext = metrics
          ? `P/E: ${metrics.pe||'N/A'}, Revenue growth: ${metrics.revenueGrowth?metrics.revenueGrowth.toFixed(1)+'%':'N/A'}, Beta: ${metrics.beta||'N/A'}`
          : 'No metrics data';
        const newsContext = news.length
          ? 'Recent headlines: ' + news.slice(0,2).map(n=>n.headline).join(' | ')
          : 'No recent news';

        const prompt = `You are an earnings pre-positioning analyst. ${ticker} reports earnings ${earning.time==='bmo'?'before market open':'after market close'} on ${earning.date}.
EPS estimate: $${earning.epsEstimate}${earning.revenueEstimate?' Revenue estimate: $'+Math.round(earning.revenueEstimate/1e6)+'M':''}
${analystContext}
${insiderContext}
${metricsContext}
${newsContext}
Based on this data, should we pre-position LONG (expecting beat), SHORT (expecting miss), or AVOID?
Consider: analyst sentiment, insider activity, recent news tone, valuation.
Return ONLY JSON:
{"ticker":"${ticker}","action":"LONG","signal":"BUY","signalScore":78,"confidence":72,"thesis":"Why we expect a beat or miss in one sentence","entryTiming":"Pre-market or at open","targetPrice":0,"stopLoss":0,"expectedReturn":"+8%","riskFactors":["risk1","risk2"],"keyMetricToWatch":"What EPS number would confirm the thesis"}
action: LONG, SHORT, or AVOID. Return ONLY JSON.`;

        const analysis = await callClaude(prompt, 'Pre-position analysis for '+ticker+' earnings on '+earning.date, 600, false);

        if (analysis.action === 'AVOID') {
          log('CATALYST', '⏭ AVOID pre-positioning for '+ticker+' — '+analysis.thesis, {ticker});
          continue;
        }

        // Add real analyst + insider data to signal
        analysis.catalyst = 'Earnings '+earning.date+' (est EPS $'+earning.epsEstimate+')';
        analysis.detail = analystContext+'. '+insiderContext;
        analysis.epsEstimate = earning.epsEstimate;
        analysis.reportDate = earning.date;
        analysis.reportTime = earning.time;
        analysis.analystRatings = ratings;
        analysis.insiderActivity = insider;
        analysis.riskScore = scoreRisk(analysis);
        analysis.riskLabel = getRiskLabel(analysis.riskScore);
        analysis.foundAt = new Date().toISOString();
        analysis.isEarningsPlay = true;
        analysis.type = analysis.action;

        if (analysis.riskScore >= 70) {
          log('RISK', '🛡️ Earnings signal for '+ticker+' blocked — risk score '+analysis.riskScore, {ticker, riskScore: analysis.riskScore});
          continue;
        }

        // Store as catalyst signal — will execute at next trade check when market opens
        const existing = catalystSignals.findIndex(s => s.ticker === ticker);
        if (existing >= 0) catalystSignals[existing] = analysis;
        else catalystSignals.push(analysis);
        updateWatchlists(analysis);

        dbUpsert('active_signals', {ticker, signal:analysis.signal, type:analysis.type, signal_score:analysis.signalScore, confidence:analysis.confidence, catalyst:analysis.catalyst, detail:analysis.detail, thesis:analysis.thesis, target_price:analysis.targetPrice||null, stop_loss:analysis.stopLoss||null, expected_return:analysis.expectedReturn, risk_score:analysis.riskScore, is_crypto:false, found_at:analysis.foundAt, updated_at:new Date().toISOString()}).catch(()=>{});

        // Save to earnings_calendar table
        dbInsert('earnings_calendar', {ticker, report_date:earning.date, report_time:earning.time, eps_estimate:earning.epsEstimate, revenue_estimate:earning.revenueEstimate||null}).catch(()=>{});

        const emoji = analysis.action === 'LONG' ? '🔺' : '🔻';
        log('CATALYST', emoji+' EARNINGS PRE-POSITION: '+ticker+' ['+analysis.action+'] Report: '+earning.date+' ('+earning.time+') | '+analysis.thesis, {
          ticker, signal:analysis.signal, signalScore:analysis.signalScore, confidence:analysis.confidence,
          thesis:analysis.thesis, catalyst:analysis.catalyst, epsEstimate:earning.epsEstimate,
          analystConsensus: ratings?.consensus, insiderActivity: insider?.netActivity,
          riskScore: analysis.riskScore,
        });

        await new Promise(r => setTimeout(r, 3000));
      } catch(e) { log('ERROR', 'Earnings analysis failed for '+earning.ticker+': '+e.message); }
    }

    log('CATALYST', '✅ Earnings pre-positioning complete — signals queued for market open');
  } catch(e) { log('ERROR', 'Earnings scan failed: '+e.message); }
  state.status = 'IDLE';
}

// ── REAL DATA ENHANCED CATALYST SCAN ─────────────────────────────
// Runs alongside the main catalyst scan but enriches with Finnhub real data
async function enrichSignalWithRealData(signal) {
  if (!FINNHUB_KEY || !signal.ticker) return signal;
  try {
    const [eps, ratings, insider] = await Promise.all([
      getEPSSurprise(signal.ticker),
      getAnalystRatings(signal.ticker),
      getInsiderActivity(signal.ticker),
    ]);

    if (eps) {
      signal.realEPS = eps;
      // Boost score if real EPS confirms the signal direction
      if (signal.signal === 'BUY' && eps.strongBeat) {
        signal.signalScore = Math.min(99, (signal.signalScore||70) + 8);
        signal.detail = (signal.detail||'') + ` Real EPS: $${eps.epsActual} vs est $${eps.epsEstimate} (${eps.surprisePct>0?'+':''}${eps.surprisePct}%).`;
      } else if (signal.signal === 'SHORT' && eps.strongMiss) {
        signal.signalScore = Math.min(99, (signal.signalScore||70) + 8);
        signal.detail = (signal.detail||'') + ` Real EPS: $${eps.epsActual} vs est $${eps.epsEstimate} (${eps.surprisePct}% miss).`;
      }
    }

    if (ratings) {
      signal.analystRatings = ratings;
      // Boost confidence if analyst consensus matches signal
      if (signal.signal === 'BUY' && ratings.consensus === 'BUY') {
        signal.confidence = Math.min(99, (signal.confidence||70) + 5);
      } else if (signal.signal === 'SHORT' && ratings.consensus === 'SELL') {
        signal.confidence = Math.min(99, (signal.confidence||70) + 5);
      }
    }

    if (insider) {
      signal.insiderActivity = insider;
      if (signal.signal === 'BUY' && insider.netActivity === 'NET_BUYING') {
        signal.signalScore = Math.min(99, (signal.signalScore||70) + 5);
      }
    }

    // Recalculate risk with enriched data
    signal.riskScore = scoreRisk(signal);
    signal.riskLabel = getRiskLabel(signal.riskScore);
    signal.dataEnriched = true;

    log('CATALYST', '📊 Enriched '+signal.ticker+' with real data: EPS '+(eps?eps.surprisePct+'%':'N/A')+' | Analyst: '+(ratings?.consensus||'N/A')+' | Insider: '+(insider?.netActivity||'N/A'), {ticker:signal.ticker});
  } catch(e) { log('ERROR', 'Signal enrichment failed for '+signal.ticker+': '+e.message); }
  return signal;
}

// ── SCHEDULER ─────────────────────────────────────────────────────
function getETTime() {
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const hhmm=et.getHours().toString().padStart(2,'0')+':'+et.getMinutes().toString().padStart(2,'0');
  const day=et.getDay(),total=et.getHours()*60+et.getMinutes();
  return{hhmm,isMarket:day>=1&&day<=5&&total>=9*60+30&&total<=16*60};
}
function minsSince(iso){return iso?(Date.now()-new Date(iso).getTime())/60000:9999;}

async function scheduler() {
  if(!['IDLE','MARKET_CLOSED'].includes(state.status)) return;
  const{hhmm,isMarket}=getETTime();
  if(hhmm==='09:00'){await runMorningBriefing();return;}
  if(hhmm==='15:30'){await runPreCloseBriefing();return;}
  if(hhmm==='18:00'){await runEarningsPrePositioning();return;}
  if(minsSince(state.lastCrypto)>=CRYPTO_INTERVAL){await runCryptoScan();return;}
  if(minsSince(state.lastInfluencer)>=INFLUENCER_INTERVAL){await runInfluencerScan();return;}
  if(isMarket){
    state.isMarketOpen=true;
    if(minsSince(state.lastCatalyst)>=CATALYST_INTERVAL) await runCatalystScan();
    else if(minsSince(state.lastTradeCheck)>=TRADE_CHECK_MINS) await runTradeCheck();
  }else{
    state.isMarketOpen=false;state.status='MARKET_CLOSED';
    if(cryptoSignals.length>0&&minsSince(state.lastTradeCheck)>=TRADE_CHECK_MINS) await runTradeCheck();
  }
}

setInterval(scheduler,5*60*1000);
log('AGENT','🤖 Agent v4 — Morning briefing | Multi-agent | Conviction | Trade DNA | Supabase memory');

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/alpaca',async(req,res)=>{
  const base=req.headers['x-alpaca-mode']==='live'?'https://api.alpaca.markets':ALPACA_BASE;
  try{const r=await fetch(base+req.url,{method:req.method,headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET,'Content-Type':'application/json'},body:['GET','HEAD'].includes(req.method)?undefined:JSON.stringify(req.body)});res.status(r.status).json(await r.json());}
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/status',(req,res)=>res.json({...state,pendingCount:pendingQueue.length,activeSignals:catalystSignals.length+cryptoSignals.length,stockSignals:catalystSignals.length,cryptoSignalCount:cryptoSignals.length,influencerAlertCount:influencerAlerts.length,dbConnected:!!DB}));
app.get('/log',(req,res)=>res.json(decisionLog.slice(0,100)));
app.get('/pending',(req,res)=>res.json(pendingQueue));
app.get('/signals',(req,res)=>res.json([...catalystSignals,...cryptoSignals]));
app.get('/influencers',(req,res)=>res.json(influencerAlerts.slice(0,20)));
app.get('/watchlists',(req,res)=>res.json(watchlists));
app.get('/briefing',(req,res)=>res.json(morningBriefing||{message:'No briefing yet. Runs at 9am ET.'}));
app.get('/tradedna',(req,res)=>res.json({summary:getTradeDNASummary(),trades:tradeDNA.slice(-50),totalTrades:tradeDNA.length,winRate:tradeDNA.length>0?Math.round(tradeDNA.filter(t=>t.profitable).length/tradeDNA.length*100):0}));
app.get('/health',(req,res)=>res.json({ok:true,uptime:process.uptime(),dbConnected:!!DB}));
app.post('/scan-now',(req,res)=>{res.json({message:'Catalyst scan triggered'});runCatalystScan();});
app.post('/earnings-now',(req,res)=>{res.json({message:'Earnings scan triggered'});runEarningsPrePositioning();});
app.get('/earnings',(req,res)=>dbSelect('earnings_calendar','order=report_date.asc&limit=20').then(d=>res.json(d||[])).catch(()=>res.json([])));
app.post('/crypto-now',(req,res)=>{res.json({message:'Crypto scan triggered'});runCryptoScan();});
app.post('/intel-now',(req,res)=>{res.json({message:'Morning briefing triggered'});runMorningBriefing();});
app.post('/influencer-now',(req,res)=>{res.json({message:'Influencer scan triggered'});runInfluencerScan();});
app.post('/trade-now',(req,res)=>{res.json({message:'Trade check triggered'});runTradeCheck();});
app.post('/clear-queue',(req,res)=>{const n=pendingQueue.length;pendingQueue=[];dbDelete('pending_queue','ticker=neq.null').catch(()=>{});log('AGENT','🗑 Queue cleared ('+n+' removed)');res.json({cleared:n});});
app.use(express.static(__dirname));

app.listen(3001,()=>{
  log('AGENT','🤖 Market Intelligence Agent v4 running on port 3001');
  initFromDB().then(()=>{
    setTimeout(runCryptoScan,20000);
    setTimeout(runInfluencerScan,50000);
    setTimeout(runCatalystScan,100000);
  }).catch(()=>{
    setTimeout(runCryptoScan,20000);
    setTimeout(runInfluencerScan,50000);
    setTimeout(runCatalystScan,100000);
  });
});
