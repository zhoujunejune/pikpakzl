import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT || 8080);
const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const SYMBOL_LOWER = SYMBOL.toLowerCase();
const SPOT_WS_BASE = String(process.env.BINANCE_SPOT_WS_BASE || 'wss://stream.binance.com:9443');
const BINANCE_API = String(process.env.BINANCE_API_BASE || 'https://api.binance.com').replace(/\/$/, '');
const PRED_WSS_BASE = String(process.env.BINANCE_PREDICTION_WSS_BASE || 'wss://api.binance.com/sapi/wss');
const API_KEY = String(process.env.BINANCE_PREDICTION_API_KEY || '');
const API_SECRET = String(process.env.BINANCE_PREDICTION_API_SECRET || '');
const ORDER_SERVICE_ORIGIN = String(process.env.ORDER_SERVICE_ORIGIN || '').replace(/\/$/, '');
const SIGNAL_SHARED_SECRET = String(process.env.SIGNAL_SHARED_SECRET || '');

const EVAL_MS = Math.max(50, Number(process.env.SIGNAL_EVAL_MS || 100));
const TRADE_WINDOW_MS = Math.max(250, Number(process.env.TRADE_WINDOW_MS || 750));
const CONFIRM_MS = Math.max(100, Number(process.env.SIGNAL_CONFIRM_MS || 250));
const MIN_CONFIDENCE = Math.min(0.98, Math.max(0.50, Number(process.env.SIGNAL_MIN_CONFIDENCE || 0.68)));
const MIN_TRADES = Math.max(3, Number(process.env.SIGNAL_MIN_TRADES || 8));
const PUSH_TTL_MS = Math.max(500, Number(process.env.SIGNAL_TTL_MS || 1500));
const MIN_ROUND_AGE_MS = Math.max(0, Number(process.env.MIN_ROUND_AGE_MS || 1000));
const MAX_ROUND_AGE_MS = Math.min(299000, Math.max(30000, Number(process.env.MAX_ROUND_AGE_MS || 285000)));
const PRED_REFRESH_MS = Math.max(5000, Number(process.env.PREDICTION_MARKET_REFRESH_MS || 12000));

const state = {
  startedAt: Date.now(),
  spotConnected: false,
  predictionConnected: false,
  predictionAuthConfigured: Boolean(API_KEY && API_SECRET),
  spotLastMessageAt: 0,
  predictionLastMessageAt: 0,
  latestBook: null,
  trades: [],
  priceSamples: [],
  prediction: {
    topicId: null,
    topicStart: null,
    topicEnd: null,
    mappedMarkets: {},
    books: {},
    lastRefreshAt: 0,
    lastRefreshError: null,
  },
  candidateDirection: null,
  candidateSince: 0,
  lastComputed: null,
  lastSignal: null,
  sentRound: null,
  lastPush: null,
};

let spotWs = null;
let predictionWs = null;
let stopping = false;
let predReconnectTimer = null;

function clamp(v, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

function currentRoundMs(t = Date.now()) {
  return Math.floor(t / 300000) * 300000;
}

function cleanOld(now = Date.now()) {
  const tradeCutoff = now - Math.max(TRADE_WINDOW_MS * 3, 5000);
  while (state.trades.length && state.trades[0].ts < tradeCutoff) state.trades.shift();
  const priceCutoff = now - 8000;
  while (state.priceSamples.length && state.priceSamples[0].ts < priceCutoff) state.priceSamples.shift();
}

function samplePriceAgo(ms, now = Date.now()) {
  const target = now - ms;
  let best = null;
  for (let i = state.priceSamples.length - 1; i >= 0; i -= 1) {
    const s = state.priceSamples[i];
    best = s;
    if (s.ts <= target) break;
  }
  return best?.price ?? null;
}

function parseLevels(levels, limit = 10) {
  if (!Array.isArray(levels)) return [];
  return levels.slice(0, limit).map(x => [Number(x?.[0]), Number(x?.[1])]).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[0] > 0 && x[1] >= 0);
}

function updateSpotBookFromDepth(data, ts) {
  const bids = parseLevels(data?.b, 20);
  const asks = parseLevels(data?.a, 20);
  if (!bids.length || !asks.length) return;
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const bestBidQty = bids[0][1];
  const bestAskQty = asks[0][1];
  const mid = (bestBid + bestAsk) / 2;
  state.latestBook = { bids, asks, bestBid, bestAsk, bestBidQty, bestAskQty, mid, ts, source: 'depth20@100ms' };
  state.priceSamples.push({ ts, price: mid });
}

function updateSpotBookFromTicker(data, ts) {
  const bestBid = Number(data?.b);
  const bestAsk = Number(data?.a);
  const bestBidQty = Number(data?.B);
  const bestAskQty = Number(data?.A);
  if (![bestBid, bestAsk, bestBidQty, bestAskQty].every(Number.isFinite) || bestBid <= 0 || bestAsk <= 0) return;
  const mid = (bestBid + bestAsk) / 2;
  if (!state.latestBook || ts >= state.latestBook.ts) {
    state.latestBook = {
      ...(state.latestBook || {}),
      bestBid, bestAsk, bestBidQty, bestAskQty, mid, ts, source: 'bookTicker',
    };
  }
  state.priceSamples.push({ ts, price: mid });
}

function onAggTrade(data, ts) {
  const price = Number(data?.p);
  const qty = Number(data?.q);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return;
  const aggressiveBuy = data?.m === false;
  state.trades.push({ ts, price, qty, notional: price * qty, aggressiveBuy });
}

function connectSpot() {
  if (stopping) return;
  const streams = `${SYMBOL_LOWER}@aggTrade/${SYMBOL_LOWER}@bookTicker/${SYMBOL_LOWER}@depth20@100ms`;
  const url = `${SPOT_WS_BASE}/stream?streams=${streams}`;
  const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10000 });
  spotWs = ws;

  ws.on('open', () => {
    state.spotConnected = true;
    console.log(JSON.stringify({ event: 'spot_ws_connected', symbol: SYMBOL, url: SPOT_WS_BASE, at: new Date().toISOString() }));
  });

  ws.on('message', raw => {
    try {
      const outer = JSON.parse(raw.toString());
      const stream = String(outer?.stream || '');
      const data = outer?.data || {};
      const ts = Number(data?.E || data?.T || Date.now());
      state.spotLastMessageAt = Date.now();
      if (stream.includes('@aggTrade')) onAggTrade(data, ts);
      else if (stream.includes('@bookTicker')) updateSpotBookFromTicker(data, ts);
      else if (stream.includes('@depth20')) updateSpotBookFromDepth(data, ts);
      cleanOld();
    } catch (e) {
      console.log(JSON.stringify({ event: 'spot_ws_parse_error', error: e?.message || String(e) }));
    }
  });

  ws.on('ping', data => { try { ws.pong(data); } catch {} });
  ws.on('close', (code, reason) => {
    state.spotConnected = false;
    console.log(JSON.stringify({ event: 'spot_ws_closed', code, reason: reason?.toString?.() || '', at: new Date().toISOString() }));
    if (!stopping) setTimeout(connectSpot, 800);
  });
  ws.on('error', e => console.log(JSON.stringify({ event: 'spot_ws_error', error: e?.message || String(e) })));
}

function signedQuery(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function signedGet(path, params = {}) {
  if (!API_KEY || !API_SECRET) throw new Error('PREDICTION_API_CREDENTIALS_MISSING');
  const base = { ...params, recvWindow: 5000, timestamp: Date.now() };
  const qs = signedQuery(base);
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  const r = await fetch(`${BINANCE_API}${path}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': API_KEY },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new Error(body?.msg || body?.message || `HTTP_${r.status}`);
  return body;
}

function directionFromMarket(market) {
  const text = `${market?.title || ''} ${market?.question || ''} ${market?.name || ''}`.toUpperCase();
  if (/\bUP\b|HIGHER|ABOVE|上涨|看涨/.test(text)) return 'UP';
  if (/\bDOWN\b|LOWER|BELOW|下跌|看跌/.test(text)) return 'DOWN';
  return null;
}

async function refreshPredictionMarket() {
  if (!API_KEY || !API_SECRET) return;
  try {
    const list = await signedGet('/sapi/v1/w3w/wallet/prediction/market/list', {
      l1Category: 'crypto', l2Category: 'up-down', sortBy: 'CREATED_TIME', orderBy: 'DESC', offset: 0, limit: 100,
    });
    const topics = Array.isArray(list?.marketTopics) ? list.marketTopics : [];
    const now = Date.now();
    const candidates = topics.filter(t => {
      const s = Number(t?.startDate), e = Number(t?.endDate);
      const duration = e - s;
      return String(t?.symbol || '').toUpperCase() === SYMBOL && Number.isFinite(duration) && duration >= 240000 && duration <= 360000;
    });
    const active = candidates.filter(t => Number(t.startDate) <= now + 30000 && Number(t.endDate) >= now - 30000)
      .sort((a, b) => Math.abs(Number(a.startDate) - currentRoundMs(now)) - Math.abs(Number(b.startDate) - currentRoundMs(now)))[0]
      || candidates[0];
    if (!active?.marketTopicId) throw new Error('BTC_5M_PREDICTION_MARKET_NOT_FOUND');
    const detail = await signedGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId: active.marketTopicId });
    const topic = { ...active, ...detail };
    const map = {};
    for (const m of Array.isArray(topic?.markets) ? topic.markets : []) {
      const id = m?.marketId ?? m?.id ?? m?.vendorMarketId;
      if (id == null) continue;
      const direction = directionFromMarket(m);
      if (direction) map[String(id)] = direction;
    }
    state.prediction.topicId = topic.marketTopicId;
    state.prediction.topicStart = Number(topic.startDate || active.startDate || 0) || null;
    state.prediction.topicEnd = Number(topic.endDate || active.endDate || 0) || null;
    state.prediction.mappedMarkets = map;
    state.prediction.lastRefreshAt = Date.now();
    state.prediction.lastRefreshError = null;
  } catch (e) {
    state.prediction.lastRefreshAt = Date.now();
    state.prediction.lastRefreshError = e?.message || String(e);
    console.log(JSON.stringify({ event: 'prediction_market_refresh_error', error: state.prediction.lastRefreshError }));
  }
}

function predictionWsUrl() {
  const params = {
    random: crypto.randomUUID().replaceAll('-', ''),
    recvWindow: 30000,
    timestamp: Date.now(),
    topic: 'web3_prediction_orderbook_data',
  };
  const qs = signedQuery(params);
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${PRED_WSS_BASE}?${qs}&signature=${signature}`;
}

function schedulePredictionReconnect(delay = 1200) {
  if (stopping || !API_KEY || !API_SECRET) return;
  clearTimeout(predReconnectTimer);
  predReconnectTimer = setTimeout(connectPrediction, delay);
}

function connectPrediction() {
  if (stopping || !API_KEY || !API_SECRET) return;
  let url;
  try { url = predictionWsUrl(); } catch (e) { return schedulePredictionReconnect(5000); }
  const ws = new WebSocket(url, { headers: { 'X-MBX-APIKEY': API_KEY }, perMessageDeflate: false, handshakeTimeout: 10000 });
  predictionWs = ws;
  ws.on('open', () => {
    state.predictionConnected = true;
    console.log(JSON.stringify({ event: 'prediction_ws_connected', topic: 'web3_prediction_orderbook_data', at: new Date().toISOString() }));
  });
  ws.on('message', raw => {
    try {
      const envelope = JSON.parse(raw.toString());
      let data = envelope?.data;
      if (typeof data === 'string') data = JSON.parse(data);
      if (!data || data.msgType !== 'orderbook' || data.marketId == null) return;
      const id = String(data.marketId);
      const updateTs = Number(data.updateTimestampMs || Date.now());
      const prev = state.prediction.books[id];
      if (prev && Number(prev.updateTs) > updateTs) return;
      const bids = parseLevels(data.bids, 20);
      const asks = parseLevels(data.asks, 20);
      const bestBid = bids[0]?.[0] ?? null;
      const bestAsk = asks[0]?.[0] ?? null;
      let mid = null;
      if (bestBid != null && bestAsk != null) mid = (bestBid + bestAsk) / 2;
      else if (bestBid != null) mid = bestBid;
      else if (bestAsk != null) mid = bestAsk;
      state.prediction.books[id] = { id, direction: state.prediction.mappedMarkets[id] || null, bestBid, bestAsk, mid, updateTs, receivedAt: Date.now() };
      state.predictionLastMessageAt = Date.now();
    } catch (e) {
      console.log(JSON.stringify({ event: 'prediction_ws_parse_error', error: e?.message || String(e) }));
    }
  });
  ws.on('ping', data => { try { ws.pong(data); } catch {} });
  ws.on('close', (code, reason) => {
    state.predictionConnected = false;
    console.log(JSON.stringify({ event: 'prediction_ws_closed', code, reason: reason?.toString?.() || '', at: new Date().toISOString() }));
    schedulePredictionReconnect();
  });
  ws.on('error', e => console.log(JSON.stringify({ event: 'prediction_ws_error', error: e?.message || String(e) })));
}

function predictionFactor(now = Date.now()) {
  let up = null, down = null;
  for (const book of Object.values(state.prediction.books)) {
    if (!book || book.mid == null || now - Number(book.receivedAt || 0) > 2500) continue;
    const dir = state.prediction.mappedMarkets[String(book.id)] || book.direction;
    if (dir === 'UP') up = book;
    if (dir === 'DOWN') down = book;
  }
  if (up && down) return { score: clamp(up.mid - down.mid), upChance: up.mid, downChance: down.mid, factual: true };
  if (up) return { score: clamp((up.mid - 0.5) * 2), upChance: up.mid, downChance: null, factual: true };
  if (down) return { score: clamp((0.5 - down.mid) * 2), upChance: null, downChance: down.mid, factual: true };
  return null;
}

function calculateSignal(now = Date.now()) {
  cleanOld(now);
  const book = state.latestBook;
  if (!book || now - Number(book.ts || 0) > 1200) return null;

  const recentTrades = state.trades.filter(t => t.ts >= now - TRADE_WINDOW_MS);
  if (recentTrades.length < MIN_TRADES) return null;
  let buy = 0, sell = 0;
  for (const t of recentTrades) {
    if (t.aggressiveBuy) buy += t.notional;
    else sell += t.notional;
  }
  const tradePressure = (buy - sell) / (buy + sell || 1);

  const bids = Array.isArray(book.bids) && book.bids.length ? book.bids.slice(0, 10) : [[book.bestBid, book.bestBidQty]];
  const asks = Array.isArray(book.asks) && book.asks.length ? book.asks.slice(0, 10) : [[book.bestAsk, book.bestAskQty]];
  const bidDepth = bids.reduce((s, [p, q]) => s + (Number(p) || 0) * (Number(q) || 0), 0);
  const askDepth = asks.reduce((s, [p, q]) => s + (Number(p) || 0) * (Number(q) || 0), 0);
  const bookImbalance = (bidDepth - askDepth) / (bidDepth + askDepth || 1);

  const spread = Math.max(1e-9, Number(book.bestAsk) - Number(book.bestBid));
  const micro = ((Number(book.bestAsk) * Number(book.bestBidQty)) + (Number(book.bestBid) * Number(book.bestAskQty))) / ((Number(book.bestBidQty) + Number(book.bestAskQty)) || 1);
  const microScore = clamp((micro - Number(book.mid)) / spread);

  const p500 = samplePriceAgo(500, now);
  const p1500 = samplePriceAgo(1500, now);
  const current = Number(book.mid);
  const r500 = p500 ? (current - p500) / p500 : 0;
  const r1500 = p1500 ? (current - p1500) / p1500 : 0;
  const momentum = clamp(0.6 * clamp(r500 / 0.00015) + 0.4 * clamp(r1500 / 0.00030));

  const pred = predictionFactor(now);
  const factors = [
    { name: 'tradePressure', value: clamp(tradePressure), weight: 0.34 },
    { name: 'bookImbalance', value: clamp(bookImbalance), weight: 0.29 },
    { name: 'microprice', value: microScore, weight: 0.14 },
    { name: 'momentum', value: momentum, weight: 0.15 },
  ];
  if (pred) factors.push({ name: 'predictionOrderbook', value: clamp(pred.score), weight: 0.08 });
  const weightSum = factors.reduce((s, f) => s + f.weight, 0);
  const score = clamp(factors.reduce((s, f) => s + f.value * f.weight, 0) / weightSum);
  const confidence = Math.min(1, Math.abs(score));
  const direction = score >= 0 ? 'UP' : 'DOWN';

  return {
    round: currentRoundMs(now), direction, score, confidence,
    components: {
      tradePressure: Number(tradePressure.toFixed(6)),
      bookImbalance: Number(bookImbalance.toFixed(6)),
      microprice: Number(microScore.toFixed(6)),
      momentum: Number(momentum.toFixed(6)),
      predictionOrderbook: pred ? Number(pred.score.toFixed(6)) : null,
      predictionUpChance: pred?.upChance ?? null,
      predictionDownChance: pred?.downChance ?? null,
      tradeCount: recentTrades.length,
      spotMid: current,
    },
    dataAgeMs: Math.max(0, now - Number(book.ts || now)),
    predictionDataAgeMs: state.predictionLastMessageAt ? Math.max(0, now - state.predictionLastMessageAt) : null,
  };
}

async function pushSignal(signal) {
  const payload = { ...signal, status: 'LOCKED', ts: Date.now(), source: 'BINANCE_OFFICIAL_WS_FAST' };
  state.lastSignal = payload;
  if (!ORDER_SERVICE_ORIGIN) {
    state.lastPush = { ok: false, error: 'ORDER_SERVICE_ORIGIN_MISSING', at: Date.now() };
    return false;
  }
  if (!SIGNAL_SHARED_SECRET) {
    state.lastPush = { ok: false, error: 'SIGNAL_SHARED_SECRET_MISSING', at: Date.now() };
    return false;
  }
  try {
    const started = Date.now();
    const r = await fetch(`${ORDER_SERVICE_ORIGIN}/api/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signal-secret': SIGNAL_SHARED_SECRET },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PUSH_TTL_MS),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    state.lastPush = { ok: r.ok, status: r.status, latencyMs: Date.now() - started, body, at: Date.now() };
    console.log(JSON.stringify({ event: r.ok ? 'signal_pushed' : 'signal_push_rejected', round: payload.round, direction: payload.direction, confidence: payload.confidence, score: payload.score, status: r.status, latencyMs: state.lastPush.latencyMs, response: body }));
    return r.ok;
  } catch (e) {
    state.lastPush = { ok: false, error: e?.message || String(e), at: Date.now() };
    console.log(JSON.stringify({ event: 'signal_push_error', error: state.lastPush.error }));
    return false;
  }
}

let evaluating = false;
async function evaluate() {
  if (evaluating) return;
  evaluating = true;
  try {
    const now = Date.now();
    const round = currentRoundMs(now);
    if (state.sentRound != null && String(state.sentRound) !== String(round)) {
      state.sentRound = null;
      state.candidateDirection = null;
      state.candidateSince = 0;
    }
    const roundAge = now - round;
    if (roundAge < MIN_ROUND_AGE_MS || roundAge > MAX_ROUND_AGE_MS) return;
    const computed = calculateSignal(now);
    state.lastComputed = computed ? { ...computed, at: now } : null;
    if (!computed || computed.confidence < MIN_CONFIDENCE) {
      state.candidateDirection = null;
      state.candidateSince = 0;
      return;
    }
    if (state.candidateDirection !== computed.direction) {
      state.candidateDirection = computed.direction;
      state.candidateSince = now;
      return;
    }
    if (now - state.candidateSince < CONFIRM_MS) return;
    if (String(state.sentRound) === String(round)) return;
    const ok = await pushSignal(computed);
    if (ok) state.sentRound = round;
  } finally {
    evaluating = false;
  }
}

function publicState() {
  return {
    ok: true,
    service: 'fast-binance-prediction-signal',
    symbol: SYMBOL,
    config: { evalMs: EVAL_MS, tradeWindowMs: TRADE_WINDOW_MS, confirmMs: CONFIRM_MS, minConfidence: MIN_CONFIDENCE, minTrades: MIN_TRADES, minRoundAgeMs: MIN_ROUND_AGE_MS, maxRoundAgeMs: MAX_ROUND_AGE_MS },
    sources: {
      spot: { connected: state.spotConnected, lastMessageAgeMs: state.spotLastMessageAt ? Date.now() - state.spotLastMessageAt : null, source: 'Binance Spot WebSocket' },
      prediction: { connected: state.predictionConnected, authConfigured: state.predictionAuthConfigured, lastMessageAgeMs: state.predictionLastMessageAt ? Date.now() - state.predictionLastMessageAt : null, topicId: state.prediction.topicId, mappedMarkets: state.prediction.mappedMarkets, lastRefreshError: state.prediction.lastRefreshError, source: 'Binance Prediction SApi WebSocket' },
    },
    lastComputed: state.lastComputed,
    lastSignal: state.lastSignal,
    lastPush: state.lastPush,
    currentRound: currentRoundMs(),
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const healthy = state.spotConnected && state.spotLastMessageAt && Date.now() - state.spotLastMessageAt < 3000;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...publicState(), healthy }));
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/state' || url.pathname === '/api/signal')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(publicState()));
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'fast_signal_started', port: PORT, symbol: SYMBOL, evalMs: EVAL_MS, tradeWindowMs: TRADE_WINDOW_MS, confirmMs: CONFIRM_MS, minConfidence: MIN_CONFIDENCE, orderServiceConfigured: Boolean(ORDER_SERVICE_ORIGIN), predictionAuthConfigured: Boolean(API_KEY && API_SECRET) }));
});

connectSpot();
if (API_KEY && API_SECRET) {
  await refreshPredictionMarket();
  connectPrediction();
  setInterval(refreshPredictionMarket, PRED_REFRESH_MS);
}
setInterval(evaluate, EVAL_MS);

function shutdown(signal) {
  stopping = true;
  clearTimeout(predReconnectTimer);
  try { spotWs?.close(); } catch {}
  try { predictionWs?.close(); } catch {}
  console.log(JSON.stringify({ event: 'fast_signal_stopped', signal }));
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
