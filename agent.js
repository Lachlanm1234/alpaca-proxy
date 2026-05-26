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
const SCAN_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES || '120');
const INTEL_MINUTES = parseInt(process.env.INTEL_INTERVAL_MINUTES || '30');
const STOCKS_PER_SCAN = 2;

// ── STATE ─────────────────────────────────────────────────────────
let state = {
  status: 'IDLE',
  lastScan: null,
  lastIntel: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};
let decisionLog = [];
let pendingQueue = []; // BUY signals queued while market is closed

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

// ── CLAUDE HELPERS ────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens) {
  maxTokens = maxTokens || 800;
  const fullSystem = systemPrompt + '\n\nCRITICAL: Your response must be ONLY a valid JSON object. No text before or after. No markdown. No backticks. Start with { and end with }.';
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
  if (!match) throw new Error('No JSON in response: ' + clean.substring(0, 120));
  return JSON.parse(match[0]);
}

// ── DISCOVERY: searches multiple live sources to find what's moving NOW ──
async function discoverAndAnalyse() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const DISCOVERY_PROMPT = `You are an elite autonomous trading agent. Today is ${today}.
Search ALL of these sources to find the ${STOCKS_PER_SCAN} best trading opportunities RIGHT NOW:
- Reddit WallStreetBets trending posts and comments today
- StockTwits most active and bullish tickers  
- Pre-market movers and after-hours activity
- Unusual options activity (large call buying, high put/call ratios)
- Analyst upgrades and price target increases from today
- Earnings beats or surprises in the last 24 hours
- Breaking financial news in the last 6 hours
- Momentum stocks with high social media buzz

For each opportunity, analyse current price, technicals, news catalyst, and sentiment.
Return ONLY valid JSON:
{
  "scanSources": ["WallStreetBets", "StockTwits", "Options Flow", "Earnings"],
  "opportunities": [
    {
      "ticker": "NVDA",
      "companyName": "NVIDIA Corporation",
      "discoveredFrom": "WSB trending + unusual call options",
      "currentPrice": 875.40,
      "priceChange": "+3.2%",
      "signal": "BUY",
      "signalScore": 84,
      "confidence": 78,
      "thesis": "2 sentence reason including the specific catalyst discovered.",
      "catalyst": "Specific event or news that triggered this signal",
      "targetPrice": 950.00,
      "stopLoss": 820.00,
      "expectedReturn": "+8.5%",
      "socialBuzz": "HIGH",
      "newsHeadline": "Most important news headline for this stock today",
      "newsSource": "Reuters",
      "risks": ["Risk 1", "Risk 2"]
    }
  ]
}
signal: BUY, HOLD, or SELL. socialBuzz: HIGH, MEDIUM, or LOW. Return ONLY JSON.`;

  const result = await callClaude(
    DISCOVERY_PROMPT,
    'Search WallStreetBets, StockTwits, options flow, earnings, analyst upgrades, and breaking financial news to find the top ' + STOCKS_PER_SCAN + ' trading opportunities right now. Be specific about what you found and where.',
    900
  );

  return result.opportunities || [];
}

// ── INTELLIGENCE SCAN (24/7 news gathering) ───────────────────────
async function runIntelligenceScan() {
  if (state.status !== 'IDLE' && state.status !== 'MARKET_CLOSED') return;
  state.status = 'INTELLIGENCE';
  state.lastIntel = new Date().toISOString();
  log('INTELLIGENCE', '🌐 Running intelligence scan — collecting news and market events');

  const INTEL_PROMPT = `You are a 24/7 market intelligence agent. Search for the latest financial news and market-moving events. Keep all strings short.
Return ONLY a JSON object:
{"topStories":[{"headline":"short headline under 100 chars","impact":"BULLISH","sectors":["Tech"],"tickers":["NVDA"],"urgency":"HIGH"},{"headline":"second headline","impact":"BEARISH","sectors":["Finance"],"tickers":["JPM"],"urgency":"MEDIUM"}],"marketSentiment":"RISK_ON","keyThemes":["AI spending","Fed rates"],"watchlist":["NVDA","AAPL"],"preMarketOutlook":"One sentence outlook."}
Maximum 3 stories. All headlines under 100 characters. Return ONLY JSON.`;

  try {
    const intel = await callClaude(
      INTEL_PROMPT,
      'Find the top 3 market-moving news stories from the last few hours. Be brief.',
      600
    );

    log('INTELLIGENCE', '📊 Market sentiment: ' + intel.marketSentiment + ' | Themes: ' + (intel.keyThemes || []).join(', '), {
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
      log('INTELLIGENCE', '🔮 Outlook: ' + intel.preMarketOutlook);
    }
    if (intel.watchlist && intel.watchlist.length > 0) {
      log('INTELLIGENCE', '👀 Watch next session: ' + intel.watchlist.join(', '), { tickers: intel.watchlist });
    }
  } catch(e) {
    log('ERROR', 'Intelligence scan failed: ' + e.message);
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
        symbol: ticker,
        notional: dollars.toFixed(2),
        side,
        type: 'market',
        time_in_force: 'day'
      })
    });
    if (order.id) {
      state.tradesExecuted++;
      // Remove from pending queue if it was there
      pendingQueue = pendingQueue.filter(p => p.ticker !== ticker);
      log('TRADE', (side === 'buy' ? '✅ BUY' : '🔴 SELL') + ' executed: ' + ticker + ' $' + dollars.toFixed(0), {
        ticker, side, dollars, orderId: order.id,
        thesis: analysis && analysis.thesis,
        catalyst: analysis && analysis.catalyst
      });
    }
    return order;
  } catch(e) {
    log('ERROR', 'Order failed ' + ticker + ': ' + e.message);
    return null;
  }
}

// ── MANAGE POSITIONS (stop loss / take profit) ────────────────────
async function managePositions() {
  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions) || !positions.length) return;
    log('PORTFOLIO', 'Reviewing ' + positions.length + ' open position(s)');
    for (const p of positions) {
      const pnl = parseFloat(p.unrealized_plpc) * 100;
      if (pnl <= -8) {
        log('RISK', '🛑 Stop loss triggered: ' + p.symbol + ' at ' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'STOP_LOSS' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      } else if (pnl >= 20) {
        log('PROFIT', '🎯 Take profit triggered: ' + p.symbol + ' at +' + pnl.toFixed(1) + '%', { ticker: p.symbol, pnlPct: pnl, reason: 'TAKE_PROFIT' });
        await alpaca('/v2/positions/' + p.symbol, { method: 'DELETE' });
      } else {
        log('PORTFOLIO', p.symbol + ': ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%', { ticker: p.symbol, pnlPct: pnl });
      }
    }
  } catch(e) {
    log('ERROR', 'Position management failed: ' + e.message);
  }
}

// ── EXECUTE PENDING QUEUE ─────────────────────────────────────────
async function executePendingQueue(portfolio, buyingPower) {
  if (pendingQueue.length === 0) return buyingPower;
  log('SCANNER', '⚡ Market open — executing ' + pendingQueue.length + ' queued signal(s)');
  const queue = [...pendingQueue];
  for (const item of queue) {
    try {
      const dollars = positionDollars(portfolio, item.signalScore, item.confidence);
      if (dollars === 0 || dollars > buyingPower) {
        log('DECISION', '⏭ SKIP queued ' + item.ticker + ' — sizing issue');
        pendingQueue = pendingQueue.filter(p => p.ticker !== item.ticker);
        continue;
      }
      log('DECISION', '✅ EXECUTING queued BUY: ' + item.ticker + ' $' + dollars.toFixed(0) + ' | Queued: ' + item.queuedAt, {
        ticker: item.ticker, dollars, signalScore: item.signalScore, thesis: item.thesis, catalyst: item.catalyst
      });
      await placeOrder(item.ticker, dollars, 'buy', item);
      buyingPower -= dollars;
      await new Promise(r => setTimeout(r, 3000));
    } catch(e) {
      log('ERROR', 'Failed to execute queued order for ' + item.ticker + ': ' + e.message);
    }
  }
  return buyingPower;
}

// ── MAIN SCAN ─────────────────────────────────────────────────────
async function runScan(allowForce) {
  const isOpen = await checkMarket();

  if (!isOpen && !allowForce) {
    log('SCANNER', 'Market closed — running intelligence scan');
    await runIntelligenceScan();
    return;
  }

  state.status = 'SCANNING';
  state.lastScan = new Date().toISOString();

  const modeLabel = (!isOpen && allowForce) ? 'analysis-only (market closed)' : 'live trading';
  log('SCANNER', '🔍 Starting ' + modeLabel + ' scan');

  try {
    // Manage existing positions first
    if (isOpen) await managePositions();

    // Get account info
    const account = await alpaca('/v2/account');
    const portfolio = parseFloat(account.portfolio_value || 100000);
    let buyingPower = parseFloat(account.buying_power || 0);

    // Execute any pending queue first if market just opened
    if (isOpen && pendingQueue.length > 0) {
      buyingPower = await executePendingQueue(portfolio, buyingPower);
    }

    // Check max positions
    const positions = await alpaca('/v2/positions');
    const openCount = Array.isArray(positions) ? positions.length : 0;
    if (isOpen && openCount >= 10) {
      log('SCANNER', 'Max positions (10) reached — skipping new entries');
      state.status = 'IDLE';
      return;
    }

    // Run discovery scan
    state.status = 'DISCOVERING';
    log('SCANNER', '🔍 Searching WSB, StockTwits, options flow, earnings, analyst upgrades, breaking news...');

    let opportunities = [];
    try {
      opportunities = await discoverAndAnalyse();
      log('SCANNER', '📊 Found ' + opportunities.length + ' opportunities from live sources: ' +
        opportunities.map(o => o.ticker).join(', '));
    } catch(e) {
      log('ERROR', 'Discovery failed: ' + e.message + ' — falling back to single stock analysis');
    }

    // Process each opportunity
    for (const analysis of opportunities) {
      const ticker = analysis.ticker;
      if (!ticker) continue;

      try {
        // Log the analysis with full context
        log('ANALYSIS', '🔎 ' + ticker + ' — ' + (analysis.companyName || '') +
          (analysis.discoveredFrom ? ' [' + analysis.discoveredFrom + ']' : ''), {
          ticker,
          signalScore: analysis.signalScore,
          confidence: analysis.confidence,
          socialBuzz: analysis.socialBuzz,
          newsHeadline: analysis.newsHeadline,
          newsSource: analysis.newsSource,
          thesis: analysis.thesis,
          catalyst: analysis.catalyst,
          currentPrice: analysis.currentPrice,
          targetPrice: analysis.targetPrice,
          stopLoss: analysis.stopLoss,
          expectedReturn: analysis.expectedReturn,
        });

        if (analysis.signal === 'BUY') {
          const dollars = positionDollars(portfolio, analysis.signalScore || 0, analysis.confidence || 0);

          if (dollars === 0) {
            log('DECISION', '⏭ SKIP ' + ticker + ' — confidence too low (score: ' + analysis.signalScore + ')');
            continue;
          }

          if (!isOpen) {
            // Queue for when market opens
            const alreadyQueued = pendingQueue.find(p => p.ticker === ticker);
            if (!alreadyQueued) {
              pendingQueue.push({
                ...analysis,
                dollars,
                queuedAt: new Date().toLocaleString(),
                queuedTimestamp: new Date().toISOString(),
              });
              log('DECISION', '📋 QUEUED for market open: ' + ticker +
                ' $' + dollars.toFixed(0) +
                ' (score: ' + analysis.signalScore + ', conf: ' + analysis.confidence + '%)' +
                ' | ' + (analysis.thesis || ''), {
                ticker,
                dollars,
                signalScore: analysis.signalScore,
                confidence: analysis.confidence,
                thesis: analysis.thesis,
                catalyst: analysis.catalyst,
                queued: true,
              });
            } else {
              log('DECISION', '⏭ ' + ticker + ' already in queue — skip duplicate');
            }
          } else {
            if (dollars > buyingPower) {
              log('DECISION', '⏭ SKIP ' + ticker + ' — insufficient buying power');
              continue;
            }
            log('DECISION', '✅ EXECUTING BUY: ' + ticker + ' $' + dollars.toFixed(0) +
              ' | ' + (analysis.thesis || ''), {
              ticker, dollars,
              signalScore: analysis.signalScore,
              confidence: analysis.confidence,
              thesis: analysis.thesis,
              catalyst: analysis.catalyst,
            });
            await placeOrder(ticker, dollars, 'buy', analysis);
            buyingPower -= dollars;
          }

        } else if (analysis.signal === 'SELL') {
          if (isOpen) {
            const pos = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
            if (pos) {
              await alpaca('/v2/positions/' + ticker, { method: 'DELETE' });
              log('DECISION', '🔴 SELL executed: ' + ticker + ' | ' + (analysis.thesis || ''), { ticker });
            } else {
              log('DECISION', '⏭ SELL signal for ' + ticker + ' — no position held');
            }
          } else {
            log('DECISION', '📋 SELL signal noted for ' + ticker + ' (market closed)', { ticker });
          }

        } else {
          log('DECISION', '⏭ HOLD: ' + ticker + ' (score: ' + analysis.signalScore + ') — ' + (analysis.thesis || ''), {
            ticker, signalScore: analysis.signalScore
          });
        }

      } catch(e) {
        log('ERROR', 'Processing failed for ' + (ticker || 'unknown') + ': ' + e.message);
      }
    }

    state.scansCompleted++;
    state.status = 'IDLE';
    log('SCANNER', '✅ Scan complete — Scans: ' + state.scansCompleted +
      ' | Trades: ' + state.tradesExecuted +
      ' | Queued: ' + pendingQueue.length);

  } catch(e) {
    log('ERROR', 'Scan cycle failed: ' + e.message);
    state.status = 'ERROR';
  }
}

// ── SCHEDULERS ────────────────────────────────────────────────────
setInterval(() => runScan(false), SCAN_MINUTES * 60 * 1000);
setInterval(() => {
  if (state.status === 'IDLE' || state.status === 'MARKET_CLOSED') {
    runIntelligenceScan();
  }
}, INTEL_MINUTES * 60 * 1000);

log('AGENT', '🤖 Autonomous agent started — trading scan every ' + SCAN_MINUTES + 'min, intel every ' + INTEL_MINUTES + 'min');

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/alpaca', async (req, res) => {
  const base = req.headers['x-alpaca-mode'] === 'live'
    ? 'https://api.alpaca.markets' : ALPACA_BASE;
  try {
    const r = await fetch(base + req.url, {
      method: req.method,
      headers: {
        'APCA-API-KEY-ID': ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
        'Content-Type': 'application/json'
      },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => res.json({
  ...state,
  scanIntervalMinutes: SCAN_MINUTES,
  intelIntervalMinutes: INTEL_MINUTES,
  pendingCount: pendingQueue.length,
}));

app.get('/log', (req, res) => res.json(decisionLog.slice(0, 100)));
app.get('/pending', (req, res) => res.json(pendingQueue));

app.post('/scan-now', (req, res) => {
  res.json({ message: 'Manual scan triggered' });
  runScan(true);
});

app.post('/intel-now', (req, res) => {
  res.json({ message: 'Intelligence scan triggered' });
  runIntelligenceScan();
});

app.post('/clear-queue', (req, res) => {
  const cleared = pendingQueue.length;
  pendingQueue = [];
  log('AGENT', '🗑 Pre-market queue cleared (' + cleared + ' items removed)');
  res.json({ message: 'Queue cleared', cleared });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use(express.static(__dirname));

app.listen(3001, () => {
  log('AGENT', '🤖 Market Intelligence Agent running on port 3001');
  setTimeout(() => runIntelligenceScan(), 10000);
  setTimeout(() => runScan(false), 60000);
});
