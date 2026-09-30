import crypto from 'node:crypto';
import WebSocket from 'ws';

const API_KEY = String(process.env.BINANCE_PREDICTION_API_KEY || '');
const API_SECRET = String(process.env.BINANCE_PREDICTION_API_SECRET || '');
const BASE = String(process.env.BINANCE_PREDICTION_WSS_BASE || 'wss://api.binance.com/sapi/wss');
const TIMEOUT_MS = Math.max(5000, Number(process.env.PREDICTION_PROBE_TIMEOUT_MS || 15000));

if (!API_KEY || !API_SECRET) {
  console.error(JSON.stringify({ event: 'prediction_probe_failed', error: 'PREDICTION_API_CREDENTIALS_MISSING' }));
  process.exit(1);
}

function signedUrl() {
  const params = {
    random: crypto.randomUUID().replaceAll('-', ''),
    recvWindow: 30000,
    timestamp: Date.now(),
    topic: 'web3_prediction_orderbook_data',
  };
  const qs = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString();
  const sig = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${BASE}?${qs}&signature=${sig}`;
}

const ws = new WebSocket(signedUrl(), {
  headers: { 'X-MBX-APIKEY': API_KEY },
  perMessageDeflate: false,
  handshakeTimeout: 10000,
});

const timer = setTimeout(() => {
  console.error(JSON.stringify({ event: 'prediction_probe_failed', error: 'NO_VALID_ORDERBOOK_MESSAGE', timeoutMs: TIMEOUT_MS }));
  try { ws.terminate(); } catch {}
  process.exit(1);
}, TIMEOUT_MS);

ws.on('open', () => {
  console.log(JSON.stringify({ event: 'prediction_probe_connected' }));
});

ws.on('message', raw => {
  try {
    const envelope = JSON.parse(raw.toString());
    let data = envelope?.data;
    if (typeof data === 'string') {
      if (data === 'SUCCESS') return;
      try { data = JSON.parse(data); } catch { return; }
    }
    if (!data || data.msgType !== 'orderbook' || data.marketId == null) return;
    if (!Array.isArray(data.bids) || !Array.isArray(data.asks)) return;
    clearTimeout(timer);
    console.log(JSON.stringify({
      event: 'prediction_probe_verified',
      marketId: String(data.marketId),
      updateTimestampMs: Number(data.updateTimestampMs || 0),
      bidLevels: data.bids.length,
      askLevels: data.asks.length,
      bestBid: data.bids?.[0] || null,
      bestAsk: data.asks?.[0] || null,
      receivedAt: Date.now(),
    }));
    try { ws.close(); } catch {}
    setTimeout(() => process.exit(0), 50);
  } catch {}
});

ws.on('ping', payload => { try { ws.pong(payload); } catch {} });
ws.on('error', err => {
  console.error(JSON.stringify({ event: 'prediction_probe_error', error: err?.message || String(err) }));
});
