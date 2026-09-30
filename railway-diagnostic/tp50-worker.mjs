import crypto from 'node:crypto';

const API = 'https://api.binance.com';
const API_KEY = process.env.BINANCE_PREDICTION_API_KEY || '';
const API_SECRET = process.env.BINANCE_PREDICTION_API_SECRET || '';
const ENV_WALLET_ADDRESS = process.env.BINANCE_PREDICTION_WALLET_ADDRESS || '';
const ENV_WALLET_ID = process.env.BINANCE_PREDICTION_WALLET_ID || '';

const ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.AUTO_TAKE_PROFIT_ENABLED || 'true').toLowerCase());
const TAKE_PROFIT_PERCENT = Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50);
const POLL_MS = Math.max(300, Number(process.env.AUTO_TAKE_PROFIT_POLL_MS || 500));
const RETRY_MS = Math.max(1000, Number(process.env.AUTO_TAKE_PROFIT_RETRY_MS || 2500));
const DEFAULT_SLIPPAGE_BPS = Number(process.env.AUTO_TAKE_PROFIT_SLIPPAGE_BPS || 1200);
const DEFAULT_FEE_RATE_BPS = Number(process.env.AUTO_TAKE_PROFIT_FEE_RATE_BPS || 200);
const SCOPE = String(process.env.AUTO_TAKE_PROFIT_SCOPE || 'BTC_5M').toUpperCase();

let workerBusy = false;
let walletCache = null;
let paymentCache = null;
let paymentCacheAt = 0;
const topicCache = new Map();
const sellState = new Map();

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, worker: 'tp50', at: new Date().toISOString(), ...extra }));
}

function sign(payload) {
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
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
  if (!API_KEY || !API_SECRET) {
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
      headers: { 'X-MBX-APIKEY': API_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
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
  if (!API_KEY || !API_SECRET) {
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
        'X-MBX-APIKEY': API_KEY,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
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

function decimalToWei(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('INVALID_DECIMAL_AMOUNT');
  let [a, b = ''] = s.split('.');
  b = (b + '0'.repeat(18)).slice(0, 18);
  return (BigInt(a) * 10n ** 18n + BigInt(b)).toString();
}

async function resolveWallet() {
  if (walletCache?.walletAddress && walletCache?.walletId) return walletCache;
  if (ENV_WALLET_ADDRESS && ENV_WALLET_ID) {
    walletCache = { ok: true, walletAddress: ENV_WALLET_ADDRESS, walletId: ENV_WALLET_ID };
    return walletCache;
  }
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/wallet/list');
  if (!call.ok) return asError(call, 'PREDICTION_WALLET_LOOKUP_FAILED');
  const wallets = Array.isArray(call.data?.wallets) ? call.data.wallets : [];
  const match = wallets.find(w => !ENV_WALLET_ADDRESS || String(w.walletAddress).toLowerCase() === ENV_WALLET_ADDRESS.toLowerCase()) || wallets[0];
  if (!match?.walletAddress || !match?.walletId) return { ok: false, error: 'NO_REGISTERED_PREDICTION_WALLET' };
  walletCache = { ok: true, walletAddress: match.walletAddress, walletId: match.walletId };
  return walletCache;
}

function paymentRoute(items) {
  const enabled = Array.isArray(items) ? items.filter(x => x?.enabled) : [];
  const positive = enabled.filter(x => Number(x?.availableBalanceDisplay) > 0);
  const cedefi = positive.find(x => String(x?.accountType).toUpperCase() === 'CEDEFI');
  const spot = positive.find(x => String(x?.accountType).toUpperCase() === 'SPOT');
  const funding = positive.find(x => String(x?.accountType).toUpperCase() === 'FUNDING');
  if (cedefi) return { accountType: 'SPOT', displayAccount: 'CeDeFi' };
  if (spot) return { accountType: 'SPOT', displayAccount: 'SPOT' };
  if (funding) return { accountType: 'FUNDING', displayAccount: 'FUNDING' };
  return { accountType: 'SPOT', displayAccount: 'SPOT' };
}

async function getPaymentRoute() {
  if (paymentCache && Date.now() - paymentCacheAt < 30000) return paymentCache;
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/balance/payment-options');
  if (call.ok) {
    paymentCache = paymentRoute(call.data?.items);
    paymentCacheAt = Date.now();
  } else if (!paymentCache) {
    paymentCache = { accountType: 'SPOT', displayAccount: 'SPOT' };
  }
  return paymentCache;
}

async function getTopic(marketTopicId) {
  const key = String(marketTopicId || '');
  if (!key) return null;
  const cached = topicCache.get(key);
  if (cached && Date.now() - cached.at < 120000) return cached.topic;
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId: key });
  if (!call.ok) return null;
  topicCache.set(key, { at: Date.now(), topic: call.data });
  return call.data;
}

function durationLooks5m(topic) {
  const start = Number(topic?.startDate);
  const end = Number(topic?.endDate);
  const duration = end - start;
  return Number.isFinite(duration) && duration >= 240000 && duration <= 360000;
}

async function inScope(position) {
  if (SCOPE === 'ALL') return true;
  const topic = await getTopic(position?.marketTopicId);
  if (!topic) return false;
  if (SCOPE === 'BTC_5M') {
    return String(topic?.symbol || '').toUpperCase() === 'BTCUSDT' && durationLooks5m(topic);
  }
  return false;
}

function positionPercent(position) {
  const direct = Number(position?.unrealizedPnlPercent);
  if (Number.isFinite(direct)) return direct;
  const avg = Number(position?.avgPrice);
  const current = Number(position?.currentPrice);
  if (avg > 0 && Number.isFinite(current)) return ((current - avg) / avg) * 100;
  return NaN;
}

async function queryOngoingPositions(walletAddress) {
  const call = await signedGet('/sapi/v1/w3w/wallet/prediction/position/list', {
    walletAddress,
    tab: 'ONGOING',
    offset: 0,
    limit: 100,
  });
  if (!call.ok) return { ...asError(call, 'QUERY_POSITIONS_FAILED'), positions: [] };
  return { ok: true, positions: Array.isArray(call.data?.positions) ? call.data.positions : [] };
}

async function getSellQuote(wallet, position, topic) {
  const shares = String(position?.shares ?? '').trim();
  if (!shares || Number(shares) <= 0) return { ok: false, error: 'NO_SHARES_TO_SELL' };
  const amountIn = decimalToWei(shares);
  const slippageBps = Number(topic?.slippageBps || DEFAULT_SLIPPAGE_BPS);
  const feeRateBps = Number(topic?.feeRateBps || DEFAULT_FEE_RATE_BPS);
  const body = {
    walletAddress: wallet.walletAddress,
    tokenId: position.tokenId,
    side: 'SELL',
    amountIn,
    orderType: 'MARKET',
    slippageBps,
    chainId: position?.chainId || topic?.chainId || '56',
    feeRateBps,
    fundingSource: 'MPC',
  };
  const call = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote', body);
  if (!call.ok) return asError(call, 'SELL_GET_QUOTE_FAILED');
  if (!call.data?.quoteId) return { ok: false, error: 'SELL_QUOTE_ID_MISSING' };
  return { ok: true, quote: call.data, slippageBps };
}

async function placeSell(wallet, payment, sellQuote) {
  const quote = sellQuote.quote;
  const expireAt = Number(quote?.expireAt || 0);
  if (expireAt > 0 && expireAt - Date.now() < 250) {
    return { ok: false, error: 'SELL_QUOTE_TOO_CLOSE_TO_EXPIRY' };
  }
  const body = {
    walletAddress: wallet.walletAddress,
    walletId: wallet.walletId,
    quoteId: quote.quoteId,
    timeInForce: 'FOK',
    accountType: payment.accountType || 'SPOT',
    orderType: 'MARKET',
    slippageBps: sellQuote.slippageBps,
    fundingSource: 'MPC',
  };
  const call = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle', body);
  if (!call.ok) return asError(call, 'SELL_PLACE_ORDER_FAILED');
  if (!call.data?.orderId) return { ok: false, error: 'SELL_ORDER_ID_MISSING' };
  return { ok: true, orderId: String(call.data.orderId), raw: call.data };
}

async function sellPosition(wallet, payment, position, pnlPercent) {
  const tokenId = String(position?.tokenId || '');
  if (!tokenId) return;
  const state = sellState.get(tokenId);
  if (state?.inFlight) return;
  if (state?.submitted && Date.now() - Number(state.submittedAt || 0) < 300000) return;
  if (state?.lastAttemptAt && Date.now() - state.lastAttemptAt < RETRY_MS) return;

  sellState.set(tokenId, { ...(state || {}), inFlight: true, lastAttemptAt: Date.now() });
  try {
    const topic = await getTopic(position.marketTopicId);
    if (!topic) {
      sellState.set(tokenId, { inFlight: false, lastAttemptAt: Date.now(), error: 'MARKET_DETAIL_UNAVAILABLE' });
      return;
    }

    const quoteResult = await getSellQuote(wallet, position, topic);
    if (!quoteResult.ok) {
      sellState.set(tokenId, { inFlight: false, lastAttemptAt: Date.now(), error: quoteResult.error });
      log('tp50_sell_quote_failed', {
        tokenId,
        marketTopicId: position.marketTopicId,
        pnlPercent,
        error: quoteResult.error,
        code: quoteResult.code ?? null,
      });
      return;
    }

    const placed = await placeSell(wallet, payment, quoteResult);
    if (!placed.ok) {
      sellState.set(tokenId, { inFlight: false, lastAttemptAt: Date.now(), error: placed.error });
      log('tp50_sell_failed', {
        tokenId,
        marketTopicId: position.marketTopicId,
        pnlPercent,
        shares: position.shares,
        avgPrice: position.avgPrice,
        currentPrice: position.currentPrice,
        error: placed.error,
        code: placed.code ?? null,
        network: Boolean(placed.network),
      });
      return;
    }

    sellState.set(tokenId, {
      inFlight: false,
      submitted: true,
      submittedAt: Date.now(),
      orderId: placed.orderId,
    });
    log('tp50_sell_submitted', {
      tokenId,
      orderId: placed.orderId,
      marketTopicId: position.marketTopicId,
      marketTitle: position.marketTitle ?? null,
      outcomeName: position.outcomeName ?? null,
      pnlPercent,
      thresholdPercent: TAKE_PROFIT_PERCENT,
      shares: position.shares,
      avgPrice: position.avgPrice,
      currentPrice: position.currentPrice,
      quoteAveragePrice: quoteResult.quote?.averagePrice ?? null,
      quoteAmountOut: quoteResult.quote?.amountOut ?? null,
    });
  } catch (e) {
    sellState.set(tokenId, { inFlight: false, lastAttemptAt: Date.now(), error: e?.message || String(e) });
    log('tp50_sell_exception', { tokenId, error: e?.message || String(e) });
  }
}

function cleanupSellState(activeTokenIds) {
  const now = Date.now();
  for (const [tokenId, state] of sellState.entries()) {
    if (activeTokenIds.has(tokenId)) continue;
    const age = now - Number(state.submittedAt || state.lastAttemptAt || 0);
    if (age > 60000) sellState.delete(tokenId);
  }
}

async function tick() {
  if (!ENABLED || workerBusy) return;
  if (!API_KEY || !API_SECRET) return;
  workerBusy = true;
  try {
    const wallet = await resolveWallet();
    if (!wallet.ok) {
      log('tp50_wallet_error', { error: wallet.error, code: wallet.code ?? null });
      return;
    }
    const positionsResult = await queryOngoingPositions(wallet.walletAddress);
    if (!positionsResult.ok) {
      log('tp50_positions_error', { error: positionsResult.error, code: positionsResult.code ?? null });
      return;
    }
    const payment = await getPaymentRoute();
    const activeTokens = new Set();

    for (const position of positionsResult.positions) {
      const tokenId = String(position?.tokenId || '');
      if (!tokenId) continue;
      activeTokens.add(tokenId);
      if (String(position?.positionStatus || '').toUpperCase() !== 'OPEN') continue;
      if (Number(position?.shares || 0) <= 0) continue;
      const pnlPercent = positionPercent(position);
      if (!Number.isFinite(pnlPercent) || pnlPercent < TAKE_PROFIT_PERCENT) continue;
      if (!(await inScope(position))) continue;
      await sellPosition(wallet, payment, position, pnlPercent);
    }

    cleanupSellState(activeTokens);
  } catch (e) {
    log('tp50_tick_exception', { error: e?.message || String(e) });
  } finally {
    workerBusy = false;
  }
}

log('tp50_worker_started', {
  enabled: ENABLED,
  thresholdPercent: TAKE_PROFIT_PERCENT,
  pollMs: POLL_MS,
  scope: SCOPE,
  hasCredentials: Boolean(API_KEY && API_SECRET),
  hasWalletAddress: Boolean(ENV_WALLET_ADDRESS),
  hasWalletId: Boolean(ENV_WALLET_ID),
});

setInterval(tick, POLL_MS);
void tick();
