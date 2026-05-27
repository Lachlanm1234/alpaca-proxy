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

// Schedule config (all times ET)
const INTEL_TIMES        = ['09:00', '15:30']; // 2x per day
const CATALYST_INTERVAL  = 120;                 // every 2 hours during market hours
const TRADE_CHECK_MINS   = 30;                  // every 30 min, no Claude call

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status: 'IDLE',
  lastIntel: null,
  lastCatalyst: null,
  lastTradeCheck: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};

let decisionLog  = [];
let pendingQueue = [];      // BUY signals queued while market closed
let catalystSignals = [];   // Latest signals from catalyst scan — reused by trade checker

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 300) decisionLog.length = 300;
  console.log('[' + type + '] ' + message);
}

// ── ALPACA ────────────────────────────────────────────────────────
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

// Get live price for a ticker from Alpaca (free, no Claude call)
async function getLivePrice(ticker) {
  try {
    const r = await fetch(
      `${ALPACA_DATA}/v2/stocks/${ticker}/quotes/latest`,
      { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
    );
    const d = await r.json();
    return parseFloat(d.quote?.ap || d.quote?.bp || 0);
  } catch(e) { return 0; }
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

// ── 1. INTELLIGENCE SCAN (2x/day, ~$0.10 each) ───────────────────
// Runs at 9am and 3:30pm ET. Focused only on actionable market context.
async function runIntelScan(timing) {
  state.status = 'INTEL_SCAN';
  state.lastIntel = new Date().toISOString();
  log('INTEL', '📰 Running ' + timing + ' intelligence scan');

  const prompt = `You are a market intelligence agent. Search for ONLY actionable financial events from the last 12 hours that directly move stock prices:
- Earnings reports: EPS actual vs estimate, revenue vs estimate, guidance
- Fed/interest rate decisions or statements
- Major analyst upgrades/downgrades with price targets
- Merger/acquisition announcements
- Significant insider buying (SEC filings)
- Short squeeze candidates (high short interest + rising price)
Do NOT include general news or geopolitical fluff unless it directly impacts a specific stock.
Return ONLY JSON:
{"timing":"${timing}","marketContext":"One sentence on overall market tone","actionableEvents":[{"ticker":"NVDA","event":"Earnings beat","detail":"EPS $5.16 vs $4.88 est, revenue $26B vs $24.6B est","impact":"BULLISH","urgency":"HIGH"},{"ticker":"AAPL","event":"Analyst upgrade","detail":"Goldman raises PT from $200 to $240, Buy rating","impact":"BULLISH","urgency":"MEDIUM"}],"sectorRotation":"Which sectors are gaining/losing today in one sentence","keyRisks":"Main risk to watch today in one sentence"}
Max 4 events. Return ONLY JSON.`;

  try {
    const intel = await callClaude(prompt,
      'Search for earnings results, analyst upgrades, insider buying, Fed statements, and M&A from the last 12 hours that will move stock prices today.',
      600
    );

    log('INTEL', '🌍 ' + (intel.marketContext || ''), { marketContext: intel.marketContext });

    (intel.actionableEvents || []).forEach(ev => {
      log('INTEL', '📌 ' + ev.ticker + ' — ' + ev.event + ': ' + ev.detail, {
        ticker: ev.ticker,
        impact: ev.impact,
        urgency: ev.urgency,
        event: ev.event,
        detail: ev.detail,
      });
    });

    if (intel.sectorRotation) log('INTEL', '🔄 ' + intel.sectorRotation);
    if (intel.keyRisks) log('INTEL', '⚠️ Risk: ' + intel.keyRisks);

  } catch(e) {
    log('ERROR', 'Intel scan failed: ' + e.message);
  }
  state.status = 'IDLE';
}

// ── 2. CATALYST SCAN (every 2hrs, ~$0.40 each) ───────────────────
// Finds specific stocks with hard catalysts. Stores signals for trade checker.
async function runCatalystScan() {
  state.status = 'CATALYST_SCAN';
  state.lastCatalyst = new Date().toISOString();
  log('CATALYST', '🔬 Running catalyst scan — searching earnings, EPS, options flow, insider activity...');

  const prompt = `You are a quantitative trading agent. Search for stocks with HARD catalysts right now — meaning specific data-driven events that historically move prices:
1. Earnings beats: EPS > estimate by 5%+, revenue beat, raised guidance
2. Earnings misses: EPS < estimate, revenue miss, lowered guidance
3. Unusual options activity: large call buying indicating insider knowledge
4. Insider buying: executives buying their own stock (SEC Form 4)
5. Short squeeze setup: high short interest % + rising price + volume spike
6. Analyst price target raises: meaningful upgrades from major banks
Find 2 stocks with the strongest catalysts. For each give a precise BUY or SELL signal with exact entry logic.
Return ONLY JSON:
{"catalysts":[{"ticker":"NVDA","companyName":"NVIDIA Corp","catalyst":"Earnings beat","detail":"Q1 EPS $5.16 beat $4.88 est by 5.7%. Revenue $26B beat $24.6B. Raised Q2 guidance.","signal":"BUY","signalScore":88,"confidence":82,"entryLogic":"Buy on open or any dip below $870","targetPrice":950,"stopLoss":820,"expectedReturn":"+8.9%","timeframe":"5-15 days","thesis":"Earnings beat with raised guidance historically drives 8-12% move in first week"},{"ticker":"PLTR","companyName":"Palantir","catalyst":"Insider buying","detail":"CEO Alex Karp bought 500K shares at $24.50 via SEC Form 4","signal":"BUY","signalScore":79,"confidence":74,"entryLogic":"Buy at market, strong insider conviction signal","targetPrice":29,"stopLoss":22,"expectedReturn":"+18.4%","timeframe":"10-30 days","thesis":"CEO buying 500K shares is rare high-conviction signal"}]}
Return ONLY JSON.`;

  try {
    const result = await callClaude(prompt,
      'Search for stocks with earnings beats/misses vs EPS estimates, unusual options activity, insider buying from SEC filings, and short squeeze setups right now. Give precise entry signals.',
      900
    );

    const newSignals = result.catalysts || [];

    // Merge with existing signals (don't duplicate tickers)
    newSignals.forEach(signal => {
      const existing = catalystSignals.findIndex(s => s.ticker === signal.ticker);
      signal.foundAt = new Date().toISOString();
      if (existing >= 0) {
        catalystSignals[existing] = signal; // Update
      } else {
        catalystSignals.push(signal);
      }
    });

    // Keep only last 20 signals
    if (catalystSignals.length > 20) catalystSignals = catalystSignals.slice(-20);

    newSignals.forEach(s => {
      log('CATALYST', '🎯 ' + s.ticker + ' [' + s.catalyst + '] — ' + s.detail, {
        ticker: s.ticker,
        signal: s.signal,
        signalScore: s.signalScore,
        confidence: s.confidence,
        thesis: s.thesis,
        catalyst: s.catalyst,
        entryLogic: s.entryLogic,
        targetPrice: s.targetPrice,
        stopLoss: s.stopLoss,
        expectedReturn: s.expectedReturn,
      });
    });

    log('CATALYST', '✅ Catalyst scan complete — ' + newSignals.length + ' new signals. Total active: ' + catalystSignals.length);
    state.scansCompleted++;

  } catch(e) {
    log('ERROR', 'Catalyst scan failed: ' + e.message);
  }
  state.status = 'IDLE';
}

// ── 3. TRADE CHECK (every 30min, NO Claude call) ──────────────────
// Re-evaluates existing catalyst signals against live prices. Nearly free.
async function runTradeCheck() {
  const isOpen = await checkMarket();
  state.lastTradeCheck = new Date().toISOString();

  if (!isOpen) {
    state.status = 'MARKET_CLOSED';
    return;
  }

  state.status = 'TRADE_CHECK';

  try {
    // Manage existing positions first
    await managePositions();

    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);
    const positions = await alpaca('/v2/positions');
    const openCount = Array.isArray(positions) ? positions.length : 0;

    // Execute any pending queue first
    if (pendingQueue.length > 0) {
      buyingPower = await executePendingQueue(portfolio, buyingPower, positions);
    }

    if (openCount >= 10) {
      log('TRADE', 'Max positions reached — skipping new entries');
      state.status = 'IDLE';
      return;
    }

    if (catalystSignals.length === 0) {
      log('TRADE', '⏳ No catalyst signals yet — waiting for next catalyst scan');
      state.status = 'IDLE';
      return;
    }

    log('TRADE', '💹 Trade check — evaluating ' + catalystSignals.length + ' catalyst signal(s) against live prices');

    // Check each signal against live price — NO Claude call
    for (const signal of catalystSignals) {
      try {
        const ticker = signal.ticker;

        // Skip if already holding
        const alreadyHolding = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
        if (alreadyHolding) continue;

        // Skip if already queued
        const alreadyQueued = pendingQueue.find(p => p.ticker === ticker);
        if (alreadyQueued) continue;

        // Get live price from Alpaca (free API call)
        const livePrice = await getLivePrice(ticker);
        if (!livePrice) continue;

        const target = parseFloat(signal.targetPrice || 0);
        const stop = parseFloat(signal.stopLoss || 0);
        const score = signal.signalScore || 0;
        const conf = signal.confidence || 0;

        // Signal is still valid if price hasn't blown past target or stop
        const priceAboveStop = livePrice > stop;
        const priceBelowTarget = livePrice < target;
        const signalFresh = signal.foundAt &&
          (Date.now() - new Date(signal.foundAt).getTime()) < 24 * 60 * 60 * 1000; // 24hr

        if (signal.signal === 'BUY' && priceAboveStop && priceBelowTarget && signalFresh) {
          const dollars = positionDollars(portfolio, score, conf);
          if (dollars === 0) continue;
          if (dollars > buyingPower) continue;

          log('TRADE', '✅ EXECUTING: ' + ticker + ' @ $' + livePrice.toFixed(2) +
            ' — $' + dollars.toFixed(0) + ' | ' + signal.catalyst, {
            ticker, dollars, livePrice,
            signalScore: score, confidence: conf,
            thesis: signal.thesis, catalyst: signal.catalyst,
          });

          await placeOrder(ticker, dollars, 'buy', signal);
          buyingPower -= dollars;

          // Remove from active signals after trading
          catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);

        } else if (signal.signal === 'BUY' && !signalFresh) {
          log('TRADE', '🗑 Signal expired for ' + ticker + ' — removing');
          catalystSignals = catalystSignals.filter(s => s.ticker !== ticker);
        }

      } catch(e) {
        log('ERROR', 'Trade check error for ' + signal.ticker + ': ' + e.message);
      }
    }

  } catch(e) {
    log('ERROR', 'Trade check failed: ' + e.message);
  }
  state.status = 'IDLE';
}

// ── POSITION SIZING ───────────────────────────────────────────────
function positionDollars(portfolio, score, confidence) {
  const c = score * 0.6 + confidence * 0.4;
  if (c >= 85) return portfolio * 0.10;
  if (c >= 78) return portfolio * 0.07;
  if (c >= 72) return portfolio * 0.05;
  if (c >= 65) return portfolio * 0.03;
  return 0;
}

// ── PLACE ORDER ───────────────────────────────────────────────────
async function placeOrder(ticker, dollars, side, analysis) {
  try {
    if (side === 'buy') {
      const positions = await alpaca('/v2/positions');
      if (Array.isArray(positions) && positions.find(p => p.symbol === ticker)) {
        log('TRADE', 'Already holding ' + ticker + ' — skip'); return null;
      }
    }
    const order = await alpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: ticker, notional: dollars.toFixed(2),
        side, type: 'market', time_in_force: 'day'
      })
    });
    if (order.id) {
      state.tradesExecuted++;
      pendingQueue = pendingQueue.filter(p => p.ticker !== ticker);
      log('TRADE', (side === 'buy' ? '✅ BUY' : '🔴 SELL') + ' executed: ' + ticker + ' $' + dollars.toFixed(0), {
        ticker, side, dollars, orderId: order.id,
        thesis: analysis && analysis.thesis,
        catalyst: analysis && analysis.catalyst
      });
    } else {
      log('ERROR', 'Order rejected for ' + ticker + ': ' + JSON.stringify(order).substring(0, 100));
    }
    return order;
  } catch(e) {
    log('ERROR', 'Order failed ' + ticker + ': ' + e.message);
    return null;
  }
}

// ── MANAGE POSITIONS ──────────────────────────────────────────────
async function managePositions() {
  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions) || !positions.length) return;
    for (const p of positions) {
      const pnl = parseFloat(p.unrealized_plpc) * 100;
      if (pnl <= -8) {
        log('RISK', '🛑 Stop loss: ' + p.symbol + ' at ' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'STOP_LOSS' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      } else if (pnl >= 20) {
        log('PROFIT', '🎯 Take profit: ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      }
    }
  } catch(e) { log('ERROR', 'Position management failed: ' + e.message); }
}

// ── EXECUTE PENDING QUEUE ─────────────────────────────────────────
async function executePendingQueue(portfolio, buyingPower, positions) {
  if (pendingQueue.length === 0) return buyingPower;
  log('TRADE', '⚡ Executing ' + pendingQueue.length + ' queued signal(s)');
  for (const item of [...pendingQueue]) {
    try {
      const alreadyHolding = Array.isArray(positions) && positions.find(p => p.symbol === item.ticker);
      if (alreadyHolding) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      const dollars = positionDollars(portfolio, item.signalScore, item.confidence);
      if (!dollars || dollars > buyingPower) { pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker); continue; }
      await placeOrder(item.ticker, dollars, 'buy', item);
      buyingPower -= dollars;
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) { log('ERROR', 'Queued order failed ' + item.ticker + ': ' + e.message); }
  }
  return buyingPower;
}

// ── TIME HELPERS ──────────────────────────────────────────────────
function getETHour() {
  const et = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  return et; // "HH:MM"
}

function isDuringMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeNum = hour * 60 + min;
  return day >= 1 && day <= 5 && timeNum >= 9 * 60 + 30 && timeNum <= 16 * 60;
}

function shouldRunIntel() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hhmm = et.getHours().toString().padStart(2, '0') + ':' + et.getMinutes().toString().padStart(2, '0');
  return INTEL_TIMES.some(t => hhmm === t);
}

// ── MAIN SCHEDULER ────────────────────────────────────────────────
// Runs every 5 minutes and decides what to do based on time
async function scheduler() {
  if (state.status !== 'IDLE' && state.status !== 'MARKET_CLOSED') return; // Already running

  const etTime = getETHour();
  const marketHours = isDuringMarketHours();

  // Intelligence scan at 9:00am and 3:30pm ET
  if (shouldRunIntel()) {
    const timing = etTime < '12:00' ? 'pre-market' : 'pre-close';
    await runIntelScan(timing);
    return;
  }

  // During market hours: trade check every 30 min, catalyst scan every 2hrs
  if (marketHours) {
    const now = new Date();
    const minutesSinceLastCatalyst = state.lastCatalyst
      ? (Date.now() - new Date(state.lastCatalyst).getTime()) / 60000
      : 999;
    const minutesSinceLastTrade = state.lastTradeCheck
      ? (Date.now() - new Date(state.lastTradeCheck).getTime()) / 60000
      : 999;

    if (minutesSinceLastCatalyst >= CATALYST_INTERVAL) {
      await runCatalystScan();
    } else if (minutesSinceLastTrade >= TRADE_CHECK_MINS) {
      await runTradeCheck();
    }
  } else {
    state.status = 'MARKET_CLOSED';
  }
}

// Run scheduler every 5 minutes
setInterval(scheduler, 5 * 60 * 1000);
log('AGENT', '🤖 Agent started — Intel: 9am+3:30pm ET | Catalyst: every 2hrs | Trade check: every 30min');

// ── API ROUTES ────────────────────────────────────────────────────
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
  activeSignals: catalystSignals.length,
  catalystIntervalMins: CATALYST_INTERVAL,
  tradeCheckMins: TRADE_CHECK_MINS,
  intelTimes: INTEL_TIMES,
}));

app.get('/log',      (req, res) => res.json(decisionLog.slice(0, 100)));
app.get('/pending',  (req, res) => res.json(pendingQueue));
app.get('/signals',  (req, res) => res.json(catalystSignals));
app.get('/health',   (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Manual triggers
app.post('/scan-now',    (req, res) => { res.json({ message: 'Catalyst scan triggered' }); runCatalystScan(); });
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
  // Run catalyst scan on startup after 30 seconds
  setTimeout(runCatalystScan, 30000);
});
