import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';
import WebSocket from 'ws';
import { reconcileOrderUpdate } from './order-status-state.mjs';
import {ORDER_DIRECTION_POLICY,mappedOrderSignal,pendingOrderMatchesProduction,hydrateDirectionSettings,refreshDirectionSettings,setDirectionMode,directionSettingsSnapshot} from './order-direction-policy.mjs';
import {probeRailwayEgress} from './egress-ip-diagnostic.mjs';
import {BASE_MODEL,NOVICE_MODEL,DYNAMIC_MODEL,EDGE_MODEL,refreshModelSelection,setModelSelection,snapshot as modelSelectionSnapshot,
  selectionPermitsRound,selectedSignalMatches,validateNoviceSignal,validateDynamicEntrySignal,validateEdgeSignal,RSI_INPUT_VERSION,
  MAX_ORDER_SUBMIT_ATTEMPTS,claimOrderSubmitAttempt,closeOrderSubmitRound,releaseRejectedOrderSubmitAttempt,retryableRejectedOrderPost} from './production-signal-choice.mjs';

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
const PRODUCTION_SIGNAL_ORIGIN = String(process.env.ROUND_STATS_ORIGIN || process.env.FROZEN_SIGNAL_ORIGIN || '').replace(/\/+$/, '');
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';
const BINANCE_API_KEY = process.env.BINANCE_PREDICTION_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_PREDICTION_API_SECRET || '';
const ENV_WALLET_ADDRESS = process.env.BINANCE_PREDICTION_WALLET_ADDRESS || '';
const ENV_WALLET_ID = process.env.BINANCE_PREDICTION_WALLET_ID || '';
const API = 'https://api.binance.com';
const SIGNAL_REDIS_URL = String(process.env.SIGNAL_REDIS_URL || '').trim();
const SIGNAL_REDIS_CHANNEL = String(process.env.SIGNAL_REDIS_CHANNEL || 'binance:prediction:lock:v1');
const SIGNAL_WS_URL = String(process.env.SIGNAL_WS_URL || '').trim();
const SIGNAL_MODEL_NAME = String(process.env.SIGNAL_MODEL_NAME || 'SITE_LOCK_MODEL_V1');
const NOVICE_LOCAL_URL='http://127.0.0.1:'+String(process.env.PANEL_PUBLIC_PORT||3000)+'/api/shadow-breakout20/novice-mix';
const DYNAMIC_LOCAL_URL='http://127.0.0.1:'+String(process.env.PANEL_PUBLIC_PORT||3000)+'/api/shadow-breakout20/dynamic-entry';
const EDGE_LOCAL_URL='http://127.0.0.1:'+String(process.env.PANEL_PUBLIC_PORT||3000)+'/api/shadow-breakout20/edge-5m';


let enabled = false;
let tradeAmountText = null;
let startAfterRound = null;
let pendingAction = null;
let lastBalance = null;
let lastBalanceAt = 0;
let balanceRefreshPromise = null;
const UI_BALANCE_CACHE_MS = Math.max(3000, Number(process.env.UI_BALANCE_CACHE_MS || 10000));
let lastOrder = null;
let orderStatusRefreshPromise = null;
let prepareInFlight = false;
let lastPrepareAttemptAt = 0;
const submittedRounds = new Set();
let pushedSignal = null;
let lastPushedSignalId = null;
let signalRedisSubscriber = null;
let signalWs = null;
let signalWsReconnectTimer = null;
const signalTransport = {
  redisConfigured: Boolean(SIGNAL_REDIS_URL),
  redisConnected: false,
  websocketConfigured: Boolean(SIGNAL_WS_URL),
  websocketConnected: false,
  lastTransport: null,
  lastSignalId: null,
  lastEventAt: null,
  lastError: null,
};


function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function pinOK(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex') === CONTROL_PIN_SHA256;
}

function sign(payload) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(payload).digest('hex');
}

function asError(call, fallback) {
  const d = call?.data || {};
  return {
    ok: false,
    httpStatus: call?.status ?? null,
    code: d?.code ?? null,
    error: d?.msg || d?.message || call?.error || fallback,
    network: Boolean(call?.network),
  };
}

async function signedGet(path, params = {}) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
  }
  try {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
    }
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    q.append('signature', sign(q.toString()));
    const r = await fetch(`${API}${path}?${q.toString()}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, network: true, error: e?.message || 'NETWORK_ERROR', data: null };
  }
}

async function signedPost(path, bodyObj = {}) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
  }
  try {
    const q = new URLSearchParams();
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyObj)) {
      if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
    }
    const signature = sign(q.toString() + body.toString());
    q.append('signature', signature);
    const r = await fetch(`${API}${path}?${q.toString()}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': BINANCE_API_KEY,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, network: true, error: e?.message || 'NETWORK_ERROR', data: null };
  }
}

function roundToMs(round) {
  const n = Number(round);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

function amountToWei(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金额格式错误');
  let [a, b = ''] = s.split('.');
  b = (b + '0'.repeat(18)).slice(0, 18);
  return (BigInt(a) * 10n ** 18n + BigInt(b)).toString();
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(value).trim();
}


function currentRoundMs() {
  return Math.floor(Date.now() / 300000) * 300000;
}

function signalFromProductionLive(live, transport = 'http') {
  const currentRound = currentRoundMs();
  const round = Number(live?.round ?? live?.input?.round);
  const direction = String(live?.signal?.direction || '').toUpperCase();
  if (
    !live ||
    live.status !== 'LOCKED' ||
    round !== currentRound ||
    !['UP', 'DOWN'].includes(direction)
  ) {
    return {
      round: Number.isFinite(round) ? round : currentRound,
      status:live?.model==='SELECTIVE_V2_FAST8_PREWARM_V1'
        ? (live?.status==='DATA_UNAVAILABLE'?'DATA_UNAVAILABLE':'PENDING') : 'WAIT',
      executionEligible:false,
      direction: null,
      score: null,
      confidence: null,
      modelProbability: null,
      model: SIGNAL_MODEL_NAME,
      upstreamModel: live?.model ?? null,
      source: live?.source ?? 'PRODUCTION_SIGNAL',
      generatedAt: live?.generatedAt ?? null,
      signalId: null,
      transport,
    };
  }
  return {
    round,
    status: 'LOCKED',
    direction,
    score: live?.signal?.score ?? null,
    confidence: live?.signal?.confidence ?? null,
    modelProbability: live?.signal?.modelProbability ?? null,
    model: SIGNAL_MODEL_NAME,
    upstreamModel: live?.model ?? null,
    source: live?.source ?? 'PRODUCTION_SIGNAL',
    generatedAt: live?.generatedAt ?? null,
    executionEligible:live?.executionEligible!==false,
    qualityGate:live?.fallbackUsed===true?'UNVERIFIED_DISPLAY_ONLY':'QUALIFIED_DIRECTION',
    productionPolicy: live?.productionPolicy ?? null,
    frozen: live?.frozen === true,
    signalId: SIGNAL_MODEL_NAME + ':' + round,
    lockedAt: live?.productionLockedAt ?? live?.generatedAt ?? null,
    transport,
  };
}

function normalizePushedSignal(envelope, transport) {
  if (!envelope || typeof envelope !== 'object') return null;
  const round = Number(envelope.round);
  const direction = String(envelope.direction || '').toUpperCase();
  if (
    envelope.status !== 'LOCKED' ||
    round !== currentRoundMs() ||
    !['UP', 'DOWN'].includes(direction) ||
    envelope.immutable !== true
  ) return null;
  const expectedId = SIGNAL_MODEL_NAME + ':' + round;
  const signalId = String(envelope.signalId || expectedId);
  if (signalId !== expectedId) return null;
  return {
    round,
    status: 'LOCKED',
    direction,
    score: envelope.score ?? null,
    confidence: envelope.confidence ?? null,
    modelProbability: envelope.modelProbability ?? null,
    model: SIGNAL_MODEL_NAME,
    upstreamModel: envelope.upstreamModel ?? null,
    source: envelope.upstreamSource ?? envelope.source ?? 'SITE_PRODUCTION_LOCK',
    generatedAt: envelope.generatedAt ?? null,
    executionEligible:envelope.executionEligible!==false,
    qualityGate:envelope.qualityGate??null,
    productionPolicy: envelope.productionPolicy ?? null,
    frozen: true,
    signalId,
    lockedAt: envelope.lockedAt ?? envelope.generatedAt ?? null,
    transport,
  };
}

function handlePushedSignal(_envelope, _transport) {
  // Legacy multi-indicator pubsub/WS is not an RSI(14) signal source.
  // It must never replace or modify direct RSI output, regardless of user model.
  return false;
}

async function startSignalRedisSubscriber() {
  if (!SIGNAL_REDIS_URL || signalRedisSubscriber) return;
  const client = createClient({ url: SIGNAL_REDIS_URL });
  signalRedisSubscriber = client;
  client.on('error', err => {
    signalTransport.redisConnected = false;
    signalTransport.lastError = err?.message || String(err);
    console.error(JSON.stringify({ event: 'locked_signal_redis_subscriber_error', error: signalTransport.lastError }));
  });
  client.on('ready', () => {
    signalTransport.redisConnected = true;
    signalTransport.lastError = null;
    console.log(JSON.stringify({ event: 'locked_signal_redis_subscriber_ready', channel: SIGNAL_REDIS_CHANNEL }));
  });
  client.on('end', () => {
    signalTransport.redisConnected = false;
  });
  try {
    await client.connect();
    await client.subscribe(SIGNAL_REDIS_CHANNEL, raw => {
      try {
        handlePushedSignal(JSON.parse(raw), 'redis_pubsub');
      } catch (err) {
        console.error(JSON.stringify({ event: 'locked_signal_redis_message_invalid', error: err?.message || String(err) }));
      }
    });
  } catch (err) {
    signalTransport.redisConnected = false;
    signalTransport.lastError = err?.message || String(err);
    console.error(JSON.stringify({ event: 'locked_signal_redis_subscribe_failed', error: signalTransport.lastError }));
    try { await client.disconnect(); } catch {}
    signalRedisSubscriber = null;
    setTimeout(() => void startSignalRedisSubscriber(), 1500).unref();
  }
}

function startSignalWebSocket() {
  if (!SIGNAL_WS_URL || signalWs) return;
  const ws = new WebSocket(SIGNAL_WS_URL, { perMessageDeflate: false, handshakeTimeout: 5000 });
  signalWs = ws;
  ws.on('open', () => {
    signalTransport.websocketConnected = true;
    signalTransport.lastError = null;
    console.log(JSON.stringify({ event: 'locked_signal_websocket_connected', url: SIGNAL_WS_URL }));
  });
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      handlePushedSignal(message?.signal ?? message, 'websocket');
    } catch (err) {
      console.error(JSON.stringify({ event: 'locked_signal_websocket_message_invalid', error: err?.message || String(err) }));
    }
  });
  ws.on('error', err => {
    signalTransport.websocketConnected = false;
    signalTransport.lastError = err?.message || String(err);
    console.error(JSON.stringify({ event: 'locked_signal_websocket_error', error: signalTransport.lastError }));
  });
  ws.on('close', () => {
    signalTransport.websocketConnected = false;
    signalWs = null;
    clearTimeout(signalWsReconnectTimer);
    signalWsReconnectTimer = setTimeout(startSignalWebSocket, 1500);
    signalWsReconnectTimer.unref?.();
  });
}

async function getSignal({ forceHttp = false } = {}) {
  // On any Redis or selector fault, stop trading rather than silently reverting.
  let choice;
  try{choice=await refreshModelSelection()}catch{return null}
  const round=currentRoundMs();
  if(!selectionPermitsRound(round,choice))return null;
  if(![NOVICE_MODEL,BASE_MODEL,DYNAMIC_MODEL,EDGE_MODEL].includes(choice.model))return null;
  if(choice.model===EDGE_MODEL){
    try{
      const response=await fetch(EDGE_LOCAL_URL,{cache:'no-store',
        signal:AbortSignal.timeout(2400),headers:{accept:'application/json'}});
      if(!response.ok)return null;
      const verified=validateEdgeSignal(await response.json());
      if(!verified.ok)return null;
      return {
        round:verified.round,status:'LOCKED',direction:verified.direction,
        rawDirection:verified.direction,randomFlipApplied:false,
        signalOutputMode:'EDGE5_CAUSAL_PROBABILITY_V1',
        inputVersion:'EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1',
        score:verified.score,confidence:null,modelProbability:verified.modelProbability,
        calibrationReady:verified.calibrationReady,calibrationSamples:verified.calibrationSamples,
        model:SIGNAL_MODEL_NAME,upstreamModel:EDGE_MODEL,
        source:'SELECTIVE_V2_FAST8_PRIMARY',generatedAt:verified.lockedAt,
        lockedAt:verified.lockedAt,marketAt:verified.marketAt,
        frozen:true,executionEligible:verified.executionEligible,
        qualityGate:verified.executionEligible?'EDGE5_OFFICIAL_CALIBRATED':'EDGE5_COLLECTING_UNCALIBRATED',
        signalId:SIGNAL_MODEL_NAME+':'+verified.round+':'+EDGE_MODEL+':'+verified.modelVersion+':'+verified.direction,
        transport:'railway_edge5m_readonly'};
    }catch{return null;}
  }
  if(choice.model===DYNAMIC_MODEL){
    try{
      const response=await fetch(DYNAMIC_LOCAL_URL,{cache:'no-store',
        signal:AbortSignal.timeout(1100),headers:{accept:'application/json'}});
      if(!response.ok)return null;
      const verified=validateDynamicEntrySignal(await response.json());
      if(!verified.ok)return null;
      return {
        round:verified.round,status:'LOCKED',direction:verified.direction,
        rawDirection:verified.direction,randomFlipApplied:false,
        signalOutputMode:'DYNAMIC_ENTRY_FROZEN_V1',
        inputVersion:'DYNAMIC_ENTRY_5M_V1',
        score:verified.score,confidence:null,modelProbability:null,
        model:SIGNAL_MODEL_NAME,upstreamModel:DYNAMIC_MODEL,
        source:'SELECTIVE_V2_FAST8_PRIMARY',generatedAt:verified.lockedAt,
        lockedAt:verified.lockedAt,marketAt:verified.marketAt,
        frozen:true,executionEligible:true,
        qualityGate:'FROZEN_DYNAMIC_ENTRY_UNCALIBRATED',
        signalId:SIGNAL_MODEL_NAME+':'+verified.round+':'+DYNAMIC_MODEL+':'+
          verified.lockedAt+':'+verified.modelVersion+':'+verified.direction,
        transport:'railway_dynamic5m_frozen_readonly'};
    }catch{return null}
  }
  try {
    const r=await fetch(NOVICE_LOCAL_URL,{cache:'no-store',
      signal:AbortSignal.timeout(1100),headers:{accept:'application/json'}});
    if(!r.ok)return null;
    const body=await r.json();
    const verified=validateNoviceSignal(body);
    if(!verified.ok||verified.inputVersion!==RSI_INPUT_VERSION)return null;
    // Pass the RSI(14) direction through verbatim. No probabilistic / random
    // transformation; per-side FORWARD/INVERSE is applied ONLY downstream.
    return {
      round:verified.round,status:'LOCKED',direction:verified.direction,
      rawDirection:verified.direction,randomFlipApplied:false,
      randomFlipProbability:0,randomFlipVersion:null,
      signalOutputMode:'RSI14_DIRECT_V1',
      rsi:verified.rsi,inputVersion:RSI_INPUT_VERSION,
      score:verified.score,confidence:null,modelProbability:null,
      model:SIGNAL_MODEL_NAME,upstreamModel:choice.model,
      source:'SELECTIVE_V2_FAST8_PRIMARY',generatedAt:verified.lockedAt,
      lockedAt:verified.lockedAt,frozen:true,executionEligible:true,
      qualityGate:'RSI14_ONLY_NO_VALIDATED_EDGE',
      signalId:SIGNAL_MODEL_NAME+':'+round+':'+choice.model+':'+RSI_INPUT_VERSION+':DIRECT',
      transport:'railway_rsi14_readonly'};
  }catch{return null;}

}

async function getPaymentBalances() {
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/balance/payment-options');
  if (!call.ok) return { ...asError(call, 'BINANCE_BALANCE_QUERY_FAILED'), items: [] };
  const items = Array.isArray(call.data?.items)
    ? call.data.items.map(x => ({
        accountType: x.accountType ?? null,
        availableBalanceDisplay: x.availableBalanceDisplay ?? null,
        enabled: Boolean(x.enabled),
      }))
    : [];
  return { ok: true, items, checkedAt: new Date().toISOString() };
}

async function refreshUiBalance() {
  if (balanceRefreshPromise) return balanceRefreshPromise;
  balanceRefreshPromise = (async () => {
    const next = await getPaymentBalances();
    if (next?.ok || process.env.RENDER_MIGRATION_PREVIEW === 'true') {
      // Preview negative-cache prevents public page polling from hammering Binance.
      lastBalance = next;
      lastBalanceAt = Date.now();
    }
    return next;
  })();
  try {
    return await balanceRefreshPromise;
  } finally {
    balanceRefreshPromise = null;
  }
}

async function getUiBalance() {
  if (lastBalance?.ok || (process.env.RENDER_MIGRATION_PREVIEW === 'true' && lastBalance)) {
    if (Date.now() - lastBalanceAt >=
      (process.env.RENDER_MIGRATION_PREVIEW === 'true' ? 120000 : UI_BALANCE_CACHE_MS))
      refreshUiBalance();
    return { ...lastBalance, cached: Date.now() - lastBalanceAt > 1000, cacheAgeMs: Math.max(0, Date.now() - lastBalanceAt) };
  }
  const fresh = await refreshUiBalance();
  return fresh;
}

async function resolveWallet() {
  if (ENV_WALLET_ADDRESS && ENV_WALLET_ID) {
    return { ok: true, walletAddress: ENV_WALLET_ADDRESS, walletId: ENV_WALLET_ID };
  }
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/wallet/list');
  if (!call.ok) return asError(call, 'PREDICTION_WALLET_LOOKUP_FAILED');
  const wallets = Array.isArray(call.data?.wallets) ? call.data.wallets : [];
  const match = wallets.find(w => !ENV_WALLET_ADDRESS || String(w.walletAddress).toLowerCase() === ENV_WALLET_ADDRESS.toLowerCase()) || wallets[0];
  if (!match?.walletAddress || !match?.walletId) return { ok: false, error: 'NO_REGISTERED_PREDICTION_WALLET' };
  return { ok: true, walletAddress: match.walletAddress, walletId: match.walletId };
}

function paymentRoute(balance) {
  const items = Array.isArray(balance?.items) ? balance.items.filter(x => x.enabled) : [];
  const positive = items.filter(x => Number(x.availableBalanceDisplay) > 0);
  const cedefi = positive.find(x => String(x.accountType).toUpperCase() === 'CEDEFI');
  const spot = positive.find(x => String(x.accountType).toUpperCase() === 'SPOT');
  const funding = positive.find(x => String(x.accountType).toUpperCase() === 'FUNDING');
  if (cedefi) return { displayAccount: 'CeDeFi', accountType: 'SPOT', fundingSource: 'CEX' };
  if (spot) return { displayAccount: 'SPOT', accountType: 'SPOT', fundingSource: 'CEX' };
  if (funding) return { displayAccount: 'FUNDING', accountType: 'FUNDING', fundingSource: 'CEX' };
  return { displayAccount: 'Prediction Wallet', accountType: 'SPOT', fundingSource: 'MPC' };
}

function durationLooks5m(topic) {
  const s = Number(topic?.startDate);
  const e = Number(topic?.endDate);
  const d = e - s;
  return Number.isFinite(d) && d >= 240000 && d <= 360000;
}

function topicScore(topic, targetStart) {
  const s = Number(topic?.startDate);
  const e = Number(topic?.endDate);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return Number.POSITIVE_INFINITY;
  return Math.abs(s - targetStart) + Math.abs(e - (targetStart + 300000));
}

async function discoverTopic(round) {
  const target = roundToMs(round);
  if (!target) return { ok: false, error: 'INVALID_SIGNAL_ROUND' };

  const listCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/list', {
    l1Category: 'crypto',
    l2Category: 'up-down',
    sortBy: 'CREATED_TIME',
    orderBy: 'DESC',
    offset: 0,
    limit: 100,
  });
  let topics = listCall.ok && Array.isArray(listCall.data?.marketTopics) ? listCall.data.marketTopics : [];

  if (!topics.length) {
    const searchCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/search', { query: 'BTC 5m', topK: 50 });
    if (searchCall.ok && Array.isArray(searchCall.data)) topics = searchCall.data;
  }

  const btc = topics.filter(t => String(t?.symbol || '').toUpperCase() === 'BTCUSDT' && durationLooks5m(t));
  const close = btc
    .filter(t => topicScore(t, target) <= 180000)
    .sort((a, b) => topicScore(a, target) - topicScore(b, target));
  const now = Date.now();
  const active = btc
    .filter(t => Number(t.startDate) <= now + 30000 && Number(t.endDate) >= now - 30000)
    .sort((a, b) => topicScore(a, target) - topicScore(b, target));
  const topic = close[0] || active[0];
  if (!topic?.marketTopicId) {
    return {
      ok: false,
      error: 'BTC_5M_PREDICTION_MARKET_NOT_FOUND',
      diagnostics: { targetRound: target, btc5mCandidates: btc.length },
    };
  }

  const detailCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId: topic.marketTopicId });
  if (!detailCall.ok) return asError(detailCall, 'PREDICTION_MARKET_DETAIL_FAILED');
  return { ok: true, topic: { ...topic, ...detailCall.data } };
}

function norm(v) {
  return String(v || '').trim().toUpperCase();
}

function chooseToken(topic, direction) {
  const markets = Array.isArray(topic?.markets) ? topic.markets : [];
  const dir = norm(direction);
  const opp = dir === 'UP' ? 'DOWN' : 'UP';
  let best = null;

  for (const m of markets) {
    const mt = norm(`${m?.title || ''} ${m?.question || ''}`);
    const trading = norm(m?.tradingStatus || 'OPEN');
    if (trading && !['OPEN', 'OPENING', 'REGISTERED'].includes(trading)) continue;
    for (const o of Array.isArray(m?.outcomes) ? m.outcomes : []) {
      if (!o?.tokenId) continue;
      const on = norm(o?.name);
      let score = 0;
      if (on === dir) score += 120;
      if (mt === dir && on === 'YES') score += 120;
      if (mt.includes(dir) && on === 'YES') score += 100;
      if (mt === opp && on === 'NO') score += 110;
      if (mt.includes(opp) && on === 'NO') score += 90;
      if (markets.length === 1 && mt.includes('UP') && on === (dir === 'UP' ? 'YES' : 'NO')) score += 80;
      if (!best || score > best.score) best = { score, market: m, outcome: o };
    }
  }
  if (!best || best.score < 50) return { ok: false, error: 'UP_DOWN_TOKEN_MAPPING_FAILED' };
  return { ok: true, market: best.market, outcome: best.outcome };
}

async function prepareIntent(signal) {
  // Independent authenticated reads can run concurrently. Keep all checks before quote and order placement.
  const [wallet, marketResult, balance] = await Promise.all([
    resolveWallet(), discoverTopic(signal.round),
    lastBalance?.ok ? Promise.resolve(lastBalance) : getPaymentBalances(),
  ]);
  if (!wallet.ok) return wallet;
  if (!marketResult.ok) return marketResult;

  const token = chooseToken(marketResult.topic, signal.direction);
  if (!token.ok) return token;

  const amountIn = amountToWei(tradeAmountText);
  lastBalance = balance;
  const payment = paymentRoute(balance);
  const slippageBps = Number(marketResult.topic?.slippageBps || 1200);
  const feeRateBps = Number(marketResult.topic?.feeRateBps || 200);

  return {
    ok: true,
    wallet,
    payment,
    topic: marketResult.topic,
    market: token.market,
    outcome: token.outcome,
    amountIn,
    slippageBps,
    feeRateBps,
  };
}

async function getFreshQuote(intent) {
  const quoteBody = {
    walletAddress: intent.wallet.walletAddress,
    tokenId: intent.outcome.tokenId,
    side: 'BUY',
    amountIn: intent.amountIn,
    orderType: 'MARKET',
    slippageBps: intent.slippageBps,
    chainId: intent.topic?.chainId || '56',
    feeRateBps: intent.feeRateBps,
    fundingSource: intent.payment.fundingSource,
  };
  if (intent.payment.fundingSource === 'CEX') quoteBody.fundTransferAmount = intent.amountIn;

  const startedAt = Date.now();
  const quoteCall = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote', quoteBody);
  const receivedAt = Date.now();
  if (!quoteCall.ok) return { ...asError(quoteCall, 'PREDICTION_GET_QUOTE_FAILED'), startedAt, receivedAt };

  const quote = quoteCall.data || {};
  if (!quote.quoteId) return { ok: false, error: 'QUOTE_ID_MISSING', startedAt, receivedAt };
  return { ok: true, quote, startedAt, receivedAt };
}

function publicPending() {
  if (!pendingAction) return null;
  const { _internal, ...safe } = pendingAction;
  return safe;
}

async function prepareWorker(signalOverride = null, trigger = 'poll') {
  if (!enabled || !tradeAmountText || prepareInFlight || !directionSettingsSnapshot().ready) return;
  let choice;
  try{choice=await refreshModelSelection()}catch{return}
  if(!selectionPermitsRound(currentRoundMs(),choice))return;
  if(signalOverride && choice.model!==BASE_MODEL)return;
  const signal = signalOverride || await getSignal();
  if (!signal || signal.status !== 'LOCKED' || !signal.round || !['UP', 'DOWN'].includes(signal.direction)) return;
  if(choice.model===NOVICE_MODEL&&signal.upstreamModel!==NOVICE_MODEL)return;
  if(choice.model===DYNAMIC_MODEL&&signal.upstreamModel!==DYNAMIC_MODEL)return;
  if(choice.model===EDGE_MODEL&&signal.upstreamModel!==EDGE_MODEL)return;
  // Display-only 8-second fallback must NEVER prepare/auto-confirm a real order.
  if (signal.executionEligible===false) {
    console.log(JSON.stringify({event:'unverified_signal_order_blocked',
      round:signal.round,source:signal.source,qualityGate:signal.qualityGate}));
    return;
  }
  if (startAfterRound != null && String(signal.round) === String(startAfterRound)) return;
  if (submittedRounds.has(String(signal.round))) return;
  if (pendingAction?.state === 'READY' && String(pendingAction.round) === String(signal.round)) return;
  if (pendingAction?.state === 'QUOTING' || pendingAction?.state === 'SUBMITTING') return;
  if (!signalOverride && Date.now() - lastPrepareAttemptAt < 2500) return;

  prepareInFlight = true;
  lastPrepareAttemptAt = Date.now();
  try {
    try { await refreshModelSelection(); } catch{return}
    const verifiedChoice=modelSelectionSnapshot();
    if(!selectionPermitsRound(Number(signal.round),verifiedChoice)||
       verifiedChoice.model!==choice.model||verifiedChoice.revision!==choice.revision)return;
    try { await refreshDirectionSettings(); } catch(err) {
      console.error(JSON.stringify({event:'direction_mode_refresh_failed',error:String(err?.message||err)}));
      return;
    }
    const settings=directionSettingsSnapshot();
    if (settings.effectiveAfterRound != null && Number(signal.round)<=settings.effectiveAfterRound) return;
    const mapping=mappedOrderSignal(signal);
    if (!mapping.orderSignal) return;
    const intent = await prepareIntent({...signal,direction:mapping.orderSignal});
    if (directionSettingsSnapshot().policy !== mapping.mappingPolicy) return;
    if (!intent.ok) {
      pendingAction = {
        state: 'PREPARE_ERROR',
        round: signal.round,
        signal: mapping.orderSignal,
        productionSignal: mapping.productionSignal,
        rawDirection:signal.rawDirection??null,randomFlipApplied:signal.randomFlipApplied??false,
        randomFlipVersion:signal.randomFlipVersion??null,
        productionSource: mapping.productionSource,
        orderSignal: mapping.orderSignal,
        mappingMode: mapping.mappingMode,
        orderDirectionPolicy: mapping.mappingPolicy,
        score: signal.score,
        signalId: signal.signalId ?? null,
        model: signal.model ?? SIGNAL_MODEL_NAME,
        upstreamModel: signal.upstreamModel ?? null,
        signalModelChoice:choice.model,signalModelChoiceRevision:choice.revision,
        signalTransport: signal.transport ?? trigger,
        amount: tradeAmountText,
        error: intent.error,
        code: intent.code ?? null,
        httpStatus: intent.httpStatus ?? null,
        at: new Date().toISOString(),
      };
      console.log(JSON.stringify({ event: 'intent_prepare_failed', ...pendingAction }));
      return;
    }

    pendingAction = {
      state: 'READY',
      at: new Date().toISOString(),
      round: signal.round,
      signal: mapping.orderSignal,
      productionSignal: mapping.productionSignal,
      rawDirection:signal.rawDirection??null,randomFlipApplied:signal.randomFlipApplied??false,
      randomFlipVersion:signal.randomFlipVersion??null,
      productionSource: mapping.productionSource,
      orderSignal: mapping.orderSignal,
      mappingMode: mapping.mappingMode,
      orderDirectionPolicy: mapping.mappingPolicy,
      score: signal.score,
      signalId: signal.signalId ?? null,
      model: signal.model ?? SIGNAL_MODEL_NAME,
      upstreamModel: signal.upstreamModel ?? null,
      signalModelChoice:choice.model,signalModelChoiceRevision:choice.revision,
      signalTransport: signal.transport ?? trigger,
      signalGeneratedAt: signal.generatedAt ?? null,
      action: mapping.action,
      amount: tradeAmountText,
      marketTopicId: intent.topic.marketTopicId,
      marketTitle: intent.market?.title || signal.direction,
      outcome: intent.outcome?.name || 'YES',
      paymentAccount: intent.payment.displayAccount,
      quoteMode: 'FRESH_ON_CONFIRM',
      confirmationToken: crypto.randomBytes(16).toString('hex'),
      _internal: intent,
    };
    console.log(JSON.stringify({
      event: 'api_intent_ready',
      round: pendingAction.round,
      signal: pendingAction.signal,
      rawDirection: pendingAction.rawDirection,
      randomFlipApplied: pendingAction.randomFlipApplied,
      productionSignal: pendingAction.productionSignal,
      model: pendingAction.model,
      upstreamModel: pendingAction.upstreamModel,
      signalId: pendingAction.signalId,
      productionSource: pendingAction.productionSource,
      mappingMode: pendingAction.mappingMode,
      signalTransport: pendingAction.signalTransport,
      signalGeneratedAt: pendingAction.signalGeneratedAt,
      amount: pendingAction.amount,
      marketTopicId: pendingAction.marketTopicId,
      quoteMode: pendingAction.quoteMode,
    }));
  } finally {
    prepareInFlight = false;
  }
}

async function lookupOrder(orderId, walletAddress) {
  const history = await signedGet('/sapi/v1/w3w/wallet/prediction/order/history', { walletAddress, offset: 0, limit: 100 });
  if (history.ok) {
    const found = (Array.isArray(history.data?.orders) ? history.data.orders : []).find(o => String(o.orderId) === String(orderId));
    if (found) return { ok: true, order: found };
  }
  const active = await signedGet('/sapi/v1/w3w/wallet/prediction/order/list', { walletAddress, offset: 0, limit: 100 });
  if (active.ok) {
    const found = (Array.isArray(active.data?.orders) ? active.data.orders : []).find(o => String(o.orderId) === String(orderId));
    if (found) return { ok: true, order: found };
  }
  return { ok: false };
}

async function auditSettledHistoryTopics(topicIds = []) {
  try {
    const wanted = new Set(topicIds.map(String));
    if (!wanted.size) return;
    const wallet = await resolveWallet();
    if (!wallet.ok) {
      console.log(JSON.stringify({ event:'settled_history_audit_failed', error:wallet.error || 'WALLET_UNAVAILABLE' }));
      return;
    }
    const call = await signedGet('/sapi/v1/w3w/wallet/prediction/position/settled-history', {
      walletAddress: wallet.walletAddress,
      l1Category: 'crypto',
      startDate: '2026-10-04',
      endDate: '2026-10-04',
      offset: 0,
      limit: 100,
    });
    if (!call.ok) {
      console.log(JSON.stringify({ event:'settled_history_audit_failed', httpStatus:call.status, error:call.data?.msg || call.error || null }));
      return;
    }
    const positions = Array.isArray(call.data?.positions) ? call.data.positions : [];
    for (const p of positions) {
      if (!wanted.has(String(p?.marketTopicId))) continue;
      let variantData = null;
      const detail = await signedGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId:p?.marketTopicId });
      if (detail.ok) variantData = detail.data?.variantData || null;
      console.log(JSON.stringify({
        event:'settled_history_audit',
        marketTopicId:p?.marketTopicId ?? null,
        marketId:p?.marketId ?? null,
        marketTopicTitle:p?.marketTopicTitle ?? null,
        marketTitle:p?.marketTitle ?? null,
        outcomeName:p?.outcomeName ?? null,
        outcomeIndex:p?.outcomeIndex ?? null,
        isWinner:p?.isWinner ?? null,
        finalOutcome:p?.finalOutcome ?? null,
        realizedPnl:p?.realizedPnl ?? null,
        endDate:p?.endDate ?? null,
        settledDate:p?.settledDate ?? null,
        variantStartPrice:variantData?.startPrice ?? null,
        variantEndPrice:variantData?.endPrice ?? null,
        priceFeedProvider:variantData?.priceFeedProvider ?? null,
        priceFeedSymbol:variantData?.priceFeedSymbol ?? null,
      }));
    }
  } catch (e) {
    console.log(JSON.stringify({ event:'settled_history_audit_failed', error:e?.message || String(e) }));
  }
}

function terminalFailureStatus(status) {
  const s = norm(status);
  return ['FAILED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(s);
}

function terminalSuccessStatus(status) {
  const s = norm(status);
  return ['FILLED', 'SUCCESS', 'COMPLETED', 'COMPLETE'].includes(s);
}

async function refreshLastOrderStatus(force = false) {
  const target = lastOrder;
  if (!target?.orderId || !target?.walletAddress) return;
  if (orderStatusRefreshPromise) return orderStatusRefreshPromise;
  if (!force && Date.now() - Number(target.lastCheckedAt || 0) < 2500) return;
  target.lastCheckedAt = Date.now();
  orderStatusRefreshPromise = (async () => {
    const found = await lookupOrder(target.orderId, target.walletAddress);
    // An older asynchronous response must never overwrite a newer order.
    if (!found.ok || lastOrder !== target) return;
    const beforeStatus = target.status;
    const beforeState = target.state;
    Object.assign(target, reconcileOrderUpdate(target, found.order));
    target.checkedAt = new Date().toISOString();
    if (target.state !== beforeState || target.status !== beforeStatus) {
      console.log(JSON.stringify({
        event: 'order_status_updated', orderId: target.orderId, status: target.status,
        state: target.state, lastObservedStatus: target.lastObservedStatus,
        fillPercentage: target.fillPercentage, filledUsdtAmount: target.filledUsdtAmount,
      }));
    }
    if (target.state === 'RECONCILIATION_REQUIRED' && beforeState !== 'RECONCILIATION_REQUIRED') {
      // FILL -> FAILED contradictions cannot establish whether Binance filled the trade.
      // Prevent further orders until reconciliation, without declaring a false failure.
      enabled = false;
      if (typeof autoConfirmHalted !== 'undefined') autoConfirmHalted = true;
      console.error(JSON.stringify({
        event: 'order_status_conflict_auto_halted', orderId: target.orderId,
        previousState: beforeState, previousStatus: beforeStatus,
        conflictingStatus: target.conflictingStatus, requiresIndependentReconciliation: true,
      }));
    }
  })().finally(() => { orderStatusRefreshPromise = null; });
  return orderStatusRefreshPromise;
}

void refreshModelSelection().catch(e=>console.error(JSON.stringify({
  event:'production_signal_choice_hydrate_failed',error:String(e?.message||e)})));
setInterval(()=>{if(!modelSelectionSnapshot().ready)void refreshModelSelection().catch(()=>{});},5000);
void hydrateDirectionSettings().catch(e=>console.error(JSON.stringify({
  event:'direction_mode_hydrate_failed',error:String(e?.message||e)})));
setInterval(()=>{if(!directionSettingsSnapshot().ready)void hydrateDirectionSettings().catch(()=>{});},5000);
void startSignalRedisSubscriber();
startSignalWebSocket();
setInterval(prepareWorker, 1200);
setInterval(() => refreshLastOrderStatus(false), 2500);

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5分钟 API 实盘确认控制台</title><style>
body{font-family:system-ui,-apple-system;background:#0f1117;color:#fff;margin:0;padding:18px}.w{max-width:580px;margin:auto}.c{background:#191d27;border-radius:18px;padding:18px;margin:14px 0}.big{font-size:25px;font-weight:800}.on{color:#3ddc84}.off,.bad{color:#ff6868}.ok{color:#3ddc84}.warn{color:#f0b90b}.muted{color:#a8b0bd;font-size:14px;line-height:1.55}input,button{width:100%;box-sizing:border-box;padding:15px;border-radius:12px;margin-top:10px;font-size:17px}input{background:#0d1016;color:#fff;border:1px solid #3b4352}button{border:0;font-weight:800}.start{background:#28c76f;color:#06150b}.stop{background:#ff5c62;color:#fff}.confirm{background:#f0b90b;color:#161616;font-size:19px}.confirm:disabled{opacity:.45}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kv{background:#10141c;padding:12px;border-radius:12px}.k{font-size:12px;color:#8f98a8}.v{font-size:17px;font-weight:700;margin-top:4px}.wallet{font-size:30px;font-weight:900;margin-top:6px}.pending{border:1px solid #454d5f}.hidden{display:none}</style></head><body><div class="w">
<h2>5分钟 API 实盘确认控制台</h2>
<div class="c"><div id="switch" class="big">加载中...</div><div class="muted">流程：新一轮 LOCKED → 后端先准备市场/方向（不提前拿 Quote）→ 你点一次“确认下单” → 后端即时获取最新 Quote → 立刻调用 Binance Prediction 下单 API → 再核验真实订单状态。</div></div>
<div class="c"><div class="k">Prediction 可用余额</div><div class="wallet" id="walletBalance">读取中...</div><div class="muted" id="walletMeta">正在连接 Binance Prediction...</div></div>
<div class="c" id="tradeInputsCard"><div class="k">每轮金额与控制 PIN</div><input id="amount" type="number" inputmode="decimal" min="1" step="0.01" placeholder="每轮金额，例如 2"><input id="pin" type="password" autocomplete="off" inputmode="numeric" placeholder="控制 PIN（输入时隐藏）"><button class="start" onclick="setV(true)">开始跟随新信号</button><button class="stop" onclick="setV(false)">停止跟随</button><button id="egressProbeBtn" type="button" class="confirm" style="background:#344155;color:#fff;font-size:15px" onclick="checkEgressIp()">检测 Railway 出口 IP（只读）</button><div id="egressProbeResult" class="muted" role="status" aria-live="polite">输入上方控制 PIN，点击检测；不会发出交易请求。</div><div class="muted">确认按钮出现时只代表方向/市场已经准备好，尚未拿 Quote。点击确认后才会即时获取 Quote 并马上提交；若报价剩余有效期不足，系统会拒绝提交，避免使用过期 Quote。</div></div>
<div class="c"><div class="grid"><div class="kv"><div class="k">当前轮次</div><div class="v" id="round">-</div></div><div class="kv"><div class="k">状态</div><div class="v" id="status">-</div></div><div class="kv"><div class="k">生产信号（原始）</div><div class="v" id="direction">-</div></div><div class="kv"><div class="k">下单信号（按来源正向/反向）</div><div class="v" id="orderDirection">-</div></div><div class="kv"><div class="k">Score</div><div class="v" id="score">-</div></div><div class="kv"><div class="k">每轮金额</div><div class="v" id="amountView">-</div></div><div class="kv"><div class="k">模式</div><div class="v">API_CONFIRM_LIVE</div></div></div></div>
<div class="c pending"><div class="k">API 已准备的实盘订单</div><div class="big" id="pendingTitle">暂无</div><div class="muted" id="pendingMeta">开启后等待下一轮 LOCKED 信号。</div><button id="confirmBtn" class="confirm hidden" onclick="confirmOrder()">确认下单</button></div>
<div class="c"><div class="k">最近一笔 API 下单结果</div><div class="big" id="orderTitle">暂无</div><div class="muted" id="orderMeta">-</div></div>
<div id="riskControlsAnchor"></div>
</div><script>
let currentPending=null;
let refreshBusy=false;
function el(id){return document.getElementById(id)}
async function refresh(){if(refreshBusy)return;refreshBusy=true;try{const r=await fetch('/api/status',{cache:'no-store'});const j=await r.json();el('switch').innerHTML=j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>';const s=j.signal||{};el('round').textContent=s.round??'-';el('status').textContent=s.status??'-';el('direction').textContent=s.direction??'-';el('score').textContent=s.score==null?'-':Number(s.score).toFixed(2);el('amountView').textContent=j.amount??'-';if(document.activeElement!==el('amount')&&j.amount!=null)el('amount').value=j.amount;const b=j.balance||{};const first=(b.items||[]).find(x=>x.enabled&&Number(x.availableBalanceDisplay)>0)||(b.items||[]).find(x=>x.enabled)||(b.items||[])[0];if(b.ok&&first){el('walletBalance').innerHTML='<span class="ok">'+first.availableBalanceDisplay+' USDT</span>';el('walletMeta').textContent='账户：'+first.accountType+' · Binance Prediction 实时可用余额'}else{el('walletBalance').innerHTML='<span class="bad">读取失败</span>';el('walletMeta').textContent=(b.error||'未返回余额')+(b.code!=null?' ('+b.code+')':'')}
currentPending=j.pendingAction||null;const btn=el('confirmBtn');if(!currentPending){el('pendingTitle').textContent='暂无';el('pendingMeta').textContent=j.enabled?'正在等待下一轮 LOCKED，并准备市场/方向...':'开启后等待下一轮 LOCKED 信号。';btn.classList.add('hidden')}else if(currentPending.state==='READY'){el('pendingTitle').textContent=(currentPending.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+currentPending.amount+' USDT';el('pendingMeta').textContent='市场 '+(currentPending.marketTitle||'-')+' / '+(currentPending.outcome||'-')+' · 支付 '+(currentPending.paymentAccount||'-')+' · Quote：点击确认后即时获取';btn.textContent='确认 '+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT（即时Quote后API下单）';btn.disabled=false;btn.classList.remove('hidden')}else if(currentPending.state==='PREPARE_ERROR'){el('pendingTitle').textContent='准备失败';el('pendingMeta').textContent=(currentPending.error||currentPending.state)+(currentPending.code!=null?' ('+currentPending.code+')':'');btn.classList.add('hidden')}else{el('pendingTitle').textContent=currentPending.state==='QUOTING'?'正在获取最新 Quote...':'正在提交...';el('pendingMeta').textContent='请稍候，不要重复点击。';btn.classList.add('hidden')}
const o=j.lastOrder;if(o){const filled=o.state==='CONFIRMED_FILLED'||Number(o.fillPercentage||0)>=1||Number(o.filledUsdtAmount||0)>0;const failed=o.state==='CONFIRMED_FAILED';if(filled){el('orderTitle').innerHTML='<span class="ok">已成交</span>'}else if(failed){el('orderTitle').innerHTML='<span class="bad">下单失败</span>'}else{el('orderTitle').innerHTML='<span class="warn">已提交，核验中</span>'}el('orderMeta').textContent='orderId '+(o.orderId||'-')+' · '+(o.action||'-')+' · '+(o.amount||'-')+' USDT · 状态 '+(o.status||o.state||'-')+(o.filledUsdtAmount?' · 已成交 '+o.filledUsdtAmount+' USDT':'')+(o.error?' · '+o.error:'')}else{el('orderTitle').textContent='暂无';el('orderMeta').textContent='-' }}catch(e){el('switch').textContent='状态读取失败'}finally{refreshBusy=false}}
async function setV(v){const a=Number(el('amount').value);if(v&&(!Number.isFinite(a)||a<1)){alert('请输入至少 1 USDT；实际最低金额仍以 Binance 返回为准');return}const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:v,amount:v?el('amount').value:undefined,pin:el('pin').value})});const j=await r.json();if(!r.ok){alert(j.error||'操作失败');return}refresh()}
async function confirmOrder(){if(!currentPending||currentPending.state!=='READY')return;if(!confirm('确认提交真实订单：'+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT？\n确认后后台会即时获取最新 Quote 并立即提交。'))return;const btn=el('confirmBtn');btn.disabled=true;btn.textContent='正在获取最新 Quote 并提交...';const r=await fetch('/api/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:el('pin').value,confirmationToken:currentPending.confirmationToken})});const j=await r.json();if(r.ok){alert('订单已提交，正在核验 Binance 成交状态。orderId：'+j.orderId)}else{alert((j.error||'下单失败')+(j.code!=null?' ('+j.code+')':''))}refresh()}
refresh();setInterval(refresh,1000);
</script></body></html>`;

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/egress-ip') {
    const body = await readBody(req);
    if (!pinOK(body.pin)) return send(res, 401, {ok:false,error:'控制 PIN 错误'});
    const result = await probeRailwayEgress();
    return send(res, result.ok ? 200 : 502, result);
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      mode: 'API_CONFIRM_LIVE',
      quoteMode: 'FRESH_ON_CONFIRM',
      hasSiteOrigin: Boolean(SITE_ORIGIN),
      hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
      hasPredictionWallet: Boolean(ENV_WALLET_ADDRESS),
      hasWalletId: Boolean(ENV_WALLET_ID),
      signalModel: SIGNAL_MODEL_NAME,
      orderSignalModel: modelSelectionSnapshot().model,
      orderSignalModelReady: modelSelectionSnapshot().ready,
      orderSignalModelEffectiveAfterRound:modelSelectionSnapshot().effectiveAfterRound,
      orderSignalModelRevision:modelSelectionSnapshot().revision,
      signalTransport: { ...signalTransport },
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) {
    return send(res, 200, page, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/order-signal-model') {
    try{
      const data=await refreshModelSelection();
      return send(res,200,{ok:true,...data,selectionControlsOrders:true});
    }catch(error){return send(res,503,{ok:false,error:'下单信号配置不可用：'+String(error?.message||error)})}
  }
  if (req.method === 'POST' && url.pathname === '/api/order-signal-model') {
    const body=await readBody(req);
    if(!pinOK(body.pin))return send(res,401,{ok:false,error:'控制 PIN 错误'});
    if(['SUBMITTING','QUOTING'].includes(pendingAction?.state))
      return send(res,409,{ok:false,error:'已有订单正在提交，暂不能切换信号'});
    try{
      const data=await setModelSelection(body.model,body.expectedRevision);
      if(data.changed){
        // Next-round-only change. No historical lock or prepared order survives.
        pendingAction=null;pushedSignal=null;startAfterRound=currentRoundMs();
        lastPrepareAttemptAt=0;
      }
      console.log(JSON.stringify({event:'order_signal_model_changed',model:data.model,
        revision:data.revision,changed:data.changed,effectiveFrom:'NEXT_ROUND'}));
      return send(res,200,{ok:true,...data,effectiveFrom:'NEXT_ROUND'});
    }catch(error){
      const m=String(error?.message||error);
      return send(res,/INVALID_/.test(m)?400:/CONFLICT|IN_PROGRESS/.test(m)?409:503,{ok:false,error:m});
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/direction-mode') {
    try { await refreshDirectionSettings(); }
    catch(err){return send(res,503,{ok:false,error:'方向配置未就绪：'+String(err?.message||err)})}
    const data=directionSettingsSnapshot();
    return send(res,data.ready?200:503,{ok:data.ready,...data});
  }
  if (req.method === 'POST' && url.pathname === '/api/direction-mode') {
    const body=await readBody(req);
    if(!pinOK(body.pin))return send(res,401,{ok:false,error:'控制 PIN 错误'});
    if(!directionSettingsSnapshot().ready)return send(res,503,{ok:false,error:'方向配置尚未同步'});
    if(['SUBMITTING','QUOTING'].includes(pendingAction?.state))return send(res,409,{ok:false,error:'有订单正在处理，暂不能切换'});
    try{
      const data=await setDirectionMode(body.source,body.direction,body.mode,body.expectedRevision,currentRoundMs());
      if(data.changed){
        pendingAction=null;
        startAfterRound=currentRoundMs();
        lastPrepareAttemptAt=0;
      }
      console.log(JSON.stringify({event:'direction_mode_changed',source:body.source,direction:body.direction,mode:body.mode,
        revision:data.revision,changed:data.changed,at:new Date().toISOString()}));
      return send(res,200,{ok:true,...data,effectiveFrom:'NEXT_ROUND'});
    }catch(err){
      const message=String(err?.message||err);
      return send(res,/INVALID_/.test(message)?400:/CONFLICT|IN_PROGRESS/.test(message)?409:503,{ok:false,error:message});
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [signal, balance] = await Promise.all([getSignal(), getUiBalance()]);
    try{await refreshDirectionSettings()}catch{}
    const mapping=mappedOrderSignal(signal);
    // The existing mobile UI renders these server-provided labels as text.
    // Do not suggest an inverse order when the direction is display-only.
    const displayOnly = signal?.status==='LOCKED' && signal.executionEligible===false;
    const displaySignal = displayOnly
      ? {...signal,status:'低置信度（仅展示，不下单）'} : signal;
    return send(res, 200, {
      ok: true,
      enabled,
      amount: tradeAmountText,
      mode: 'API_CONFIRM_LIVE',
      quoteMode: 'FRESH_ON_CONFIRM',
      signal:displaySignal,
      productionSignal: signal?.status==='LOCKED'?signal.direction:null,
      modelOriginalSignal: signal?.status==='LOCKED'?signal.rawDirection??null:null,
      signalRandomFlipApplied: signal?.status==='LOCKED'?false:null,
      signalOutputMode: signal?.status==='LOCKED'?'RSI14_DIRECT_V1':null,
      orderSignal: displayOnly?null:mapping.orderSignal,
      orderMappingMode: mapping.mappingMode,
      orderProductionSource: mapping.productionSource,
      orderDirectionPolicy: mapping.mappingPolicy,
      directionModes:directionSettingsSnapshot().modes,
      directionModeReady:directionSettingsSnapshot().ready,
      signalModel: SIGNAL_MODEL_NAME,
      orderSignalModel:modelSelectionSnapshot().model,
      orderSignalModelReady:modelSelectionSnapshot().ready,
      orderSignalModelEffectiveAfterRound:modelSelectionSnapshot().effectiveAfterRound,
      orderSignalModelRevision:modelSelectionSnapshot().revision,
      signalTransport: { ...signalTransport },
      balance,
      startAfterRound,
      pendingAction: publicPending(),
      lastOrder: lastOrder ? { ...lastOrder, walletAddress: undefined, lastCheckedAt: undefined } : null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/balance') {
    const balance = await getPaymentBalances();
    lastBalance = balance;
    return send(res, balance.ok ? 200 : 502, balance);
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    const body = await readBody(req);
    if (process.env.RENDER_MIGRATION_PREVIEW === 'true' && body.enabled === true) {
      return send(res, 403, {ok:false,error:'Render 免费测试环境：实盘跟随未启用。请先完成持久化和交易链路验证。'});
    }
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });
    const nextEnabled = Boolean(body.enabled);
    if (nextEnabled) {
      if (lastOrder?.state === 'RECONCILIATION_REQUIRED')
        return send(res, 409, { ok:false, error:'上一笔订单的成交与失败状态矛盾，请先核对交易所原始成交记录，禁止继续自动下单' });
      const amount = cleanAmount(body.amount);
      if (!amount || Number(amount) < 1) {
        return send(res, 400, { ok: false, error: 'MARKET 市价单金额请至少填写 1 USDT，实际最低值以 Binance 为准' });
      }
      tradeAmountText = amount;
      const current = await getSignal();
      startAfterRound = current?.round ?? null;
      pendingAction = null;
    } else {
      pendingAction = null;
    }
    enabled = nextEnabled;
    console.log(JSON.stringify({
      event: 'api_confirm_control',
      enabled,
      amount: tradeAmountText,
      startAfterRound,
      quoteMode: 'FRESH_ON_CONFIRM',
      at: new Date().toISOString(),
    }));
    return send(res, 200, { ok: true, enabled, amount: tradeAmountText, startAfterRound, mode: 'API_CONFIRM_LIVE', quoteMode: 'FRESH_ON_CONFIRM' });
  }

  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });

    const p = pendingAction;
    if (!p || p.state !== 'READY') return send(res, 409, { ok: false, error: '当前没有可确认的 API 订单' });
    try{await refreshModelSelection()}catch{return send(res,503,{ok:false,error:'下单模型选择配置暂不可用'})}
    if(!selectedSignalMatches(p))return send(res,409,{ok:false,error:'下单信号源已切换，旧订单不可提交'});
    if (body.confirmationToken !== p.confirmationToken) return send(res, 409, { ok: false, error: '订单确认令牌已失效，请刷新页面' });
    if (submittedRounds.has(String(p.round))) return send(res, 409, { ok: false, error: '本轮已经提交过订单' });

    p.state = 'QUOTING';
    const quoteRequestStartedAt = Date.now();
    const [current, freshQuote] = await Promise.all([
      getSignal(),
      getFreshQuote(p._internal),
    ]);

    if (!current || current.status !== 'LOCKED' || String(current.round) !== String(p.round) || !pendingOrderMatchesProduction(p,current)) {
      pendingAction = null;
      return send(res, 409, { ok: false, error: '当前信号或轮次已经变化，已阻止旧订单提交' });
    }

    try{await refreshModelSelection()}catch{return send(res,503,{ok:false,error:'下单模型选择配置不可用'})}
    if(!selectedSignalMatches(p))return send(res,409,{ok:false,error:'下单信号源已变化，停止旧报价提交'});
    if (!freshQuote.ok) {
      p.state = 'READY';
      p.error = freshQuote.error;
      p.code = freshQuote.code ?? null;
      console.log(JSON.stringify({
        event: 'fresh_quote_failed',
        round: p.round,
        action: p.action,
        error: freshQuote.error,
        code: freshQuote.code ?? null,
        httpStatus: freshQuote.httpStatus ?? null,
      }));
      return send(res, 502, freshQuote);
    }

    const quote = freshQuote.quote;
    const expireAt = Number(quote.expireAt || 0);
    const remainingMs = expireAt > 0 ? expireAt - Date.now() : null;
    console.log(JSON.stringify({
      event: 'fresh_quote_ready',
      round: p.round,
      action: p.action,
      quoteId: quote.quoteId,
      chance: quote.chance ?? null,
      expireAt: quote.expireAt ?? null,
      remainingMs,
      quoteLatencyMs: freshQuote.receivedAt - freshQuote.startedAt,
      confirmToQuoteMs: Date.now() - quoteRequestStartedAt,
    }));

    if (remainingMs !== null && remainingMs < 1200) {
      p.state = 'READY';
      p.error = '最新 Quote 剩余有效期不足，未提交。请在下一次按钮出现后更快确认。';
      console.log(JSON.stringify({ event: 'fresh_quote_too_close_to_expiry', round: p.round, remainingMs, expireAt }));
      return send(res, 409, { ok: false, error: p.error, expireAt, remainingMs });
    }

    p.state = 'SUBMITTING';
    const intent = p._internal;
    const placeBody = {
      walletAddress: intent.wallet.walletAddress,
      walletId: intent.wallet.walletId,
      quoteId: quote.quoteId,
      timeInForce: 'FOK',
      accountType: intent.payment.accountType,
      orderType: 'MARKET',
      slippageBps: intent.slippageBps,
      fundingSource: intent.payment.fundingSource,
    };
    if (intent.payment.fundingSource === 'CEX') placeBody.fundTransferAmount = intent.amountIn;

    const startedAt = new Date().toISOString();
    const placeStartedAtMs = Date.now();
    const call = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle', placeBody);
    const placeFinishedAtMs = Date.now();

    if (!call.ok) {
      const err = asError(call, 'PREDICTION_PLACE_ORDER_FAILED');
      const unknown = call.network || Number(call.status) >= 500;
      p.state = unknown ? 'SUBMISSION_UNKNOWN' : 'PLACE_ERROR';
      p.error = err.error;
      p.code = err.code;
      p.httpStatus = err.httpStatus;
      lastOrder = {
        state: p.state,
        status: p.state,
        orderId: null,
        action: p.action,
        amount: p.amount,
        round: p.round,
        error: err.error,
        code: err.code,
        startedAt,
      };
      console.log(JSON.stringify({
        event: 'api_order_failed',
        round: p.round,
        action: p.action,
        amount: p.amount,
        quoteRemainingAtSubmitMs: expireAt > 0 ? expireAt - placeStartedAtMs : null,
        submitLatencyMs: placeFinishedAtMs - placeStartedAtMs,
        ...err,
      }));
      return send(res, unknown ? 502 : 400, err);
    }

    const orderId = call.data?.orderId;
    if (!orderId) {
      p.state = 'SUBMISSION_UNKNOWN';
      return send(res, 502, { ok: false, error: 'Binance 返回成功但缺少 orderId，状态未知，请勿重复提交' });
    }

    submittedRounds.add(String(p.round));
    p.state = 'SUBMITTED_PENDING_CONFIRMATION';
    p.quoteExpireAt = quote.expireAt ?? null;
    p.quoteChance = quote.chance ?? null;
    lastOrder = {
      state: 'SUBMITTED_PENDING_CONFIRMATION',
      status: 'PLACED_UNVERIFIED',
      orderId: String(orderId),
      action: p.action,
      amount: p.amount,
      round: p.round,
      walletAddress: intent.wallet.walletAddress,
      submittedAt: new Date().toISOString(),
      fillPercentage: null,
      filledUsdtAmount: null,
      quoteExpireAt: quote.expireAt ?? null,
      quoteRemainingAtSubmitMs: expireAt > 0 ? expireAt - placeStartedAtMs : null,
      submitLatencyMs: placeFinishedAtMs - placeStartedAtMs,
    };

    console.log(JSON.stringify({
      event: 'api_order_submitted_pending_confirmation',
      orderId: String(orderId),
      round: p.round,
      action: p.action,
      amount: p.amount,
      quoteRemainingAtSubmitMs: lastOrder.quoteRemainingAtSubmitMs,
      submitLatencyMs: lastOrder.submitLatencyMs,
    }));

    setTimeout(() => refreshLastOrderStatus(true), 700);
    setTimeout(() => refreshLastOrderStatus(true), 1800);
    setTimeout(() => refreshLastOrderStatus(true), 3500);
    return send(res, 202, { ok: true, orderId: String(orderId), state: 'SUBMITTED_PENDING_CONFIRMATION' });
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}).listen(PORT, '0.0.0.0', async () => {
  console.log(JSON.stringify({
    event: 'control_panel_started',
    port: PORT,
    mode: 'API_CONFIRM_LIVE',
    quoteMode: 'FRESH_ON_CONFIRM',
    hasSiteOrigin: Boolean(SITE_ORIGIN),
    hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
    hasPredictionWallet: Boolean(ENV_WALLET_ADDRESS),
    hasWalletId: Boolean(ENV_WALLET_ID),
  }));
  lastBalance = await getPaymentBalances();
  lastBalanceAt = Date.now();
  console.log(JSON.stringify({
    event: 'prediction_balance_check',
    ok: lastBalance.ok,
    items: process.env.RENDER_MIGRATION_PREVIEW === 'true' ? [] : (lastBalance.items || []),
    itemCount: Array.isArray(lastBalance.items) ? lastBalance.items.length : 0,
    error: lastBalance.error || null,
  }));
  await auditSettledHistoryTopics(['6374907','6374910']);
});
