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

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ALPACA_BASE   = 'https://paper-api.alpaca.markets';
const ALPACA_DATA   = 'https://data.alpaca.markets';
const SCAN_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES || '120');
const INTEL_MINUTES = parseInt(process.env.INTEL_INTERVAL_MINUTES || '30');
const STOCKS_PER_SCAN = 3;

let state = {
  status: 'IDLE',
  lastScan: null,
  lastIntel: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};
let decisionLog = [];

function log(type, message, data) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...(data || {}) };
  decisionLog.unshift(entry);
  if (decisionLog.length > 300) decisionLog.length = 300;
  console.log('[' + type + '] ' + message);
}

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
  try {
    const c = await alpaca('/v2/clock');
    state.isMarketOpen = c.is_open;
    return c.is_open;
  } catch(e) { return false; }
}

async function getCandidates() {
  const fallback = [
    'AAPL','NVDA','MSFT','AMZN','META','GOOGL','TSLA','AMD','BABA','TSM',
    'ASML','PLTR','COIN','SOFI','ARM','SMCI','MSTR','IONQ','RGTI','HOOD',
    'RKLB','PATH','AI','SNOW','DDOG','NET','CRWD','UBER','LYFT','SHOP',
    'NFLX','DIS','PYPL','SQ','ROKU','ZOOM','SPOT','ABNB','DASH','RIVN'
  ];

  // Try most-actives screener first
  try {
    const r = await fetch(ALPACA_DATA + '/v1beta1/screener/stocks/most-actives?by=volume&top=20', {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
    });
    const d = await r.json();
    const syms = (d.most_actives || [])
      .filter(s => s.symbol && !s.symbol.includes('/') && !s.symbol.includes('.'))
      .slice(0, STOCKS_PER_SCAN)
      .map(s => s.symbol);
    if (syms.length > 0) {
      log('SCANNER', 'Live candidates (most active): ' + syms.join(', '));
      return syms;
    }
  } catch(e) {
    log('SCANNER', 'Screener error: ' + e.message);
  }

  // Try top gainers
  try {
    const r = await fetch(ALPACA_DATA + '/v1beta1/screener/stocks/top-market-movers?top=10', {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
    });
    const d = await r.json();
    const gainers = (d.gainers || [])
      .filter(s => s.symbol && !s.symbol.includes('/'))
      .slice(0, STOCKS_PER_SCAN)
      .map(s => s.symbol);
    if (gainers.length > 0) {
      log('SCANNER', 'Live candidates (top movers): ' + gainers.join(', '));
      return gainers;
    }
  } catch(e) {
    log('SCANNER', 'Movers error: ' + e.message);
  }

  // Rotating fallback — different stocks each scan based on time
  const hour = new Date().getHours();
  const rotated = [...fallback.slice(hour % fallback.length), ...fallback.slice(0, hour % fallback.length)];
  const picks = rotated.slice(0, STOCKS_PER_SCAN);
  log('SCANNER', 'Rotating fallback candidates: ' + picks.join(', '));
  return picks;
}

async function callIntelClaude(systemPrompt, userContent) {
  const fullSystem = systemPrompt + '\n\nCRITICAL: Return ONLY a valid JSON object. No text before or after. Start with { end with }. Keep all string values short.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
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
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function callClaude(systemPrompt, userContent) {
  const fullSystem = systemPrompt + '\n\nIMPORTANT: Your response must be ONLY a valid JSON object. No text before or after it. No markdown. No backticks. Start your response with { and end with }.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
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
  if (!match) throw new Error('No JSON in response: ' + clean.substring(0, 100));
  return JSON.parse(match[0]);
}

// ── 24/7 INTELLIGENCE SCAN ─────────────────────────────────────────
// Runs regardless of market hours — collects news, events, narratives
async function runIntelligenceScan() {
  if (state.status !== 'IDLE' && state.status !== 'MARKET_CLOSED') return;
  state.status = 'INTELLIGENCE';
  state.lastIntel = new Date().toISOString();
  log('INTELLIGENCE', '🌐 Running overnight intelligence scan — collecting news and market events');

  const INTEL_PROMPT = `You are a 24/7 market intelligence agent. Search for the latest financial news and market-moving events. Keep all strings short.
Return ONLY a JSON object like this exact structure:
{"topStories":[{"headline":"short headline under 100 chars","impact":"BULLISH","sectors":["Tech"],"tickers":["NVDA"],"urgency":"HIGH"},{"headline":"short headline","impact":"BEARISH","sectors":["Finance"],"tickers":["JPM"],"urgency":"MEDIUM"}],"marketSentiment":"RISK_ON","keyThemes":["AI spending","Fed rates"],"watchlist":["NVDA","AAPL"],"preMarketOutlook":"One sentence outlook."}
Maximum 3 stories. All headlines under 100 characters. Return ONLY JSON.`;

  try {
    const intel = await callIntelClaude(INTEL_PROMPT, 'Find the top 3 market-moving news stories from the last few hours. Be brief.');
    
    log('INTELLIGENCE', '📰 Market sentiment: ' + intel.marketSentiment + ' | Key themes: ' + (intel.keyThemes || []).join(', '), {
      marketSentiment: intel.marketSentiment,
      keyThemes: intel.keyThemes,
    });

    (intel.topStories || []).forEach(story => {
      log('INTELLIGENCE', story.headline, {
        impact: story.impact,
        urgency: story.urgency,
        tickers: story.tickers,
        sectors: story.sectors,
      });
    });

    if (intel.preMarketOutlook) {
      log('INTELLIGENCE', '🔮 Pre-market outlook: ' + intel.preMarketOutlook);
    }

    if (intel.watchlist && intel.watchlist.length > 0) {
      log('INTELLIGENCE', '👀 Stocks to watch next session: ' + intel.watchlist.join(', '), { tickers: intel.watchlist });
    }

  } catch(e) {
    log('ERROR', 'Intelligence scan failed: ' + e.message);
  }
  state.status = 'IDLE';
}

// ── TRADING ANALYSIS ───────────────────────────────────────────────
async function analyseStock(ticker) {
  const prompt = `You are an autonomous AI trading agent. Analyse ${ticker} using web search for current price, momentum, recent news, social sentiment, and technical signals. Return ONLY valid JSON no markdown:
{"ticker":"${ticker}","companyName":"Full Name","currentPrice":150.00,"signal":"BUY","signalScore":82,"confidence":76,"thesis":"Short 1-2 sentence reason.","targetPrice":175.00,"stopLoss":138.00,"expectedReturn":"+16.7%","risks":["risk1"],"catalysts":["catalyst1"]}
signal must be BUY, HOLD, or SELL. scores 0-100. Return ONLY JSON.`;
  return callClaude(prompt, 'Full trading analysis for: ' + ticker);
}

function positionDollars(portfolio, score, confidence) {
  const c = score * 0.6 + confidence * 0.4;
  if (c >= 85) return portfolio * 0.10;
  if (c >= 78) return portfolio * 0.07;
  if (c >= 72) return portfolio * 0.05;
  if (c >= 65) return portfolio * 0.03;
  return 0;
}

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
      log('TRADE', (side === 'buy' ? '✅ BUY' : '🔴 SELL') + ' ' + ticker + ' $' + dollars.toFixed(0), {
        ticker, side, dollars, orderId: order.id, thesis: analysis && analysis.thesis
      });
    }
    return order;
  } catch(e) { log('ERROR', 'Order failed ' + ticker + ': ' + e.message); return null; }
}

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

// ── MAIN TRADING SCAN ──────────────────────────────────────────────
// allowForce = true means run even if market is closed (manual trigger)
async function runScan(allowForce) {
  const isOpen = await checkMarket();

  if (!isOpen && !allowForce) {
    log('SCANNER', 'Market closed — running intelligence scan instead');
    await runIntelligenceScan();
    return;
  }

  if (!isOpen && allowForce) {
    log('SCANNER', '⚡ Manual scan triggered — market is closed, analysis only (no trades will execute)');
  }

  state.status = 'SCANNING';
  state.lastScan = new Date().toISOString();
  log('SCANNER', '🔍 Starting ' + (allowForce && !isOpen ? 'analysis-only' : 'trading') + ' scan cycle');

  try {
    if (isOpen) await managePositions();

    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);
    const positions = await alpaca('/v2/positions');
    const openCount = Array.isArray(positions) ? positions.length : 0;

    if (isOpen && openCount >= 10) {
      log('SCANNER', 'Max positions (10) reached — skipping new entries');
      state.status = 'IDLE';
      return;
    }

    // Run unified discovery + analysis
    state.status = 'DISCOVERING';
    log('SCANNER', '🔍 Searching WSB, StockTwits, options flow, earnings, analyst upgrades, breaking news...');
    
    let opportunities = [];
    try {
      opportunities = await discoverAndAnalyse();
      log('SCANNER', '📊 Discovered ' + opportunities.length + ' opportunities from live sources');
    } catch(e) {
      log('ERROR', 'Discovery failed: ' + e.message + ' — falling back to single stock analysis');
      const fallbacks = ['NVDA','AAPL','TSLA','AMD','META'].slice(0, STOCKS_PER_SCAN);
      for (const t of fallbacks) {
        try { const a = await analyseStock(t); opportunities.push(a); await new Promise(r => setTimeout(r, 15000)); } catch(e2) {}
      }
    }

    for (const analysis of opportunities) {
      const ticker = analysis.ticker;
      if (!ticker) continue;
      try {
        const sourceInfo = analysis.discoveredFrom ? ' [via ' + analysis.discoveredFrom + ']' : '';
        const catalyst = analysis.catalyst ? ' | ' + analysis.catalyst : '';
        log('ANALYSIS', '🔎 ' + ticker + ' — ' + (analysis.companyName || '') + sourceInfo + catalyst, {
          ticker, signalScore: analysis.signalScore, confidence: analysis.confidence,
          socialBuzz: analysis.socialBuzz, newsHeadline: analysis.newsHeadline,
          newsSource: analysis.newsSource, thesis: analysis.thesis,
        });
        if (analysis.signal === 'BUY') {
          if (!isOpen) {
            log('DECISION', '📋 BUY queued for market open: ' + ticker + ' (score:' + analysis.signalScore + ')', {
              ticker, signalScore: analysis.signalScore, confidence: analysis.confidence, thesis: analysis.thesis, catalyst: analysis.catalyst
            });
          } else {
            const dollars = positionDollars(portfolio, analysis.signalScore, analysis.confidence);
            if (dollars === 0) { log('DECISION', '⏭ SKIP ' + ticker + ' — score too low (' + analysis.signalScore + ')'); continue; }
            if (dollars > buyingPower) { log('DECISION', '⏭ SKIP ' + ticker + ' — insufficient buying power'); continue; }
            log('DECISION', '✅ EXECUTING BUY ' + ticker + ' $' + dollars.toFixed(0) + ' | ' + (analysis.thesis || ''), {
              ticker, dollars, signalScore: analysis.signalScore, confidence: analysis.confidence,
              thesis: analysis.thesis, catalyst: analysis.catalyst
            });
            await placeOrder(ticker, dollars, 'buy', analysis);
            buyingPower -= dollars;
          }
        } else if (analysis.signal === 'SELL') {
          if (isOpen) {
            const pos = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
            if (pos) { await alpaca('/v2/positions/' + ticker, { method: 'DELETE' }); log('DECISION', '🔴 SELL ' + ticker + ' | ' + (analysis.thesis || ''), { ticker }); }
            else { log('DECISION', '⏭ SELL signal ' + ticker + ' — no position held'); }
          } else {
            log('DECISION', '📋 SELL queued for market open: ' + ticker, { ticker });
          }
        } else {
          log('DECISION', '⏭ HOLD ' + ticker + ' (score:' + analysis.signalScore + ') — ' + (analysis.thesis || ''), { ticker, signalScore: analysis.signalScore });
        }
      } catch(e) { log('ERROR', 'Processing failed for ' + ticker + ': ' + e.message); }
    }

        state.scansCompleted++;
    state.status = 'IDLE';
    log('SCANNER', '✅ Scan complete. Total scans: ' + state.scansCompleted + ' | Total trades: ' + state.tradesExecuted);
  } catch(e) {
    log('ERROR', 'Scan failed: ' + e.message);
    state.status = 'ERROR';
  }
}

// ── SCHEDULERS ────────────────────────────────────────────────────
// Trading scan every N minutes
setInterval(() => runScan(false), SCAN_MINUTES * 60 * 1000);

// Intelligence scan every 30 min (runs regardless of market hours)
setInterval(() => {
  if (state.status === 'IDLE' || state.status === 'MARKET_CLOSED') {
    runIntelligenceScan();
  }
}, INTEL_MINUTES * 60 * 1000);

log('AGENT', '🤖 Autonomous agent started — trading scan every ' + SCAN_MINUTES + 'min, intelligence scan every ' + INTEL_MINUTES + 'min');

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

app.get('/status', (req, res) => res.json({ ...state, scanIntervalMinutes: SCAN_MINUTES, intelIntervalMinutes: INTEL_MINUTES }));
app.get('/log', (req, res) => res.json(decisionLog.slice(0, 100)));

// Manual scan — always runs regardless of market hours
app.post('/scan-now', (req, res) => {
  res.json({ message: 'Manual scan triggered' });
  runScan(true); // allowForce = true
});

// Manual intelligence scan
app.post('/intel-now', (req, res) => {
  res.json({ message: 'Intelligence scan triggered' });
  runIntelligenceScan();
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(3001, () => {
  log('AGENT', '🤖 Market Intelligence Agent running on port 3001');
  // Run intelligence scan 10 seconds after startup
  setTimeout(() => runIntelligenceScan(), 10000);
  // Run trading scan 60 seconds after startup
  setTimeout(() => runScan(false), 60000);
});
