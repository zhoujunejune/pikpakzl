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
const DECISION_WINDOW_MS = Math.max(OBSERVE_MIN_MS + 5000, Number(process.env.SIGNAL_DECISION_WINDOW_MS || 22000));
const MIN_CONTEXT_MS = Math.max(30000, Number(process.env.SIGNAL_MIN_CONTEXT_MS || 60000));
const MICRO_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_MICRO_THRESHOLD || 0.16));
const TREND_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_TREND_THRESHOLD || 0.60));
const CONTEXT_OPPOSE_LIMIT = Math.max(0.10, Number(process.env.SIGNAL_CONTEXT_OPPOSE_LIMIT || 0.28));
const RANGE_OBSERVE_MS = Math.max(OBSERVE_MIN_MS, Number(process.env.SIGNAL_RANGE_OBSERVE_MS || 14000));
const COUNTERTREND_OBSERVE_MS = Math.max(RANGE_OBSERVE_MS + 2000, Number(process.env.SIGNAL_COUNTERTREND_OBSERVE_MS || 22000));
const REGIME_THRESHOLD = Math.max(0.08, Number(process.env.SIGNAL_REGIME_THRESHOLD || 0.18));
const REVERSAL_THRESHOLD = Math.max(0.15, Number(process.env.SIGNAL_REVERSAL_THRESHOLD || 0.40));
const PREDICTION_CONFLICT_MARGIN = Math.min(0.25, Math.max(0.05, Number(process.env.PREDICTION_CONFLICT_MARGIN || 0.10)));
const PREDICTION_SUPPORT_MIN = Math.min(0.25, Math.max(0, Number(process.env.SIGNAL_PREDICTION_SUPPORT_MIN || 0.025)));
const MAX_ABS_SCORE = Math.min(0.95, Math.max(0.30, Number(process.env.SIGNAL_MAX_ABS_SCORE || 0.70)));
const REQUIRE_PREDICTION_SUPPORT = String(process.env.SIGNAL_REQUIRE_PREDICTION_SUPPORT || 'true').toLowerCase() !== 'false';
const REJECT_ABSORPTION = String(process.env.SIGNAL_REJECT_ABSORPTION || 'true').toLowerCase() !== 'false';
const PRICE_SAMPLE_MS = Math.max(100, Number(process.env.SIGNAL_PRICE_SAMPLE_MS || 250));
const STRATEGY_VERSION = 'REGIME_LAYER_V6_QUALITY_GATED_5M';
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
let lastPriceSampleTs = 0;

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


function sampledRealizedVolBps(windowMs, now, stepMs = 5000) {
  if (prices.length < 3) return 0;
  const cutoff = now - windowMs;
  let nextTarget = now;
  const sampled = [];
  for (let i = prices.length - 1; i >= 0 && nextTarget >= cutoff; i -= 1) {
    const p = prices[i];
    if (p.marketTs <= nextTarget) {
      sampled.push(p.price);
      nextTarget -= stepMs;
    }
  }
  if (sampled.length < 3) return 0;
  sampled.reverse();
  let sumSq = 0;
  let n = 0;
  for (let i = 1; i < sampled.length; i += 1) {
    const r = bps(sampled[i], sampled[i - 1]);
    if (!Number.isFinite(r)) continue;
    sumSq += r * r;
    n += 1;
  }
  return n ? Math.sqrt(sumSq / n) : 0;
}

function priceRangePosition(windowMs, now) {
  const cutoff = now - windowMs;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = prices.length - 1; i >= 0; i -= 1) {
    const p = prices[i];
    if (p.marketTs < cutoff) break;
    if (!Number.isFinite(p.price)) continue;
    if (p.price < lo) lo = p.price;
    if (p.price > hi) hi = p.price;
  }
  if (!Number.isFinite(lastPrice) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0;
  return clamp(((lastPrice - lo) / (hi - lo)) * 2 - 1);
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

function isWinningOutcome(o) {
  return o?.isWinner === true || o?.winner === true ||
    ['WINNER','WON','WIN','RESOLVED_TRUE'].includes(predNorm(o?.status)) ||
    ['WINNER','WON','WIN'].includes(predNorm(o?.result));
}

function directionFromVariantPrices(topic) {
  const v = topic?.variantData || topic?.variant_data || null;
  if (!v) return null;
  const start = Number(v?.startPrice ?? v?.start_price);
  const end = Number(v?.endPrice ?? v?.end_price);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
  return end > start
    ? { direction:'UP', evidence:'variantData.startPrice_endPrice' }
    : { direction:'DOWN', evidence:'variantData.startPrice_endPrice' };
}

function extractOfficialResolution(topic) {
  const byPrice = directionFromVariantPrices(topic);
  if (byPrice) return byPrice;
  const directKeys = ['result','resolution','resolvedOutcome','winningOutcome','winner','answer','finalResult'];

  // Explicit topic-level UP/DOWN is authoritative.
  for (const k of directKeys) {
    const d = directionFromResolutionValue(topic?.[k]);
    if (d) return { direction:d, evidence:'topic.' + k };
  }

  // Resolve winner only from one canonical binary market instead of scanning
  // every YES/NO market and guessing from titles that may contain BOTH UP/DOWN.
  const canonicalUp = choosePredictionOutcome(topic, 'UP');
  const canonicalMarket = canonicalUp?.market || null;
  if (canonicalMarket) {
    for (const k of directKeys) {
      const d = directionFromResolutionValue(canonicalMarket?.[k]);
      if (d) return { direction:d, evidence:'canonical_market.' + k };
    }

    const selectedName = predNorm(canonicalUp?.outcome?.name);
    const yesDirection =
      selectedName === 'YES' ? 'UP' :
      selectedName === 'NO' ? 'DOWN' :
      null;

    for (const o of Array.isArray(canonicalMarket?.outcomes) ? canonicalMarket.outcomes : []) {
      if (!isWinningOutcome(o)) continue;
      const name = predNorm(o?.name);
      if (name === 'UP' || name === 'DOWN') {
        return { direction:name, evidence:'canonical_outcome_winner_direct' };
      }
      if (yesDirection && (name === 'YES' || name === 'NO')) {
        const d = name === 'YES'
          ? yesDirection
          : (yesDirection === 'UP' ? 'DOWN' : 'UP');
        return { direction:d, evidence:'canonical_outcome_winner_yes_no' };
      }
    }
  }

  // Fallback is intentionally strict: only accept unambiguous market text.
  for (const m of Array.isArray(topic?.markets) ? topic.markets : []) {
    const mt = predNorm((m?.title || '') + ' ' + (m?.question || ''));
    const hasUp = mt.includes('UP');
    const hasDown = mt.includes('DOWN');
    if (hasUp === hasDown) continue;
    const yesDirection = hasUp ? 'UP' : 'DOWN';
    for (const o of Array.isArray(m?.outcomes) ? m.outcomes : []) {
      if (!isWinningOutcome(o)) continue;
      const name = predNorm(o?.name);
      if (name === 'UP' || name === 'DOWN') {
        return { direction:name, evidence:'unambiguous_outcome_winner_direct' };
      }
      if (name === 'YES' || name === 'NO') {
        const d = name === 'YES'
          ? yesDirection
          : (yesDirection === 'UP' ? 'DOWN' : 'UP');
        return { direction:d, evidence:'unambiguous_outcome_winner_yes_no' };
      }
    }
  }
  return null;
}

async function getOfficialPredictionResolution(round, marketTopicId = null) {
  let topic = null;
  if (marketTopicId) {
    const detail = await signedPredictionGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId });
    if (!detail.ok) return { ok:false, resolved:false, error:'PREDICTION_DETAIL_FAILED', marketTopicId, status:detail.status };
    topic = { ...(detail.data || {}), marketTopicId };
  } else {
    const found = await discoverPredictionTopic(round, 1000);
    if (!found.ok) return { ok:false, resolved:false, error:found.error || 'TOPIC_NOT_FOUND' };
    topic = found.topic;
  }
  const extracted = extractOfficialResolution(topic);
  return {
    ok:true,
    resolved:Boolean(extracted?.direction),
    direction:extracted?.direction || null,
    evidence:extracted?.evidence || null,
    marketTopicId:topic?.marketTopicId ?? marketTopicId ?? null,
    status:topic?.status ?? topic?.tradingStatus ?? null,
    endDate:topic?.endDate ?? null,
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

  const vol5sRms60 = sampledRealizedVolBps(60000, marketNow, 5000);
  const vol5sRms300 = sampledRealizedVolBps(300000, marketNow, 5000);
  const scale5 = Math.max(1.0, vol5sRms60 || 1);
  const scale15 = Math.max(1.5, scale5 * Math.sqrt(3));
  const scale30 = Math.max(2.0, scale5 * Math.sqrt(6));
  const scale60 = Math.max(3.0, scale5 * Math.sqrt(12));
  const scale180 = Math.max(5.0, scale5 * Math.sqrt(36));
  const scale300 = Math.max(7.0, scale5 * Math.sqrt(60));

  const n5 = clamp(momentum5sBps / scale5);
  const n15 = clamp(momentum15sBps / scale15);
  const n30 = clamp(momentum30sBps / scale30);
  const n60 = clamp(momentum60sBps / scale60);
  const n180 = clamp(momentum180sBps / scale180);
  const n300 = clamp(momentum300sBps / scale300);
  const nRound = clamp(distanceFromOpenBps / Math.max(2.0, scale5 * Math.sqrt(Math.max(1, Math.min(60, (marketNow - (currentKlineStart || marketNow)) / 5000)))));
  const n1mOpen = clamp(distanceFrom1mOpenBps / scale60);
  const n15mOpen = clamp(distanceFrom15mOpenBps / Math.max(10, scale300 * 1.5));
  const rangePosition180 = priceRangePosition(180000, marketNow);

  const microScore = clamp(
    0.30 * clamp(ofi5.normalized) +
    0.25 * clamp(flow5.pressure) +
    0.15 * clamp(flow15.pressure) +
    0.15 * clamp(bookImbalance) +
    0.15 * clamp(micropriceBps / 0.5)
  );

  // V6: current trend is volatility-normalized, so a fixed 5 bps move does not mean the same thing in every regime.
  const currentTrendScore = clamp(
    0.30 * nRound +
    0.25 * n30 +
    0.20 * n15 +
    0.10 * n5 +
    0.15 * n1mOpen
  );

  // V6 regime layer: longer-horizon state is explicitly separated from current microstructure.
  const regimeComponents = [
    historyAgeMs >= 60000 ? { w: 0.25, v: n60, h: '60s' } : null,
    historyAgeMs >= 180000 ? { w: 0.25, v: n180, h: '180s' } : null,
    historyAgeMs >= 300000 ? { w: 0.20, v: n300, h: '300s' } : null,
    historyAgeMs >= 60000 ? { w: 0.10, v: clamp(flow60.pressure), h: 'flow60s' } : null,
    historyAgeMs >= 180000 ? { w: 0.10, v: rangePosition180, h: 'range180s' } : null,
    Number.isFinite(currentKline15mOpen) ? { w: 0.10, v: n15mOpen, h: '15mOpen' } : null,
  ].filter(Boolean);
  const regimeWeightSum = regimeComponents.reduce((sum, p) => sum + p.w, 0);
  const regimeScore = regimeWeightSum > 0
    ? clamp(regimeComponents.reduce((sum, p) => sum + p.w * p.v, 0) / regimeWeightSum)
    : 0;
  const activeRegimeHorizons = regimeComponents.map(p => p.h);

  const regimeSigns = [
    historyAgeMs >= 60000 ? Math.sign(n60) : 0,
    historyAgeMs >= 180000 ? Math.sign(n180) : 0,
    historyAgeMs >= 300000 ? Math.sign(n300) : 0,
  ].filter(v => v !== 0);
  const regimeSignSum = regimeSigns.reduce((a, b) => a + b, 0);
  const regimeAgreement = regimeSigns.length ? Math.abs(regimeSignSum) / regimeSigns.length : 0;
  const regimeDirection = Math.abs(regimeScore) >= REGIME_THRESHOLD && regimeAgreement >= 0.34
    ? (regimeScore > 0 ? 'UP' : 'DOWN')
    : 'RANGE';
  const highVol = vol5sRms300 > 0 && vol5sRms60 > Math.max(1.5, vol5sRms300 * 1.55);
  const volatilityRegime = highVol ? 'HIGH_VOL' : 'NORMAL';

  // Reduce the previous V5 dominance of 1-30s microstructure.
  const currentScore = clamp(0.40 * microScore + 0.60 * currentTrendScore);
  const historyWeight = regimeDirection === 'RANGE'
    ? 0.35
    : Math.min(0.62, 0.48 + 0.14 * regimeAgreement);
  const currentWeight = 1 - historyWeight;
  const score = clamp(currentWeight * currentScore + historyWeight * regimeScore);

  // Strong aggressive flow with weak price progress often means absorption/exhaustion rather than continuation.
  const absorptionRisk = Math.abs(flow15.pressure) >= 0.35 && Math.abs(n30) < 0.28;
  const flowPriceEfficiency = Math.abs(flow15.pressure) > 0.05
    ? Math.min(5, Math.abs(n30) / Math.abs(flow15.pressure))
    : null;

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
  let proposedDirection = 'WAIT';
  if (
    priceSide > 0 &&
    currentScore >= TREND_THRESHOLD &&
    score >= SCORE_THRESHOLD
  ) proposedDirection = 'UP';
  else if (
    priceSide < 0 &&
    currentScore <= -TREND_THRESHOLD &&
    score <= -SCORE_THRESHOLD
  ) proposedDirection = 'DOWN';

  const proposedSign = proposedDirection === 'UP' ? 1 : proposedDirection === 'DOWN' ? -1 : 0;
  const regimeSign = regimeDirection === 'UP' ? 1 : regimeDirection === 'DOWN' ? -1 : 0;
  const alignment = proposedSign === 0
    ? 'NONE'
    : regimeSign === 0
      ? 'RANGE'
      : proposedSign === regimeSign ? 'ALIGNED' : 'COUNTERTREND';

  const reversalScore = proposedSign === 0 ? 0 : clamp(proposedSign * (
    0.35 * currentTrendScore +
    0.25 * microScore +
    0.20 * n30 +
    0.10 * n15 +
    0.10 * n60
  ));
  const reversalStructureConfirmed = proposedSign !== 0 &&
    proposedSign * n30 >= 0.20 &&
    proposedSign * n15 >= 0.10 &&
    proposedSign * flow15.pressure >= 0.08 &&
    reversalScore >= REVERSAL_THRESHOLD;

  const predBookAgeMs = predictionBook.receivedAt ? Math.max(0, now - predictionBook.receivedAt) : Infinity;
  const predBookUsable = predictionMarketMeta?.mappingReliable &&
    predBookAgeMs <= PREDICTION_BOOK_STALE_MS &&
    Number.isFinite(Number(predictionBook.upMid));
  const predUpMid = Number(predictionBook.upMid);
  const predictionConflict = predBookUsable && (
    (proposedDirection === 'UP' && predUpMid <= 0.5 - PREDICTION_CONFLICT_MARGIN) ||
    (proposedDirection === 'DOWN' && predUpMid >= 0.5 + PREDICTION_CONFLICT_MARGIN)
  );

  const predictionSupport = proposedDirection === 'UP'
    ? (predBookUsable ? predUpMid - 0.5 : null)
    : proposedDirection === 'DOWN'
      ? (predBookUsable ? 0.5 - predUpMid : null)
      : null;

  let requiredObserveMs = OBSERVE_MIN_MS;
  let requiredTicks = CONFIRM_TICKS;
  if (alignment === 'RANGE') {
    requiredObserveMs = RANGE_OBSERVE_MS;
    requiredTicks += 1;
  } else if (alignment === 'COUNTERTREND') {
    requiredObserveMs = COUNTERTREND_OBSERVE_MS;
    requiredTicks += 2;
  }
  if (highVol) {
    requiredObserveMs += 3000;
    requiredTicks += 1;
  }
  if (absorptionRisk) requiredTicks += 1;
  requiredObserveMs = Math.min(requiredObserveMs, Math.max(OBSERVE_MIN_MS, DECISION_WINDOW_MS - 1000));

  let nextCandidate = 'WAIT';
  let reason = 'V6_NEUTRAL';

  if (dataAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_STREAM';
  } else if (depthAgeMs > STALE_MS) {
    reason = 'STALE_BINANCE_DEPTH';
  } else if (!hasBook || !hasPrice) {
    reason = 'WAITING_FOR_REAL_MARKET_DATA';
  } else if (historyAgeMs < MIN_CONTEXT_MS) {
    reason = 'WARMING_CONTINUOUS_CONTEXT';
  } else if (elapsedMs > DECISION_WINDOW_MS) {
    reason = 'V6_DECISION_WINDOW_EXPIRED';
  } else if (flow5.count < MIN_TRADES) {
    reason = 'INSUFFICIENT_REAL_TRADES';
  } else if (ofi5.count < MIN_OFI_EVENTS) {
    reason = 'INSUFFICIENT_REAL_DEPTH_UPDATES';
  } else if (proposedDirection === 'WAIT') {
    reason = 'V6_DIRECTION_THRESHOLDS_NOT_MET';
  } else if (elapsedMs < requiredObserveMs) {
    reason = alignment === 'COUNTERTREND'
      ? 'V6_COUNTERTREND_NEEDS_MORE_CONFIRMATION'
      : alignment === 'RANGE'
        ? 'V6_RANGE_NEEDS_MORE_CONFIRMATION'
        : 'V6_CONFIRMATION_WINDOW';
  } else if (REQUIRE_PREDICTION_SUPPORT && !predBookUsable) {
    reason = 'V6_PREDICTION_SUPPORT_UNAVAILABLE';
  } else if (REQUIRE_PREDICTION_SUPPORT && Number(predictionSupport) < PREDICTION_SUPPORT_MIN) {
    reason = 'V6_PREDICTION_SUPPORT_TOO_WEAK';
  } else if (Math.abs(score) >= MAX_ABS_SCORE) {
    reason = 'V6_OVEREXTENDED_SCORE';
  } else if (predictionConflict) {
    reason = 'V6_PREDICTION_MARKET_STRONG_CONFLICT';
  } else if (alignment === 'COUNTERTREND' && !reversalStructureConfirmed) {
    reason = 'V6_PULLBACK_NOT_CONFIRMED_REVERSAL';
  } else if (REJECT_ABSORPTION && absorptionRisk) {
    reason = 'V6_FLOW_ABSORPTION_RISK';
  } else {
    nextCandidate = proposedDirection;
    reason = alignment === 'ALIGNED'
      ? 'V6_REGIME_ALIGNED_CONFIRMED'
      : alignment === 'COUNTERTREND'
        ? 'V6_REVERSAL_CONFIRMED'
        : 'V6_RANGE_BREAK_CONFIRMED';
  }

  if (nextCandidate === candidateDirection) candidateTicks += 1;
  else {
    candidateDirection = nextCandidate;
    candidateTicks = 1;
  }

  const rawDirection = nextCandidate !== 'WAIT' && candidateTicks >= requiredTicks ? nextCandidate : 'WAIT';
  const rawStrength = rawDirection === 'WAIT'
    ? 0
    : Number(Math.min(0.99, Math.max(0, Math.abs(score) * (0.75 + 0.25 * regimeAgreement))).toFixed(4));

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
      requiredObserveMs,
      requiredTicks,
      historyAgeMs,
      marketClockTs: marketNow,
      regimeDirection,
      regimeScore: Number(regimeScore.toFixed(6)),
      regimeAgreement: Number(regimeAgreement.toFixed(4)),
      volatilityRegime,
      vol5sRms60: Number(vol5sRms60.toFixed(4)),
      vol5sRms300: Number(vol5sRms300.toFixed(4)),
      currentScore: Number(currentScore.toFixed(6)),
      microScore: Number(microScore.toFixed(6)),
      currentTrendScore: Number(currentTrendScore.toFixed(6)),
      alignment,
      reversalScore: Number(reversalScore.toFixed(6)),
      reversalStructureConfirmed,
      absorptionRisk,
      predictionMarketUpMid: predBookUsable ? predUpMid : null,
      predictionConflict,
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
    requiredTicks,
    score: direction === 'WAIT' ? Number(score.toFixed(6)) : frozenScore,
    confidence,
    generatedAt: direction === 'WAIT' ? now : frozenAt,
    reason: direction === 'WAIT'
      ? (nextCandidate !== 'WAIT' ? 'V6_CONFIRMING_CANDIDATE' : reason)
      : 'ROUND_SIGNAL_FROZEN_V6',
    roundStartMs: round.start,
    roundEndMs: round.end,
    facts: {
      lastPrice,
      roundOpenPrice: currentKlineOpen,
      distanceFromOpenBps: Number(distanceFromOpenBps.toFixed(4)),
      distanceFrom1mOpenBps: Number(distanceFrom1mOpenBps.toFixed(4)),
      distanceFrom15mOpenBps: Number(distanceFrom15mOpenBps.toFixed(4)),
      normalizedDistanceFromOpen: Number(nRound.toFixed(6)),
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
      predictionMarketConflict: predictionConflict,
      predictionMarketSupport: Number.isFinite(Number(predictionSupport)) ? Number(Number(predictionSupport).toFixed(6)) : null,
      qualityGate: {
        currentScoreMin: TREND_THRESHOLD,
        predictionSupportMin: PREDICTION_SUPPORT_MIN,
        maxDecisionMs: DECISION_WINDOW_MS,
        maxAbsScore: MAX_ABS_SCORE,
        rejectAbsorption: REJECT_ABSORPTION,
        requirePredictionSupport: REQUIRE_PREDICTION_SUPPORT,
      },
      momentum1sBps: Number(momentum1sBps.toFixed(4)),
      momentum5sBps: Number(momentum5sBps.toFixed(4)),
      momentum15sBps: Number(momentum15sBps.toFixed(4)),
      momentum30sBps: Number(momentum30sBps.toFixed(4)),
      momentum60sBps: Number(momentum60sBps.toFixed(4)),
      momentum180sBps: Number(momentum180sBps.toFixed(4)),
      momentum300sBps: Number(momentum300sBps.toFixed(4)),
      normalizedMomentum5s: Number(n5.toFixed(6)),
      normalizedMomentum15s: Number(n15.toFixed(6)),
      normalizedMomentum30s: Number(n30.toFixed(6)),
      normalizedMomentum60s: Number(n60.toFixed(6)),
      normalizedMomentum180s: Number(n180.toFixed(6)),
      normalizedMomentum300s: Number(n300.toFixed(6)),
      vol5sRms60: Number(vol5sRms60.toFixed(4)),
      vol5sRms300: Number(vol5sRms300.toFixed(4)),
      volatilityRegime,
      rangePosition180: Number(rangePosition180.toFixed(6)),
      microprice: Number.isFinite(microprice) ? Number(microprice.toFixed(4)) : null,
      micropriceBps: Number(micropriceBps.toFixed(4)),
      microScore: Number(microScore.toFixed(6)),
      currentTrendScore: Number(currentTrendScore.toFixed(6)),
      currentScore: Number(currentScore.toFixed(6)),
      regimeScore: Number(regimeScore.toFixed(6)),
      regimeDirection,
      regimeAgreement: Number(regimeAgreement.toFixed(4)),
      activeRegimeHorizons,
      historyWeight: Number(historyWeight.toFixed(4)),
      alignment,
      reversalScore: Number(reversalScore.toFixed(6)),
      reversalStructureConfirmed,
      absorptionRisk,
      flowPriceEfficiency: Number.isFinite(flowPriceEfficiency) ? Number(flowPriceEfficiency.toFixed(6)) : null,
      requiredObserveMs,
      requiredTicks,
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
    if (!lastPriceSampleTs || lastTradeMarketTs - lastPriceSampleTs >= PRICE_SAMPLE_MS) {
      prices.push({ marketTs: lastTradeMarketTs, exchangeTs: lastTradeMarketTs, price });
      lastPriceSampleTs = lastTradeMarketTs;
    }
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
  if (prices.length) {
    lastMarketTs = Math.max(lastMarketTs, prices[prices.length - 1].marketTs);
    lastPriceSampleTs = prices[prices.length - 1].marketTs;
  }
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
      freezePolicy: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
      strategyVersion: STRATEGY_VERSION,
      horizonsMs: [5000, 15000, 30000, 60000, 180000, 300000, 900000],
      principle: 'REGIME_FIRST_5M_TARGET_WITH_CONTINUOUS_MARKET_STATE',
      regimeLayer: {
        rangeObserveMs: RANGE_OBSERVE_MS,
        countertrendObserveMs: COUNTERTREND_OBSERVE_MS,
        regimeThreshold: REGIME_THRESHOLD,
        reversalThreshold: REVERSAL_THRESHOLD,
        predictionConflictMargin: PREDICTION_CONFLICT_MARGIN,
        volatilityNormalized: true,
        predictionMarketRole: 'CONFIRMATION_VETO_NOT_DIRECTION_DRIVER',
      },
      predictionOrderbook: {
        enabled: Boolean(PREDICTION_API_KEY && PREDICTION_API_SECRET),
        source: 'BINANCE_W3W_PREDICTION_ORDERBOOK_WSS',
        refreshMs: PREDICTION_REFRESH_MS,
        staleMs: PREDICTION_BOOK_STALE_MS,
        usedForDirectionWeight: false,
        usedAsStrongConflictVeto: true,
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
      const marketTopicId = url.searchParams.get('marketTopicId');
      const result = await getOfficialPredictionResolution(round, marketTopicId);
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
    freezePolicy: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
    observeMinMs: OBSERVE_MIN_MS,
    decisionWindowMs: DECISION_WINDOW_MS,
    streams: STREAMS,
    windowMs: WINDOW_MS,
    evaluationMs: EVAL_MS,
    confirmTicks: CONFIRM_TICKS,
    scoreThreshold: SCORE_THRESHOLD,
    trendThreshold: TREND_THRESHOLD,
    predictionSupportMin: PREDICTION_SUPPORT_MIN,
    maxAbsScore: MAX_ABS_SCORE,
    rejectAbsorption: REJECT_ABSORPTION,
    requirePredictionSupport: REQUIRE_PREDICTION_SUPPORT,
    at: new Date().toISOString(),
  }));
});
