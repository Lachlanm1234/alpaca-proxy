const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// CONFIG
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ALPACA_BASE   = 'https://paper-api.alpaca.markets';
const ALPACA_DATA   = 'https://data.alpaca.markets';
const SCAN_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES || '120');
const STOCKS_PER_SCAN = 5;

// STATE
let state = { status: 'IDLE', lastScan: null, scansCompleted: 0, tradesExecuted: 0, isMarketOpen: false };
let decisionLog = [];

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 200) decisionLog.length = 200;
  console.log('[' + type + '] ' + message);
}

// ALPACA
async function alpaca(path, opts) {
  opts = opts || {};
  const r = await fetch(ALPACA_BASE + path, {
    method: opts.method || 'GET',
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
    body: opts.body || undefined,
  });
  return r.json();
}

// MARKET CHECK
async function isMarketOpen() {
  try {
    const c = await alpaca('/v2/clock');
    state.isMarketOpen = c.is_open;
    return c.is_open;
  } catch(e) { return false; }
}

// GET CANDIDATES
async function getCandidates() {
  const fallback = ['AAPL','NVDA','MSFT','AMZN','META','GOOGL','TSLA','AMD','BABA','TSM','ASML','PLTR','COIN','SOFI','ARM'];
  try {
    const r = await fetch(ALPACA_DATA + '/v1beta1/screener/stocks/most-actives?by=volume&top=20', {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
    });
    const d = await r.json();
    const syms = (d.most_actives || []).filter(s => s.symbol && !s.symbol.includes('/')).slice(0, STOCKS_PER_SCAN).map(s => s.symbol);
    if (syms.length > 0) { log('SCANNER', 'Candidates: ' + syms.join(', ')); return syms; }
  } catch(e) {}
  const picks = fallback.sort(() => Math.random() - 0.5).slice(0, STOCKS_PER_SCAN);
  log('SCANNER', 'Fallback candidates: ' + picks.join(', '));
  return picks;
}

// AI ANALYSIS
async function analyseStock(ticker) {
  const prompt = `You are an autonomous AI trading agent. Analyse ${ticker} using web search for current price, momentum, news, sentiment, and technicals. Return ONLY valid JSON no markdown:
{"ticker":"${ticker}","companyName":"Full Name","currentPrice":150.00,"signal":"BUY","signalScore":82,"confidence":76,"thesis":"Short 1-2 sentence reason.","targetPrice":175.00,"stopLoss":138.00,"expectedReturn":"+16.7%","risks":["risk1"],"catalysts":["catalyst1"]}
signal must be BUY, HOLD, or SELL. scores 0-100. Return ONLY JSON.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 600, system: prompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Analyse: ' + ticker }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const text = d.content.map(b => b.type === 'text' ? b.text : '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// POSITION SIZING
function positionDollars(portfolio, score, confidence) {
  const c = score * 0.6 + confidence * 0.4;
  if (c >= 85) return portfolio * 0.10;
  if (c >= 78) return portfolio * 0.07;
  if (c >= 72) return portfolio * 0.05;
  if (c >= 65) return portfolio * 0.03;
  return 0;
}

// PLACE ORDER
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
      body: JSON.stringify({ symbol: ticker, notional: dollars.toFixed(2), side, type: 'market', time_in_force: 'day' })
    });
    if (order.id) {
      state.tradesExecuted++;
      log('TRADE', (side === 'buy' ? '✅ BUY' : '🔴 SELL') + ' ' + ticker + ' $' + dollars.toFixed(0), { ticker, side, dollars, orderId: order.id, thesis: analysis && analysis.thesis });
    }
    return order;
  } catch(e) { log('ERROR', 'Order failed ' + ticker + ': ' + e.message); return null; }
}

// MANAGE POSITIONS
async function managePositions() {
  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions) || !positions.length) return;
    for (const p of positions) {
      const pnl = parseFloat(p.unrealized_plpc) * 100;
      if (pnl <= -8) {
        log('RISK', '🛑 Stop loss ' + p.symbol + ' at ' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'STOP_LOSS' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      } else if (pnl >= 20) {
        log('PROFIT', '🎯 Take profit ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      } else {
        log('PORTFOLIO', 'Holding ' + p.symbol + ': ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%', { ticker: p.symbol, pnlPct: pnl });
      }
    }
  } catch(e) { log('ERROR', 'Position management failed: ' + e.message); }
}

// MAIN SCAN
async function runScan() {
  const open = await isMarketOpen();
  if (!open) { log('SCANNER', 'Market closed — skipping scan'); state.status = 'MARKET_CLOSED'; return; }
  state.status = 'SCANNING';
  state.lastScan = new Date().toISOString();
  log('SCANNER', '🔍 Starting scan cycle');
  try {
    await managePositions();
    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);
    const positions = await alpaca('/v2/positions');
    const openCount = Array.isArray(positions) ? positions.length : 0;
    if (openCount >= 10) { log('SCANNER', 'Max positions reached'); state.status = 'IDLE'; return; }
    const candidates = await getCandidates();
    for (const ticker of candidates) {
      try {
        state.status = 'ANALYSING ' + ticker;
        const analysis = await analyseStock(ticker);
        if (analysis.signal === 'BUY') {
          const dollars = positionDollars(portfolio, analysis.signalScore, analysis.confidence);
          if (dollars === 0) { log('DECISION', '⏭ SKIP ' + ticker + ' — score too low (' + analysis.signalScore + ')'); continue; }
          if (dollars > buyingPower) { log('DECISION', '⏭ SKIP ' + ticker + ' — insufficient buying power'); continue; }
          log('DECISION', '✅ BUY ' + ticker + ' $' + dollars.toFixed(0) + ' (score:' + analysis.signalScore + ' conf:' + analysis.confidence + '%)', { ticker, dollars, signalScore: analysis.signalScore, confidence: analysis.confidence, thesis: analysis.thesis });
          await placeOrder(ticker, dollars, 'buy', analysis);
          buyingPower -= dollars;
        } else if (analysis.signal === 'SELL') {
          const pos = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
          if (pos) { await alpaca('/v2/positions/' + ticker, { method: 'DELETE' }); log('DECISION', '🔴 SELL ' + ticker, { ticker }); }
          else { log('DECISION', '⏭ SELL signal ' + ticker + ' but no position'); }
        } else {
          log('DECISION', '⏭ HOLD ' + ticker + ' (score:' + analysis.signalScore + ')');
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) { log('ERROR', 'Analysis failed ' + ticker + ': ' + e.message); }
    }
    state.scansCompleted++;
    state.status = 'IDLE';
    log('SCANNER', '✅ Scan complete. Scans: ' + state.scansCompleted + ' Trades: ' + state.tradesExecuted);
  } catch(e) { log('ERROR', 'Scan failed: ' + e.message); state.status = 'ERROR'; }
}

// SCHEDULER — no external deps, pure setInterval
function scheduleScans() {
  const ms = SCAN_MINUTES * 60 * 1000;
  setInterval(runScan, ms);
  log('AGENT', 'Scheduler started — every ' + SCAN_MINUTES + ' minutes');
}

// ROUTES
app.use('/alpaca', async (req, res) => {
  const base = req.headers['x-alpaca-mode'] === 'live' ? 'https://api.alpaca.markets' : ALPACA_BASE;
  try {
    const r = await fetch(base + req.url, {
      method: req.method,
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => res.json({ ...state, scanIntervalMinutes: SCAN_MINUTES }));
app.get('/log', (req, res) => res.json(decisionLog.slice(0, 100)));
app.post('/scan-now', (req, res) => { res.json({ message: 'Scan triggered' }); runScan(); });
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// START
app.listen(3001, () => {
  log('AGENT', '🤖 Market Intelligence Agent running on port 3001');
  scheduleScans();
  setTimeout(runScan, 5000);
});
