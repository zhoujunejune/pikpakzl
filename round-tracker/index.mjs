import http from 'node:http';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT || 3000);
const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const SYMBOL_LOWER = SYMBOL.toLowerCase();
const SIGNAL_ORIGIN = String(process.env.SIGNAL_ORIGIN || 'https://signal-diagnostic-v3-production.up.railway.app').replace(/\/+$/, '');
const POLL_MS = Math.max(100, Number(process.env.SIGNAL_POLL_MS || 200));
const HISTORY_LIMIT = Math.max(20, Number(process.env.ROUND_HISTORY_LIMIT || 200));
const HISTORY_FILE = process.env.ROUND_HISTORY_FILE || '/tmp/round-history.json';
const KLINE_WS_URL = process.env.BINANCE_KLINE_WS_URL || `wss://stream.binance.com:9443/stream?streams=${SYMBOL_LOWER}@kline_5m`;

const rounds = new Map();
let signalPollBusy = false;
let ws = null;
let reconnectTimer = null;
let reconnects = 0;
let connectedAt = null;
let lastKlineAt = 0;
let lastSignalPollAt = 0;
let lastSignalOkAt = 0;
let lastSignalError = null;

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, service: 'round-tracker', at: new Date().toISOString(), ...extra }));
}

function saveHistory() {
  try {
    const data = Array.from(rounds.values())
      .sort((a, b) => a.roundStartMs - b.roundStartMs)
      .slice(-HISTORY_LIMIT);
    const temp = `${HISTORY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
    fs.renameSync(temp, HISTORY_FILE);
  } catch (e) {
    log('history_save_failed', { error: e?.message || String(e) });
  }
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const item of parsed.slice(-HISTORY_LIMIT)) {
      if (Number.isFinite(Number(item?.roundStartMs))) rounds.set(String(item.roundStartMs), item);
    }
    log('history_loaded', { records: rounds.size, file: HISTORY_FILE });
  } catch (e) {
    if (e?.code !== 'ENOENT') log('history_load_failed', { error: e?.message || String(e) });
  }
}

function ensureRound(roundStartMs, roundEndMs = null) {
  const key = String(roundStartMs);
  let row = rounds.get(key);
  if (!row) {
    row = {
      roundStartMs: Number(roundStartMs),
      roundEndMs: Number.isFinite(Number(roundEndMs)) ? Number(roundEndMs) : Number(roundStartMs) + 300000 - 1,
      prediction: 'WAIT',
      predictionScore: null,
      predictionConfidence: null,
      predictedAt: null,
      predictionDelayMs: null,
      actual: null,
      openPrice: null,
      closePrice: null,
      settledAt: null,
      result: 'PENDING',
      source: 'FAST_MICROSTRUCTURE_WITH_REAL_OFI_V2',
    };
    rounds.set(key, row);
    trimHistory();
  }
  return row;
}

function trimHistory() {
  if (rounds.size <= HISTORY_LIMIT) return;
  const keys = Array.from(rounds.keys()).sort((a, b) => Number(a) - Number(b));
  while (keys.length > HISTORY_LIMIT) rounds.delete(keys.shift());
}

async function pollSignal() {
  if (signalPollBusy) return;
  signalPollBusy = true;
  lastSignalPollAt = Date.now();
  try {
    const r = await fetch(`${SIGNAL_ORIGIN}/api/local-predictions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1000, POLL_MS * 4)),
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    const json = await r.json();
    const live = json?.live;
    if (!live?.round) return;
    lastSignalOkAt = Date.now();
    lastSignalError = null;

    const row = ensureRound(Number(live.round));
    const direction = live?.status === 'LOCKED' ? live?.signal?.direction : null;
    if (!row.predictedAt && (direction === 'UP' || direction === 'DOWN')) {
      row.prediction = direction;
      row.predictionScore = Number.isFinite(Number(live?.signal?.score)) ? Number(live.signal.score) : null;
      row.predictionConfidence = Number.isFinite(Number(live?.signal?.confidence)) ? Number(live.signal.confidence) : null;
      row.predictedAt = Number(live.generatedAt || Date.now());
      row.predictionDelayMs = Math.max(0, row.predictedAt - row.roundStartMs);
      row.source = live.model || row.source;
      saveHistory();
      log('round_prediction_locked', {
        round: row.roundStartMs,
        prediction: row.prediction,
        score: row.predictionScore,
        confidence: row.predictionConfidence,
        predictionDelayMs: row.predictionDelayMs,
      });
    }
  } catch (e) {
    lastSignalError = e?.message || String(e);
  } finally {
    signalPollBusy = false;
  }
}

function settleRound(k) {
  const start = Number(k.t);
  const end = Number(k.T);
  const open = Number(k.o);
  const close = Number(k.c);
  if (![start, end, open, close].every(Number.isFinite)) return;
  const row = ensureRound(start, end);
  row.roundEndMs = end;
  row.openPrice = open;
  row.closePrice = close;
  row.actual = close > open ? 'UP' : close < open ? 'DOWN' : 'FLAT';
  row.settledAt = Date.now();
  row.result = row.prediction === 'UP' || row.prediction === 'DOWN'
    ? (row.actual === row.prediction ? 'HIT' : row.actual === 'FLAT' ? 'FLAT' : 'MISS')
    : 'NO_DECISION';
  saveHistory();
  log('round_settled', {
    round: row.roundStartMs,
    prediction: row.prediction,
    actual: row.actual,
    result: row.result,
    openPrice: row.openPrice,
    closePrice: row.closePrice,
  });
}

function handleKline(raw) {
  lastKlineAt = Date.now();
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const k = msg?.data?.k || msg?.k;
  if (!k) return;
  const start = Number(k.t);
  const end = Number(k.T);
  if (Number.isFinite(start)) ensureRound(start, end);
  if (k.x === true) settleRound(k);
}

function connectKline() {
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }
  log('kline_ws_connecting', { url: KLINE_WS_URL });
  ws = new WebSocket(KLINE_WS_URL, { perMessageDeflate: false, handshakeTimeout: 10000 });
  ws.on('open', () => {
    connectedAt = Date.now();
    reconnects = 0;
    log('kline_ws_connected', { symbol: SYMBOL });
  });
  ws.on('message', handleKline);
  ws.on('ping', data => { try { ws.pong(data); } catch {} });
  ws.on('error', err => log('kline_ws_error', { error: err?.message || String(err) }));
  ws.on('close', (code, reason) => {
    log('kline_ws_closed', { code, reason: reason?.toString?.() || '' });
    ws = null;
    reconnects += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectKline, Math.min(5000, 500 * Math.max(1, reconnects)));
  });
}

function summary() {
  const records = Array.from(rounds.values()).sort((a, b) => b.roundStartMs - a.roundStartMs);
  const settled = records.filter(r => r.actual === 'UP' || r.actual === 'DOWN');
  const decided = settled.filter(r => r.prediction === 'UP' || r.prediction === 'DOWN');
  const correct = decided.filter(r => r.result === 'HIT').length;
  const wrong = decided.filter(r => r.result === 'MISS').length;
  const noDecision = settled.filter(r => r.result === 'NO_DECISION').length;
  const accuracyPct = decided.length ? Number(((correct / decided.length) * 100).toFixed(2)) : null;
  const coveragePct = settled.length ? Number(((decided.length / settled.length) * 100).toFixed(2)) : null;
  return {
    totalTrackedRounds: records.length,
    settledRounds: settled.length,
    decidedRounds: decided.length,
    correct,
    wrong,
    noDecision,
    accuracyPct,
    coveragePct,
  };
}

function payload() {
  const records = Array.from(rounds.values()).sort((a, b) => b.roundStartMs - a.roundStartMs);
  return {
    ok: true,
    service: 'binance-round-tracker',
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    rule: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',
    accuracyRule: 'HIT_DIVIDED_BY_DECIDED_SETTLED_ROUNDS',
    summary: summary(),
    health: {
      signalPollMs: POLL_MS,
      lastSignalPollAt,
      lastSignalOkAt,
      lastSignalError,
      klineWsConnected: ws?.readyState === WebSocket.OPEN,
      klineConnectedAt: connectedAt,
      lastKlineAgeMs: lastKlineAt ? Date.now() - lastKlineAt : null,
    },
    records: records.slice(0, 50),
  };
}

loadHistory();
connectKline();
setInterval(pollSignal, POLL_MS).unref();
pollSignal();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const p = payload();
    const healthy = p.health.klineWsConnected && p.health.lastSignalOkAt && Date.now() - p.health.lastSignalOkAt < 5000;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: Boolean(healthy), health: p.health }));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/round-stats')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload()));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => {
  log('round_tracker_started', {
    port: PORT,
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    pollMs: POLL_MS,
    historyLimit: HISTORY_LIMIT,
    historyFile: HISTORY_FILE,
    rule: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',
  });
});
