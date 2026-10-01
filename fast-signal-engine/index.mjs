import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT || 3000);
const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const SYMBOL_LOWER = SYMBOL.toLowerCase();
const WINDOW_MS = Math.max(5000, Number(process.env.SIGNAL_WINDOW_MS || 5000));
const STORAGE_MS = Math.max(300000, Number(process.env.SIGNAL_STORAGE_MS || 900000));
const EVAL_MS = Math.max(100, Number(process.env.SIGNAL_EVAL_MS || 200));
const MIN_TRADES = Math.max(5, Number(process.env.SIGNAL_MIN_TRADES || 12));
const MIN_OFI_EVENTS = Math.max(3, Number(process.env.SIGNAL_MIN_OFI_EVENTS || 8));
const SCORE_THRESHOLD = Math.min(0.95, Math.max(0.05, Number(process.env.SIGNAL_SCORE_THRESHOLD || 0.22)));
const CONFIRM_TICKS = Math.max(2, Number(process.env.SIGNAL_CONFIRM_TICKS || 3));
const STALE_MS = Math.max(500, Number(process.env.SIGNAL_STALE_MS || 1500));
const OBSERVE_MIN_MS = Math.max(5000, Number(process.env.SIGNAL_OBSERVE_MIN_MS || 10000));
const DECISION_WINDOW_MS = Math.max(OBSERVE_MIN_MS + 2000, Number(process.env.SIGNAL_DECISION_WINDOW_MS || 18000));
const MIN_CONTEXT_MS = Math.max(30000, Number(process.env.SIGNAL_MIN_CONTEXT_MS || 60000));
const MICRO_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_MICRO_THRESHOLD || 0.16));
const TREND_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_TREND_THRESHOLD || 0.14));
const CONTEXT_OPPOSE_LIMIT = Math.max(0.10, Number(process.env.SIGNAL_CONTEXT_OPPOSE_LIMIT || 0.28));
const STRATEGY_VERSION = 'CONTINUOUS_MARKET_STATE_V5';
const PREDICTION_API = 'https://api.binance.com';
const PREDICTION_API_KEY = String(process.env.BINANCE_PREDICTION_API_KEY || '');
const PREDICTION_API_SECRET = String(process.env.BINANCE_PREDICTION_API_SECRET || '');
const PREDICTION_REFRESH_MS = Math.max(1000, Number(process.env.PREDICTION_MARKET_REFRESH_MS || 3000));
const PREDICTION_BOOK_STALE_MS = Math.max(1000, Number(process.env.PREDICTION_BOOK_STALE_MS || 5000));

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
let lastMarketTs = 0;
let lastTradeMarketTs = 0;
let lastDepthMarketTs = 0;
let bootstrapCompletedAt = null;

let predictionWs = null;
let predictionReconnectTimer = null;
let predictionRefreshBusy = false;
let predictionMarketRound = null;
let predictionMarketTopicId = null;
let predictionMarketId = null;
let predictionYesDirection = null;
let predictionMarketMeta = null;
let predictionBookLoggedMarketId = null;
let predictionBook = {
  updateTimestampMs: 0,
  receivedAt: 0,
  bestBid: null,
  bestAsk: null,
  bidDepth5: null,
  askDepth5: null,
  imbalance5: null,
  upBid: null,
  upAsk: null,
  upMid: null,
};
const predictionTopicCache = new Map();

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
  const cutoff = now - STORAGE_MS;
  while (trades.length && trades[0].marketTs < cutoff) trades.shift();
  while (ofiEvents.length && ofiEvents[0].marketTs < cutoff) ofiEvents.shift();
  while (prices.length && prices[0].marketTs < cutoff) prices.shift();
}

function tradeFlow(windowMs, now) {
  const cutoff = now - windowMs;
  let buyVol = 0;
  let sellVol = 0;
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const t = trades[i];
    if (t.marketTs < cutoff) break;
    count += 1;
    if (t.isAggressiveBuy) buyVol += t.qty;
    else sellVol += t.qty;
  }
  const total = buyVol + sellVol;
  return {
    count,
    buyVol,
    sellVol,
    pressure: total > 0 ? (buyVol - sellVol) / total : 0,
  };
}

function ofiFlow(windowMs, now) {
  const cutoff = now - windowMs;
  let raw = 0;
  let scale = 0;
  let count = 0;
  for (let i = ofiEvents.length - 1; i >= 0; i -= 1) {
    const e = ofiEvents[i];
    if (e.marketTs < cutoff) break;
    count += 1;
    raw += e.value;
    scale += e.scale;
  }
  return {
    count,
    raw,
    scale,
    normalized: scale > 0 ? clamp(raw / scale) : 0,
  };
}

function priceNear(targetTs) {
  if (!prices.length) return null;
  let selected = null;
  for (let i = prices.length - 1; i >= 0; i -= 1) {
    if (prices[i].marketTs <= targetTs) {
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
  ofiEvents.push({ marketTs: now, value, scale });

  prevDepthBid = bid;
  prevDepthAsk = ask;
  prevDepthBidQty = bidQty;
  prevDepthAskQty = askQty;
}


function predictionSign(query) {
  return crypto.createHmac('sha256', PREDICTION_API_SECRET).update(query).digest('hex');
}

async function signedPredictionGet(path, params = {}) {
  if (!PREDICTION_API_KEY || !PREDICTION_API_SECRET) {
    return { ok: false, status: 500, data: { msg: 'PREDICTION_API_CREDENTIALS_MISSING' } };
  }
  try {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
    }
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    q.append('signature', predictionSign(q.toString()));
    const r = await fetch(PREDICTION_API + path + '?' + q.toString(), {
      headers: { 'X-MBX-APIKEY': PREDICTION_API_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e?.message || String(e) };
  }
}

function predNorm(v) {
  return String(v ?? '').trim().toUpperCase();
}

function predDurationLooks5m(topic) {
  const start = Number(topic?.startDate);
  const end = Number(topic?.endDate);
  if (Number.isFinite(start) && Number.isFinite(end) && Math.abs((end - start) - 300000) <= 30000) return true;
  return /(^|\D)5\s*M(IN(UTE)?)?S?(\D|$)/i.test(String(topic?.duration || topic?.title || topic?.question || ''));
}

function predTopicScore(topic, target) {
  const st = Number(topic?.startDate);
  const en = Number(topic?.endDate);
  if (!Number.isFinite(st) || !Number.isFinite(en)) return Number.POSITIVE_INFINITY;
  return Math.abs(st - target) + Math.abs(en - (target + 300000));
}

function mapOutcomeDirection(market, outcome) {
  const name = predNorm(outcome?.name);
  if (name === 'UP' || name === 'DOWN') return name;
  const mt = predNorm((market?.title || '') + ' ' + (market?.question || ''));
  if (name === 'YES') {
    if (mt.includes('UP')) return 'UP';
    if (mt.includes('DOWN')) return 'DOWN';
  }
  if (name === 'NO') {
    if (mt.includes('UP')) return 'DOWN';
    if (mt.includes('DOWN')) return 'UP';
  }
  return null;
}

function choosePredictionOutcome(topic, direction) {
  const dir = predNorm(direction);
  let best = null;
  for (const m of Array.isArray(topic?.markets) ? topic.markets : []) {
    const mt = predNorm((m?.title || '') + ' ' + (m?.question || ''));
    for (const o of Array.isArray(m?.outcomes) ? m.outcomes : []) {
      const mapped = mapOutcomeDirection(m, o);
      let score = mapped === dir ? 200 : 0;
      if (predNorm(o?.name) === dir) score += 50;
      if (mt.includes(dir) && predNorm(o?.name) === 'YES') score += 40;
      if (!best || score > best.score) best = { score, market: m, outcome: o, mapped };
    }
  }
  return best && best.score >= 100 ? best : null;
}

async function discoverPredictionTopic(round, maxAgeMs = 4000) {
  const target = Number(round);
  const cached = predictionTopicCache.get(String(target));
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;

  const listCall = await signedPredictionGet('/sapi/v1/w3w/wallet/prediction/market/list', {
    l1Category: 'crypto',
    l2Category: 'up-down',
    sortBy: 'CREATED_TIME',
    orderBy: 'DESC',
    offset: 0,
    limit: 100,
  });
  let topics = listCall.ok && Array.isArray(listCall.data?.marketTopics) ? listCall.data.marketTopics : [];
  const hasRound = topics.some(t =>
    String(t?.symbol || '').toUpperCase() === SYMBOL &&
    predDurationLooks5m(t) &&
    Number.isFinite(Number(t?.startDate)) &&
    Math.abs(Number(t.startDate) - target) <= 30000
  );
  if (!topics.length || !hasRound) {
    const searchCall = await signedPredictionGet('/sapi/v1/w3w/wallet/prediction/market/search', { query: 'BTC 5m', topK: 50 });
    if (searchCall.ok && Array.isArray(searchCall.data)) {
      const merged = new Map();
      for (const t of topics) merged.set(String(t?.marketTopicId ?? (String(t?.startDate) + ':' + String(t?.symbol))), t);
      for (const t of searchCall.data) merged.set(String(t?.marketTopicId ?? (String(t?.startDate) + ':' + String(t?.symbol))), t);
      topics = Array.from(merged.values());
    }
  }

  const candidates = topics
    .filter(t => String(t?.symbol || '').toUpperCase() === SYMBOL && predDurationLooks5m(t))
    .sort((a,b) => predTopicScore(a,target) - predTopicScore(b,target));
  const topic = candidates[0];
  if (!topic?.marketTopicId || predTopicScore(topic,target) > 180000) {
    const value = { ok:false, error:'PREDICTION_TOPIC_NOT_FOUND', round:target };
    predictionTopicCache.set(String(target), { at:Date.now(), value });
    return value;
  }

  const detail = await signedPredictionGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId: topic.marketTopicId });
  const value = detail.ok ? { ok:true, topic:{ ...topic, ...detail.data } } : { ok:false, error:'PREDICTION_DETAIL_FAILED', status:detail.status };
  predictionTopicCache.set(String(target), { at:Date.now(), value });
  return value;
}

function inferPredictionBookMapping(topic) {
  const up = choosePredictionOutcome(topic, 'UP');
  if (!up?.market) return null;
  const marketId = Number(up.market?.marketId ?? up.market?.id);
  if (!Number.isFinite(marketId)) return null;
  const mt = predNorm((up.market?.title || '') + ' ' + (up.market?.question || ''));
  let yesDirection = null;
  if (mt.includes('UP')) yesDirection = 'UP';
  else if (mt.includes('DOWN')) yesDirection = 'DOWN';
  return {
    marketId,
    yesDirection,
    marketTitle: up.market?.title || up.market?.question || null,
    mappingReliable: yesDirection === 'UP' || yesDirection === 'DOWN',
  };
}

function closePredictionWs() {
  clearTimeout(predictionReconnectTimer);
  predictionReconnectTimer = null;
  if (predictionWs) {
    try { predictionWs.terminate(); } catch {}
    predictionWs = null;
  }
}

function connectPredictionOrderbook(marketId, yesDirection) {
  closePredictionWs();
  if (!PREDICTION_API_KEY || !PREDICTION_API_SECRET || !Number.isFinite(Number(marketId))) return;

  const params = {
    random: crypto.randomBytes(8).toString('hex'),
    recvWindow: '30000',
    timestamp: String(Date.now()),
    topic: 'web3_prediction_orderbook_' + String(marketId),
  };
  const sorted = Object.keys(params).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const url = 'wss://api.binance.com/sapi/wss?' + sorted + '&signature=' + predictionSign(sorted);
  predictionWs = new WebSocket(url, {
    headers: { 'X-MBX-APIKEY': PREDICTION_API_KEY },
    perMessageDeflate: false,
    handshakeTimeout: 10000,
  });

  predictionWs.on('open', () => {
    console.log(JSON.stringify({ event:'prediction_orderbook_connected', marketId, yesDirection, strategyVersion:STRATEGY_VERSION }));
  });
  predictionWs.on('message', raw => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    let d = env?.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d || d.msgType !== 'orderbook' || Number(d.marketId) !== Number(marketId)) return;
    const ts = Number(d.updateTimestampMs);
    if (!Number.isFinite(ts) || ts <= Number(predictionBook.updateTimestampMs || 0)) return;

    const bids = Array.isArray(d.bids) ? d.bids : [];
    const asks = Array.isArray(d.asks) ? d.asks : [];
    const bestBid = Number(bids?.[0]?.[0]);
    const bestAsk = Number(asks?.[0]?.[0]);
    const bidDepth5 = bids.slice(0,5).reduce((a,x)=>a + (Number(x?.[1]) || 0),0);
    const askDepth5 = asks.slice(0,5).reduce((a,x)=>a + (Number(x?.[1]) || 0),0);
    const depthTotal = bidDepth5 + askDepth5;
    const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : Number.isFinite(bestAsk) ? bestAsk : bestBid;
    const upBid = yesDirection === 'UP' ? bestBid : yesDirection === 'DOWN' && Number.isFinite(bestAsk) ? 1 - bestAsk : null;
    const upAsk = yesDirection === 'UP' ? bestAsk : yesDirection === 'DOWN' && Number.isFinite(bestBid) ? 1 - bestBid : null;
    const upMid = yesDirection === 'UP' ? mid : yesDirection === 'DOWN' && Number.isFinite(mid) ? 1 - mid : null;

    predictionBook = {
      updateTimestampMs: ts,
      receivedAt: Date.now(),
      bestBid: Number.isFinite(bestBid) ? bestBid : null,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
      bidDepth5,
      askDepth5,
      imbalance5: depthTotal > 0 ? (bidDepth5 - askDepth5) / depthTotal : null,
      upBid: Number.isFinite(upBid) ? Number(upBid.toFixed(6)) : null,
      upAsk: Number.isFinite(upAsk) ? Number(upAsk.toFixed(6)) : null,
      upMid: Number.isFinite(upMid) ? Number(upMid.toFixed(6)) : null,
    };
    if (Number(predictionBookLoggedMarketId) !== Number(marketId)) {
      predictionBookLoggedMarketId = Number(marketId);
      console.log(JSON.stringify({
        event:'prediction_orderbook_first_update',
        marketId:Number(marketId),
        yesDirection,
        updateTimestampMs:ts,
        bestBid:predictionBook.bestBid,
        bestAsk:predictionBook.bestAsk,
        upMid:predictionBook.upMid,
        bidDepth5,
        askDepth5,
      }));
    }
  });
  predictionWs.on('ping', data => { try { predictionWs?.pong(data); } catch {} });
  predictionWs.on('error', err => {
    console.error(JSON.stringify({ event:'prediction_orderbook_error', marketId, error:err?.message || String(err) }));
  });
  predictionWs.on('close', () => {
    predictionWs = null;
    if (Number(predictionMarketId) === Number(marketId)) {
      predictionReconnectTimer = setTimeout(() => connectPredictionOrderbook(marketId, yesDirection), 1500);
    }
  });
}

async function refreshPredictionMarket() {
  if (predictionRefreshBusy) return;
  predictionRefreshBusy = true;
  try {
    const marketNow = lastMarketTs || Date.now();
    const round = roundInfo(marketNow).start;
    if (predictionMarketRound === round && predictionMarketId && predictionWs?.readyState === WebSocket.OPEN) return;
    const found = await discoverPredictionTopic(round);
    if (!found.ok) return;
    const mapping = inferPredictionBookMapping(found.topic);
    predictionMarketRound = round;
    predictionMarketTopicId = found.topic?.marketTopicId ?? null;
    predictionMarketMeta = mapping;
    if (!mapping?.marketId) return;
    if (Number(predictionMarketId) !== Number(mapping.marketId) || predictionWs?.readyState !== WebSocket.OPEN) {
      predictionMarketId = Number(mapping.marketId);
      predictionYesDirection = mapping.yesDirection;
      predictionBook = { updateTimestampMs:0, receivedAt:0, bestBid:null, bestAsk:null, bidDepth5:null, askDepth5:null, imbalance5:null, upBid:null, upAsk:null, upMid:null };
      connectPredictionOrderbook(predictionMarketId, predictionYesDirection);
    }
  } catch (e) {
    console.error(JSON.stringify({ event:'prediction_market_refresh_failed', error:e?.message || String(e) }));
  } finally {
    predictionRefreshBusy = false;
  }
}

function directionFromResolutionValue(v) {
  const t = predNorm(typeof v === 'object' ? (v?.name ?? v?.value ?? v?.result ?? '') : v);
  if (t === 'UP' || /(^|\W)UP($|\W)/.test(t)) return 'UP';
  if (t === 'DOWN' || /(^|\W)DOWN($|\W)/.test(t)) return 'DOWN';
  return null;
}

function extractOfficialResolution(topic) {
  const directKeys = ['result','resolution','resolvedOutcome','winningOutcome','winner','answer','finalResult'];
  for (const k of directKeys) {
    const d = directionFromResolutionValue(topic?.[k]);
    if (d) return { direction:d, evidence:'topic.' + k };
  }
  for (const m of Array.isArray(topic?.markets) ? topic.markets : []) {
    for (const k of directKeys) {
      const d = directionFromResolutionValue(m?.[k]);
      if (d) return { direction:d, evidence:'market.' + k };
    }
    for (const o of Array.isArray(m?.outcomes) ? m.outcomes : []) {
      const flag = o?.isWinner === true || o?.winner === true ||
        ['WINNER','WON','WIN','RESOLVED_TRUE','TRUE'].includes(predNorm(o?.status)) ||
        ['WINNER','WON','WIN','TRUE'].includes(predNorm(o?.result));
      if (flag) {
        const d = mapOutcomeDirection(m,o);
        if (d) return { direction:d, evidence:'outcome_winner_flag' };
      }
    }
  }
  return null;
}

async function getOfficialPredictionResolution(round) {
  const found = await discoverPredictionTopic(round, 1000);
  if (!found.ok) return { ok:false, resolved:false, error:found.error || 'TOPIC_NOT_FOUND' };
  const extracted = extractOfficialResolution(found.topic);
  return {
    ok:true,
    resolved:Boolean(extracted?.direction),
    direction:extracted?.direction || null,
    evidence:extracted?.evidence || null,
    marketTopicId:found.topic?.marketTopicId ?? null,
    status:found.topic?.status ?? found.topic?.tradingStatus ?? null,
    endDate:found.topic?.endDate ?? null,
  };
}

function calculate(now = Date.now()) {
  const marketNow = lastMarketTs || now;
  prune(marketNow);

  const dataAgeMs = lastWsMessageAt ? now - lastWsMessageAt : Infinity;
  const depthAgeMs = lastDepthAt ? now - lastDepthAt : Infinity;
  const hasBook = [bestBid, bestAsk, bestBidQty, bestAskQty].every(Number.isFinite);
  const hasPrice = Number.isFinite(lastPrice);
  const historyAgeMs = prices.length ? Math.max(0, marketNow - prices[0].marketTs) : 0;

  const flow5 = tradeFlow(5000, marketNow);
  const flow15 = tradeFlow(15000, marketNow);
  const flow60 = tradeFlow(60000, marketNow);
  const ofi5 = ofiFlow(5000, marketNow);
  const ofi60 = ofiFlow(60000, marketNow);

  const bookTotal = hasBook ? bestBidQty + bestAskQty : 0;
  const bookImbalance = bookTotal > 0 ? (bestBidQty - bestAskQty) / bookTotal : 0;

  const p1 = priceNear(marketNow - 1000);
  const p5 = priceNear(marketNow - 5000);
  const p15 = priceNear(marketNow - 15000);
  const p30 = priceNear(marketNow - 30000);
  const p60 = priceNear(marketNow - 60000);
  const p180 = priceNear(marketNow - 180000);
  const p300 = priceNear(marketNow - 300000);

  const momentum1sBps = hasPrice && Number.isFinite(p1) ? bps(lastPrice, p1) : 0;
  const momentum5sBps = hasPrice && Number.isFinite(p5) ? bps(lastPrice, p5) : 0;
  const momentum15sBps = hasPrice && Number.isFinite(p15) ? bps(lastPrice, p15) : 0;
  const momentum30sBps = hasPrice && Number.isFinite(p30) ? bps(lastPrice, p30) : 0;
  const momentum60sBps = hasPrice && Number.isFinite(p60) ? bps(lastPrice, p60) : 0;
  const momentum180sBps = hasPrice && Number.isFinite(p180) ? bps(lastPrice, p180) : 0;
  const momentum300sBps = hasPrice && Number.isFinite(p300) ? bps(lastPrice, p300) : 0;

  const mid = hasBook ? (bestBid + bestAsk) / 2 : null;
  const microprice = hasBook && bookTotal > 0
    ? (bestAsk * bestBidQty + bestBid * bestAskQty) / bookTotal
    : null;
  const micropriceBps = Number.isFinite(microprice) && Number.isFinite(mid) ? bps(microprice, mid) : 0;
  const spreadBps = hasBook && Number.isFinite(mid) ? ((bestAsk - bestBid) / mid) * 10000 : null;

  const distanceFromOpenBps = hasPrice && Number.isFinite(currentKlineOpen) ? bps(lastPrice, currentKlineOpen) : 0;
  const distanceFrom1mOpenBps = hasPrice && Number.isFinite(currentKline1mOpen) ? bps(lastPrice, currentKline1mOpen) : 0;
  const distanceFrom15mOpenBps = hasPrice && Number.isFinite(currentKline15mOpen) ? bps(lastPrice, currentKline15mOpen) : 0;

  // Current-state score: what is happening now and whether current-round price confirms it.
  const microScore = clamp(
    0.30 * clamp(ofi5.normalized) +
    0.25 * clamp(flow5.pressure) +
    0.15 * clamp(flow15.pressure) +
    0.15 * clamp(bookImbalance) +
    0.15 * clamp(micropriceBps / 0.5)
  );

  const currentTrendScore = clamp(
    0.30 * clamp(distanceFromOpenBps / 5) +
    0.25 * clamp(momentum15sBps / 5) +
    0.20 * clamp(momentum30sBps / 7) +
    0.15 * clamp(momentum5sBps / 3) +
    0.10 * clamp(momentum1sBps / 2)
  );

  // Continuous prior: horizons only participate when enough real history exists.
  // This prevents a freshly restarted service from treating its earliest sample as a fake 3m/5m observation.
  const priorParts = [
    historyAgeMs >= 60000 ? { w: 0.30, v: clamp(momentum60sBps / 12), h: '60s' } : null,
    historyAgeMs >= 180000 ? { w: 0.25, v: clamp(momentum180sBps / 20), h: '180s' } : null,
    historyAgeMs >= 300000 ? { w: 0.20, v: clamp(momentum300sBps / 30), h: '300s' } : null,
    historyAgeMs >= 60000 ? { w: 0.15, v: clamp(flow60.pressure), h: 'flow60s' } : null,
    Number.isFinite(currentKline15mOpen) ? { w: 0.10, v: clamp(distanceFrom15mOpenBps / 25), h: '15mOpen' } : null,
  ].filter(Boolean);
  const priorWeightSum = priorParts.reduce((sum, p) => sum + p.w, 0);
  const priorScore = priorWeightSum > 0
    ? clamp(priorParts.reduce((sum, p) => sum + p.w * p.v, 0) / priorWeightSum)
    : 0;
  const activePriorHorizons = priorParts.map(p => p.h);

  const signs = [
    historyAgeMs >= 30000 ? Math.sign(momentum30sBps) : 0,
    historyAgeMs >= 60000 ? Math.sign(momentum60sBps) : 0,
    historyAgeMs >= 180000 ? Math.sign(momentum180sBps) : 0,
    historyAgeMs >= 300000 ? Math.sign(momentum300sBps) : 0,
  ].filter(v => v !== 0);
  const signSum = signs.reduce((a, b) => a + b, 0);
  const regimeStability = signs.length ? Math.abs(signSum) / signs.length : 0;
  const historyWeight = 0.25 + 0.15 * regimeStability;
  const currentWeight = 1 - historyWeight;

  const currentScore = clamp(0.55 * microScore + 0.45 * currentTrendScore);
  const score = clamp(currentWeight * currentScore + historyWeight * priorScore);

  const round = roundInfo(marketNow);
  const elapsedMs = Math.max(0, marketNow - round.start);
  if (frozenRoundStart !== round.start) {
    frozenRoundStart = round.start;
    frozenDirection = 'WAIT';
    frozenScore = 0;
    frozenConfidence = 0;
    frozenAt = null;
    candidateDirection = 'WAIT';
    candidateTicks = 0;
  }

  const priceSide = distanceFromOpenBps > 0 ? 1 : distanceFromOpenBps < 0 ? -1 : 0;
  let nextCandidate = 'WAIT';
  let reason = 'CONTINUOUS_STATE_NEUTRAL';

  if (dataAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_STREAM';
  } else if (depthAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_DEPTH';
  } else if (!hasBook || !hasPrice) {
    reason = 'WAITING_FOR_REAL_MARKET_DATA';
  } else if (historyAgeMs < MIN_CONTEXT_MS) {
    reason = 'WARMING_CONTINUOUS_CONTEXT';
  } else if (elapsedMs < OBSERVE_MIN_MS) {
    reason = 'CURRENT_ROUND_CONFIRMATION_WINDOW';
  } else if (elapsedMs > DECISION_WINDOW_MS) {
    reason = 'DECISION_WINDOW_EXPIRED';
  } else if (flow5.count < MIN_TRADES) {
    reason = 'INSUFFICIENT_REAL_TRADES';
  } else if (ofi5.count < MIN_OFI_EVENTS) {
    reason = 'INSUFFICIENT_REAL_DEPTH_UPDATES';
  } else if (
    priceSide > 0 &&
    currentScore >= TREND_THRESHOLD &&
    score >= SCORE_THRESHOLD &&
    priorScore >= -CONTEXT_OPPOSE_LIMIT
  ) {
    nextCandidate = 'UP';
    reason = 'CONTINUOUS_STATE_CONFIRMED_UP';
  } else if (
    priceSide < 0 &&
    currentScore <= -TREND_THRESHOLD &&
    score <= -SCORE_THRESHOLD &&
    priorScore <= CONTEXT_OPPOSE_LIMIT
  ) {
    nextCandidate = 'DOWN';
    reason = 'CONTINUOUS_STATE_CONFIRMED_DOWN';
  } else if (
    Math.sign(currentScore) !== 0 &&
    Math.sign(priorScore) !== 0 &&
    Math.sign(currentScore) !== Math.sign(priorScore) &&
    Math.abs(priorScore) >= CONTEXT_OPPOSE_LIMIT
  ) {
    reason = 'CURRENT_PRIOR_CONFLICT';
  } else {
    reason = 'CONTINUOUS_QUALITY_THRESHOLDS_NOT_MET';
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
      historyAgeMs,
      marketClockTs: marketNow,
      currentScore: Number(currentScore.toFixed(6)),
      microScore: Number(microScore.toFixed(6)),
      currentTrendScore: Number(currentTrendScore.toFixed(6)),
      priorScore: Number(priorScore.toFixed(6)),
      activePriorHorizons,
      priorWeightSum: Number(priorWeightSum.toFixed(4)),
      regimeStability: Number(regimeStability.toFixed(4)),
      historyWeight: Number(historyWeight.toFixed(4)),
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
      ? (nextCandidate !== 'WAIT' ? 'CONFIRMING_CONTINUOUS_STATE' : reason)
      : 'ROUND_SIGNAL_FROZEN_V5',
    roundStartMs: round.start,
    roundEndMs: round.end,
    facts: {
      lastPrice,
      roundOpenPrice: currentKlineOpen,
      distanceFromOpenBps: Number(distanceFromOpenBps.toFixed(4)),
      distanceFrom1mOpenBps: Number(distanceFrom1mOpenBps.toFixed(4)),
      distanceFrom15mOpenBps: Number(distanceFrom15mOpenBps.toFixed(4)),
      bestBid,
      bestAsk,
      bidQty: bestBidQty,
      askQty: bestAskQty,
      spreadBps: Number.isFinite(spreadBps) ? Number(spreadBps.toFixed(4)) : null,
      tradeCount5s: flow5.count,
      tradePressure5s: Number(flow5.pressure.toFixed(6)),
      tradePressure15s: Number(flow15.pressure.toFixed(6)),
      tradePressure60s: Number(flow60.pressure.toFixed(6)),
      ofiEventCount5s: ofi5.count,
      ofiNormalized5s: Number(ofi5.normalized.toFixed(6)),
      ofiNormalized60s: Number(ofi60.normalized.toFixed(6)),
      lastDepthUpdateId,
      depthAgeMs: Number.isFinite(depthAgeMs) ? depthAgeMs : null,
      historyAgeMs,
      predictionMarketTopicId,
      predictionMarketId,
      predictionMarketBookAgeMs: predictionBook.receivedAt ? Math.max(0, now - predictionBook.receivedAt) : null,
      predictionMarketUpdateTimestampMs: predictionBook.updateTimestampMs || null,
      predictionMarketYesDirection: predictionYesDirection,
      predictionMarketMappingReliable: Boolean(predictionMarketMeta?.mappingReliable),
      predictionMarketUpBid: predictionBook.upBid,
      predictionMarketUpAsk: predictionBook.upAsk,
      predictionMarketUpMid: predictionBook.upMid,
      predictionMarketDepthImbalance5: predictionBook.imbalance5,
      momentum1sBps: Number(momentum1sBps.toFixed(4)),
      momentum5sBps: Number(momentum5sBps.toFixed(4)),
      momentum15sBps: Number(momentum15sBps.toFixed(4)),
      momentum30sBps: Number(momentum30sBps.toFixed(4)),
      momentum60sBps: Number(momentum60sBps.toFixed(4)),
      momentum180sBps: Number(momentum180sBps.toFixed(4)),
      momentum300sBps: Number(momentum300sBps.toFixed(4)),
      microprice: Number.isFinite(microprice) ? Number(microprice.toFixed(4)) : null,
      micropriceBps: Number(micropriceBps.toFixed(4)),
      microScore: Number(microScore.toFixed(6)),
      currentTrendScore: Number(currentTrendScore.toFixed(6)),
      currentScore: Number(currentScore.toFixed(6)),
      priorScore: Number(priorScore.toFixed(6)),
      activePriorHorizons,
      regimeStability: Number(regimeStability.toFixed(4)),
      historyWeight: Number(historyWeight.toFixed(4)),
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
    const exchangeTs = Number(d.T || d.E || now);
    lastTradeExchangeLagMs = Number.isFinite(exchangeTs) ? Math.max(0, now - exchangeTs) : null;
    lastTradeMarketTs = Number.isFinite(exchangeTs) ? exchangeTs : now;
    lastMarketTs = Math.max(lastMarketTs, lastTradeMarketTs);
    lastPrice = price;
    trades.push({
      marketTs: lastTradeMarketTs,
      exchangeTs: lastTradeMarketTs,
      price,
      qty,
      // Binance aggTrade m=true => buyer is maker => seller is the aggressor.
      isAggressiveBuy: d.m === false,
    });
    prices.push({ marketTs: lastTradeMarketTs, exchangeTs: lastTradeMarketTs, price });
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
      const depthMarketTs = Number(d.E || d.T || now);
      lastDepthMarketTs = Number.isFinite(depthMarketTs) ? depthMarketTs : now;
      lastMarketTs = Math.max(lastMarketTs, lastDepthMarketTs);
      pushOfiEvent(lastDepthMarketTs, bid, bidQty, ask, askQty);
      lastDepthAt = now;
      if (Number.isFinite(Number(d.lastUpdateId))) lastDepthUpdateId = Number(d.lastUpdateId);
    }
    return;
  }

  if (stream.includes('@kline_1m')) {
    const k = d.k || {};
    const eventTs = Number(d.E || now);
    if (Number.isFinite(eventTs)) lastMarketTs = Math.max(lastMarketTs, eventTs);
    const open = Number(k.o);
    if (Number.isFinite(open)) currentKline1mOpen = open;
    return;
  }

  if (stream.includes('@kline_5m')) {
    const k = d.k || {};
    const eventTs = Number(d.E || now);
    if (Number.isFinite(eventTs)) lastMarketTs = Math.max(lastMarketTs, eventTs);
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
    const eventTs = Number(d.E || now);
    if (Number.isFinite(eventTs)) lastMarketTs = Math.max(lastMarketTs, eventTs);
    const open = Number(k.o);
    if (Number.isFinite(open)) currentKline15mOpen = open;
  }
}

function resetTransportState() {
  prevDepthBid = null;
  prevDepthAsk = null;
  prevDepthBidQty = null;
  prevDepthAskQty = null;
  lastDepthUpdateId = null;
  lastDepthAt = 0;
  candidateDirection = 'WAIT';
  candidateTicks = 0;
}

async function bootstrapMarketHistory() {
  const now = Date.now();
  try {
    const startTime = now - Math.min(STORAGE_MS, 999000);
    const u = new URL('https://api.binance.com/api/v3/klines');
    u.searchParams.set('symbol', SYMBOL);
    u.searchParams.set('interval', '1s');
    u.searchParams.set('startTime', String(startTime));
    u.searchParams.set('endTime', String(now));
    u.searchParams.set('limit', '1000');
    const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        for (const k of data) {
          const marketTs = Number(k?.[6] ?? k?.[0]);
          const price = Number(k?.[4]);
          if (Number.isFinite(marketTs) && Number.isFinite(price)) prices.push({ marketTs, exchangeTs: marketTs, price });
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'market_history_kline_bootstrap_failed', error: e?.message || String(e) }));
  }

  try {
    const u = new URL('https://api.binance.com/api/v3/aggTrades');
    u.searchParams.set('symbol', SYMBOL);
    u.searchParams.set('limit', '1000');
    const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        for (const t of data) {
          const marketTs = Number(t?.T);
          const price = Number(t?.p);
          const qty = Number(t?.q);
          if (![marketTs, price, qty].every(Number.isFinite)) continue;
          trades.push({ marketTs, exchangeTs: marketTs, price, qty, isAggressiveBuy: t?.m === false });
          lastTradeMarketTs = Math.max(lastTradeMarketTs, marketTs);
          lastPrice = price;
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'market_history_trade_bootstrap_failed', error: e?.message || String(e) }));
  }

  prices.sort((a,b) => a.marketTs - b.marketTs);
  trades.sort((a,b) => a.marketTs - b.marketTs);
  if (prices.length) lastMarketTs = Math.max(lastMarketTs, prices[prices.length - 1].marketTs);
  if (trades.length) lastMarketTs = Math.max(lastMarketTs, trades[trades.length - 1].marketTs);
  prune(lastMarketTs || now);
  bootstrapCompletedAt = Date.now();
  console.log(JSON.stringify({
    event: 'continuous_market_history_bootstrapped',
    strategyVersion: STRATEGY_VERSION,
    priceSamples: prices.length,
    tradeSamples: trades.length,
    historyAgeMs: prices.length ? Math.max(0, (lastMarketTs || now) - prices[0].marketTs) : 0,
    bootstrapCompletedAt,
  }));
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }

  resetTransportState();
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
setInterval(refreshPredictionMarket, PREDICTION_REFRESH_MS).unref();
await bootstrapMarketHistory();
connect();
refreshPredictionMarket();
setTimeout(async () => {
  try {
    const currentRound = roundInfo(lastMarketTs || Date.now()).start;
    const probeRound = currentRound - 300000;
    const result = await getOfficialPredictionResolution(probeRound);
    console.log(JSON.stringify({
      event:'prediction_resolution_probe',
      round:probeRound,
      ok:Boolean(result?.ok),
      resolved:Boolean(result?.resolved),
      direction:result?.direction ?? null,
      evidence:result?.evidence ?? null,
      status:result?.status ?? null,
      marketTopicId:result?.marketTopicId ?? null,
      error:result?.error ?? null,
    }));
  } catch (e) {
    console.error(JSON.stringify({ event:'prediction_resolution_probe_failed', error:e?.message || String(e) }));
  }
}, 4000).unref();

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
      lastMarketTs: lastMarketTs || null,
      marketClockAgeMs: lastMarketTs ? Math.max(0, now - lastMarketTs) : null,
      bootstrapCompletedAt,
      predictionOrderbookConnected: predictionWs?.readyState === WebSocket.OPEN,
      predictionOrderbookAgeMs: predictionBook.receivedAt ? Math.max(0, now - predictionBook.receivedAt) : null,
      predictionOrderbookFresh: predictionBook.receivedAt ? (now - predictionBook.receivedAt) <= PREDICTION_BOOK_STALE_MS : false,
      signalAgeMs: now - lastSignal.generatedAt,
    },
    config: {
      windowMs: WINDOW_MS,
      storageMs: STORAGE_MS,
      evaluationMs: EVAL_MS,
      minTrades: MIN_TRADES,
      minOfiEvents: MIN_OFI_EVENTS,
      scoreThreshold: SCORE_THRESHOLD,
      confirmTicks: CONFIRM_TICKS,
      staleMs: STALE_MS,
      observeMinMs: OBSERVE_MIN_MS,
      decisionWindowMs: DECISION_WINDOW_MS,
      minContextMs: MIN_CONTEXT_MS,
      microThreshold: MICRO_THRESHOLD,
      trendThreshold: TREND_THRESHOLD,
      contextOpposeLimit: CONTEXT_OPPOSE_LIMIT,
      freezePolicy: 'FIRST_CONTINUOUS_STATE_LOCK_PER_5M_ROUND',
      strategyVersion: STRATEGY_VERSION,
      horizonsMs: [5000, 15000, 30000, 60000, 180000, 300000, 900000],
      principle: '5M_BOUNDARY_IS_SETTLEMENT_ONLY_NOT_MARKET_STATE_RESET',
      predictionOrderbook: {
        enabled: Boolean(PREDICTION_API_KEY && PREDICTION_API_SECRET),
        source: 'BINANCE_W3W_PREDICTION_ORDERBOOK_WSS',
        refreshMs: PREDICTION_REFRESH_MS,
        staleMs: PREDICTION_BOOK_STALE_MS,
        usedForDirectionWeight: false,
      },
    },
    signal: lastSignal,
  };
}

http.createServer(async (req, res) => {
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

  if (req.method === 'GET' && url.pathname === '/api/prediction-resolution') {
    const round = Number(url.searchParams.get('round'));
    if (!Number.isFinite(round)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:false, resolved:false, error:'INVALID_ROUND' }));
    }
    try {
      const result = await getOfficialPredictionResolution(round);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok:false, resolved:false, error:e?.message || String(e) }));
    }
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
    freezePolicy: 'FIRST_CONTINUOUS_STATE_LOCK_PER_5M_ROUND',
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
