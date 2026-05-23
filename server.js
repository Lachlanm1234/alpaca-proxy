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

app.use('/alpaca', async (req, res) => {
  const mode = req.headers['x-alpaca-mode'];
  const base = mode === 'live'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';
  const url = base + req.url;
  console.log('Proxying to:', url);
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'APCA-API-KEY-ID': req.headers['apca-api-key-id'],
        'APCA-API-SECRET-KEY': req.headers['apca-api-secret-key'],
        'Content-Type': 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await response.json();
    console.log('Alpaca response status:', response.status);
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log('Alpaca proxy running on port 3001'));
