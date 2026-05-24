const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const fs = require('fs');

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
const SCAN_INTERVAL = process.env.SCAN_INTERVAL_MINUTES || 120; // minutes between scans
const STOCKS_PER_SCAN = 5; // how many stocks to analyse each scan
const LOG_FILE = '/tmp/agent-log.json';

// ── STATE ─────────────────────────────────────────────────────────
let agentState = {
  status: 'IDLE',
  lastScan: null,
  nextScan: null,
  scansCompleted: 0,
  tradesExecuted: 0,
  isMarketOpen: false,
};
let decisionLog = [];
let loadedLog = [];
try { loadedLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
decisionLog = loadedLog;

function saveLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(decisionLog.slice(-200), null, 2)); } catch(e) {}
}

function log(type, message, data = {}) {
  const entry = { timestamp: new Date().toISOString(), type, message, ...data };
  decisionLog.unshift(entry);
  if (decisionLog.length > 200) decisionLog = decisionLog.slice(0, 200);
  saveLog();
  console.log(`[${type}] ${message}`, data);
}

// ── ALPACA HELPERS ────────────────────────────────────────────────
async function alpaca(path, options = {}) {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    ...options,
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

async function alpacaData(path) {
  const res = await fetch(`${ALPACA_DATA}${path}`, {
    headers: {
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
    },
  });
  return res.json();
}

// ── MARKET STATUS ─────────────────────────────────────────────────
async function checkMarketOpen() {
  try {
    const clock = await alpaca('/v2/clock');
    agentState.isMarketOpen = clock.is_open;
    return clock.is_open;
  } catch(e) {
    log('ERROR', 'Failed to check market status', { error: e.message });
    return false;
  }
}

// ── STOCK DISCOVERY ───────────────────────────────────────────────
async function getTopCandidates() {
  try {
    // Get most active stocks by volume from Alpaca screener
    const res = await fetch(
      `${ALPACA_DATA}/v1beta1/screener/stocks/most-actives?by=volume&top=50`,
      { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
    );
    const data = await res.json();
    const symbols = (data.most_actives || [])
      .filter(s => s.symbol && !s.symbol.includes('/'))
      .slice(0, STOCKS_PER_SCAN)
      .map(s => s.symbol);

    if (symbols.length > 0) {
      log('SCANNER', `Found ${symbols.length} active stocks to analyse`, { symbols });
      return symbols;
    }
  } catch(e) {
    log('SCANNER', 'Screener unavailable, using fallback list');
  }

  // Fallback: diversified watchlist of liquid US + ADR stocks
  const fallback = [
    'AAPL','NVDA','MSFT','AMZN','META','GOOGL','TSLA','AMD','BABA','TSM',
    'ASML','NVO','SMCI','ARM','PLTR','COIN','MSTR','SOFI','RIVN','LCID',
    'SPY','QQQ','ARKK','XLK','XLF','GLD','SLV','USO',
  ];
  // Shuffle and pick STOCKS_PER_SCAN
  const shuffled = fallback.sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, STOCKS_PER_SCAN);
  log('SCANNER', `Using fallback watchlist`, { symbols: picks });
  return picks;
}

// ── AI ANALYSIS ───────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content.map(b => b.type === 'text' ? b.text : '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function analyseStock(ticker) {
  log('ANALYSIS', `Starting analysis for ${ticker}`);

  const SIGNAL_PROMPT = `You are an elite autonomous AI trading agent. Analyse the stock ${ticker} using real-time web search. 
Evaluate: current price, momentum, technicals (RSI, MACD, moving averages), recent news, social sentiment, insider activity, institutional flows, upcoming catalysts, and risks.
Return ONLY valid JSON, no markdown:
{
  "ticker": "${ticker}",
  "companyName": "Full name",
  "currentPrice": 150.00,
  "priceChange": "+2.3%",
  "direction": "up",
  "signal": "BUY",
  "signalScore": 82,
  "confidence": 76,
  "technicalScore": 80,
  "sentimentScore": 75,
  "newsScore": 85,
  "rsi": 58,
  "technicalSignal": "BULLISH",
  "thesis": "2 sentence reason for the trade.",
  "targetPrice": 175.00,
  "stopLoss": 138.00,
  "expectedReturn": "+16.7%",
  "timeHorizon": "30-60 DAYS",
  "risks": ["Risk 1", "Risk 2"],
  "catalysts": ["Catalyst 1"],
  "sector": "Technology"
}
signal must be: BUY, HOLD, or SELL. All scores 0-100. Return ONLY JSON.`;

  const result = await callClaude(SIGNAL_PROMPT, `Full autonomous trading analysis for: ${ticker}`);
  log('ANALYSIS', `${ticker} signal: ${result.signal} (score: ${result.signalScore}, confidence: ${result.confidence}%)`, {
    ticker, signal: result.signal, signalScore: result.signalScore, confidence: result.confidence, thesis: result.thesis
  });
  return result;
}

// ── POSITION SIZING ───────────────────────────────────────────────
function getPositionDollars(portfolioValue, signalScore, confidence) {
  const combined = (signalScore * 0.6) + (confidence * 0.4);
  if (combined >= 85) return portfolioValue * 0.10;
  if (combined >= 78) return portfolioValue * 0.07;
  if (combined >= 72) return portfolioValue * 0.05;
  if (combined >= 65) return portfolioValue * 0.03;
  return 0;
}

// ── TRADE EXECUTION ───────────────────────────────────────────────
async function placeOrder(ticker, notionalDollars, side, analysis) {
  try {
    // Check if we already hold this
    if (side === 'buy') {
      const positions = await alpaca('/v2/positions');
      const existing = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
      if (existing) {
        log('TRADE', `Skipping ${ticker} — already holding position`, { ticker });
        return null;
      }
    }

    const order = await alpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: ticker,
        notional: notionalDollars.toFixed(2),
        side,
        type: 'market',
        time_in_force: 'day',
      }),
    });

    if (order.id) {
      agentState.tradesExecuted++;
      log('TRADE', `✅ ${side.toUpperCase()} order placed for ${ticker} — $${notionalDollars.toFixed(0)}`, {
        ticker, side, dollars: notionalDollars, orderId: order.id,
        signalScore: analysis?.signalScore, confidence: analysis?.confidence,
        thesis: analysis?.thesis, stopLoss: analysis?.stopLoss, target: analysis?.targetPrice,
      });
      return order;
    } else {
      log('ERROR', `Order rejected for ${ticker}`, { ticker, response: order });
      return null;
    }
  } catch(e) {
    log('ERROR', `Order failed for ${ticker}: ${e.message}`, { ticker, error: e.message });
    return null;
  }
}

// ── POSITION MANAGEMENT ───────────────────────────────────────────
async function manageExistingPositions() {
  try {
    const positions = await alpaca('/v2/positions');
    if (!Array.isArray(positions) || positions.length === 0) return;

    log('PORTFOLIO', `Managing ${positions.length} open positions`);

    for (const pos of positions) {
      const pnlPct = parseFloat(pos.unrealized_plpc) * 100;
      const ticker = pos.symbol;

      // Stop loss: exit at -8%
      if (pnlPct <= -8) {
        log('RISK', `🛑 Stop loss triggered for ${ticker} at ${pnlPct.toFixed(1)}%`, { ticker, pnlPct });
        await alpaca('/v2/positions/' + ticker, { method: 'DELETE' });
        log('TRADE', `🔴 SOLD ${ticker} — stop loss hit (${pnlPct.toFixed(1)}%)`, { ticker, pnlPct, reason: 'STOP_LOSS' });
        continue;
      }

      // Take profit: exit at +20%
      if (pnlPct >= 20) {
        log('PROFIT', `🎯 Take profit triggered for ${ticker} at +${pnlPct.toFixed(1)}%`, { ticker, pnlPct });
        await alpaca('/v2/positions/' + ticker, { method: 'DELETE' });
        log('TRADE', `🟢 SOLD ${ticker} — take profit hit (+${pnlPct.toFixed(1)}%)`, { ticker, pnlPct, reason: 'TAKE_PROFIT' });
        continue;
      }

      log('PORTFOLIO', `Holding ${ticker}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, { ticker, pnlPct, value: pos.market_value });
    }
  } catch(e) {
    log('ERROR', `Position management failed: ${e.message}`, { error: e.message });
  }
}

// ── MAIN SCAN ─────────────────────────────────────────────────────
async function runScan() {
  const isOpen = await checkMarketOpen();
  if (!isOpen) {
    log('SCANNER', 'Market closed — skipping scan');
    agentState.status = 'MARKET_CLOSED';
    return;
  }

  agentState.status = 'SCANNING';
  agentState.lastScan = new Date().toISOString();
  log('SCANNER', '🔍 Starting autonomous scan cycle');

  try {
    // 1. Manage existing positions first
    await manageExistingPositions();

    // 2. Get account info
    const account = await alpaca('/v2/account');
    const portfolioValue = parseFloat(account.portfolio_value || 100000);
    const buyingPower = parseFloat(account.buying_power || 0);

    log('PORTFOLIO', `Portfolio: $${portfolioValue.toLocaleString()} | Buying power: $${buyingPower.toLocaleString()}`);

    // 3. Get max open positions (don't over-concentrate)
    const positions = await alpaca('/v2/positions');
    const openCount = Array.isArray(positions) ? positions.length : 0;
    const MAX_POSITIONS = 10;

    if (openCount >= MAX_POSITIONS) {
      log('SCANNER', `Max positions (${MAX_POSITIONS}) reached — skipping new entries`);
      agentState.status = 'IDLE';
      return;
    }

    // 4. Discover candidates
    const candidates = await getTopCandidates();

    // 5. Analyse each candidate
    for (const ticker of candidates) {
      try {
        agentState.status = `ANALYSING ${ticker}`;
        const analysis = await analyseStock(ticker);

        if (analysis.signal === 'BUY') {
          const dollars = getPositionDollars(portfolioValue, analysis.signalScore, analysis.confidence);

          if (dollars === 0) {
            log('DECISION', `⏭ SKIP ${ticker} — confidence too low (score: ${analysis.signalScore}, confidence: ${analysis.confidence}%)`);
            continue;
          }

          if (dollars > buyingPower) {
            log('DECISION', `⏭ SKIP ${ticker} — insufficient buying power ($${buyingPower.toFixed(0)} available, need $${dollars.toFixed(0)})`);
            continue;
          }

          log('DECISION', `✅ EXECUTE BUY ${ticker} — $${dollars.toFixed(0)} (score: ${analysis.signalScore}, confidence: ${analysis.confidence}%)`, {
            ticker, dollars, signalScore: analysis.signalScore, confidence: analysis.confidence,
          });
          await placeOrder(ticker, dollars, 'buy', analysis);

          // Update buying power estimate
          buyingPower -= dollars;

        } else if (analysis.signal === 'SELL') {
          // Check if we hold it
          const pos = Array.isArray(positions) && positions.find(p => p.symbol === ticker);
          if (pos) {
            log('DECISION', `🔴 SELL signal for ${ticker} — liquidating position`);
            await alpaca('/v2/positions/' + ticker, { method: 'DELETE' });
          } else {
            log('DECISION', `⏭ SELL signal for ${ticker} but no position held — skip`);
          }
        } else {
          log('DECISION', `⏭ HOLD ${ticker} — no action (score: ${analysis.signalScore})`);
        }

        // Small delay between analyses to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) {
        log('ERROR', `Analysis failed for ${ticker}: ${e.message}`, { ticker, error: e.message });
      }
    }

    agentState.scansCompleted++;
    agentState.status = 'IDLE';
    log('SCANNER', `✅ Scan cycle complete. Total scans: ${agentState.scansCompleted}, Total trades: ${agentState.tradesExecuted}`);
  } catch(e) {
    log('ERROR', `Scan cycle failed: ${e.message}`, { error: e.message });
    agentState.status = 'ERROR';
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────
// Run every N minutes during market hours (Mon-Fri, 9:30am-4pm ET)
const cronExpression = `*/${SCAN_INTERVAL} 9-15 * * 1-5`;
cron.schedule(cronExpression, runScan, { timezone: 'America/New_York' });
log('AGENT', `🤖 Autonomous trading agent started. Scanning every ${SCAN_INTERVAL} minutes during market hours.`);

// Run once immediately on startup if market is open
setTimeout(runScan, 5000);

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/alpaca', async (req, res) => {
  const mode = req.headers['x-alpaca-mode'];
  const base = mode === 'live' ? 'https://api.alpaca.markets' : ALPACA_BASE;
  const url = base + req.url;
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'APCA-API-KEY-ID': ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
        'Content-Type': 'application/json',
      },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ ...agentState, scanIntervalMinutes: SCAN_INTERVAL, stocksPerScan: STOCKS_PER_SCAN });
});

app.get('/log', (req, res) => {
  res.json(decisionLog.slice(0, 100));
});

app.post('/scan-now', async (req, res) => {
  res.json({ message: 'Scan triggered' });
  runScan();
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Keep-alive: ping self every 5 minutes to prevent Railway sleep
setInterval(async () => {
  try {
    await fetch('https://alpaca-proxy-production-32ad.up.railway.app/health');
  } catch(e) {}
}, 5 * 60 * 1000);

app.listen(3001, () => console.log('🤖 Market Intelligence Agent running on port 3001'));
