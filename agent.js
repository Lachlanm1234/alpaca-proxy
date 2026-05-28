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
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ALPACA_BASE   = 'https://paper-api.alpaca.markets';
const ALPACA_DATA   = 'https://data.alpaca.markets';

const INTEL_TIMES       = ['09:00', '15:30'];
const CATALYST_INTERVAL = 120;  // minutes between catalyst scans (market hours)
const CRYPTO_INTERVAL   = 240;  // minutes between crypto scans (24/7)
const TRADE_CHECK_MINS  = 30;   // minutes between trade checks (no Claude call)

const CRYPTO_SYMBOLS = ['BTC/USD','ETH/USD','SOL/USD','AVAX/USD','LINK/USD','DOGE/USD'];

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status: 'IDLE',
  lastIntel: null,
  lastCatalyst: null,
  lastCrypto: null,
  lastTradeCheck: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};
let decisionLog     = [];
let pendingQueue    = [];
let catalystSignals = []; // stocks: LONG and SHORT signals
let cryptoSignals   = []; // crypto signals

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 300) decisionLog.length = 300;
  console.log('[' + type + '] ' + message);
}

// ── ALPACA HELPERS ────────────────────────────────────────────────
async function alpaca(path, opts) {
  opts = opts || {};
  const r = await fetch(ALPACA_BASE + path, {
    method: opts.method || 'GET',
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Content-Type': 'application/json'
    },
    body: opts.body || undefined,
  });
  return r.json();
}

async function checkMarket() {
  try {
    const c = await alpaca('/v2/clock');
    state.isMarketOpen = c.is_open;
    return c.is_open;
  } catch(e) { return false; }
}

async function getLivePrice(ticker) {
  try {
    const isCrypto = ticker.includes('/');
    const endpoint = isCrypto
      ? `${ALPACA_DATA}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(ticker)}`
      : `${ALPACA_DATA}/v2/stocks/${ticker}/quotes/latest`;
    const r = await fetch(endpoint, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
    });
    const d = await r.json();
    if (isCrypto) {
      const quote = d.quotes && d.quotes[ticker];
      return parseFloat(quote?.ap || quote?.bp || 0);
    }
    return parseFloat(d.quote?.ap || d.quote?.bp || 0);
  } catch(e) { return 0; }
}

async function isShortable(ticker) {
  try {
    const asset = await alpaca('/v2/assets/' + ticker);
    return asset.shortable && asset.easy_to_borrow;
  } catch(e) { return false; }
}

// ── CLAUDE ────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens) {
  maxTokens = maxTokens || 700;
  const fullSystem = systemPrompt + '\n\nCRITICAL: Return ONLY a valid JSON object. No text before or after. Start with { end with }.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: fullSystem,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.content.map(b => b.type === 'text' ? b.text : '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON: ' + clean.substring(0, 100));
  return JSON.parse(match[0]);
}

// ── 1. INTEL SCAN (9am + 3:30pm ET) ──────────────────────────────
async function runIntelScan(timing) {
  state.status = 'INTEL_SCAN';
  state.lastIntel = new Date().toISOString();
  log('INTEL', '📰 Running ' + timing + ' intelligence scan');

  const prompt = `Market intelligence agent. Search for ONLY these actionable events from last 12 hours that directly move stock prices:
- Earnings: EPS actual vs estimate, revenue vs estimate, guidance changes
- Fed/rates: decisions or statements affecting markets
- Analyst upgrades/downgrades with price targets from major banks
- M&A announcements
- Significant insider buying or selling (SEC Form 4 filings)
- Short squeeze setups: high short interest + rising price + volume
NO general news. Only price-moving events tied to specific stocks.
Return ONLY JSON:
{"timing":"${timing}","marketContext":"One sentence market tone","actionableEvents":[{"ticker":"NVDA","event":"Earnings beat","detail":"EPS $5.16 vs $4.88 est (+5.7%). Revenue beat. Raised guidance.","impact":"BULLISH","urgency":"HIGH"},{"ticker":"TSLA","event":"Earnings miss","detail":"EPS $0.27 vs $0.41 est (-34%). Margin compression.","impact":"BEARISH","urgency":"HIGH"}],"sectorRotation":"One sentence on sectors","keyRisks":"Main risk today"}
Max 4 events. Return ONLY JSON.`;

  try {
    const intel = await callClaude(prompt,
      'Search earnings results vs EPS estimates, analyst upgrades/downgrades, insider buys/sells, Fed statements from last 12 hours.',
      600
    );
    log('INTEL', '🌍 ' + (intel.marketContext || ''), { marketContext: intel.marketContext });
    (intel.actionableEvents || []).forEach(ev => {
      log('INTEL', '📌 ' + ev.ticker + ' — ' + ev.event + ': ' + ev.detail, {
        ticker: ev.ticker, impact: ev.impact, urgency: ev.urgency,
        event: ev.event, detail: ev.detail,
      });
    });
    if (intel.sectorRotation) log('INTEL', '🔄 ' + intel.sectorRotation);
    if (intel.keyRisks)       log('INTEL', '⚠️ Risk: ' + intel.keyRisks);
  } catch(e) { log('ERROR', 'Intel scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 2. CATALYST SCAN — STOCKS (every 2hrs, market hours) ──────────
// Finds LONG and SHORT signals with hard data catalysts
async function runCatalystScan() {
  state.status = 'CATALYST_SCAN';
  state.lastCatalyst = new Date().toISOString();
  log('CATALYST', '🔬 Running stock catalyst scan — longs AND shorts...');

  const prompt = `Quantitative trading agent. Search for stocks with strong LONG or SHORT catalysts right now.
LONG signals to find: earnings beats (EPS > estimate 5%+), analyst upgrades, insider buying, unusual call options, short squeeze setups.
SHORT signals to find: earnings misses (EPS < estimate 5%+), guidance cuts, analyst downgrades, insider selling, technical breakdowns, high short interest with price breakdown.
Find 1 strong LONG and 1 strong SHORT opportunity. Give precise entry logic for each.
Return ONLY JSON:
{"catalysts":[{"ticker":"NVDA","companyName":"NVIDIA","type":"LONG","catalyst":"Earnings beat","detail":"Q1 EPS $5.16 beat $4.88 est by 5.7%. Revenue $26B beat. Raised Q2 guidance.","signal":"BUY","signalScore":88,"confidence":82,"entryLogic":"Buy at open or dip below $870","targetPrice":950,"stopLoss":820,"expectedReturn":"+8.9%","timeframe":"5-15 days","thesis":"Earnings beat with raised guidance drives 8-12% move historically"},{"ticker":"TSLA","companyName":"Tesla","type":"SHORT","catalyst":"Earnings miss + guidance cut","detail":"EPS $0.27 vs $0.41 est (-34%). Margins compressed. Lowered FY guidance.","signal":"SHORT","signalScore":81,"confidence":76,"entryLogic":"Short at market or bounce to $175","targetPrice":145,"stopLoss":185,"expectedReturn":"+14.2%","timeframe":"5-20 days","thesis":"Earnings miss with guidance cut typically drives 10-15% decline"}]}
type: LONG or SHORT. signal: BUY (for longs) or SHORT (for shorts). Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'Search for one strong LONG and one strong SHORT stock opportunity right now based on earnings vs EPS estimates, analyst actions, insider activity, options flow.',
      900
    );
    const newSignals = result.catalysts || [];
    newSignals.forEach(signal => {
      const existing = catalystSignals.findIndex(s => s.ticker === signal.ticker);
      signal.foundAt = new Date().toISOString();
      if (existing >= 0) catalystSignals[existing] = signal;
      else catalystSignals.push(signal);
    });
    if (catalystSignals.length > 20) catalystSignals = catalystSignals.slice(-20);

    newSignals.forEach(s => {
      const emoji = s.type === 'SHORT' ? '🔻' : '🔺';
      log('CATALYST', emoji + ' ' + s.type + ': ' + s.ticker + ' [' + s.catalyst + '] ' + s.detail, {
        ticker: s.ticker, signal: s.signal, type: s.type,
        signalScore: s.signalScore, confidence: s.confidence,
        thesis: s.thesis, catalyst: s.catalyst, entryLogic: s.entryLogic,
        targetPrice: s.targetPrice, stopLoss: s.stopLoss, expectedReturn: s.expectedReturn,
      });
    });
    state.scansCompleted++;
    log('CATALYST', '✅ Stock catalyst scan complete — ' + newSignals.length + ' new signals');
  } catch(e) { log('ERROR', 'Catalyst scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 3. CRYPTO SCAN (every 4hrs, 24/7) ────────────────────────────
// Runs around the clock since crypto never sleeps
async function runCryptoScan() {
  state.status = 'CRYPTO_SCAN';
  state.lastCrypto = new Date().toISOString();
  log('CRYPTO', '₿ Running crypto scan — BTC, ETH, SOL and more...');

  const prompt = `Crypto trading agent. Search for the strongest buy or sell signal across major cryptocurrencies right now: BTC, ETH, SOL, AVAX, LINK, DOGE.
Look for: price breakouts above/below key levels, RSI overbought/oversold, on-chain data (whale activity, exchange inflows/outflows), funding rates, social sentiment spikes, major protocol news, regulatory developments.
Find the 1 strongest crypto signal right now.
Return ONLY JSON:
{"cryptoSignals":[{"symbol":"BTC/USD","name":"Bitcoin","signal":"BUY","signalScore":82,"confidence":76,"currentPrice":68500,"catalyst":"Broke above $68k resistance with high volume, ETF inflows surging","detail":"Spot ETF saw $500M inflow today. RSI at 58 (not overbought). Whale wallets accumulating.","entryLogic":"Buy at market, add on dips to $66k","targetPrice":75000,"stopLoss":64000,"expectedReturn":"+9.5%","timeframe":"3-10 days","thesis":"ETF demand + technical breakout = bullish continuation"}]}
symbol must be one of: BTC/USD, ETH/USD, SOL/USD, AVAX/USD, LINK/USD, DOGE/USD. signal: BUY or SELL. Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'Search for the strongest crypto trading signal right now across BTC, ETH, SOL, AVAX, LINK, DOGE. Check price levels, RSI, on-chain data, sentiment, news.',
      700
    );
    const newSignals = result.cryptoSignals || [];
    newSignals.forEach(signal => {
      const existing = cryptoSignals.findIndex(s => s.symbol === signal.symbol);
      signal.foundAt = new Date().toISOString();
      signal.isCrypto = true;
      if (existing >= 0) cryptoSignals[existing] = signal;
      else cryptoSignals.push(signal);
    });
    if (cryptoSignals.length > 10) cryptoSignals = cryptoSignals.slice(-10);

    newSignals.forEach(s => {
      const emoji = s.signal === 'BUY' ? '🟢' : '🔴';
      log('CRYPTO', emoji + ' ' + s.signal + ': ' + s.symbol + ' — ' + s.catalyst, {
        ticker: s.symbol, signal: s.signal, signalScore: s.signalScore,
        confidence: s.confidence, thesis: s.thesis, catalyst: s.catalyst,
        targetPrice: s.targetPrice, stopLoss: s.stopLoss, expectedReturn: s.expectedReturn,
        isCrypto: true,
      });
    });
    log('CRYPTO', '✅ Crypto scan complete — ' + newSignals.length + ' signal(s)');
  } catch(e) { log('ERROR', 'Crypto scan failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── 4. TRADE CHECK (every 30min, no Claude call) ──────────────────
async function runTradeCheck() {
  state.lastTradeCheck = new Date().toISOString();
  state.status = 'TRADE_CHECK';

  try {
    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);
    const positions = await alpaca('/v2/positions');

    // Manage existing positions (stop loss / take profit)
    await managePositions(positions);

    // Execute pending queue if market is open
    const isOpen = await checkMarket();
    if (isOpen && pendingQueue.length > 0) {
      buyingPower = await executePendingQueue(portfolio, buyingPower, positions);
    }

    const openCount = Array.isArray(positions) ? positions.length : 0;
    if (openCount >= 12) {
      log('TRADE', 'Max positions reached (12)');
      state.status = 'IDLE';
      return;
    }

    const allSignals = [
      ...catalystSignals.map(s => ({ ...s, ticker: s.ticker })),
      ...cryptoSignals.map(s => ({ ...s, ticker: s.symbol })),
    ];

    if (allSignals.length === 0) {
      log('TRADE', '⏳ No signals yet — awaiting next scan');
      state.status = 'IDLE';
      return;
    }

    log('TRADE', '💹 Trade check — ' + allSignals.length + ' signal(s) | Market: ' + (isOpen ? 'OPEN' : 'CLOSED'));

    for (const signal of allSignals) {
      try {
        const ticker = signal.ticker;
        const isCrypto = signal.isCrypto || ticker.includes('/');
        const isShort = signal.signal === 'SHORT';

        // Crypto trades 24/7, stocks only during market hours
        if (!isCrypto && !isOpen) continue;

        // Skip if already holding this position
        const holding = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
        if (holding) continue;

        // Skip if already queued
        if (pendingQueue.find(p => p.ticker === ticker)) continue;

        // Signal freshness (stocks: 24hr, crypto: 48hr)
        const maxAge = isCrypto ? 48 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        const signalAge = signal.foundAt ? Date.now() - new Date(signal.foundAt).getTime() : 999999999;
        if (signalAge > maxAge) {
          log('TRADE', '🗑 Expired signal removed: ' + ticker);
          if (isCrypto) cryptoSignals = cryptoSignals.filter(s => s.symbol !== ticker);
          else catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);
          continue;
        }

        // Get live price
        const livePrice = await getLivePrice(ticker);
        if (!livePrice) continue;

        const score = signal.signalScore || 0;
        const conf = signal.confidence || 0;
        const target = parseFloat(signal.targetPrice || 0);
        const stop = parseFloat(signal.stopLoss || 0);

        // For LONG: price must be above stop and below target
        // For SHORT: price must be below stop (their stop is above) and above target (their target is below)
        const longValid = !isShort && livePrice > stop && livePrice < target;
        const shortValid = isShort && livePrice < stop && livePrice > target;
        const cryptoBuyValid = isCrypto && signal.signal === 'BUY' && livePrice > stop && livePrice < target;

        if (longValid || shortValid || cryptoBuyValid) {
          // Check shortability for short trades
          if (isShort && !isCrypto) {
            const canShort = await isShortable(ticker);
            if (!canShort) {
              log('TRADE', '⏭ ' + ticker + ' not shortable — skip');
              continue;
            }
          }

          const dollars = positionDollars(portfolio, score, conf);
          if (!dollars || dollars > buyingPower) continue;

          const side = isShort ? 'sell' : 'buy';
          const typeLabel = isCrypto ? 'CRYPTO' : isShort ? 'SHORT' : 'LONG';
          const emoji = isShort ? '🔻' : '🟢';

          log('TRADE', emoji + ' EXECUTING ' + typeLabel + ': ' + ticker +
            ' @ $' + livePrice.toFixed(2) + ' | $' + dollars.toFixed(0) +
            ' | ' + (signal.thesis || ''), {
            ticker, dollars, livePrice, side, typeLabel,
            signalScore: score, confidence: conf,
            thesis: signal.thesis, catalyst: signal.catalyst, isCrypto,
          });

          await placeOrder(ticker, dollars, side, signal, isCrypto);
          buyingPower -= dollars;

          // Remove executed signal
          if (isCrypto) cryptoSignals = cryptoSignals.filter(s => s.symbol !== ticker);
          else catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);
        }

        await new Promise(r => setTimeout(r, 1000));
      } catch(e) { log('ERROR', 'Trade check error for ' + signal.ticker + ': ' + e.message); }
    }

  } catch(e) { log('ERROR', 'Trade check failed: ' + e.message); }
  state.status = 'IDLE';
}

// ── POSITION SIZING ───────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c = score * 0.6 + confidence * 0.4;
  // Slightly smaller for crypto/shorts due to higher volatility
  if (c >= 85) return portfolio * 0.08;
  if (c >= 78) return portfolio * 0.06;
  if (c >= 72) return portfolio * 0.04;
  if (c >= 65) return portfolio * 0.02;
  return 0;
}

// ── PLACE ORDER ───────────────────────────────────────────────────
async function placeOrder(ticker, dollars, side, analysis, isCrypto) {
  try {
    // Check if already holding
    const positions = await alpaca('/v2/positions');
    const holding = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
    if (holding && side === 'buy') { log('TRADE', 'Already holding ' + ticker); return null; }

    const order = await alpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: ticker,
        notional: dollars.toFixed(2),
        side,
        type: 'market',
        time_in_force: isCrypto ? 'gtc' : 'day', // crypto uses gtc
      })
    });

    if (order.id) {
      state.tradesExecuted++;
      pendingQueue = pendingQueue.filter(p => p.ticker !== ticker);
      const typeLabel = isCrypto ? '₿ CRYPTO' : side === 'sell' ? '🔻 SHORT' : '🟢 LONG';
      log('TRADE', typeLabel + ' executed: ' + ticker + ' $' + dollars.toFixed(0), {
        ticker, side, dollars, orderId: order.id, isCrypto,
        thesis: analysis && analysis.thesis,
        catalyst: analysis && analysis.catalyst,
      });
    } else {
      log('ERROR', 'Order rejected ' + ticker + ': ' + JSON.stringify(order).substring(0, 150));
    }
    return order;
  } catch(e) { log('ERROR', 'Order failed ' + ticker + ': ' + e.message); return null; }
}

// ── MANAGE POSITIONS ──────────────────────────────────────────────
async function managePositions(positions) {
  if (!positions) positions = await alpaca('/v2/positions');
  if (!Array.isArray(positions) || !positions.length) return;

  for (const p of positions) {
    const pnl = parseFloat(p.unrealized_plpc) * 100;
    const isCrypto = p.asset_class === 'crypto';
    const isShort = parseFloat(p.qty) < 0;

    // Wider stops for crypto due to volatility
    const stopThreshold = isCrypto ? -12 : -8;
    const profitThreshold = isCrypto ? 25 : 20;

    if (pnl <= stopThreshold) {
      const label = isShort ? 'SHORT stop loss' : 'Stop loss';
      log('RISK', '🛑 ' + label + ': ' + p.symbol + ' at ' + pnl.toFixed(1) + '%', {
        ticker: p.symbol, pnlPct: pnl, reason: 'STOP_LOSS', isShort, isCrypto
      });
      await alpaca('/v2/positions/' + encodeURIComponent(p.symbol), { method: 'DELETE' });
    } else if (pnl >= profitThreshold) {
      const label = isShort ? 'SHORT take profit' : 'Take profit';
      log('PROFIT', '🎯 ' + label + ': ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', {
        ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT', isShort, isCrypto
      });
      await alpaca('/v2/positions/' + encodeURIComponent(p.symbol), { method: 'DELETE' });
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
      const dollars = positionDollars(portfolio, item.signalScore, item.confidence);
      if (!dollars || dollars > buyingPower) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      const side = item.signal === 'SHORT' ? 'sell' : 'buy';
      await placeOrder(item.ticker, dollars, side, item, item.isCrypto);
      buyingPower -= dollars;
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) { log('ERROR', 'Queue order failed ' + item.ticker + ': ' + e.message); }
  }
  return buyingPower;
}

// ── SCHEDULER ─────────────────────────────────────────────────────
function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hhmm = et.getHours().toString().padStart(2,'0') + ':' + et.getMinutes().toString().padStart(2,'0');
  const day = et.getDay();
  const totalMins = et.getHours() * 60 + et.getMinutes();
  const isMarket = day >= 1 && day <= 5 && totalMins >= 9*60+30 && totalMins <= 16*60;
  return { hhmm, isMarket };
}

function minutesSince(isoStr) {
  if (!isoStr) return 9999;
  return (Date.now() - new Date(isoStr).getTime()) / 60000;
}

async function scheduler() {
  if (!['IDLE','MARKET_CLOSED'].includes(state.status)) return;

  const { hhmm, isMarket } = getETTime();

  // Intel at 9:00am and 3:30pm ET
  if (INTEL_TIMES.includes(hhmm)) {
    const timing = hhmm < '12:00' ? 'pre-market' : 'pre-close';
    await runIntelScan(timing);
    return;
  }

  // Crypto scan runs 24/7
  if (minutesSince(state.lastCrypto) >= CRYPTO_INTERVAL) {
    await runCryptoScan();
    return;
  }

  if (isMarket) {
    state.isMarketOpen = true;
    if (minutesSince(state.lastCatalyst) >= CATALYST_INTERVAL) {
      await runCatalystScan();
    } else if (minutesSince(state.lastTradeCheck) >= TRADE_CHECK_MINS) {
      await runTradeCheck();
    }
  } else {
    state.isMarketOpen = false;
    state.status = 'MARKET_CLOSED';
    // Still run trade check for crypto even when market is closed
    if (cryptoSignals.length > 0 && minutesSince(state.lastTradeCheck) >= TRADE_CHECK_MINS) {
      await runTradeCheck();
    }
  }
}

setInterval(scheduler, 5 * 60 * 1000);
log('AGENT', '🤖 Agent started — Intel: 9am+3:30pm ET | Stocks: every 2hrs | Crypto: every 4hrs 24/7 | Trade: every 30min');

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
}));

app.get('/log',      (req, res) => res.json(decisionLog.slice(0, 100)));
app.get('/pending',  (req, res) => res.json(pendingQueue));
app.get('/signals',  (req, res) => res.json([...catalystSignals, ...cryptoSignals]));
app.get('/health',   (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/scan-now',    (req, res) => { res.json({ message: 'Catalyst scan triggered' }); runCatalystScan(); });
app.post('/crypto-now',  (req, res) => { res.json({ message: 'Crypto scan triggered' }); runCryptoScan(); });
app.post('/intel-now',   (req, res) => { res.json({ message: 'Intel scan triggered' }); runIntelScan('manual'); });
app.post('/trade-now',   (req, res) => { res.json({ message: 'Trade check triggered' }); runTradeCheck(); });
app.post('/clear-queue', (req, res) => {
  const n = pendingQueue.length; pendingQueue = [];
  log('AGENT', '🗑 Queue cleared (' + n + ' removed)');
  res.json({ cleared: n });
});

app.use(express.static(__dirname));

app.listen(3001, () => {
  log('AGENT', '🤖 Market Intelligence Agent running on port 3001');
  setTimeout(runCryptoScan, 15000);   // Crypto scan on startup (15s)
  setTimeout(runCatalystScan, 45000); // Stock catalyst scan (45s)
});
