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
let upcomingEarnings = []; // In-memory earnings calendar
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
  days = days || 7; // Extended to 7 days for more results
  if (!FINNHUB_KEY) {
    log('ERROR', 'Earnings scan failed: FINNHUB_KEY not set in environment variables');
    return [];
  }
  const today = new Date();
  const future = new Date(today);
  future.setDate(future.getDate() + days);
  const from = today.toISOString().split('T')[0];
  const to = future.toISOString().split('T')[0];
  log('CATALYST', '📅 Fetching earnings from Finnhub: '+from+' to '+to);
  const data = await finnhub(`/calendar/earnings?from=${from}&to=${to}`);
  if (!data) {
    log('ERROR', 'Finnhub earnings returned null — check FINNHUB_KEY in Render environment');
    return [];
  }
  if (!data.earningsCalendar) {
    log('ERROR', 'Finnhub earnings: unexpected response — '+JSON.stringify(data).substring(0,100));
    return [];
  }
  // Include ALL earnings regardless of whether estimate exists
  const results = data.earningsCalendar
    .filter(e => e.symbol)
    .map(e => ({
      ticker: e.symbol,
      date: e.date,
      time: e.hour || 'unknown',
      epsEstimate: e.epsEstimate || null,   // null is fine — show it anyway
      revenueEstimate: e.revenueEstimate || null,
    }));
  log('CATALYST', '📅 Finnhub returned '+data.earningsCalendar.length+' total, '+results.length+' valid earnings');
  return results;
}

// ── HISTORICAL EARNINGS ANALYSIS ─────────────────────────────────
// Fetches past earnings results + calculates stock move after each
// This is the data that tells agents what ACTUALLY happens after earnings

async function getHistoricalEarningsImpact(ticker) {
  try {
    // Get last 8 quarters of earnings from Finnhub
    const earningsHistory = await finnhub(`/stock/earnings?symbol=${ticker}&limit=8`);
    if (!earningsHistory || !earningsHistory.length) return null;

    const results = [];

    for (const e of earningsHistory) {
      if (!e.period || (!e.actual && e.actual !== 0)) continue;

      const surprise = e.estimate
        ? parseFloat(((e.actual - e.estimate) / Math.abs(e.estimate) * 100).toFixed(2))
        : null;
      const beat = surprise !== null ? surprise > 0 : null;

      // Fetch price move around earnings date using Alpaca
      let priceMove1d = null, priceMove5d = null;
      try {
        const earningsDate = new Date(e.period);
        const dayBefore = new Date(earningsDate);
        dayBefore.setDate(dayBefore.getDate() - 2);
        const dayAfter = new Date(earningsDate);
        dayAfter.setDate(dayAfter.getDate() + 6);

        const bars = await fetch(
          `${ALPACA_DATA}/v2/stocks/${ticker}/bars?timeframe=1Day` +
          `&start=${dayBefore.toISOString().split('T')[0]}` +
          `&end=${dayAfter.toISOString().split('T')[0]}&limit=10`,
          { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
        ).then(r => r.json());

        if (bars.bars && bars.bars.length >= 2) {
          const close0 = bars.bars[0].c; // day before
          if (bars.bars[1]) priceMove1d = parseFloat(((bars.bars[1].c - close0) / close0 * 100).toFixed(2));
          if (bars.bars[5]) priceMove5d = parseFloat(((bars.bars[5].c - close0) / close0 * 100).toFixed(2));
        }
      } catch(e) {}

      results.push({
        period: e.period,
        epsActual: e.actual,
        epsEstimate: e.estimate,
        surprisePct: surprise,
        beat,
        priceMove1d,
        priceMove5d,
      });
    }

    if (!results.length) return null;

    // Calculate averages
    const beats = results.filter(r => r.beat === true && r.priceMove1d !== null);
    const misses = results.filter(r => r.beat === false && r.priceMove1d !== null);
    const all = results.filter(r => r.priceMove1d !== null);

    const avgMoveAll   = all.length   ? parseFloat((all.reduce((s,r)=>s+r.priceMove1d,0)/all.length).toFixed(2))   : null;
    const avgMoveBeat  = beats.length  ? parseFloat((beats.reduce((s,r)=>s+r.priceMove1d,0)/beats.length).toFixed(2))  : null;
    const avgMoveMiss  = misses.length ? parseFloat((misses.reduce((s,r)=>s+r.priceMove1d,0)/misses.length).toFixed(2)) : null;
    const beatRate     = results.filter(r=>r.beat===true).length;

    return {
      ticker,
      quartersAnalysed: results.length,
      beatRate: results.length ? Math.round(beatRate/results.length*100) : null,
      avgMoveAfterBeat: avgMoveBeat,
      avgMoveAfterMiss: avgMoveMiss,
      avgMoveAll,
      recentQuarters: results.slice(0, 4), // Last 4 quarters
      summary: `${ticker}: Beat rate ${beatRate}/${results.length} quarters. `+
        `After beat: avg ${avgMoveBeat>=0?'+':''}${avgMoveBeat}% next day. `+
        `After miss: avg ${avgMoveMiss>=0?'+':''}${avgMoveMiss}% next day.`,
    };
  } catch(e) {
    return null;
  }
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

// ── TECHNICAL ANALYSIS ENGINE ────────────────────────────────────
// Fetches 365 days of price history from Alpaca and calculates
// all standard technical indicators. Free — uses existing Alpaca connection.

async function fetchPriceBars(ticker, days) {
  days = days || 365;
  try {
    const isCrypto = ticker.includes('/');
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startStr = start.toISOString().split('T')[0];

    if (isCrypto) {
      const sym = encodeURIComponent(ticker);
      const r = await fetch(
        `${ALPACA_DATA}/v1beta3/crypto/us/bars?symbols=${sym}&timeframe=1Day&start=${startStr}&limit=365`,
        { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
      );
      const d = await r.json();
      const bars = d.bars && d.bars[ticker];
      return Array.isArray(bars) ? bars : [];
    } else {
      const r = await fetch(
        `${ALPACA_DATA}/v2/stocks/${ticker}/bars?timeframe=1Day&start=${startStr}&adjustment=raw&limit=365`,
        { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
      );
      const d = await r.json();
      return Array.isArray(d.bars) ? d.bars : [];
    }
  } catch(e) {
    log('ERROR', 'Failed to fetch price bars for '+ticker+': '+e.message);
    return [];
  }
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i] - recent[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcSupportResistance(bars, lookback) {
  lookback = lookback || 90; // Last 90 days for key levels
  const recent = bars.slice(-lookback);
  const highs = recent.map(b => b.h);
  const lows  = recent.map(b => b.l);

  // Find local maxima and minima
  const resistanceLevels = [], supportLevels = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      resistanceLevels.push(highs[i]);
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      supportLevels.push(lows[i]);
    }
  }

  const currentPrice = bars[bars.length - 1].c;

  // Find nearest support below and resistance above current price
  const supports = supportLevels.filter(l => l < currentPrice).sort((a,b) => b - a);
  const resistances = resistanceLevels.filter(l => l > currentPrice).sort((a,b) => a - b);

  return {
    nearestSupport: supports[0] ? parseFloat(supports[0].toFixed(2)) : null,
    nearestResistance: resistances[0] ? parseFloat(resistances[0].toFixed(2)) : null,
    supportLevels: supports.slice(0, 3).map(l => parseFloat(l.toFixed(2))),
    resistanceLevels: resistances.slice(0, 3).map(l => parseFloat(l.toFixed(2))),
  };
}

function detectTrend(bars, closes) {
  // Higher highs and higher lows = uptrend, vice versa
  const recent20  = bars.slice(-20);
  const recent50  = bars.slice(-50);
  const recent200 = bars.slice(-200);

  const sma20  = calcSMA(closes, 20);
  const sma50  = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const current = closes[closes.length - 1];

  // Trend strength: how many SMAs is price above?
  let aboveSMAs = 0;
  if (sma20  && current > sma20)  aboveSMAs++;
  if (sma50  && current > sma50)  aboveSMAs++;
  if (sma200 && current > sma200) aboveSMAs++;

  // Check SMA alignment (bullish = 20 > 50 > 200)
  const smaAligned = sma20 && sma50 && sma200 && sma20 > sma50 && sma50 > sma200;

  // Recent momentum: price change over last 20 days
  const momentum20d = recent20.length >= 2
    ? ((recent20[recent20.length-1].c - recent20[0].c) / recent20[0].c * 100)
    : 0;

  let trend, trendStrength;
  if (aboveSMAs === 3 && smaAligned && momentum20d > 2) {
    trend = 'STRONG UPTREND'; trendStrength = 90;
  } else if (aboveSMAs >= 2 && momentum20d > 0) {
    trend = 'UPTREND'; trendStrength = 70;
  } else if (aboveSMAs === 0 && !smaAligned && momentum20d < -2) {
    trend = 'STRONG DOWNTREND'; trendStrength = 10;
  } else if (aboveSMAs <= 1 && momentum20d < 0) {
    trend = 'DOWNTREND'; trendStrength = 30;
  } else {
    trend = 'SIDEWAYS'; trendStrength = 50;
  }

  return { trend, trendStrength, aboveSMAs, smaAligned, momentum20d: parseFloat(momentum20d.toFixed(2)) };
}

function detectBreakout(bars, closes, resistance) {
  if (!resistance || bars.length < 5) return { isBreakout: false };
  const current = closes[closes.length - 1];
  const prev5Closes = closes.slice(-6, -1);
  const avgPrev = prev5Closes.reduce((s,v)=>s+v,0)/prev5Closes.length;

  // Breakout: today's close above resistance, previous closes were below
  const isBreakout = current > resistance && avgPrev < resistance;
  const breakoutStrength = isBreakout
    ? parseFloat(((current - resistance) / resistance * 100).toFixed(2))
    : 0;

  return { isBreakout, breakoutStrength };
}

// Master function: fetch 365 days and calculate everything
async function getTechnicalAnalysis(ticker) {
  const bars = await fetchPriceBars(ticker, 365);
  if (!bars || bars.length < 20) {
    return { available: false, reason: 'Insufficient price history' };
  }

  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const current = closes[closes.length - 1];

  // Core calculations
  const sma20  = calcSMA(closes, 20);
  const sma50  = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const ema12  = calcEMA(closes, 12);
  const ema26  = calcEMA(closes, 26);
  const rsi    = calcRSI(closes, 14);
  const { nearestSupport, nearestResistance, supportLevels, resistanceLevels } = calcSupportResistance(bars, 90);
  const { trend, trendStrength, aboveSMAs, smaAligned, momentum20d } = detectTrend(bars, closes);

  // 52-week metrics
  const year52High = Math.max(...closes.slice(-252));
  const year52Low  = Math.min(...closes.slice(-252));
  const week52Position = year52High > year52Low
    ? parseFloat(((current - year52Low) / (year52High - year52Low) * 100).toFixed(1))
    : 50;

  // Volume analysis
  const avgVolume30d = volumes.slice(-30).reduce((s,v)=>s+v,0) / 30;
  const todayVolume  = volumes[volumes.length - 1];
  const relativeVolume = avgVolume30d > 0
    ? parseFloat((todayVolume / avgVolume30d).toFixed(2))
    : 1;

  // Breakout detection
  const { isBreakout, breakoutStrength } = detectBreakout(bars, closes, nearestResistance);

  // RSI interpretation
  let rsiLabel = 'Neutral';
  if (rsi >= 70) rsiLabel = 'Overbought — caution';
  else if (rsi >= 60) rsiLabel = 'Bullish momentum';
  else if (rsi <= 30) rsiLabel = 'Oversold — potential reversal';
  else if (rsi <= 40) rsiLabel = 'Bearish momentum';

  // MACD signal
  const macdLine = ema12 && ema26 ? ema12 - ema26 : null;
  const macdSignal = macdLine !== null ? (macdLine > 0 ? 'Bullish' : 'Bearish') : null;

  // Distance from key SMAs (%)
  const distFrom50  = sma50  ? parseFloat(((current-sma50)/sma50*100).toFixed(2))  : null;
  const distFrom200 = sma200 ? parseFloat(((current-sma200)/sma200*100).toFixed(2)) : null;

  // Composite technical score (0-100)
  let techScore = 50;
  // Trend component (0-30 pts)
  techScore += (trendStrength - 50) * 0.3;
  // RSI component (-15 to +15 pts)
  if (rsi) {
    if (rsi >= 30 && rsi <= 60) techScore += 10;       // Healthy zone
    else if (rsi > 60 && rsi < 70) techScore += 5;    // Strong but watch
    else if (rsi >= 70) techScore -= 10;               // Overbought penalty
    else if (rsi < 30) techScore += 15;               // Oversold bounce potential
  }
  // Volume confirmation (+10 if above average)
  if (relativeVolume > 1.5) techScore += 10;
  else if (relativeVolume > 1.2) techScore += 5;
  // Breakout bonus (+10)
  if (isBreakout) techScore += 10;
  // Above all SMAs (+10)
  if (aboveSMAs === 3) techScore += 8;
  else if (aboveSMAs === 2) techScore += 4;
  else if (aboveSMAs === 0) techScore -= 8;
  // 52-week position
  if (week52Position >= 80) techScore += 5;  // Near highs = strength
  else if (week52Position <= 20) techScore -= 5;

  techScore = Math.round(Math.min(99, Math.max(1, techScore)));

  return {
    available: true,
    ticker,
    barsAnalysed: bars.length,
    current: parseFloat(current.toFixed(2)),

    // Moving averages
    sma20:  sma20  ? parseFloat(sma20.toFixed(2))  : null,
    sma50:  sma50  ? parseFloat(sma50.toFixed(2))  : null,
    sma200: sma200 ? parseFloat(sma200.toFixed(2)) : null,
    aboveSMA20:  sma20  ? current > sma20  : null,
    aboveSMA50:  sma50  ? current > sma50  : null,
    aboveSMA200: sma200 ? current > sma200 : null,
    distFrom50, distFrom200,

    // Momentum
    rsi, rsiLabel,
    macdSignal,
    momentum20d,

    // Trend
    trend, trendStrength, smaAligned,

    // Levels
    nearestSupport, nearestResistance,
    supportLevels, resistanceLevels,
    isBreakout, breakoutStrength,

    // 52-week
    year52High: parseFloat(year52High.toFixed(2)),
    year52Low:  parseFloat(year52Low.toFixed(2)),
    week52Position,

    // Volume
    avgVolume30d: Math.round(avgVolume30d),
    relativeVolume,

    // Summary score
    technicalScore: techScore,

    // Summary for Claude agents
    summary: `Trend: ${trend}. RSI: ${rsi} (${rsiLabel}). Price vs SMAs: above ${aboveSMAs}/3. ` +
      `52wk position: ${week52Position}% (High: $${year52High}, Low: $${year52Low}). ` +
      `Support: $${nearestSupport||'—'}, Resistance: $${nearestResistance||'—'}. ` +
      `Vol: ${relativeVolume}x avg. ${isBreakout?'⚡ BREAKOUT above $'+nearestResistance+'!':''} ` +
      `Technical score: ${techScore}/100.`,
  };
}

// ── AI CIO REPORT ENGINE ─────────────────────────────────────────
// Generates a real-time portfolio assessment and action plan
// Runs after morning briefing and on-demand. Cheap: no web search.

let cioReport = null;

async function generateCIOReport() {
  try {
    const [positions, account] = await Promise.all([
      alpaca('/v2/positions'),
      alpaca('/v2/account'),
    ]);

    const portfolioValue = parseFloat(account.portfolio_value || 100000);
    const startValue = 100000;
    const totalReturn = ((portfolioValue - startValue) / startValue * 100).toFixed(2);
    const concentration = await analyzePortfolioConcentration();
    const rankings = rankOpportunities();
    const analytics = getPerformanceAnalytics();
    const regime = currentRegime;
    const openCount = Array.isArray(positions) ? positions.length : 0;

    // ── Portfolio Score (0-100) ──
    let score = 65;
    // Regime bonus/penalty
    if (['BULL','RISK_ON'].includes(regime.regime)) score += 8;
    else if (['BEAR','RISK_OFF'].includes(regime.regime)) score -= 12;
    // Diversification
    if (concentration.hasPositions) {
      if (concentration.concentrationScore < 20) score += 10;
      else if (concentration.concentrationScore >= 50) score -= 20;
      else if (concentration.concentrationScore >= 35) score -= 10;
    } else { score += 5; } // No positions = no concentration risk
    // Performance
    if (analytics) {
      if (analytics.winRate >= 65) score += 10;
      else if (analytics.winRate >= 50) score += 5;
      else if (analytics.winRate < 40) score -= 10;
    }
    // Position count
    if (openCount > 10) score -= 5;
    else if (openCount >= 5 && openCount <= 8) score += 3;
    // Return
    const ret = parseFloat(totalReturn);
    if (ret > 5) score += 8;
    else if (ret > 0) score += 3;
    else if (ret < -5) score -= 10;

    score = Math.min(99, Math.max(10, Math.round(score)));
    const riskLevel = score >= 75 ? 'LOW' : score >= 55 ? 'MODERATE' : 'HIGH';

    // ── Biggest Risk ──
    let biggestRisk = 'No significant concentration risk';
    if (concentration.hasPositions && concentration.sectors && concentration.sectors.length > 0) {
      const top = concentration.sectors[0];
      if (top.pct >= 40) biggestRisk = top.name + ' at ' + top.pct + '% of portfolio — dangerously concentrated';
      else if (top.pct >= 25) biggestRisk = top.name + ' concentration at ' + top.pct + '%';
    }
    if (['BEAR','RISK_OFF'].includes(regime.regime) && openCount > 5) {
      biggestRisk = 'Market in ' + regime.label + ' with ' + openCount + ' open positions — consider reducing exposure';
    }

    // ── Best Opportunity ──
    const topSignal = rankings[0];
    const bestOpp = topSignal
      ? { ticker: topSignal.ticker, score: topSignal.rankScore, signal: topSignal.signal, catalyst: topSignal.catalyst }
      : null;

    // ── Generate recommendations (cheap Claude call, no web search) ──
    let recommendations = [];
    let analysis = '';

    const positionSummary = Array.isArray(positions) && positions.length
      ? positions.map(p => {
          const pnl = (parseFloat(p.unrealized_plpc)*100).toFixed(1);
          return p.symbol + '(' + pnl + '%)';
        }).join(', ')
      : 'No open positions';

    const sectorSummary = concentration.hasPositions && concentration.sectors
      ? concentration.sectors.map(s => s.name + ':' + s.pct + '%').join(', ')
      : 'No positions';

    const prompt = `You are an AI Chief Investment Officer. Assess this portfolio and give specific actions.
Positions: ${positionSummary}
Sector exposure: ${sectorSummary}
Market regime: ${regime.label}
Portfolio score: ${score}/100
Risk level: ${riskLevel}
Best signal available: ${bestOpp ? bestOpp.ticker + ' (' + bestOpp.catalyst + ')' : 'None'}
Performance: ${analytics ? analytics.winRate + '% win rate, ' + analytics.totalTrades + ' trades' : 'No history'}
Provide 2-3 specific, actionable recommendations (max 90 chars each).
Return ONLY JSON: {"recommendations":["Specific action 1","Specific action 2","Specific action 3"],"analysis":"One clear sentence on portfolio health"}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 250,
          system: prompt + '\n\nReturn ONLY valid JSON.',
          messages: [{ role: 'user', content: 'Portfolio assessment' }]
        })
      });
      const d = await r.json();
      const text = d.content.map(b => b.type==='text'?b.text:'').join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const res = JSON.parse(match[0]);
        recommendations = res.recommendations || [];
        analysis = res.analysis || '';
      }
    } catch(e) {
      recommendations = [
        regime.riskMultiplier < 1 ? 'Reduce position sizes — current regime suggests caution' : 'Regime is '+regime.label+' — maintain current strategy',
        bestOpp ? 'Top opportunity: '+bestOpp.ticker+' with rank score '+bestOpp.score : 'Run a scan to find new opportunities',
      ];
    }

    cioReport = {
      portfolioScore: score,
      portfolioRisk: riskLevel,
      regime: regime.label,
      regimeType: regime.regime,
      biggestRisk,
      bestOpportunity: bestOpp,
      recommendations,
      analysis,
      portfolioValue,
      totalReturnPct: parseFloat(totalReturn),
      openPositions: openCount,
      generatedAt: new Date().toISOString(),
    };

    log('INTEL', '🎯 CIO Report: Score '+score+'/100 | '+riskLevel+' risk | '+regime.label+' | '+analysis, {
      portfolioScore: score, portfolioRisk: riskLevel
    });
    return cioReport;
  } catch(e) {
    log('ERROR', 'CIO report failed: '+e.message);
    return null;
  }
}

// ── MARKET REGIME ENGINE ─────────────────────────────────────────
// Detects current market regime from real data: VIX, SPY trend,
// sector rotation, momentum. Adjusts all trading behaviour accordingly.

let currentRegime = {
  regime: 'UNKNOWN',
  label: 'Determining...',
  riskMultiplier: 1.0,    // Multiply position sizes
  stopMultiplier: 1.0,    // Multiply stop loss distances
  holdMultiplier: 1.0,    // Multiply target holds
  lastUpdated: null,
};

async function detectMarketRegime() {
  try {
    // Fetch SPY, QQQ, VIX bars from Alpaca (free — already connected)
    const [spyBars, vixBars] = await Promise.all([
      fetchPriceBars('SPY', 60),
      fetchPriceBars('VIXY', 60), // VIX proxy ETF
    ]);

    if (!spyBars || spyBars.length < 20) {
      log('REGIME', '⚠️ Insufficient data for regime detection');
      return currentRegime;
    }

    const spyCloses  = spyBars.map(b => b.c);
    const spyCurrent = spyCloses[spyCloses.length - 1];
    const spySMA20   = calcSMA(spyCloses, 20);
    const spySMA50   = calcSMA(spyCloses, 50);
    const spyRSI     = calcRSI(spyCloses, 14);
    const spy20dChg  = spyCloses.length >= 20
      ? (spyCurrent - spyCloses[spyCloses.length - 20]) / spyCloses[spyCloses.length - 20] * 100
      : 0;
    const spy5dChg   = spyCloses.length >= 5
      ? (spyCurrent - spyCloses[spyCloses.length - 5]) / spyCloses[spyCloses.length - 5] * 100
      : 0;

    // VIX level (use VIXY as proxy, or default to moderate)
    let vixLevel = 20; // Default moderate
    if (vixBars && vixBars.length > 0) {
      const vixCloses = vixBars.map(b => b.c);
      vixLevel = vixCloses[vixCloses.length - 1] * 10; // VIXY ~= VIX/10
    }

    // Trend strength indicators
    const aboveSMA20 = spySMA20 && spyCurrent > spySMA20;
    const aboveSMA50 = spySMA50 && spyCurrent > spySMA50;
    const bullishMomentum = spy20dChg > 3;
    const bearishMomentum = spy20dChg < -3;
    const highVol = vixLevel > 25;
    const extremeVol = vixLevel > 35;
    const lowVol = vixLevel < 15;

    // Classify regime
    let regime, label, riskMult, stopMult, holdMult, description;

    if (extremeVol || (bearishMomentum && !aboveSMA20 && !aboveSMA50)) {
      regime = 'BEAR';
      label = 'Bear Market / High Fear';
      riskMult = 0.4;  // 40% position sizes
      stopMult = 0.7;  // Tighter stops
      holdMult = 0.6;
      description = 'High volatility, downtrend. Reduce exposure significantly. Favour shorts and defensive positions.';
    } else if (highVol && bearishMomentum) {
      regime = 'RISK_OFF';
      label = 'Risk-Off / Elevated Fear';
      riskMult = 0.6;
      stopMult = 0.8;
      holdMult = 0.7;
      description = 'Elevated volatility, negative momentum. Reduce position sizes, tighter stops, prefer quality.';
    } else if (!aboveSMA20 && spy20dChg < 0) {
      regime = 'CORRECTION';
      label = 'Market Correction';
      riskMult = 0.75;
      stopMult = 0.85;
      holdMult = 0.8;
      description = 'Below key moving averages. Cautious positioning. Wait for confirmation before entering longs.';
    } else if (aboveSMA20 && aboveSMA50 && !bullishMomentum && !highVol) {
      regime = 'SIDEWAYS';
      label = 'Sideways / Consolidation';
      riskMult = 0.85;
      stopMult = 1.0;
      holdMult = 0.9;
      description = 'Range-bound market. Standard positioning. Favour mean-reversion plays over momentum.';
    } else if (aboveSMA20 && aboveSMA50 && bullishMomentum && !highVol) {
      regime = 'RISK_ON';
      label = 'Risk-On / Bull Trend';
      riskMult = 1.1;
      stopMult = 1.1;  // Slightly wider stops — give winners room
      holdMult = 1.2;
      description = 'Strong uptrend, low volatility. Increase exposure. Favour momentum and growth.';
    } else if (aboveSMA20 && aboveSMA50 && bullishMomentum && lowVol && spy20dChg > 6) {
      regime = 'BULL';
      label = 'Bull Market / Strong Trend';
      riskMult = 1.25;
      stopMult = 1.2;
      holdMult = 1.5;
      description = 'Strong bull trend, low volatility. Maximum exposure. Let winners run.';
    } else {
      regime = 'NEUTRAL';
      label = 'Neutral / Mixed Signals';
      riskMult = 1.0;
      stopMult = 1.0;
      holdMult = 1.0;
      description = 'Mixed signals. Standard positioning. Follow individual signal quality.';
    }

    currentRegime = {
      regime, label, riskMultiplier: riskMult,
      stopMultiplier: stopMult, holdMultiplier: holdMult,
      description, lastUpdated: new Date().toISOString(),
      metrics: {
        spyPrice: parseFloat(spyCurrent.toFixed(2)),
        spy20dChange: parseFloat(spy20dChg.toFixed(2)),
        spy5dChange: parseFloat(spy5dChg.toFixed(2)),
        spyRSI: spyRSI,
        aboveSMA20, aboveSMA50,
        estimatedVix: parseFloat(vixLevel.toFixed(1)),
      },
    };

    log('REGIME', '🌍 Market Regime: '+label+' | Risk multiplier: '+riskMult+'x | '+description, {
      regime, riskMultiplier: riskMult,
      spy20dChange: spy20dChg.toFixed(2)+'%',
      aboveSMA20, aboveSMA50,
    });

    return currentRegime;
  } catch(e) {
    log('ERROR', 'Regime detection failed: '+e.message);
    return currentRegime;
  }
}

// Apply regime to position sizing
function regimeAdjustedDollars(baseDollars) {
  return baseDollars * currentRegime.riskMultiplier;
}

// ── OPPORTUNITY RANKING ENGINE ────────────────────────────────────
// Ranks all active signals by a composite conviction score
function rankOpportunities() {
  const allSignals = [...catalystSignals, ...cryptoSignals.map(s=>({...s,ticker:s.symbol}))];
  if (!allSignals.length) return [];

  return allSignals
    .map(signal => {
      const conv = signal.conviction || {};
      const tech = signal.technicalAnalysis || {};
      const hs   = conv.historicalSimilarity || {};

      // Composite rank score (0-100)
      let rankScore = 0;
      // Signal score (30%)
      rankScore += (signal.signalScore || 0) * 0.30;
      // Probability from conviction (25%)
      rankScore += (conv.probability || 50) * 0.25;
      // Agent consensus (20%)
      rankScore += (conv.agentConsensus || 50) * 0.20;
      // Technical score (15%)
      rankScore += (tech.technicalScore || 50) * 0.15;
      // Historical win rate (10%)
      rankScore += (hs.hasSimilarity ? hs.winRate : 50) * 0.10;
      // Regime adjustment
      rankScore *= currentRegime.riskMultiplier;
      // Risk penalty
      rankScore -= (signal.riskScore || 0) * 0.15;

      return {
        ...signal,
        rankScore: Math.round(Math.min(99, Math.max(1, rankScore))),
        conviction: conv,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map((signal, idx) => ({ ...signal, rank: idx + 1 }));
}

// ── PORTFOLIO CONCENTRATION ANALYZER ─────────────────────────────
// Detects sector concentration, correlation risk, over-exposure
const SECTOR_MAP = {
  // Tech
  NVDA:'AI/Tech', AMD:'AI/Tech', MSFT:'AI/Tech', AAPL:'AI/Tech', GOOGL:'AI/Tech',
  META:'AI/Tech', AMZN:'AI/Tech', CRM:'AI/Tech', ORCL:'AI/Tech', SMCI:'AI/Tech',
  // Finance
  JPM:'Financials', BAC:'Financials', GS:'Financials', MS:'Financials', WFC:'Financials',
  // Energy
  XOM:'Energy', CVX:'Energy', SLB:'Energy', COP:'Energy',
  // Healthcare
  JNJ:'Healthcare', PFE:'Healthcare', UNH:'Healthcare', ABBV:'Healthcare',
  // Crypto
  'BTC/USD':'Crypto', 'ETH/USD':'Crypto', 'SOL/USD':'Crypto', 'AVAX/USD':'Crypto',
  'LINK/USD':'Crypto', 'DOGE/USD':'Crypto',
  // Industrials
  BA:'Industrials', CAT:'Industrials', GE:'Industrials', LMT:'Industrials',
  // Consumer
  WMT:'Consumer', COST:'Consumer', TGT:'Consumer', AMZN:'Consumer',
};

async function analyzePortfolioConcentration() {
  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions) || !positions.length) {
      return { hasPositions: false, message: 'No open positions' };
    }

    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);

    // Calculate sector exposure
    const sectorExposure = {};
    let totalInvested = 0;

    positions.forEach(p => {
      const mv = Math.abs(parseFloat(p.market_value || 0));
      const sector = SECTOR_MAP[p.symbol] || 'Other';
      totalInvested += mv;
      if (!sectorExposure[sector]) sectorExposure[sector] = { value: 0, tickers: [], pct: 0 };
      sectorExposure[sector].value += mv;
      sectorExposure[sector].tickers.push(p.symbol);
    });

    // Calculate percentages
    Object.keys(sectorExposure).forEach(sector => {
      sectorExposure[sector].pct = parseFloat((sectorExposure[sector].value / portfolio * 100).toFixed(1));
    });

    // Sort by exposure
    const sectors = Object.entries(sectorExposure)
      .sort((a, b) => b[1].pct - a[1].pct)
      .map(([name, data]) => ({ name, ...data }));

    // Identify risks
    const risks = [];
    sectors.forEach(s => {
      if (s.pct >= 40) risks.push(`⚠️ HIGH: ${s.pct}% in ${s.name} (${s.tickers.join(', ')}) — dangerously concentrated`);
      else if (s.pct >= 25) risks.push(`⚡ MODERATE: ${s.pct}% in ${s.name} — consider reducing`);
    });

    const concentrationScore = sectors.length > 0 ? sectors[0].pct : 0; // Higher = more concentrated = riskier

    return {
      hasPositions: true,
      portfolio, totalInvested,
      investedPct: parseFloat((totalInvested / portfolio * 100).toFixed(1)),
      sectors,
      risks,
      concentrationScore,
      diversificationRating: concentrationScore < 20 ? 'Well Diversified' : concentrationScore < 35 ? 'Moderate' : concentrationScore < 50 ? 'Concentrated' : 'HIGH RISK — Overconcentrated',
      positionCount: positions.length,
    };
  } catch(e) {
    return { hasPositions: false, error: e.message };
  }
}

// ── STRATEGY GENOME ENGINE ────────────────────────────────────────
// Identifies recurring profitable patterns from Trade DNA.
// Grows more powerful with every trade the system makes.

function buildStrategyGenome() {
  if (tradeDNA.length < 5) {
    return {
      hasPatterns: false,
      message: 'Need more trades to identify patterns (currently '+tradeDNA.length+'/20 minimum)',
      patterns: [],
    };
  }

  const patterns = {};

  tradeDNA.forEach(trade => {
    // Build pattern fingerprint from the trade's characteristics
    const catalystType = classifyCatalyst(trade.catalyst || '');
    const scoreRange   = trade.signalScore >= 85 ? 'HIGH' : trade.signalScore >= 72 ? 'MED' : 'LOW';
    const rsiZone      = trade.factorBreakdown?.technicalFactor >= 75 ? 'BULLISH_TECH'
                       : trade.factorBreakdown?.technicalFactor <= 40 ? 'BEARISH_TECH' : 'NEUTRAL_TECH';
    const insiderSignal = trade.factorBreakdown?.insiderFactor >= 70 ? 'INSIDER_BUY' : 'NO_INSIDER';

    const key = [catalystType, scoreRange, rsiZone, insiderSignal].join('|');

    if (!patterns[key]) {
      patterns[key] = {
        id: Object.keys(patterns).length + 1,
        catalystType, scoreRange, rsiZone, insiderSignal,
        trades: [], wins: 0, totalReturn: 0,
      };
    }

    patterns[key].trades.push(trade);
    if (trade.profitable) patterns[key].wins++;
    patterns[key].totalReturn += trade.returnPct || 0;
  });

  // Only return patterns with 2+ occurrences
  const validPatterns = Object.values(patterns)
    .filter(p => p.trades.length >= 2)
    .map(p => ({
      id: p.id,
      description: formatPatternDescription(p),
      occurrences: p.trades.length,
      winRate: Math.round(p.wins / p.trades.length * 100),
      avgReturn: parseFloat((p.totalReturn / p.trades.length).toFixed(2)),
      bestReturn: parseFloat(Math.max(...p.trades.map(t => t.returnPct || 0)).toFixed(2)),
      worstReturn: parseFloat(Math.min(...p.trades.map(t => t.returnPct || 0)).toFixed(2)),
      catalystType: p.catalystType,
      scoreRange: p.scoreRange,
    }))
    .sort((a, b) => (b.winRate * b.occurrences) - (a.winRate * a.occurrences));

  const topPattern = validPatterns[0];

  return {
    hasPatterns: validPatterns.length > 0,
    patternCount: validPatterns.length,
    tradesAnalysed: tradeDNA.length,
    bestPattern: topPattern || null,
    patterns: validPatterns.slice(0, 10),
    insight: topPattern
      ? `Best pattern: ${topPattern.description} — ${topPattern.occurrences} occurrences, ${topPattern.winRate}% win rate, avg ${topPattern.avgReturn >= 0 ? '+' : ''}${topPattern.avgReturn}%`
      : 'No clear patterns yet — keep trading to build the genome.',
  };
}

function classifyCatalyst(catalyst) {
  const c = catalyst.toLowerCase();
  if (c.includes('earnings beat') || c.includes('eps beat')) return 'EARNINGS_BEAT';
  if (c.includes('earnings miss') || c.includes('eps miss')) return 'EARNINGS_MISS';
  if (c.includes('analyst upgrade')) return 'ANALYST_UPGRADE';
  if (c.includes('insider buy')) return 'INSIDER_BUY';
  if (c.includes('influencer')) return 'INFLUENCER';
  if (c.includes('breakout')) return 'BREAKOUT';
  if (c.includes('short squeeze')) return 'SHORT_SQUEEZE';
  if (c.includes('crypto') || c.includes('btc') || c.includes('eth')) return 'CRYPTO';
  return 'OTHER';
}

function formatPatternDescription(p) {
  const parts = [];
  if (p.catalystType !== 'OTHER') parts.push(p.catalystType.replace(/_/g, ' '));
  if (p.scoreRange === 'HIGH') parts.push('High conviction (85+)');
  else if (p.scoreRange === 'MED') parts.push('Medium conviction (72-84)');
  if (p.rsiZone === 'BULLISH_TECH') parts.push('Strong technicals');
  if (p.insiderSignal === 'INSIDER_BUY') parts.push('Insider buying');
  return parts.join(' + ') || 'Mixed signals';
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

    // Restore earnings calendar
    const earnRows = await dbSelect('earnings_calendar',
      'order=report_date.asc&limit=100'
    );
    if (Array.isArray(earnRows) && earnRows.length) {
      upcomingEarnings = earnRows.map(r => ({
        ticker: r.ticker, date: r.report_date,
        time: r.report_time, epsEstimate: r.eps_estimate,
        revenueEstimate: r.revenue_estimate,
      }));
      console.log('[AGENT] Restored '+upcomingEarnings.length+' earnings records');
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
    // Refresh agent weights from historical performance
    await refreshAgentWeights();
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
  try {
    const a = await alpaca('/v2/assets/' + ticker);
    if (a.shortable && a.easy_to_borrow) {
      log('TRADE', '✅ '+ticker+' is shortable (easy to borrow)', { ticker });
      return true;
    }
    if (a.shortable && !a.easy_to_borrow) {
      log('TRADE', '⚠️ '+ticker+' shortable but NOT easy to borrow — blocked', { ticker });
      return false;
    }
    log('TRADE', '❌ '+ticker+' is NOT shortable on Alpaca', { ticker });
    return false;
  } catch(e) {
    log('ERROR', 'isShortable check failed for '+ticker+': '+e.message+' — defaulting to allow', { ticker });
    return true; // Don't block shorts just because the check failed
  }
}

// Diagnostics: get full status of all short signals
function getShortsDiagnostics() {
  const shorts = catalystSignals.filter(s => s.signal === 'SHORT' || s.type === 'SHORT');
  return {
    totalShortSignals: shorts.length,
    shorts: shorts.map(s => ({
      ticker: s.ticker,
      signal: s.signal,
      signalScore: s.signalScore,
      confidence: s.confidence,
      riskScore: s.riskScore,
      riskLabel: s.riskLabel,
      targetPrice: s.targetPrice,
      stopLoss: s.stopLoss,
      foundAt: s.foundAt,
      catalyst: s.catalyst,
      blockedByRisk: (s.riskScore || 0) >= 70,
      hasPriceTargets: !!(s.targetPrice && s.stopLoss),
    })),
  };
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
function recordTradeOutcome(ticker, entryPrice, exitPrice, catalyst, signalScore, reason, extraData) {
  extraData = extraData || {};
  const returnPct = entryPrice>0 ? ((exitPrice-entryPrice)/entryPrice)*100 : 0;
  const holdDays = extraData.entryDate ? (Date.now()-new Date(extraData.entryDate).getTime())/(1000*60*60*24) : null;
  const record = {
    ticker, entryPrice, exitPrice, catalyst, signalScore,
    returnPct: parseFloat(returnPct.toFixed(2)),
    profitable: returnPct > 0, reason,
    signalType: extraData.signalType || 'unknown',
    sector: extraData.sector || null,
    factorBreakdown: extraData.factorBreakdown || null,
    agentVotes: extraData.agentVotes || null,
    holdingPeriodDays: holdDays ? parseFloat(holdDays.toFixed(1)) : null,
    confidence: extraData.confidence || null,
    riskScore: extraData.riskScore || null,
    isCrypto: extraData.isCrypto || false,
    date: new Date().toISOString()
  };
  tradeDNA.push(record);
  if(tradeDNA.length>500) tradeDNA.shift();
  log('DNA','📊 Trade recorded: '+ticker+' '+returnPct.toFixed(1)+'% ['+reason+']',{ticker,returnPct,profitable:returnPct>0,signalType:record.signalType});
  // Store enriched record in Supabase
  dbInsert('trade_dna',{
    ticker, entry_price:entryPrice, exit_price:exitPrice,
    return_pct:record.returnPct, profitable:record.profitable,
    catalyst, signal_score:signalScore, reason,
    signal_type:record.signalType, sector:record.sector,
    factor_breakdown:record.factorBreakdown?JSON.stringify(record.factorBreakdown):null,
    agent_votes:record.agentVotes?JSON.stringify(record.agentVotes):null,
    holding_period_days:record.holdingPeriodDays,
    confidence:record.confidence, risk_score:record.riskScore,
    is_crypto:record.isCrypto,
  }).catch(()=>{});
  // Track agent performance
  if (record.agentVotes && Array.isArray(record.agentVotes)) {
    record.agentVotes.forEach(av => {
      const expectedVote = returnPct > 0 ? 'BUY' : 'SELL';
      const wasCorrect = av.vote === expectedVote || (av.vote === 'HOLD' && Math.abs(returnPct) < 3);
      dbInsert('agent_performance',{
        agent_name:av.agent, ticker, vote:av.vote, signal_score:signalScore,
        outcome:reason, return_pct:record.returnPct, was_correct:wasCorrect
      }).catch(()=>{});
    });
  }
}

// ── HISTORICAL SIMILARITY ENGINE ─────────────────────────────────
// Compares a new signal against all past trade DNA to find similar setups
function calculateHistoricalSimilarity(signal) {
  if (tradeDNA.length < 3) {
    return { hasSimilarity: false, message: 'Building history — need more trades', count: 0 };
  }

  const signalCatalyst = (signal.catalyst||'').toLowerCase();
  const signalScore = signal.signalScore || 70;
  const isCrypto = signal.isCrypto || false;

  // Determine signal type
  let signalType = 'unknown';
  if (signalCatalyst.includes('earnings beat') || signalCatalyst.includes('eps beat')) signalType = 'earnings_beat';
  else if (signalCatalyst.includes('earnings miss') || signalCatalyst.includes('eps miss')) signalType = 'earnings_miss';
  else if (signalCatalyst.includes('analyst upgrade')) signalType = 'analyst_upgrade';
  else if (signalCatalyst.includes('insider buy')) signalType = 'insider_buy';
  else if (signalCatalyst.includes('influencer')) signalType = 'influencer';
  else if (isCrypto) signalType = 'crypto';
  else if (signal.signal === 'SHORT') signalType = 'short';

  // Find similar historical trades
  const similar = tradeDNA.filter(trade => {
    const tradeCatalyst = (trade.catalyst||'').toLowerCase();
    let tradeType = 'unknown';
    if (tradeCatalyst.includes('earnings beat')||tradeCatalyst.includes('eps beat')) tradeType = 'earnings_beat';
    else if (tradeCatalyst.includes('earnings miss')) tradeType = 'earnings_miss';
    else if (tradeCatalyst.includes('analyst upgrade')) tradeType = 'analyst_upgrade';
    else if (tradeCatalyst.includes('insider buy')) tradeType = 'insider_buy';
    else if (tradeCatalyst.includes('influencer')) tradeType = 'influencer';
    else if (trade.isCrypto) tradeType = 'crypto';
    else if (trade.signalType === 'short') tradeType = 'short';

    const typeMatch = signalType === tradeType;
    const scoreMatch = Math.abs((trade.signalScore||70) - signalScore) <= 15;
    return typeMatch || (scoreMatch && tradeType !== 'unknown');
  });

  if (similar.length < 2) {
    // Try broader match just by score range
    const byScore = tradeDNA.filter(t => Math.abs((t.signalScore||70)-signalScore) <= 20);
    if (byScore.length < 2) return { hasSimilarity: false, message: 'No similar historical setups yet', count: 0 };
    return buildSimilarityResult(byScore, signalType, 40);
  }

  // Calculate similarity score (how closely matched are they)
  const similarityScore = Math.min(99, 50 + (similar.length >= 10 ? 30 : similar.length * 3) + (signalType !== 'unknown' ? 20 : 0));
  return buildSimilarityResult(similar, signalType, similarityScore);
}

function buildSimilarityResult(trades, signalType, similarityScore) {
  const wins = trades.filter(t => t.profitable);
  const winRate = Math.round(wins.length / trades.length * 100);
  const returns = trades.map(t => t.returnPct || 0);
  const avgReturn = parseFloat((returns.reduce((s,r)=>s+r,0)/returns.length).toFixed(2));
  const bestReturn = parseFloat(Math.max(...returns).toFixed(2));
  const worstReturn = parseFloat(Math.min(...returns).toFixed(2));
  const holdTimes = trades.filter(t=>t.holdingPeriodDays).map(t=>t.holdingPeriodDays);
  const avgHoldDays = holdTimes.length ? parseFloat((holdTimes.reduce((s,h)=>s+h,0)/holdTimes.length).toFixed(1)) : null;

  return {
    hasSimilarity: true,
    similarityScore,
    count: trades.length,
    winRate,
    avgReturn,
    bestReturn,
    worstReturn,
    avgHoldDays,
    signalType,
    summary: `${trades.length} similar setups — ${winRate}% win rate, avg ${avgReturn>=0?'+':''}${avgReturn}%`,
  };
}

// ── AGENT PERFORMANCE STATS ───────────────────────────────────────
async function getAgentStats() {
  if (!DB) {
    // Calculate from in-memory trade DNA
    return INFLUENCERS.map(i => ({ agent: i.name, wins: 0, total: 0, winRate: 0 }));
  }
  try {
    const rows = await dbSelect('agent_performance', 'order=created_at.desc&limit=500');
    if (!Array.isArray(rows) || !rows.length) return [];
    const byAgent = {};
    rows.forEach(r => {
      if (!byAgent[r.agent_name]) byAgent[r.agent_name] = { agent: r.agent_name, wins: 0, total: 0 };
      byAgent[r.agent_name].total++;
      if (r.was_correct) byAgent[r.agent_name].wins++;
    });
    return Object.values(byAgent).map(a => ({
      ...a,
      winRate: a.total > 0 ? Math.round(a.wins/a.total*100) : 0
    })).sort((a,b) => b.winRate - a.winRate);
  } catch(e) { return []; }
}

// ── PERFORMANCE ANALYTICS ─────────────────────────────────────────
function getPerformanceAnalytics() {
  if (tradeDNA.length === 0) return null;
  const wins = tradeDNA.filter(t=>t.profitable);
  const losses = tradeDNA.filter(t=>!t.profitable);
  const returns = tradeDNA.map(t=>t.returnPct||0);
  const avgReturn = returns.reduce((s,r)=>s+r,0)/returns.length;
  const winRate = Math.round(wins.length/tradeDNA.length*100);

  // Sharpe ratio (simplified — return/volatility)
  const variance = returns.reduce((s,r)=>s+Math.pow(r-avgReturn,2),0)/returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? parseFloat((avgReturn/stdDev).toFixed(2)) : 0;

  // Best and worst catalysts
  const byCatalyst = {};
  tradeDNA.forEach(t => {
    const cat = (t.catalyst||'unknown').split(' ').slice(0,2).join(' ').toLowerCase();
    if (!byCatalyst[cat]) byCatalyst[cat] = {wins:0,total:0,returns:[]};
    byCatalyst[cat].total++;
    if(t.profitable) byCatalyst[cat].wins++;
    byCatalyst[cat].returns.push(t.returnPct||0);
  });
  const catalystStats = Object.entries(byCatalyst)
    .filter(([,v])=>v.total>=2)
    .map(([cat,v])=>({
      catalyst: cat,
      winRate: Math.round(v.wins/v.total*100),
      avgReturn: parseFloat((v.returns.reduce((s,r)=>s+r,0)/v.returns.length).toFixed(2)),
      count: v.total
    }))
    .sort((a,b)=>b.winRate-a.winRate);

  return {
    totalTrades: tradeDNA.length,
    winRate,
    avgReturn: parseFloat(avgReturn.toFixed(2)),
    bestReturn: parseFloat(Math.max(...returns).toFixed(2)),
    worstReturn: parseFloat(Math.min(...returns).toFixed(2)),
    sharpeRatio: sharpe,
    profitFactor: losses.length > 0 ? parseFloat((wins.reduce((s,t)=>s+t.returnPct,0)/Math.abs(losses.reduce((s,t)=>s+t.returnPct,0))).toFixed(2)) : null,
    bestCatalysts: catalystStats.slice(0,5),
    worstCatalysts: [...catalystStats].sort((a,b)=>a.winRate-b.winRate).slice(0,3),
    recentTrades: tradeDNA.slice(-10).reverse(),
  };
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

// ── AGENT WEIGHT ENGINE ──────────────────────────────────────────
// Tracks historical accuracy per agent and weights votes accordingly
let agentWeights = {
  Momentum: 1.0, Earnings: 1.0, Macro: 1.0,
  Sentiment: 1.0, Technical: 1.0, Risk: 1.0,
};

async function refreshAgentWeights() {
  try {
    const rows = await dbSelect('agent_performance',
      'order=created_at.desc&limit=200'
    );
    if (!Array.isArray(rows) || rows.length < 10) return;

    const byAgent = {};
    rows.forEach(r => {
      if (!byAgent[r.agent_name]) byAgent[r.agent_name] = { correct: 0, total: 0 };
      byAgent[r.agent_name].total++;
      if (r.was_correct) byAgent[r.agent_name].correct++;
    });

    // Recalculate weights: 1.0 = baseline (50% accuracy)
    // Better than 65% = up to 2.0x weight
    // Worse than 40% = down to 0.5x weight
    Object.entries(byAgent).forEach(([agent, stats]) => {
      if (stats.total < 5) return; // Need min 5 predictions
      const accuracy = stats.correct / stats.total;
      const weight = Math.max(0.5, Math.min(2.0,
        0.5 + (accuracy * 3) // 50% acc = 2.0x, 33% acc = 1.5x, 0% = 0.5x
      ));
      agentWeights[agent] = parseFloat(weight.toFixed(2));
    });

    log('AGENT', '⚖️ Agent weights updated: '+
      Object.entries(agentWeights).map(([k,v])=>k+':'+v+'x').join(' | '));
  } catch(e) {
    log('ERROR', 'Agent weight refresh failed: '+e.message);
  }
}

// Apply weights to agent votes for conviction calculation
function weightedAgentConsensus(agentVotes, isShort) {
  let weightedBuy = 0, weightedSell = 0, weightedHold = 0, totalWeight = 0;
  agentVotes.forEach(v => {
    const w = agentWeights[v.agent] || 1.0;
    totalWeight += w;
    if (v.vote === 'BUY')  weightedBuy  += w;
    if (v.vote === 'SELL') weightedSell += w;
    if (v.vote === 'HOLD') weightedHold += w;
  });
  if (totalWeight === 0) return 50;
  const bullishWeight = isShort ? weightedSell : weightedBuy;
  return Math.round((bullishWeight / totalWeight) * 100);
}

// ── PHASE 1B: MARKET MEMORY DATABASE ─────────────────────────────
// Stores ALL signals — not just executed trades — so we can learn
// from rejected, blocked, and expired signals too.
async function recordSignalMemory(signal, disposition, reason) {
  // disposition: 'EXECUTED', 'REJECTED_RISK', 'REJECTED_NOT_SHORTABLE',
  //              'EXPIRED', 'BLOCKED_MARKET_CLOSED', 'SKIPPED_MAX_POSITIONS'
  if (!DB) return;
  try {
    await dbInsert('signal_memory', {
      ticker: signal.ticker || signal.symbol,
      signal: signal.signal,
      signal_score: signal.signalScore,
      confidence: signal.confidence,
      catalyst: signal.catalyst,
      risk_score: signal.riskScore,
      disposition,
      reason,
      agent_votes: signal.conviction?.agentVotes ? JSON.stringify(signal.conviction.agentVotes) : null,
      conviction_probability: signal.conviction?.probability || null,
      technical_score: signal.technicalAnalysis?.technicalScore || null,
      market_regime: currentRegime.regime || null,
      is_crypto: signal.isCrypto || false,
      found_at: signal.foundAt || new Date().toISOString(),
      recorded_at: new Date().toISOString(),
    }).catch(() => {});
  } catch(e) {}
}

// ── MULTI-AGENT ANALYST ───────────────────────────────────────────
async function runMultiAgentAnalysis(signal) {
  const ticker=signal.ticker||signal.symbol;
  const ctx=`Stock: ${ticker}\nCatalyst: ${signal.catalyst||''}\nDetail: ${signal.detail||''}\nScore: ${signal.signalScore} Conf: ${signal.confidence}%\nThesis: ${signal.thesis||''}`;
  // If we have technical data, pass it as context to agents
  const techContext = signal.technicalAnalysis
    ? `Technical context: ${signal.technicalAnalysis.summary}`
    : '';

  const agents=[
    {name:'Momentum',  focus:'price momentum, volume, RSI, moving averages, trend strength only. '+techContext},
    {name:'Earnings',  focus:'EPS vs estimate, revenue, guidance, analyst revisions only'},
    {name:'Macro',     focus:'Fed policy, sector rotation, economic cycle, macro risks only'},
    {name:'Sentiment', focus:'social buzz, options flow, retail positioning only'},
    {name:'Technical', focus:'chart patterns, support/resistance, trend direction, RSI, SMA alignment, breakouts. Use this data: '+techContext},
    {name:'Risk',      focus:'finding reasons NOT to trade — risks, red flags, overbought conditions only. '+techContext},
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
  const consensus = weightedAgentConsensus(agentVotes, isShort);

  // Get historical similarity
  const similarity = calculateHistoricalSimilarity(signal);

  // Probability = blend of confidence + agent consensus + historical win rate
  let probability = (signal.confidence||70)*0.5 + consensus*0.3;
  if (similarity.hasSimilarity && similarity.winRate) {
    probability = probability*0.7 + similarity.winRate*0.3;
  }
  probability = Math.round(probability);

  const entry=parseFloat(signal.currentPrice||0);
  const target=parseFloat(signal.targetPrice||0);
  const stop=parseFloat(signal.stopLoss||0);
  const expectedReturn=(entry>0&&target>0)?((target-entry)/entry*100).toFixed(1)+'%':(signal.expectedReturn||'—');
  const worstCase=(entry>0&&stop>0)?((stop-entry)/entry*100).toFixed(1)+'%':(isShort?'+5%':'-8%');
  const upside=target&&entry?Math.abs(target-entry):0;
  const downside=stop&&entry?Math.abs(stop-entry):1;
  const riskReward=downside>0?(upside/downside).toFixed(1)+':1':'—';

  // Conviction rating
  let convictionRating = 'Low';
  if (probability >= 75 && (signal.signalScore||0) >= 80) convictionRating = 'Very High';
  else if (probability >= 65 && (signal.signalScore||0) >= 72) convictionRating = 'High';
  else if (probability >= 55) convictionRating = 'Medium';

  return {
    probability, expectedReturn, worstCase, riskReward,
    agentConsensus:Math.round(consensus),
    buyVotes:buyCount, sellVotes:sellCount, holdVotes:total-buyCount-sellCount,
    agentVoteSummary:buyCount+'/'+total+' agents '+(isShort?'bearish':'bullish'),
    dnaSummary:getTradeDNASummary(),
    agentVotes,
    historicalSimilarity: similarity,
    convictionRating,
    technicalScore: signal.technicalAnalysis?.technicalScore || null,
    technicalTrend: signal.technicalAnalysis?.trend || null,
  };
}

// ── POSITION SIZING ───────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c = score*0.6 + confidence*0.4;
  let base = 0;
  if(c>=85) base = portfolio*0.08;
  else if(c>=78) base = portfolio*0.06;
  else if(c>=72) base = portfolio*0.04;
  else if(c>=65) base = portfolio*0.02;
  else return 0;
  // Apply market regime multiplier — smaller in bear, larger in bull
  const adjusted = base * (currentRegime.riskMultiplier || 1.0);
  return Math.min(adjusted, portfolio * 0.12); // Cap at 12% regardless
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
      recordSignalMemory(signal||{ticker,signal:side==='sell'?'SHORT':'BUY'}, 'EXECUTED', typeLabel+' $'+dollars.toFixed(0));
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
      recordTradeOutcome(p.symbol,entry,current,'stop loss',0,'STOP_LOSS',{isCrypto,signalType:isCrypto?'crypto':isShort?'short':'long'});
      delete sellEvalCache[p.symbol];
    }else if(pnl>=hardT){
      log('PROFIT','🎯 Hard take profit: '+p.symbol+' at +'+pnl.toFixed(1)+'%',{ticker:p.symbol,pnlPct:pnl,reason:'TAKE_PROFIT_HARD',isShort,isCrypto});
      await alpaca('/v2/positions/'+encodeURIComponent(p.symbol),{method:'DELETE'});
      recordTradeOutcome(p.symbol,entry,current,'hard take profit',0,'TAKE_PROFIT_HARD',{isCrypto,signalType:isCrypto?'crypto':isShort?'short':'long'});
      delete sellEvalCache[p.symbol];
    }else if(pnl>=warnT){
      const sell=await shouldSell(p.symbol,pnl,entry,current,isCrypto);
      if(sell){
        log('PROFIT','🎯 AI-confirmed sell: '+p.symbol+' at +'+pnl.toFixed(1)+'%',{ticker:p.symbol,pnlPct:pnl,reason:'TAKE_PROFIT_AI',isShort,isCrypto});
        await alpaca('/v2/positions/'+encodeURIComponent(p.symbol),{method:'DELETE'});
        recordTradeOutcome(p.symbol,entry,current,'AI take profit',0,'TAKE_PROFIT_AI',{isCrypto,signalType:isCrypto?'crypto':isShort?'short':'long'});
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
  const analytics = getPerformanceAnalytics();
  const analyticsContext = analytics
    ? `Portfolio stats: ${analytics.totalTrades} trades, ${analytics.winRate}% win rate, avg return ${analytics.avgReturn}%`
    : 'No trade history yet';
  const regimeContext = currentRegime.regime !== 'UNKNOWN'
    ? `Current market regime: ${currentRegime.label}. Risk multiplier: ${currentRegime.riskMultiplier}x. ${currentRegime.description}`
    : '';
  const genomeContext = buildStrategyGenome().insight || '';

  const prompt=`You are an AI Chief Investment Officer. Market regime: ${regimeContext}. Strategy genome: ${genomeContext}. Search overnight news and futures. Context: ${dna}. ${analyticsContext}
Generate an institutional morning briefing. Respond with ONLY JSON:
{"greeting":"Good morning. [Key overnight development in one sentence]","portfolioRiskScore":65,"marketRegime":"RISK_ON","futuresSnapshot":"Brief futures","topWatches":[{"ticker":"NVDA","reason":"Why today","bias":"BULLISH","expectedMove":"+2%"}],"sectorFocus":"Which sector and why","keyRisk":"Biggest risk","recommendedActions":["Action 1","Action 2"],"topIdea":{"ticker":"AAPL","catalyst":"Why best trade","action":"BUY","confidence":78}}
All strings under 100 chars. Return ONLY JSON.`;
  try{
    const result=await callClaude(prompt,'Search overnight futures, pre-market movers, and key catalysts for today.',700,true);
    morningBriefing={...result,generatedAt:new Date().toISOString()};
    log('INTEL','☀️ '+(result.greeting||'Morning briefing ready'),{marketRegime:result.marketRegime});
    if(result.topIdea) log('INTEL','💡 Top idea: '+result.topIdea.ticker+' — '+result.topIdea.catalyst,{ticker:result.topIdea.ticker});
    (result.topWatches||[]).forEach(w=>log('INTEL','👀 Watch: '+w.ticker+' — '+w.reason,{ticker:w.ticker,bias:w.bias}));
    // Generate CIO report after briefing
    setTimeout(generateCIOReport, 5000);
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
  const prompt=`Respond with ONLY JSON. Find the single most important market-moving statement from: ${names} in last 24 hours.
Respond with exactly: {"influencerActivity":[{"person":"Name","platform":"X","action":"Action under 50 chars","relatedTickers":["TICK"],"relatedSectors":["Sector"],"estimatedImpact":"+2%","impactLagHours":2,"confidence":75,"sentiment":"BULLISH","urgency":"MEDIUM","tradingImplication":"Implication under 50 chars"}]}
If nothing found: {"influencerActivity":[]}
ONE item maximum. All strings under 60 characters.`;
  try{
    const result=await callClaude(prompt,'Most important market statement from Musk Trump Powell Wood Pelosi Burry Buffett today?',500,true);
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

      // Fetch 365 days of technical data before agent analysis
      log('CATALYST','📈 Fetching 365-day technical analysis for '+signal.ticker+'...');
      const technicalAnalysis = await getTechnicalAnalysis(signal.ticker);
      if (technicalAnalysis.available) {
        signal.technicalAnalysis = technicalAnalysis;
        // Adjust signal score based on technical confirmation
        if (signal.signal === 'BUY') {
          if (technicalAnalysis.trend === 'STRONG UPTREND') signal.signalScore = Math.min(99, signal.signalScore + 5);
          if (technicalAnalysis.isBreakout) signal.signalScore = Math.min(99, signal.signalScore + 5);
          if (technicalAnalysis.rsi >= 70) signal.signalScore = Math.max(0, signal.signalScore - 8); // Overbought penalty
          if (technicalAnalysis.trend === 'STRONG DOWNTREND') signal.signalScore = Math.max(0, signal.signalScore - 10);
        } else if (signal.signal === 'SHORT') {
          if (technicalAnalysis.trend === 'STRONG DOWNTREND') signal.signalScore = Math.min(99, signal.signalScore + 5);
          if (technicalAnalysis.rsi <= 30) signal.signalScore = Math.max(0, signal.signalScore - 8); // Oversold penalty for shorts
        }
        signal.riskScore = scoreRisk(signal); // Recalculate with technical data
        log('CATALYST', '📈 '+signal.ticker+' technicals: '+technicalAnalysis.trend+
          ' | RSI:'+technicalAnalysis.rsi+' | Score:'+technicalAnalysis.technicalScore+
          '/100 | '+technicalAnalysis.week52Position+'% of 52wk range', {
          ticker: signal.ticker,
          trend: technicalAnalysis.trend,
          rsi: technicalAnalysis.rsi,
          technicalScore: technicalAnalysis.technicalScore,
          week52Position: technicalAnalysis.week52Position,
          isBreakout: technicalAnalysis.isBreakout,
        });
      }

      log('CATALYST','🤖 Running 6-agent analysis for '+signal.ticker+'...');
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
          recordSignalMemory(signal, 'EXPIRED', 'Signal older than '+maxAge/3600000+'hrs');
          if(isCrypto)cryptoSignals=cryptoSignals.filter(s=>s.symbol!==ticker);
          else catalystSignals=catalystSignals.filter(s=>s.ticker!==ticker);
          dbDelete('active_signals','ticker=eq.'+ticker).catch(()=>{});
          continue;
        }
        const livePrice=await getLivePrice(ticker);if(!livePrice) continue;
        const score=signal.signalScore||0,conf=signal.confidence||0;
        const target=parseFloat(signal.targetPrice||0),stop=parseFloat(signal.stopLoss||0);
        const longValid = !isShort && livePrice > stop && livePrice < target;
        // For shorts: if target=0 (not set), allow entry as long as price is below stop
        // Target=0 means Claude didn't set one; we'll use a default 10% below entry
        const shortTargetOk = target > 0 ? livePrice > target : true;
        const shortStopOk   = stop > 0 ? livePrice < stop : true;
        const shortValid = isShort && shortStopOk && shortTargetOk;
        const cryptoValid=isCrypto&&signal.signal==='BUY'&&livePrice>stop&&livePrice<target;
        if(longValid||shortValid||cryptoValid){
          if (isShort && !isCrypto) {
            log('TRADE', '🔍 Checking if '+ticker+' is shortable on Alpaca...', { ticker });
            const canShort = await isShortable(ticker);
            if (!canShort) {
              log('TRADE', '🚫 SHORT blocked: '+ticker+' not available to borrow', { ticker, reason: 'NOT_SHORTABLE' });
              continue;
            }
          }
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

    // Store in memory immediately so dashboard can access right away
    upcomingEarnings = upcoming;
    log('CATALYST', '📅 Earnings stored in memory — '+upcoming.length+' upcoming reports');

    // Save to Supabase async in background (don't await — takes too long for 100+ records)
    (async () => {
      try {
        await dbDelete('earnings_calendar',
          'report_date=gte.'+new Date().toISOString().split('T')[0]
        ).catch(()=>{});
        // Batch insert in groups of 10 to be faster
        const batch = [];
        for (const e of upcoming) {
          batch.push({
            ticker: e.ticker, report_date: e.date,
            report_time: e.time || 'unknown',
            eps_estimate: e.epsEstimate || null,
            revenue_estimate: e.revenueEstimate || null,
          });
        }
        // Single bulk insert — much faster than one-by-one
        await dbInsert('earnings_calendar', batch).catch(()=>{});
        log('CATALYST', '📅 Earnings saved to Supabase — '+upcoming.length+' records');
      } catch(e) { log('ERROR', 'Earnings Supabase save failed: '+e.message); }
    })();

    // Analyse top 3 most significant upcoming earnings
    const toAnalyse = upcoming.slice(0, 3);

    for (const earning of toAnalyse) {
      try {
        const ticker = earning.ticker;

        // Get real data from Finnhub
        const [ratings, insider, metrics, news, technicalAnalysis, historicalImpact] = await Promise.all([
          getAnalystRatings(ticker),
          getInsiderActivity(ticker),
          getMetrics(ticker),
          getCompanyNews(ticker),
          getTechnicalAnalysis(ticker),
          getHistoricalEarningsImpact(ticker),
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

        const techContext = technicalAnalysis?.available
          ? `Technical setup: ${technicalAnalysis.summary}`
          : 'No technical data';

        const prompt = `You are an earnings pre-positioning analyst. ${ticker} reports earnings ${earning.time==='bmo'?'before market open':'after market close'} on ${earning.date}.
EPS estimate: $${earning.epsEstimate}${earning.revenueEstimate?' Revenue estimate: $'+Math.round(earning.revenueEstimate/1e6)+'M':''}
${analystContext}
${insiderContext}
${metricsContext}
${newsContext}
${techContext}
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
        analysis.catalyst = 'Earnings '+earning.date+' (est EPS $'+(earning.epsEstimate||'TBD')+')';
        analysis.detail = analystContext+'. '+insiderContext;
        analysis.historicalEarningsImpact = historicalImpact;
        if (historicalImpact) {
          log('CATALYST', '📊 '+ticker+' historical earnings: '+historicalImpact.summary, { ticker });
        }
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
  if(hhmm==='09:00'){await detectMarketRegime();await runMorningBriefing();return;}
  // Tactical auto-close check
  await checkTacticalClose();
  if(hhmm==='12:00'){await detectMarketRegime();return;} // Midday regime check
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
// ═══════════════════════════════════════════════════════════════════
// TACTICAL TRADING MODULE — Intraday only, isolated from swing engine
// ═══════════════════════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────────────────────
let tacticalState = {
  active: false,
  scanRunning: false,
  lastScan: null,
  signals: [],         // Active intraday signals
  trades: [],          // Today's tactical trades (closed)
  openPositions: [],   // Currently open tactical positions
  log: [],
  pnl: { realized: 0, trades: 0, wins: 0 },
};

const TACTICAL_UNIVERSE = [
  'SPY','QQQ','AAPL','NVDA','AMD','MSFT','TSLA','META',
  'AMZN','GOOGL','JPM','BAC','NFLX','PLTR','COIN','MARA',
  'XLF','XLE','GLD','SOFI','RIVN','LCID','SNAP','UBER',
];

// Max position size for tactical trades (smaller than swing)
const TACTICAL_MAX_DOLLARS = 2000;
const TACTICAL_STOP_PCT    = 0.005;  // 0.5% stop loss (tight for intraday)
const TACTICAL_TARGET_MULT = 2.0;    // 2:1 reward/risk default
const TACTICAL_CLOSE_HOUR  = 15;     // Close all positions at 3:45 PM ET
const TACTICAL_CLOSE_MIN   = 45;

function tlog(type, msg, data) {
  const entry = { type, message: msg, timestamp: new Date().toISOString(), ...data };
  tacticalState.log.unshift(entry);
  if (tacticalState.log.length > 200) tacticalState.log = tacticalState.log.slice(0, 200);
  console.log('[TACTICAL]', type, msg);
}

// ── INTRADAY DATA ─────────────────────────────────────────────────
async function getIntradayBars(ticker, timeframe) {
  timeframe = timeframe || '1Min';
  try {
    // Get today's date in ET (approximate — use UTC-4 for EDT)
    const now = new Date();
    const etOffset = 4 * 60 * 60 * 1000; // EDT offset
    const etNow = new Date(now.getTime() - etOffset);
    const todayDate = etNow.toISOString().split('T')[0];
    const start = todayDate + 'T09:30:00';

    const r = await fetch(
      ALPACA_DATA + '/v2/stocks/' + ticker + '/bars?timeframe=' + timeframe +
      '&start=' + todayDate + 'T13:30:00Z&limit=400&adjustment=raw',
      { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
    );
    const d = await r.json();
    return Array.isArray(d.bars) ? d.bars : [];
  } catch(e) {
    return [];
  }
}

// ── VWAP CALCULATOR ───────────────────────────────────────────────
function calcVWAP(bars) {
  if (!bars || !bars.length) return null;
  let cumTPV = 0, cumVol = 0;
  bars.forEach(b => {
    const tp = (b.h + b.l + b.c) / 3;
    cumTPV += tp * (b.v || 0);
    cumVol += (b.v || 0);
  });
  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── OPENING RANGE BREAKOUT ─────────────────────────────────────────
async function detectORB(ticker) {
  try {
    const bars = await getIntradayBars(ticker, '1Min');
    if (bars.length < 10) return null;

    // First 30 bars = Opening Range (9:30-10:00 AM ET)
    const orBars = bars.slice(0, 30);
    const restBars = bars.slice(30);
    if (!restBars.length) return null;

    const orHigh = Math.max(...orBars.map(b => b.h));
    const orLow  = Math.min(...orBars.map(b => b.l));
    const orRange = orHigh - orLow;
    const orMidpoint = (orHigh + orLow) / 2;

    // Current candle
    const current = bars[bars.length - 1];
    const currentPrice = current.c;
    const vwap = calcVWAP(bars);

    // Volume confirmation
    const orVolume    = orBars.reduce((s, b) => s + b.v, 0);
    const avgBarVol   = orVolume / orBars.length;
    const recentVol   = restBars.slice(-5).reduce((s, b) => s + b.v, 0) / 5;
    const volConfirmed = recentVol > avgBarVol * 1.3;

    // Breakout check — price above OR high with volume
    const isBreakout  = currentPrice > orHigh && volConfirmed;
    const isBreakdown = currentPrice < orLow  && volConfirmed;

    if (!isBreakout && !isBreakdown) return null;

    const direction = isBreakout ? 'LONG' : 'SHORT';
    const entry     = currentPrice;
    const stop      = isBreakout ? orHigh - (orRange * 0.3) : orLow + (orRange * 0.3);
    const target1   = isBreakout ? orHigh + orRange : orLow - orRange;
    const target2   = isBreakout ? orHigh + (orRange * 2) : orLow - (orRange * 2);
    const rr        = Math.abs(target1 - entry) / Math.abs(entry - stop);
    const breakoutPct = Math.abs((currentPrice - (isBreakout ? orHigh : orLow)) / entry * 100);

    // Require price not too extended past OR
    if (breakoutPct > 2.5) return null;

    return {
      type: 'ORB',
      ticker,
      direction,
      entry:   parseFloat(entry.toFixed(2)),
      stop:    parseFloat(stop.toFixed(2)),
      target1: parseFloat(target1.toFixed(2)),
      target2: parseFloat(target2.toFixed(2)),
      orHigh:  parseFloat(orHigh.toFixed(2)),
      orLow:   parseFloat(orLow.toFixed(2)),
      orRange: parseFloat(orRange.toFixed(4)),
      vwap:    vwap ? parseFloat(vwap.toFixed(2)) : null,
      vwapDistance: vwap ? parseFloat(((currentPrice - vwap) / vwap * 100).toFixed(2)) : null,
      riskReward:   parseFloat(rr.toFixed(2)),
      breakoutPct:  parseFloat(breakoutPct.toFixed(2)),
      volConfirmed,
      signalScore:  Math.min(95, 60 + (volConfirmed ? 15 : 0) + (rr > 2 ? 10 : 5) + (vwap && isBreakout && currentPrice > vwap ? 10 : 0)),
      barsAnalysed: bars.length,
    };
  } catch(e) { return null; }
}

// ── RELATIVE VOLUME SCANNER ────────────────────────────────────────
async function calcRelativeVolume(ticker) {
  try {
    const bars = await getIntradayBars(ticker, '5Min');
    if (bars.length < 3) return null;

    // Historical daily bars for avg volume
    const histBars = await fetchPriceBars(ticker, 20);
    if (!histBars.length) return null;

    const avgDailyVol = histBars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
    const todayVol    = bars.reduce((s, b) => s + b.v, 0);

    // Time-adjust: how much of the day has passed
    const now = new Date();
    const etHour = now.getUTCHours() - 4;
    const etMin  = now.getUTCMinutes();
    const minutesPassed = Math.max(1, (etHour - 9) * 60 + etMin - 30);
    const dayFraction   = Math.min(1, minutesPassed / 390); // 390 min trading day

    const projectedVol = dayFraction > 0 ? todayVol / dayFraction : todayVol;
    const relVol       = avgDailyVol > 0 ? projectedVol / avgDailyVol : 1;

    return {
      ticker,
      todayVol: Math.round(todayVol),
      avgDailyVol: Math.round(avgDailyVol),
      projectedVol: Math.round(projectedVol),
      relVol: parseFloat(relVol.toFixed(2)),
      isUnusual: relVol > 2.0,
      isVeryUnusual: relVol > 3.0,
    };
  } catch(e) { return null; }
}

// ── VWAP ANALYSIS ─────────────────────────────────────────────────
async function analyzeVWAPSetup(ticker) {
  try {
    const bars = await getIntradayBars(ticker, '5Min');
    if (bars.length < 5) return null;

    const vwap = calcVWAP(bars);
    if (!vwap) return null;

    const current    = bars[bars.length - 1];
    const price      = current.c;
    const pctFromVWAP = (price - vwap) / vwap * 100;
    const aboveVWAP  = price > vwap;

    // VWAP bounce: price returning to VWAP after being away
    const prev5     = bars.slice(-6, -1);
    const avgPrev   = prev5.reduce((s, b) => s + b.c, 0) / prev5.length;
    const bouncing  = aboveVWAP
      ? (avgPrev < vwap * 1.005 && price > vwap * 1.002) // bounce off VWAP upward
      : (avgPrev > vwap * 0.995 && price < vwap * 0.998); // rejection at VWAP

    // VWAP cross
    const prevPrice  = prev5[prev5.length - 1]?.c || price;
    const vwapCross  = (prevPrice < vwap && price > vwap) || (prevPrice > vwap && price < vwap);

    if (Math.abs(pctFromVWAP) < 0.1 && !vwapCross && !bouncing) return null;

    const direction = aboveVWAP ? 'LONG' : 'SHORT';
    const entry     = price;
    const stop      = aboveVWAP ? vwap * 0.998 : vwap * 1.002;
    const target    = aboveVWAP
      ? price + (price - stop) * TACTICAL_TARGET_MULT
      : price - (stop - price) * TACTICAL_TARGET_MULT;
    const rr        = Math.abs(target - entry) / Math.abs(entry - stop);

    return {
      type:         'VWAP',
      ticker,
      direction,
      entry:        parseFloat(entry.toFixed(2)),
      stop:         parseFloat(stop.toFixed(2)),
      target1:      parseFloat(target.toFixed(2)),
      vwap:         parseFloat(vwap.toFixed(2)),
      pctFromVWAP:  parseFloat(pctFromVWAP.toFixed(2)),
      aboveVWAP,
      vwapCross,
      bouncing,
      riskReward:   parseFloat(rr.toFixed(2)),
      signalScore:  Math.min(95,
        (vwapCross ? 75 : bouncing ? 68 : 55) +
        (Math.abs(pctFromVWAP) > 0.5 ? 10 : 0) +
        (rr > 2 ? 5 : 0)
      ),
      barsAnalysed: bars.length,
    };
  } catch(e) { return null; }
}

// ── MOMENTUM SCANNER ──────────────────────────────────────────────
async function detectMomentum(ticker) {
  try {
    const bars = await getIntradayBars(ticker, '5Min');
    if (bars.length < 10) return null;

    const current  = bars[bars.length - 1];
    const bar5ago  = bars[bars.length - 6];
    const bar15ago = bars.length > 15 ? bars[bars.length - 16] : bars[0];

    const move5m   = (current.c - bar5ago.c)  / bar5ago.c  * 100;
    const move15m  = (current.c - bar15ago.c) / bar15ago.c * 100;

    const vwap     = calcVWAP(bars);
    const rsi      = calcRSI(bars.map(b => b.c), 9); // Fast RSI for intraday

    // Volume surge in last 3 bars
    const recentBars = bars.slice(-3);
    const olderBars  = bars.slice(-13, -3);
    const recentVol  = recentBars.reduce((s, b) => s + b.v, 0) / 3;
    const olderVol   = olderBars.length ? olderBars.reduce((s, b) => s + b.v, 0) / olderBars.length : recentVol;
    const volSurge   = olderVol > 0 ? recentVol / olderVol : 1;

    // Qualify momentum
    const strongMoveUp   = move5m > 0.8  && move15m > 1.2;
    const strongMoveDown = move5m < -0.8 && move15m < -1.2;

    if (!strongMoveUp && !strongMoveDown) return null;
    if (volSurge < 1.3) return null; // Need volume confirmation

    const direction = strongMoveUp ? 'LONG' : 'SHORT';
    const entry     = current.c;
    const stop      = strongMoveUp
      ? entry * (1 - TACTICAL_STOP_PCT * 2)
      : entry * (1 + TACTICAL_STOP_PCT * 2);
    const target    = strongMoveUp
      ? entry + (entry - stop) * TACTICAL_TARGET_MULT
      : entry - (stop - entry) * TACTICAL_TARGET_MULT;
    const rr        = Math.abs(target - entry) / Math.abs(entry - stop);

    return {
      type:       'MOMENTUM',
      ticker,
      direction,
      entry:      parseFloat(entry.toFixed(2)),
      stop:       parseFloat(stop.toFixed(2)),
      target1:    parseFloat(target.toFixed(2)),
      vwap:       vwap ? parseFloat(vwap.toFixed(2)) : null,
      rsi:        rsi,
      move5m:     parseFloat(move5m.toFixed(2)),
      move15m:    parseFloat(move15m.toFixed(2)),
      volSurge:   parseFloat(volSurge.toFixed(2)),
      riskReward: parseFloat(rr.toFixed(2)),
      signalScore: Math.min(95,
        55 +
        (Math.abs(move5m)  > 1.5 ? 10 : 5) +
        (Math.abs(move15m) > 2.0 ? 10 : 5) +
        (volSurge > 2 ? 10 : volSurge > 1.5 ? 5 : 0) +
        (vwap && direction === 'LONG' && entry > vwap ? 5 : 0) +
        (rsi && direction === 'LONG' && rsi > 50 && rsi < 75 ? 5 : 0)
      ),
      barsAnalysed: bars.length,
    };
  } catch(e) { return null; }
}

// ── REVERSAL SCANNER ──────────────────────────────────────────────
async function detectReversal(ticker) {
  try {
    const bars = await getIntradayBars(ticker, '5Min');
    if (bars.length < 12) return null;

    const vwap    = calcVWAP(bars);
    const rsi     = calcRSI(bars.map(b => b.c), 9);
    const current = bars[bars.length - 1];
    const prev3   = bars.slice(-4, -1);
    const price   = current.c;

    if (!vwap || !rsi) return null;

    const pctFromVWAP = (price - vwap) / vwap * 100;
    const extendedLong  = pctFromVWAP > 2.0 && rsi > 72; // Overbought, extended above VWAP
    const extendedShort = pctFromVWAP < -2.0 && rsi < 28; // Oversold, extended below VWAP

    if (!extendedLong && !extendedShort) return null;

    // Reversal candle: current bar closing against the trend
    const prevBarsUp = prev3.every((b, i) => i === 0 || b.c > prev3[i-1].c);
    const prevBarsDn = prev3.every((b, i) => i === 0 || b.c < prev3[i-1].c);
    const reversalCandle = extendedLong
      ? current.c < current.o && current.c < prev3[prev3.length-1].c
      : current.c > current.o && current.c > prev3[prev3.length-1].c;

    if (!reversalCandle && Math.abs(pctFromVWAP) < 3.0) return null;

    const direction = extendedLong ? 'SHORT' : 'LONG'; // Fade the move
    const entry     = price;
    const stop      = extendedLong
      ? current.h * 1.001  // Stop above candle high
      : current.l * 0.999; // Stop below candle low
    const target    = vwap; // Target = VWAP (mean reversion)
    const rr        = Math.abs(target - entry) / Math.abs(entry - stop);

    if (rr < 1.5) return null; // Not worth it

    return {
      type:         'REVERSAL',
      ticker,
      direction,
      entry:        parseFloat(entry.toFixed(2)),
      stop:         parseFloat(stop.toFixed(2)),
      target1:      parseFloat(target.toFixed(2)),
      vwap:         parseFloat(vwap.toFixed(2)),
      rsi:          rsi,
      pctFromVWAP:  parseFloat(pctFromVWAP.toFixed(2)),
      reversalCandle,
      riskReward:   parseFloat(rr.toFixed(2)),
      signalScore:  Math.min(95,
        58 +
        (reversalCandle ? 15 : 0) +
        (Math.abs(pctFromVWAP) > 3 ? 10 : 5) +
        (extendedLong ? (rsi > 78 ? 12 : 7) : (rsi < 22 ? 12 : 7))
      ),
      barsAnalysed: bars.length,
    };
  } catch(e) { return null; }
}

// ── 4-AGENT INTRADAY COMMITTEE ────────────────────────────────────
async function runTacticalAgents(signal) {
  try {
    const context = [
      'Type: ' + signal.type,
      'Ticker: ' + signal.ticker,
      'Direction: ' + signal.direction,
      'Entry: $' + signal.entry,
      'Stop: $' + signal.stop,
      'Target: $' + signal.target1,
      'R/R: ' + signal.riskReward,
      'Signal Score: ' + signal.signalScore,
      signal.vwap ? 'VWAP: $' + signal.vwap + ' (' + signal.pctFromVWAP + '% away)' : '',
      signal.rsi  ? 'RSI: ' + signal.rsi : '',
      signal.volSurge ? 'Volume Surge: ' + signal.volSurge + 'x' : '',
      signal.move5m ? '5min move: ' + signal.move5m + '%' : '',
      signal.move15m ? '15min move: ' + signal.move15m + '%' : '',
    ].filter(Boolean).join('. ');

    const agents = [
      { name: 'Flow',  focus: 'institutional volume patterns, unusual activity, order flow imbalance' },
      { name: 'Tape',  focus: 'price action, momentum, trend strength, intraday structure' },
      { name: 'News',  focus: 'potential catalysts, news events, sector momentum driving the move' },
      { name: 'Risk',  focus: 'reasons to REJECT this trade — spread risk, false breakout risk, market conditions' },
    ];

    const votes = [];
    let buyCount = 0;

    for (const agent of agents) {
      try {
        const prompt = 'Intraday ' + signal.direction + ' signal on ' + signal.ticker + '. ' + context + '. ' +
          'As the ' + agent.name + ' agent focusing only on ' + agent.focus + ': ' +
          'Vote BUY (take trade), SKIP (pass), or FADE (opposite direction). ' +
          'Reply ONLY: {"vote":"BUY|SKIP|FADE","confidence":0-100,"reason":"under 60 chars"}';

        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 80,
            messages: [{ role: 'user', content: prompt }]
          })
        });
        const d = await r.json();
        const text = d.content.map(b => b.type === 'text' ? b.text : '').join('');
        const match = text.match(/\{[\s\S]*?\}/);
        if (match) {
          const res = JSON.parse(match[0]);
          votes.push({ agent: agent.name, vote: res.vote || 'SKIP', confidence: res.confidence || 50, reason: res.reason || '' });
          if (res.vote === 'BUY') buyCount++;
        }
      } catch(e) {
        votes.push({ agent: agent.name, vote: 'SKIP', confidence: 50, reason: 'Agent error' });
      }
    }

    const consensus = Math.round(buyCount / agents.length * 100);
    const probability = Math.min(89, signal.signalScore * 0.5 + consensus * 0.5);

    return {
      votes,
      consensus,
      probability: Math.round(probability),
      buyCount,
      agentSummary: buyCount + '/' + agents.length + ' agents bullish',
      expectedMove: signal.direction === 'LONG'
        ? '$' + signal.entry + ' → $' + signal.target1 + ' (+' + ((signal.target1 - signal.entry) / signal.entry * 100).toFixed(2) + '%)'
        : '$' + signal.entry + ' → $' + signal.target1 + ' (' + ((signal.target1 - signal.entry) / signal.entry * 100).toFixed(2) + '%)',
    };
  } catch(e) {
    return { votes: [], consensus: 50, probability: 50, buyCount: 0, agentSummary: 'Committee unavailable', expectedMove: '--' };
  }
}

// ── MAIN TACTICAL SCAN ────────────────────────────────────────────
async function runTacticalScan() {
  if (tacticalState.scanRunning) return;
  if (!isMarketOpen()) { tlog('TACTICAL', 'Market closed — tactical scan skipped'); return; }

  tacticalState.scanRunning = true;
  tlog('TACTICAL', 'Starting tactical scan across ' + TACTICAL_UNIVERSE.length + ' symbols...');

  const signals = [];

  // Scan each ticker with all strategies
  for (const ticker of TACTICAL_UNIVERSE.slice(0, 12)) { // Limit to 12 per scan to control cost
    await new Promise(r => setTimeout(r, 200)); // Rate limit
    const [orb, vwap, momentum, reversal, relvol] = await Promise.all([
      detectORB(ticker),
      analyzeVWAPSetup(ticker),
      detectMomentum(ticker),
      detectReversal(ticker),
      calcRelativeVolume(ticker),
    ]);

    const found = [orb, vwap, momentum, reversal].filter(Boolean);
    for (const signal of found) {
      if (relvol) signal.relVol = relvol.relVol;

      // Skip if already have a signal for this ticker
      if (signals.find(s => s.ticker === signal.ticker)) continue;

      // Run agent committee
      tlog('TACTICAL', 'Running agents on ' + ticker + ' [' + signal.type + ']...');
      const agentResult = await runTacticalAgents(signal);
      signal.agents    = agentResult.votes;
      signal.probability  = agentResult.probability;
      signal.expectedMove = agentResult.expectedMove;
      signal.agentSummary = agentResult.agentSummary;
      signal.consensus    = agentResult.consensus;
      signal.foundAt      = new Date().toISOString();
      signal.id           = ticker + '_' + signal.type + '_' + Date.now();

      // Only include if at least 2/4 agents agree
      if (agentResult.buyCount >= 2) {
        signals.push(signal);
        tlog('TACTICAL', '✅ ' + ticker + ' [' + signal.type + '] ' + signal.direction + ' — agents ' + agentResult.agentSummary, { ticker, type: signal.type });
      } else {
        tlog('TACTICAL', '⏭ ' + ticker + ' [' + signal.type + '] skipped — only ' + agentResult.buyCount + '/4 agents');
      }
    }
  }

  // Sort by signal score
  signals.sort((a, b) => b.signalScore - a.signalScore);
  tacticalState.signals  = signals;
  tacticalState.lastScan = new Date().toISOString();
  tacticalState.scanRunning = false;

  tlog('TACTICAL', 'Scan complete — ' + signals.length + ' opportunities found', { count: signals.length });
  return signals;
}

// ── TACTICAL TRADE EXECUTION ──────────────────────────────────────
async function executeTacticalTrade(signalId, dollars) {
  const signal = tacticalState.signals.find(s => s.id === signalId);
  if (!signal) return { error: 'Signal not found' };
  dollars = Math.min(dollars || 1000, TACTICAL_MAX_DOLLARS);

  try {
    const account = await alpaca('/v2/account');
    const cash    = parseFloat(account.cash || 0);
    if (cash < dollars) return { error: 'Insufficient cash: $' + cash.toFixed(0) };

    const qty  = Math.floor(dollars / signal.entry);
    if (qty < 1) return { error: 'Position too small' };
    const side = signal.direction === 'LONG' ? 'buy' : 'sell';

    // Tag order as tactical
    const order = await alpaca('/v2/orders', 'POST', {
      symbol: signal.ticker, qty, side, type: 'market',
      time_in_force: 'day', // DAY order — never overnight
      client_order_id: 'TACTICAL_' + signal.id.substring(0, 20),
    });

    tlog('TACTICAL', '📈 Tactical ' + side.toUpperCase() + ' ' + signal.ticker + ' x' + qty + ' @ ~$' + signal.entry, {
      ticker: signal.ticker, dollars, qty, signalId
    });

    return { success: true, order, qty, dollars: qty * signal.entry };
  } catch(e) {
    return { error: e.message };
  }
}

// ── AUTO-CLOSE TACTICAL POSITIONS ─────────────────────────────────
// Called every 5 min — closes all TACTICAL_ tagged positions at 3:45 PM ET
async function checkTacticalClose() {
  if (!isMarketOpen()) return;

  const now    = new Date();
  const etHour = now.getUTCHours() - 4; // EDT
  const etMin  = now.getUTCMinutes();

  if (etHour !== TACTICAL_CLOSE_HOUR || etMin < TACTICAL_CLOSE_MIN) return;

  tlog('TACTICAL', '⏰ 3:45 PM ET — Auto-closing all tactical positions');

  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions)) return;

    const tacticalPositions = positions.filter(p =>
      p.asset_class !== 'crypto' && // Skip crypto
      !catalystSignals.find(s => s.ticker === p.symbol) // Not in swing engine
    );

    for (const pos of tacticalPositions) {
      try {
        await alpaca('/v2/positions/' + pos.symbol, 'DELETE', { percentage: 100 });
        const returnPct = parseFloat(pos.unrealized_plpc) * 100;
        tacticalState.pnl.realized += parseFloat(pos.unrealized_pl || 0);
        tacticalState.pnl.trades++;
        if (returnPct > 0) tacticalState.pnl.wins++;
        tacticalState.trades.push({
          ticker: pos.symbol, entryPrice: parseFloat(pos.avg_entry_price),
          exitPrice: parseFloat(pos.current_price), returnPct: parseFloat(returnPct.toFixed(2)),
          profitable: returnPct > 0, closedAt: new Date().toISOString(), reason: 'EOD_AUTO_CLOSE'
        });
        tlog('TACTICAL', '✅ Closed ' + pos.symbol + ' ' + (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%', { ticker: pos.symbol });
      } catch(e) {}
    }
  } catch(e) {}
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const etHour = now.getUTCHours() - 4;
  const etMin  = now.getUTCMinutes();
  const mins   = etHour * 60 + etMin;
  return mins >= 570 && mins <= 960; // 9:30 to 16:00 ET
}

// ── TACTICAL ROUTES ───────────────────────────────────────────────
app.get('/tactical/status',  (req, res) => res.json({ ...tacticalState, signals: tacticalState.signals.length, logCount: tacticalState.log.length }));
app.get('/tactical/signals', (req, res) => res.json(tacticalState.signals));
app.get('/tactical/log',     (req, res) => res.json(tacticalState.log.slice(0, 50)));
app.get('/tactical/trades',  (req, res) => res.json({ trades: tacticalState.trades, pnl: tacticalState.pnl }));
app.get('/tactical/pnl',     (req, res) => res.json(tacticalState.pnl));

app.post('/tactical/scan', async (req, res) => {
  if (tacticalState.scanRunning) return res.json({ message: 'Scan already running' });
  res.json({ message: 'Tactical scan started' });
  runTacticalScan();
});

app.post('/tactical/execute', async (req, res) => {
  const { signalId, dollars } = req.body || {};
  const result = await executeTacticalTrade(signalId, dollars);
  res.json(result);
});

app.post('/tactical/close-all', async (req, res) => {
  res.json({ message: 'Closing all tactical positions...' });
  try {
    const positions = await alpaca('/v2/positions');
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        await alpaca('/v2/positions/' + pos.symbol, 'DELETE', { percentage: 100 }).catch(() => {});
      }
    }
  } catch(e) {}
});

// Add tactical close check to existing scheduler

app.get('/cio-report',(req,res)=>res.json(cioReport||{message:'No report yet. Runs at 9am or trigger manually.'}));
app.post('/cio-now',(req,res)=>{res.json({message:'CIO report generating...'});generateCIOReport();});

// ── TRADE LOG — pulls full order history from Alpaca ──────────────
app.get('/trade-log', async (req, res) => {
  try {
    const limit = req.query.limit || 200;

    // Fetch all closed/filled orders from Alpaca
    const orders = await fetch(
      `${ALPACA_BASE}/v2/orders?status=closed&limit=${limit}&direction=desc`,
      { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
    ).then(r => r.json());

    if (!Array.isArray(orders)) return res.json({ orders: [], summary: {} });

    // Filter to filled orders only
    const filled = orders.filter(o => o.status === 'filled' && parseFloat(o.filled_qty) > 0);

    // Build enriched order list
    const trades = filled.map(o => {
      const qty    = parseFloat(o.filled_qty || 0);
      const price  = parseFloat(o.filled_avg_price || 0);
      const value  = qty * price;
      const isCrypto = o.asset_class === 'crypto';
      const isShort = o.side === 'sell' && !o.close_position; // sell without close = short

      return {
        id:          o.id,
        orderId:     o.id,
        symbol:      o.symbol,
        side:        o.side,
        type:        o.type,
        qty:         qty,
        price:       price,
        value:       parseFloat(value.toFixed(2)),
        filledAt:    o.filled_at || o.updated_at,
        createdAt:   o.created_at,
        isCrypto:    isCrypto,
        status:      o.status,
        timeInForce: o.time_in_force,
        displaySide: o.side === 'buy' ? 'BUY' : 'SELL/SHORT',
        assetClass:  o.asset_class,
      };
    });

    // Group by symbol to calculate round-trip P&L
    const bySymbol = {};
    trades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { buys: [], sells: [] };
      if (t.side === 'buy') bySymbol[t.symbol].buys.push(t);
      else bySymbol[t.symbol].sells.push(t);
    });

    // Calculate realized P&L per symbol
    const realizedPnL = [];
    Object.entries(bySymbol).forEach(([symbol, { buys, sells }]) => {
      if (buys.length > 0 && sells.length > 0) {
        const totalBought = buys.reduce((s, t) => s + t.value, 0);
        const totalSold   = sells.reduce((s, t) => s + t.value, 0);
        const pnl         = totalSold - totalBought;
        const pnlPct      = totalBought > 0 ? (pnl / totalBought * 100) : 0;
        realizedPnL.push({
          symbol,
          totalBought:  parseFloat(totalBought.toFixed(2)),
          totalSold:    parseFloat(totalSold.toFixed(2)),
          realizedPnl:  parseFloat(pnl.toFixed(2)),
          pnlPct:       parseFloat(pnlPct.toFixed(2)),
          profitable:   pnl > 0,
          buyCount:     buys.length,
          sellCount:    sells.length,
        });
      }
    });

    realizedPnL.sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl));

    // Summary stats
    const totalRealized    = realizedPnL.reduce((s, p) => s + p.realizedPnl, 0);
    const winners          = realizedPnL.filter(p => p.profitable);
    const losers           = realizedPnL.filter(p => !p.profitable);
    const winRate          = realizedPnL.length > 0 ? Math.round(winners.length / realizedPnL.length * 100) : 0;
    const avgWin           = winners.length > 0 ? winners.reduce((s,p)=>s+p.pnlPct,0)/winners.length : 0;
    const avgLoss          = losers.length  > 0 ? losers.reduce((s,p) =>s+p.pnlPct,0)/losers.length  : 0;

    res.json({
      orders: trades,
      realizedPnL,
      summary: {
        totalOrders:    trades.length,
        filledOrders:   trades.length,
        buyOrders:      trades.filter(t => t.side === 'buy').length,
        sellOrders:     trades.filter(t => t.side === 'sell').length,
        totalRealized:  parseFloat(totalRealized.toFixed(2)),
        winRate,
        winners:        winners.length,
        losers:         losers.length,
        avgWinPct:      parseFloat(avgWin.toFixed(2)),
        avgLossPct:     parseFloat(avgLoss.toFixed(2)),
        symbolsTraded:  Object.keys(bySymbol).length,
      },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/scan-now',(req,res)=>{res.json({message:'Catalyst scan triggered'});runCatalystScan();});
app.post('/earnings-now',(req,res)=>{res.json({message:'Earnings scan triggered'});runEarningsPrePositioning();});
app.get('/earnings/history/:ticker', async (req, res) => {
  try {
    const impact = await getHistoricalEarningsImpact(req.params.ticker.toUpperCase());
    res.json(impact || { error: 'No historical data found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/earnings-test', async (req,res)=>{
  // Debug endpoint: directly call Finnhub and return raw results
  try {
    if (!FINNHUB_KEY) return res.json({error:'FINNHUB_KEY not set in Render environment'});
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(); future.setDate(future.getDate()+7);
    const to = future.toISOString().split('T')[0];
    const raw = await fetch(`${FINNHUB_BASE}/calendar/earnings?from=${today}&to=${to}&token=${FINNHUB_KEY}`).then(r=>r.json());
    res.json({
      finnhubKeySet: !!FINNHUB_KEY,
      dateRange: {from:today, to},
      totalReturned: raw?.earningsCalendar?.length||0,
      sample: raw?.earningsCalendar?.slice(0,5)||[],
      rawResponse: raw,
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/analytics',(req,res)=>res.json(getPerformanceAnalytics()||{}));
app.get('/agent-stats',(req,res)=>getAgentStats().then(d=>res.json(d)).catch(()=>res.json([])));
app.get('/regime',      (req, res) => res.json(currentRegime));
app.get('/rankings',    (req, res) => res.json(rankOpportunities()));
app.get('/genome',      (req, res) => res.json(buildStrategyGenome()));
app.get('/agent-weights', (req, res) => res.json(agentWeights));
app.get('/signal-memory', async (req, res) => {
  try {
    const rows = await dbSelect('signal_memory',
      'order=recorded_at.desc&limit=100'
    );
    const summary = {
      executed:  rows.filter(r=>r.disposition==='EXECUTED').length,
      rejected:  rows.filter(r=>r.disposition?.startsWith('REJECTED')).length,
      expired:   rows.filter(r=>r.disposition==='EXPIRED').length,
      totalSignals: rows.length,
    };
    res.json({ summary, signals: rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/portfolio-risk', async (req, res) => {
  try { res.json(await analyzePortfolioConcentration()); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/shorts', async (req, res) => {
  try {
    const positions = await alpaca('/v2/positions');
    const shortPositions = Array.isArray(positions)
      ? positions.filter(p => parseFloat(p.qty) < 0)
      : [];
    const shortSignals = catalystSignals.filter(s => s.signal === 'SHORT' || s.type === 'SHORT');
    res.json({
      activeShortPositions: shortPositions,
      pendingShortSignals: shortSignals,
      diagnostics: getShortsDiagnostics(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/shorts-debug', (req, res) => res.json(getShortsDiagnostics()));

app.post('/test-shortable/:ticker', async (req, res) => {
  try {
    const a = await alpaca('/v2/assets/' + req.params.ticker);
    res.json({
      ticker: req.params.ticker,
      shortable: a.shortable,
      easyToBorrow: a.easy_to_borrow,
      canShort: a.shortable && a.easy_to_borrow,
      assetDetails: { status: a.status, tradable: a.tradable, fractionable: a.fractionable },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/technical/:ticker', async (req,res)=>{
  try {
    const analysis = await getTechnicalAnalysis(req.params.ticker);
    res.json(analysis);
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/similarity/:ticker',(req,res)=>{
  const sig={ticker:req.params.ticker,catalyst:req.query.catalyst||'',signalScore:parseInt(req.query.score)||70,signal:req.query.signal||'BUY'};
  res.json(calculateHistoricalSimilarity(sig));
});
app.get('/earnings', async (req, res) => {
  // 1. Serve from memory (instant)
  if (upcomingEarnings.length > 0) {
    return res.json(upcomingEarnings.slice(0, 50).map(e => ({
      ticker: e.ticker, report_date: e.date,
      report_time: e.time, eps_estimate: e.epsEstimate,
      revenue_estimate: e.revenueEstimate,
    })));
  }
  // 2. Try Supabase
  try {
    const rows = await dbSelect('earnings_calendar', 'order=report_date.asc&limit=50');
    if (Array.isArray(rows) && rows.length) {
      upcomingEarnings = rows.map(r => ({
        ticker: r.ticker, date: r.report_date, time: r.report_time,
        epsEstimate: r.eps_estimate, revenueEstimate: r.revenue_estimate,
      }));
      return res.json(rows);
    }
  } catch(e) {}
  // 3. Last resort: fetch directly from Finnhub right now
  try {
    if (FINNHUB_KEY) {
      const fresh = await getUpcomingEarnings(7);
      if (fresh.length) {
        upcomingEarnings = fresh;
        return res.json(fresh.map(e => ({
          ticker: e.ticker, report_date: e.date,
          report_time: e.time, eps_estimate: e.epsEstimate,
          revenue_estimate: e.revenueEstimate,
        })));
      }
    }
  } catch(e) {}
  res.json([]);
});
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
