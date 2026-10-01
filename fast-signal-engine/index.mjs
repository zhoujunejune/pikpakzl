import http from 'node:http';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT || 3000);
const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const SYMBOL_LOWER = SYMBOL.toLowerCase();
const WINDOW_MS = Math.max(2000, Number(process.env.SIGNAL_WINDOW_MS || 5000));
const EVAL_MS = Math.max(100, Number(process.env.SIGNAL_EVAL_MS || 200));
const MIN_TRADES = Math.max(5, Number(process.env.SIGNAL_MIN_TRADES || 12));
const MIN_OFI_EVENTS = Math.max(3, Number(process.env.SIGNAL_MIN_OFI_EVENTS || 8));
const SCORE_THRESHOLD = Math.min(0.95, Math.max(0.05, Number(process.env.SIGNAL_SCORE_THRESHOLD || 0.22)));
const CONFIRM_TICKS = Math.max(2, Number(process.env.SIGNAL_CONFIRM_TICKS || 3));
const STALE_MS = Math.max(500, Number(process.env.SIGNAL_STALE_MS || 1500));
const OBSERVE_MIN_MS = Math.max(2500, Number(process.env.SIGNAL_OBSERVE_MIN_MS || 3500));
const DECISION_WINDOW_MS = Math.max(OBSERVE_MIN_MS + 1000, Number(process.env.SIGNAL_DECISION_WINDOW_MS || 9000));
const MICRO_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_MICRO_THRESHOLD || 0.20));
const TREND_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_TREND_THRESHOLD || 0.16));
const CONTEXT_OPPOSE_LIMIT = Math.max(0.10, Number(process.env.SIGNAL_CONTEXT_OPPOSE_LIMIT || 0.30));
const STRATEGY_VERSION = 'QUALITY_FILTER_V3_5M';

const STREAMS = [
  `${SYMBOL_LOWER}@aggTrade`,
  `${SYMBOL_LOWER}@bookTicker`,
  `${SYMBOL_LOWER}@depth20@100ms`,
  `${SYMBOL_LOWER}@kline_1m`,
  `${SYMBOL_LOWER}@kline_5m`,
  `${SYMBOL_LOWER}@kline_15m`,
];
const WS_URL = process.env.BINANCE_WS_URL || `wss://stream.binance.com:9443/stream?streams=${STREAMS.join('/')}`;

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const bps = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? ((a - b) / b) * 10000 : 0;

let ws = null;
let reconnectTimer = null;
let reconnects = 0;
let lastWsMessageAt = 0;
let lastTradeExchangeLagMs = null;
let connectedAt = null;

let bestBid = null;
let bestAsk = null;
let bestBidQty = null;
let bestAskQty = null;
let lastPrice = null;
let currentKlineOpen = null;
let currentKlineStart = null;
let currentKlineEnd = null;
let currentKline1mOpen = null;
let currentKline15mOpen = null;

let prevDepthBid = null;
let prevDepthAsk = null;
let prevDepthBidQty = null;
let prevDepthAskQty = null;
let lastDepthUpdateId = null;
let lastDepthAt = 0;

const trades = [];
const prices = [];
const ofiEvents = [];

let candidateDirection = 'WAIT';
let candidateTicks = 0;
let frozenRoundStart = null;
let frozenDirection = 'WAIT';
let frozenScore = 0;
let frozenConfidence = 0;
let frozenAt = null;
let lastSignal = {
  direction: 'WAIT',
  candidateDirection: 'WAIT',
  score: 0,
  confidence: 0,
  generatedAt: Date.now(),
  reason: 'STARTING',
};

function prune(now) {
  const cutoff = now - WINDOW_MS;
  while (trades.length && trades[0].localTs < cutoff) trades.shift();
  while (ofiEvents.length && ofiEvents[0].localTs < cutoff) ofiEvents.shift();
  const priceCutoff = now - Math.max(WINDOW_MS, 5000);
  while (prices.length && prices[0].localTs < priceCutoff) prices.shift();
}

function priceNear(targetTs) {
  if (!prices.length) return null;
  let selected = null;
  for (let i = prices.length - 1; i >= 0; i -= 1) {
    if (prices[i].localTs <= targetTs) {
      selected = prices[i].price;
      break;
    }
  }
  return selected ?? prices[0].price;
}

function roundInfo(now) {
  const start = Number.isFinite(currentKlineStart) ? currentKlineStart : Math.floor(now / 300000) * 300000;
  const end = Number.isFinite(currentKlineEnd) ? currentKlineEnd : start + 300000 - 1;
  return { start, end };
}

function pushOfiEvent(now, bid, bidQty, ask, askQty) {
  if (![prevDepthBid, prevDepthAsk, prevDepthBidQty, prevDepthAskQty].every(Number.isFinite)) {
    prevDepthBid = bid;
    prevDepthAsk = ask;
    prevDepthBidQty = bidQty;
    prevDepthAskQty = askQty;
    return;
  }

  // Top-of-book OFI using real Binance depth snapshots.
  // Positive = buy-side pressure; negative = sell-side pressure.
  let bidContribution = 0;
  if (bid > prevDepthBid) bidContribution = bidQty;
  else if (bid < prevDepthBid) bidContribution = -prevDepthBidQty;
  else bidContribution = bidQty - prevDepthBidQty;

  let askContribution = 0;
  if (ask < prevDepthAsk) askContribution = -askQty;
  else if (ask > prevDepthAsk) askContribution = prevDepthAskQty;
  else askContribution = prevDepthAskQty - askQty;

  const value = bidContribution + askContribution;
  const scale = Math.abs(bidContribution) + Math.abs(askContribution);
  ofiEvents.push({ localTs: now, value, scale });

  prevDepthBid = bid;
  prevDepthAsk = ask;
  prevDepthBidQty = bidQty;
  prevDepthAskQty = askQty;
}

function calculate(now = Date.now()) {
  prune(now);

  const dataAgeMs = lastWsMessageAt ? now - lastWsMessageAt : Infinity;
  const depthAgeMs = lastDepthAt ? now - lastDepthAt : Infinity;
  const hasBook = [bestBid, bestAsk, bestBidQty, bestAskQty].every(Number.isFinite);
  const hasPrice = Number.isFinite(lastPrice);

  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    if (t.isAggressiveBuy) buyVol += t.qty;
    else sellVol += t.qty;
  }
  const totalVol = buyVol + sellVol;
  const tradePressure = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

  const bookTotal = hasBook ? bestBidQty + bestAskQty : 0;
  const bookImbalance = bookTotal > 0 ? (bestBidQty - bestAskQty) / bookTotal : 0;

  let ofiRaw = 0;
  let ofiScale = 0;
  for (const e of ofiEvents) {
    ofiRaw += e.value;
    ofiScale += e.scale;
  }
  const ofiNormalized = ofiScale > 0 ? clamp(ofiRaw / ofiScale) : 0;

  const p1 = priceNear(now - 1000);
  const p3 = priceNear(now - 3000);
  const p5 = priceNear(now - 5000);
  const momentum1sBps = hasPrice && Number.isFinite(p1) ? bps(lastPrice, p1) : 0;
  const momentum3sBps = hasPrice && Number.isFinite(p3) ? bps(lastPrice, p3) : 0;
  const momentum5sBps = hasPrice && Number.isFinite(p5) ? bps(lastPrice, p5) : 0;

  const mid = hasBook ? (bestBid + bestAsk) / 2 : null;
  const microprice = hasBook && bookTotal > 0
    ? (bestAsk * bestBidQty + bestBid * bestAskQty) / bookTotal
    : null;
  const micropriceBps = Number.isFinite(microprice) && Number.isFinite(mid) ? bps(microprice, mid) : 0;
  const spreadBps = hasBook && Number.isFinite(mid) ? ((bestAsk - bestBid) / mid) * 10000 : null;
  const distanceFromOpenBps = hasPrice && Number.isFinite(currentKlineOpen) ? bps(lastPrice, currentKlineOpen) : 0;
  const distanceFrom1mOpenBps = hasPrice && Number.isFinite(currentKline1mOpen) ? bps(lastPrice, currentKline1mOpen) : 0;
  const distanceFrom15mOpenBps = hasPrice && Number.isFinite(currentKline15mOpen) ? bps(lastPrice, currentKline15mOpen) : 0;

  // V3: separate "what the order flow is doing now" from "whether price is actually following".
  // We only lock when microstructure and short-horizon price trend agree inside the early decision window.
  const microScore = clamp(
    0.35 * clamp(ofiNormalized) +
    0.30 * clamp(tradePressure) +
    0.20 * clamp(bookImbalance) +
    0.15 * clamp(micropriceBps / 0.5)
  );
  const trendScore = clamp(
    0.40 * clamp(distanceFromOpenBps / 5) +
    0.35 * clamp(momentum5sBps / 4) +
    0.15 * clamp(momentum3sBps / 3) +
    0.10 * clamp(momentum1sBps / 2)
  );
  const contextScore = clamp(
    0.60 * clamp(distanceFrom15mOpenBps / 20) +
    0.40 * clamp(distanceFrom1mOpenBps / 8)
  );
  const score = clamp(0.50 * microScore + 0.35 * trendScore + 0.15 * contextScore);

  const round = roundInfo(now);
  const elapsedMs = Math.max(0, now - round.start);
  if (frozenRoundStart !== round.start) {
    frozenRoundStart = round.start;
    frozenDirection = 'WAIT';
    frozenScore = 0;
    frozenConfidence = 0;
    frozenAt = null;
    candidateDirection = 'WAIT';
    candidateTicks = 0;
  }

  let nextCandidate = 'WAIT';
  let reason = 'QUALITY_FILTER_NEUTRAL';
  if (dataAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_STREAM';
  } else if (depthAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_DEPTH';
  } else if (!hasBook || !hasPrice) {
    reason = 'WAITING_FOR_REAL_MARKET_DATA';
  } else if (elapsedMs < OBSERVE_MIN_MS) {
    reason = 'OBSERVATION_WINDOW';
  } else if (elapsedMs > DECISION_WINDOW_MS) {
    reason = 'DECISION_WINDOW_EXPIRED';
  } else if (trades.length < MIN_TRADES) {
    reason = 'INSUFFICIENT_REAL_TRADES';
  } else if (ofiEvents.length < MIN_OFI_EVENTS) {
    reason = 'INSUFFICIENT_REAL_DEPTH_UPDATES';
  } else if (
    microScore >= MICRO_THRESHOLD &&
    trendScore >= TREND_THRESHOLD &&
    contextScore >= -CONTEXT_OPPOSE_LIMIT &&
    score >= SCORE_THRESHOLD
  ) {
    nextCandidate = 'UP';
    reason = 'MICRO_TREND_ALIGNED_UP';
  } else if (
    microScore <= -MICRO_THRESHOLD &&
    trendScore <= -TREND_THRESHOLD &&
    contextScore <= CONTEXT_OPPOSE_LIMIT &&
    score <= -SCORE_THRESHOLD
  ) {
    nextCandidate = 'DOWN';
    reason = 'MICRO_TREND_ALIGNED_DOWN';
  } else if (Math.sign(microScore) !== 0 && Math.sign(trendScore) !== 0 && Math.sign(microScore) !== Math.sign(trendScore)) {
    reason = 'MICRO_TREND_CONFLICT';
  } else {
    reason = 'QUALITY_THRESHOLDS_NOT_MET';
  }

  if (nextCandidate === candidateDirection) candidateTicks += 1;
  else {
    candidateDirection = nextCandidate;
    candidateTicks = 1;
  }

  const rawDirection = nextCandidate !== 'WAIT' && candidateTicks >= CONFIRM_TICKS ? nextCandidate : 'WAIT';
  const rawStrength = rawDirection === 'WAIT' ? 0 : Number(Math.min(0.99, Math.abs(score)).toFixed(4));

  if (frozenDirection === 'WAIT' && (rawDirection === 'UP' || rawDirection === 'DOWN')) {
    frozenDirection = rawDirection;
    frozenScore = Number(score.toFixed(6));
    frozenConfidence = rawStrength;
    frozenAt = now;
    console.log(JSON.stringify({
      event: 'round_signal_frozen',
      strategyVersion: STRATEGY_VERSION,
      round: round.start,
      direction: frozenDirection,
      score: frozenScore,
      signalStrength: frozenConfidence,
      elapsedMs,
      microScore: Number(microScore.toFixed(6)),
      trendScore: Number(trendScore.toFixed(6)),
      contextScore: Number(contextScore.toFixed(6)),
      at: new Date(frozenAt).toISOString(),
    }));
  }

  const direction = frozenDirection;
  const confidence = direction === 'WAIT' ? 0 : frozenConfidence;

  lastSignal = {
    direction,
    candidateDirection: nextCandidate,
    candidateTicks,
    requiredTicks: CONFIRM_TICKS,
    score: direction === 'WAIT' ? Number(score.toFixed(6)) : frozenScore,
    confidence,
    generatedAt: direction === 'WAIT' ? now : frozenAt,
    reason: direction === 'WAIT'
      ? (nextCandidate !== 'WAIT' ? 'CONFIRMING_QUALITY_SIGNAL' : reason)
      : 'ROUND_SIGNAL_FROZEN_V3',
    roundStartMs: round.start,
    roundEndMs: round.end,
    facts: {
      lastPrice,
      roundOpenPrice: currentKlineOpen,
      distanceFromOpenBps: Number(distanceFromOpenBps.toFixed(4)),
      bestBid,
      bestAsk,
      bidQty: bestBidQty,
      askQty: bestAskQty,
      spreadBps: Number.isFinite(spreadBps) ? Number(spreadBps.toFixed(4)) : null,
      tradeCount: trades.length,
      buyVolume: Number(buyVol.toFixed(8)),
      sellVolume: Number(sellVol.toFixed(8)),
      tradePressure: Number(tradePressure.toFixed(6)),
      bookImbalance: Number(bookImbalance.toFixed(6)),
      ofiEventCount: ofiEvents.length,
      ofiRaw: Number(ofiRaw.toFixed(8)),
      ofiScale: Number(ofiScale.toFixed(8)),
      ofiNormalized: Number(ofiNormalized.toFixed(6)),
      lastDepthUpdateId,
      depthAgeMs: Number.isFinite(depthAgeMs) ? depthAgeMs : null,
      momentum1sBps: Number(momentum1sBps.toFixed(4)),
      momentum3sBps: Number(momentum3sBps.toFixed(4)),
      momentum5sBps: Number(momentum5sBps.toFixed(4)),
      distanceFrom1mOpenBps: Number(distanceFrom1mOpenBps.toFixed(4)),
      distanceFrom15mOpenBps: Number(distanceFrom15mOpenBps.toFixed(4)),
      microprice: Number.isFinite(microprice) ? Number(microprice.toFixed(4)) : null,
      micropriceBps: Number(micropriceBps.toFixed(4)),
      microScore: Number(microScore.toFixed(6)),
      trendScore: Number(trendScore.toFixed(6)),
      contextScore: Number(contextScore.toFixed(6)),
      liveCandidateDirection: rawDirection,
      liveScore: Number(score.toFixed(6)),
      frozenDirection,
      frozenAt,
      roundElapsedMs: elapsedMs,
      strategyVersion: STRATEGY_VERSION,
    },
  };
}

function handleMessage(raw) {
  const now = Date.now();
  lastWsMessageAt = now;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const stream = String(msg?.stream || '');
  const d = msg?.data || {};

  if (stream.endsWith('@aggTrade')) {
    const price = Number(d.p);
    const qty = Number(d.q);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) return;
    const exchangeTs = Number(d.E || d.T || now);
    lastTradeExchangeLagMs = Number.isFinite(exchangeTs) ? Math.max(0, now - exchangeTs) : null;
    lastPrice = price;
    trades.push({
      localTs: now,
      exchangeTs,
      price,
      qty,
      // Binance aggTrade m=true => buyer is maker => seller is the aggressor.
      isAggressiveBuy: d.m === false,
    });
    prices.push({ localTs: now, exchangeTs, price });
    return;
  }

  if (stream.endsWith('@bookTicker')) {
    const bid = Number(d.b);
    const ask = Number(d.a);
    const bidQty = Number(d.B);
    const askQty = Number(d.A);
    if ([bid, ask, bidQty, askQty].every(Number.isFinite)) {
      bestBid = bid;
      bestAsk = ask;
      bestBidQty = bidQty;
      bestAskQty = askQty;
    }
    return;
  }

  if (stream.includes('@depth20@100ms')) {
    const bid0 = Array.isArray(d.bids) ? d.bids[0] : null;
    const ask0 = Array.isArray(d.asks) ? d.asks[0] : null;
    const bid = Number(bid0?.[0]);
    const bidQty = Number(bid0?.[1]);
    const ask = Number(ask0?.[0]);
    const askQty = Number(ask0?.[1]);
    if ([bid, ask, bidQty, askQty].every(Number.isFinite) && bid > 0 && ask > 0 && bidQty >= 0 && askQty >= 0) {
      pushOfiEvent(now, bid, bidQty, ask, askQty);
      lastDepthAt = now;
      if (Number.isFinite(Number(d.lastUpdateId))) lastDepthUpdateId = Number(d.lastUpdateId);
    }
    return;
  }

  if (stream.includes('@kline_1m')) {
    const k = d.k || {};
    const open = Number(k.o);
    if (Number.isFinite(open)) currentKline1mOpen = open;
    return;
  }

  if (stream.includes('@kline_5m')) {
    const k = d.k || {};
    const open = Number(k.o);
    const start = Number(k.t);
    const end = Number(k.T);
    if (Number.isFinite(open)) currentKlineOpen = open;
    if (Number.isFinite(start)) currentKlineStart = start;
    if (Number.isFinite(end)) currentKlineEnd = end;
    return;
  }

  if (stream.includes('@kline_15m')) {
    const k = d.k || {};
    const open = Number(k.o);
    if (Number.isFinite(open)) currentKline15mOpen = open;
  }
}

function resetMicrostructureState() {
  trades.length = 0;
  prices.length = 0;
  ofiEvents.length = 0;
  prevDepthBid = null;
  prevDepthAsk = null;
  prevDepthBidQty = null;
  prevDepthAskQty = null;
  lastDepthUpdateId = null;
  lastDepthAt = 0;
  candidateDirection = 'WAIT';
  candidateTicks = 0;
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }

  resetMicrostructureState();
  console.log(JSON.stringify({ event: 'binance_ws_connecting', url: WS_URL, at: new Date().toISOString() }));
  ws = new WebSocket(WS_URL, { perMessageDeflate: false, handshakeTimeout: 10000 });

  ws.on('open', () => {
    connectedAt = Date.now();
    reconnects = 0;
    console.log(JSON.stringify({ event: 'binance_ws_connected', streams: STREAMS, ofiMode: 'REAL_DEPTH20_100MS_TOP_OF_BOOK', at: new Date().toISOString() }));
  });

  ws.on('message', handleMessage);
  ws.on('ping', data => {
    try { ws.pong(data); } catch {}
  });
  ws.on('error', err => {
    console.error(JSON.stringify({ event: 'binance_ws_error', error: err?.message || String(err), at: new Date().toISOString() }));
  });
  ws.on('close', (code, reason) => {
    console.error(JSON.stringify({ event: 'binance_ws_closed', code, reason: reason?.toString?.() || '', at: new Date().toISOString() }));
    ws = null;
    reconnects += 1;
    const delay = Math.min(5000, 500 * Math.max(1, reconnects));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  });
}

setInterval(() => calculate(Date.now()), EVAL_MS).unref();
connect();

function payload() {
  const now = Date.now();
  return {
    ok: true,
    service: 'binance-fast-signal-engine',
    symbol: SYMBOL,
    source: 'BINANCE_OFFICIAL_SPOT_WEBSOCKET',
    model: STRATEGY_VERSION,
    dataIntegrity: {
      simulated: false,
      estimatedOrderBook: false,
      ofiUsesRealDepth: true,
      ofiMode: 'REAL_DEPTH20_100MS_TOP_OF_BOOK',
      streams: STREAMS,
      wsConnected: ws?.readyState === WebSocket.OPEN,
      connectedAt,
      lastMessageAgeMs: lastWsMessageAt ? now - lastWsMessageAt : null,
      lastDepthAgeMs: lastDepthAt ? now - lastDepthAt : null,
      lastExchangeEventLagMs: lastTradeExchangeLagMs,
      signalAgeMs: now - lastSignal.generatedAt,
    },
    config: {
      windowMs: WINDOW_MS,
      evaluationMs: EVAL_MS,
      minTrades: MIN_TRADES,
      minOfiEvents: MIN_OFI_EVENTS,
      scoreThreshold: SCORE_THRESHOLD,
      confirmTicks: CONFIRM_TICKS,
      staleMs: STALE_MS,
      observeMinMs: OBSERVE_MIN_MS,
      decisionWindowMs: DECISION_WINDOW_MS,
      microThreshold: MICRO_THRESHOLD,
      trendThreshold: TREND_THRESHOLD,
      contextOpposeLimit: CONTEXT_OPPOSE_LIMIT,
      freezePolicy: 'FIRST_QUALITY_LOCKED_UP_DOWN_PER_5M_ROUND',
      strategyVersion: STRATEGY_VERSION,
      weights: {
        finalMicro: 0.50,
        finalTrend: 0.35,
        finalContext: 0.15,
      },
    },
    signal: lastSignal,
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const p = payload();
    const healthy = p.dataIntegrity.wsConnected
      && p.dataIntegrity.lastMessageAgeMs != null
      && p.dataIntegrity.lastMessageAgeMs < STALE_MS * 2
      && p.dataIntegrity.lastDepthAgeMs != null
      && p.dataIntegrity.lastDepthAgeMs < STALE_MS * 2;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: healthy, service: p.service, source: p.source, model: p.model, dataIntegrity: p.dataIntegrity }));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/signal')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload()));
  }

  // Compatibility endpoint for the existing trade-control service. It is NOT wired to it automatically.
  if (req.method === 'GET' && url.pathname === '/api/local-predictions') {
    const p = payload();
    const s = p.signal;
    const locked = s.direction === 'UP' || s.direction === 'DOWN';
    const live = {
      round: s.roundStartMs,
      status: locked ? 'LOCKED' : 'WAIT',
      signal: locked ? { direction: s.direction, score: s.score, confidence: s.confidence } : null,
      input: { round: s.roundStartMs },
      generatedAt: s.generatedAt,
      source: p.source,
      model: p.model,
      facts: s.facts,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, live, records: [live] }));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'fast_signal_engine_started',
    port: PORT,
    symbol: SYMBOL,
    source: 'BINANCE_OFFICIAL_SPOT_WEBSOCKET',
    model: STRATEGY_VERSION,
    ofiMode: 'REAL_DEPTH20_100MS_TOP_OF_BOOK',
    strategyVersion: STRATEGY_VERSION,
    freezePolicy: 'FIRST_QUALITY_LOCKED_UP_DOWN_PER_5M_ROUND',
    observeMinMs: OBSERVE_MIN_MS,
    decisionWindowMs: DECISION_WINDOW_MS,
    streams: STREAMS,
    windowMs: WINDOW_MS,
    evaluationMs: EVAL_MS,
    confirmTicks: CONFIRM_TICKS,
    scoreThreshold: SCORE_THRESHOLD,
    at: new Date().toISOString(),
  }));
});
