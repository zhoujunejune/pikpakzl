import crypto from 'node:crypto';
import fs from 'node:fs';

const API = 'https://api.binance.com';
const API_KEY = process.env.BINANCE_PREDICTION_API_KEY || '';
const API_SECRET = process.env.BINANCE_PREDICTION_API_SECRET || '';
const ENV_WALLET_ADDRESS = process.env.BINANCE_PREDICTION_WALLET_ADDRESS || '';
const ENV_WALLET_ID = process.env.BINANCE_PREDICTION_WALLET_ID || '';

const TAKE_PROFIT_ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.AUTO_TAKE_PROFIT_ENABLED || 'false').toLowerCase());
const STOP_LOSS_ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.AUTO_STOP_LOSS_ENABLED || 'false').toLowerCase());
const TAKE_PROFIT_PERCENT = Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50);
const STOP_LOSS_PERCENT = Number(process.env.AUTO_STOP_LOSS_PERCENT || 50);
const POLL_MS = Math.max(300, Number(process.env.AUTO_RISK_POLL_MS || process.env.AUTO_TAKE_PROFIT_POLL_MS || 300));
const RETRY_MS = Math.max(1000, Number(process.env.AUTO_RISK_RETRY_MS || process.env.AUTO_TAKE_PROFIT_RETRY_MS || 1000));
const SLOW_RETRY_MS = 5000; // prevent endless fast failures when exchange rejects requests
const UNKNOWN_RECONCILE_MS = 10000; // never blindly repeat an ambiguous SELL
const DEFAULT_SLIPPAGE_BPS = Number(process.env.AUTO_TAKE_PROFIT_SLIPPAGE_BPS || 1200);
const DEFAULT_FEE_RATE_BPS = Number(process.env.AUTO_TAKE_PROFIT_FEE_RATE_BPS || 200);
const SCOPE = String(process.env.AUTO_RISK_SCOPE || process.env.AUTO_TAKE_PROFIT_SCOPE || 'BTC_5M').toUpperCase();
const QUOTE_MIN_REMAINING_MS = 250;
const STATE_CLEANUP_MS = 60000;

let workerBusy = false;
let walletCache = null;
let paymentCache = null;
let paymentCacheAt = 0;
const topicCache = new Map();
const sellState = new Map();
// Read-only health output for the control panel. No trade inputs or decisions depend on it.
const WORKER_HEALTH_FILE = '/tmp/risk-worker-health.json';
const health = {
  at: null,
  pid: process.pid,
  lastTickStartedAt: null,
  lastTickFinishedAt: null,
  lastSuccessfulPositionsAt: null,
  positionsSeen: null,
  lastQuoteAt: null,
  lastQuoteAmount: null,
  quoteChecks: 0,
  quoteErrors: 0,
  lastErrorAt: null,
  lastError: null,
  lastSellEventAt: null,
  lastSellEvent: null,
};
function emitHealth() {
  health.at = new Date().toISOString();
  try {
    const filename = WORKER_HEALTH_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(filename, JSON.stringify(health), 'utf8');
    fs.renameSync(filename, WORKER_HEALTH_FILE);
  } catch (err) {
    // Health monitoring must never interrupt SELL/QUOTE processing.
    console.error(JSON.stringify({event:'risk_health_write_failed', error:String(err?.message||err)}));
  }
}
function trackHealthEvent(event, extra) {
  const at = new Date().toISOString();
  if (event === 'risk_check') {
    health.lastQuoteAt = at;
    health.lastQuoteAmount = Number.isFinite(Number(extra.currentSellAmount)) ? Number(extra.currentSellAmount) : null;
    health.quoteChecks += 1;
    health.lastError = null;
  } else if (event === 'risk_sell_quote_failed') {
    health.quoteErrors += 1;
    health.lastErrorAt = at;
    health.lastError = String(extra.error || event).slice(0,160);
  } else if (event === 'risk_wallet_error' || event === 'risk_positions_error' ||
             event === 'risk_invalid_position' || event === 'risk_tick_exception' ||
             event === 'risk_sell_exception' || event === 'risk_sell_failed' ||
             event === 'risk_sell_unknown') {
    health.lastErrorAt = at;
    health.lastError = String(extra.error || event).slice(0,160);
  }
  if (event === 'risk_sell_submitted' || event === 'risk_sell_unknown' ||
      event === 'risk_sell_failed' || event === 'risk_triggered') {
    health.lastSellEventAt = at;
    health.lastSellEvent = event;
  }
}


function log(event, extra = {}) {
  trackHealthEvent(event, extra);
  console.log(JSON.stringify({ event, worker: 'risk', at: new Date().toISOString(), ...extra }));
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
  if (!API_KEY || !API_SECRET) return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
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
  if (!API_KEY || !API_SECRET) return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
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

function weiToDecimal(value) {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^-?\d+$/.test(s)) {
    const wei = BigInt(s);
    const negative = wei < 0n;
    const abs = negative ? -wei : wei;
    const base = 10n ** 18n;
    const whole = abs / base;
    const fraction = (abs % base).toString().padStart(18, '0').replace(/0+$/, '');
    const decimal = `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
    const parsed = Number(decimal);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  const parsed = Number(s);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validPercent(n) {
  return Number.isFinite(n) && n >= 1 && n <= 100;
}

function basePosition(position) {
  const totalCost = Number(position?.totalCost);
  const shares = Number(position?.shares);
  const tokenId = String(position?.tokenId ?? '').trim();
  if (!Number.isFinite(totalCost) || totalCost < 0) return { ok: false, error: 'INVALID_TOTAL_COST' };
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: 'INVALID_SHARES' };
  if (!tokenId) return { ok: false, error: 'TOKEN_ID_MISSING' };
  return { ok: true, totalCost, shares, tokenId };
}

function calculateTargets(position) {
  const base = basePosition(position);
  if (!base.ok) return base;
  const out = { ...base, tpTarget: null, slTarget: null, toWin: null, maxProfit: null };

  if (STOP_LOSS_ENABLED) {
    if (!validPercent(STOP_LOSS_PERCENT)) return { ok: false, error: 'INVALID_STOP_LOSS_PERCENT' };
    out.slTarget = base.totalCost * (1 - STOP_LOSS_PERCENT / 100);
  }

  if (TAKE_PROFIT_ENABLED) {
    if (!validPercent(TAKE_PROFIT_PERCENT)) return { ok: false, error: 'INVALID_TAKE_PROFIT_PERCENT' };
    const toWin = Number(position?.toWin);
    if (!Number.isFinite(toWin) || toWin < 0) return { ok: false, error: 'INVALID_TO_WIN' };
    const maxProfit = toWin - base.totalCost;
    if (!Number.isFinite(maxProfit) || maxProfit <= 0) return { ok: false, error: 'NON_POSITIVE_MAX_PROFIT' };
    const rawTarget = base.totalCost + maxProfit * (TAKE_PROFIT_PERCENT / 100);
    out.toWin = toWin;
    out.maxProfit = maxProfit;
    out.tpTarget = Math.ceil(rawTarget * 100) / 100;
  }

  return out;
}

function evaluateRisk(targets, quote) {
  const currentSellAmount = weiToDecimal(quote?.amountOut);
  if (!Number.isFinite(currentSellAmount)) return { ok: false, error: 'INVALID_SELL_QUOTE_AMOUNT_OUT' };
  const tpTriggered = TAKE_PROFIT_ENABLED && Number.isFinite(targets.tpTarget) && currentSellAmount >= targets.tpTarget;
  const slTriggered = STOP_LOSS_ENABLED && Number.isFinite(targets.slTarget) && currentSellAmount <= targets.slTarget;
  const reason = slTriggered ? 'STOP_LOSS' : (tpTriggered ? 'TAKE_PROFIT' : null);
  return { ok: true, currentSellAmount, tpTriggered, slTriggered, triggered: Boolean(reason), reason };
}

function quoteTooCloseToExpiry(quote) {
  const expireAt = Number(quote?.expireAt || 0);
  return expireAt > 0 && expireAt - Date.now() < QUOTE_MIN_REMAINING_MS;
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
  if (SCOPE === 'BTC_5M') return String(topic?.symbol || '').toUpperCase() === 'BTCUSDT' && durationLooks5m(topic);
  return false;
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
  if (quoteTooCloseToExpiry(quote)) return { ok: false, error: 'SELL_QUOTE_TOO_CLOSE_TO_EXPIRY' };
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
  if (!call.ok) {
    const err = asError(call, 'SELL_PLACE_ORDER_FAILED');
    const statusUnknown = Boolean(call?.network) || Number(call?.status || 0) >= 500;
    return { ...err, statusUnknown };
  }
  if (!call.data?.orderId) return { ok: false, error: 'SELL_ORDER_ID_MISSING', statusUnknown: true };
  return { ok: true, orderId: String(call.data.orderId), raw: call.data };
}

function stateBlocksSell(state) {
  return Boolean(state?.inFlight || state?.submitted || state?.statusUnknown);
}

function nextRetryDelay(failures) {
  return failures <= 3 ? RETRY_MS : Math.max(SLOW_RETRY_MS, RETRY_MS);
}
function scheduleKnownFailure(tokenId, previous, error, stage) {
  const failures = Math.max(0, Number(previous?.failures) || 0) + 1;
  const retryMs = nextRetryDelay(failures);
  const next = {
    ...(previous || {}),
    inFlight: false,
    submitted: false,
    statusUnknown: false,
    failures,
    lastAttemptAt: Date.now(),
    retryAfterAt: Date.now() + retryMs,
    error: String(error || 'RETRYABLE_SELL_FAILURE').slice(0,160),
  };
  log('risk_retry_scheduled', { tokenId, stage, failures, retryMs });
  return next;
}
function parseOrderTimestamp(row) {
  for (const key of ['createTime','createdAt','createdTime','orderTime','timestamp']) {
    const raw = row?.[key];
    const v = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw || '')) ? Number(raw) : Date.parse(String(raw || ''));
    if (!Number.isFinite(v)) continue;
    const ms = v < 100000000000 ? v * 1000 : v;
    if (ms > 1000000000000) return ms;
  }
  return null;
}
// A network timeout or HTTP 5xx is NOT an unfilled order. Search exchange
// history/active orders; only a precisely matched, recent SELL is confirmable.
// A missing entry is NOT proof of failure or permission to submit another SELL.
async function reconcileUnknownSell(wallet, position, state) {
  const now = Date.now();
  if (now - (state.lastReconciledAt || 0) < UNKNOWN_RECONCILE_MS) return;
  state.lastReconciledAt = now;
  const params = { walletAddress: wallet.walletAddress, offset: 0, limit: 100 };
  const [history, active] = await Promise.all([
    signedGet('/sapi/v1/w3w/wallet/prediction/order/history', params),
    signedGet('/sapi/v1/w3w/wallet/prediction/order/list', params),
  ]);
  const rows = [history, active].flatMap(r => r.ok && Array.isArray(r.data?.orders) ? r.data.orders : []);
  const tokenId = String(position.tokenId || '');
  const since = state.sellRequestAt || state.submittedAt || state.lastAttemptAt;
  const match = rows.find(o => {
    const token = String(o?.tokenId ?? o?.token?.tokenId ?? o?.marketTokenId ?? '');
    const side = String(o?.side ?? o?.tradeSide ?? '').toUpperCase();
    const t = parseOrderTimestamp(o);
    return token === tokenId && side === 'SELL' && t != null && t >= since - 2000 && t <= now + 2000;
  });
  if (match) {
    sellState.set(tokenId, {
      ...state, statusUnknown: false, submitted: true,
      orderId: String(match.orderId ?? '') || null, error: null,
      resolvedAt: now,
    });
    log('risk_unknown_order_found', { tokenId, hadOrderId: Boolean(match.orderId) });
  } else {
    log('risk_unknown_reconcile_pending', {
      tokenId, historyOk: Boolean(history.ok), activeOk: Boolean(active.ok),
      retrySellBlocked: true,
    });
  }
}

async function sellPosition(wallet, payment, position, topic, targets, initialQuoteResult, initialEvaluation) {
  const tokenId = targets.tokenId;
  const previous = sellState.get(tokenId);
  if (stateBlocksSell(previous)) return;
  if (previous?.retryAfterAt && Date.now() < previous.retryAfterAt) return;

  sellState.set(tokenId, { ...(previous || {}), inFlight: true, lastAttemptAt: Date.now(), error: null });
  try {
    let quoteResult = initialQuoteResult;
    let evaluation = initialEvaluation;

    if (quoteTooCloseToExpiry(quoteResult.quote)) {
      quoteResult = await getSellQuote(wallet, position, topic);
      if (!quoteResult.ok) {
        sellState.set(tokenId, scheduleKnownFailure(tokenId, previous, quoteResult.error, 'EXPIRED_QUOTE_REFRESH'));
        log('risk_sell_quote_failed', { tokenId, error: quoteResult.error, code: quoteResult.code ?? null, httpStatus: quoteResult.httpStatus ?? null, network: Boolean(quoteResult.network) });
        return;
      }
      evaluation = evaluateRisk(targets, quoteResult.quote);
      if (!evaluation.ok) {
        sellState.set(tokenId, scheduleKnownFailure(tokenId, previous, evaluation.error, 'QUOTE_EVALUATION'));
        log('risk_sell_quote_failed', { tokenId, error: evaluation.error });
        return;
      }
      if (!evaluation.triggered) {
        sellState.set(tokenId, { inFlight: false, lastAttemptAt: 0, error: null });
        log('risk_check', {
          tokenId,
          totalCost: targets.totalCost,
          currentSellAmount: evaluation.currentSellAmount,
          tpTarget: targets.tpTarget,
          slTarget: targets.slTarget,
          tpTriggered: evaluation.tpTriggered,
          slTriggered: evaluation.slTriggered,
          refreshedQuote: true,
        });
        return;
      }
    }

    const sellRequestAt = Date.now();
    const placed = await placeSell(wallet, payment, quoteResult);
    if (!placed.ok) {
      if (placed.statusUnknown) {
        sellState.set(tokenId, {
          inFlight: false,
          submitted: false,
          statusUnknown: true,
          submittedAt: Date.now(),
          sellRequestAt,
          lastAttemptAt: Date.now(),
          lastReconciledAt: 0,
          orderId: null,
          error: placed.error,
        });
        log('risk_sell_unknown', {
          tokenId,
          reason: evaluation.reason,
          error: placed.error,
          code: placed.code ?? null,
          httpStatus: placed.httpStatus ?? null,
          network: Boolean(placed.network),
        });
        return;
      }
      sellState.set(tokenId, scheduleKnownFailure(tokenId, previous, placed.error, 'SELL_POST_KNOWN_FAILURE'));
      log('risk_sell_failed', {
        tokenId,
        reason: evaluation.reason,
        error: placed.error,
        code: placed.code ?? null,
        httpStatus: placed.httpStatus ?? null,
        network: Boolean(placed.network),
      });
      return;
    }

    sellState.set(tokenId, {
      inFlight: false,
      submitted: true,
      statusUnknown: false,
      failures: 0,
      retryAfterAt: 0,
      submittedAt: Date.now(),
      lastAttemptAt: Date.now(),
      orderId: placed.orderId,
      error: null,
    });
    const targetAmount = evaluation.reason === 'STOP_LOSS' ? targets.slTarget : targets.tpTarget;
    log('risk_sell_submitted', {
      tokenId,
      orderId: placed.orderId,
      reason: evaluation.reason,
      shares: position.shares,
      totalCost: targets.totalCost,
      currentSellAmount: evaluation.currentSellAmount,
      targetAmount,
      quoteAveragePrice: quoteResult.quote?.averagePrice ?? null,
      quoteAmountOut: quoteResult.quote?.amountOut ?? null,
    });
  } catch (e) {
    // Unknown outcome may already have sold on Binance: never blindly resend.
    sellState.set(tokenId, { inFlight: false, submitted: false, statusUnknown: true,
      sellRequestAt: Date.now(), lastAttemptAt: Date.now(), lastReconciledAt: 0,
      error: String(e?.message || e).slice(0,160) });
    log('risk_sell_exception', { tokenId, error: e?.message || String(e) });
  }
}

function cleanupSellState(activeTokenIds) {
  const now = Date.now();
  for (const [tokenId, state] of sellState.entries()) {
    if (activeTokenIds.has(tokenId)) continue;
    const age = now - Number(state.submittedAt || state.lastAttemptAt || 0);
    if (age > STATE_CLEANUP_MS) sellState.delete(tokenId);
  }
}

async function tick() {
  if ((!TAKE_PROFIT_ENABLED && !STOP_LOSS_ENABLED) || workerBusy) return;
  if (!API_KEY || !API_SECRET) return;
  workerBusy = true;
  health.lastTickStartedAt = new Date().toISOString();
  try {
    const wallet = await resolveWallet();
    if (!wallet.ok) {
      log('risk_wallet_error', { error: wallet.error, code: wallet.code ?? null });
      return;
    }
    const positionsResult = await queryOngoingPositions(wallet.walletAddress);
    if (!positionsResult.ok) {
      log('risk_positions_error', { error: positionsResult.error, code: positionsResult.code ?? null });
      return;
    }
    health.lastSuccessfulPositionsAt = new Date().toISOString();
    health.positionsSeen = Array.isArray(positionsResult.positions) ? positionsResult.positions.length : null;
    // Warm the existing payment lookup while unchanged position/quote checks run.
    // No extra API request, cached route and SELL parameters remain identical.
    const paymentReady = getPaymentRoute();
    const activeTokens = new Set();

    for (const position of positionsResult.positions) {
      const tokenId = String(position?.tokenId || '').trim();
      if (tokenId) activeTokens.add(tokenId);
      if (String(position?.positionStatus || '').toUpperCase() !== 'OPEN') continue;
      if (!(await inScope(position))) continue;

      const targets = calculateTargets(position);
      if (!targets.ok) {
        log('risk_invalid_position', {
          tokenId: tokenId || null,
          marketTopicId: position?.marketTopicId ?? null,
          error: targets.error,
          hasTotalCost: position?.totalCost !== undefined && position?.totalCost !== null && position?.totalCost !== '',
          hasToWin: position?.toWin !== undefined && position?.toWin !== null && position?.toWin !== '',
          hasShares: position?.shares !== undefined && position?.shares !== null && position?.shares !== '',
          hasTokenId: Boolean(tokenId),
        });
        continue;
      }

      const state = sellState.get(tokenId);
      if (state?.statusUnknown) {
        try { await reconcileUnknownSell(wallet, position, state); }
        catch (e) { log('risk_unknown_reconcile_error', {
          tokenId, error: String(e?.message || e).slice(0,100), retrySellBlocked: true
        }); }
        continue;
      }
      if (stateBlocksSell(state)) continue;
      if (state?.retryAfterAt && Date.now() < state.retryAfterAt) continue;

      const topic = await getTopic(position.marketTopicId);
      if (!topic) {
        sellState.set(tokenId, scheduleKnownFailure(tokenId, state, 'MARKET_DETAIL_UNAVAILABLE', 'MARKET_DETAIL'));
        log('risk_sell_quote_failed', { tokenId, marketTopicId: position.marketTopicId, error: 'MARKET_DETAIL_UNAVAILABLE' });
        continue;
      }

      const quoteResult = await getSellQuote(wallet, position, topic);
      if (!quoteResult.ok) {
        sellState.set(tokenId, scheduleKnownFailure(tokenId, state, quoteResult.error, 'QUOTE_REQUEST'));
        log('risk_sell_quote_failed', {
          tokenId,
          marketTopicId: position.marketTopicId,
          error: quoteResult.error,
          code: quoteResult.code ?? null,
          httpStatus: quoteResult.httpStatus ?? null,
          network: Boolean(quoteResult.network),
        });
        continue;
      }

      const evaluation = evaluateRisk(targets, quoteResult.quote);
      if (!evaluation.ok) {
        sellState.set(tokenId, scheduleKnownFailure(tokenId, state, evaluation.error, 'QUOTE_EVALUATION'));
        log('risk_sell_quote_failed', { tokenId, marketTopicId: position.marketTopicId, error: evaluation.error });
        continue;
      }

      // Keep retry count through a fresh quote; only a confirmed SELL clears it.
      if (state?.error) sellState.set(tokenId, { ...state, error: null });

      log('risk_check', {
        tokenId,
        totalCost: targets.totalCost,
        currentSellAmount: evaluation.currentSellAmount,
        tpTarget: targets.tpTarget,
        slTarget: targets.slTarget,
        tpTriggered: evaluation.tpTriggered,
        slTriggered: evaluation.slTriggered,
      });

      if (!evaluation.triggered) continue;
      const targetAmount = evaluation.reason === 'STOP_LOSS' ? targets.slTarget : targets.tpTarget;
      log('risk_triggered', { tokenId, reason: evaluation.reason, currentSellAmount: evaluation.currentSellAmount, targetAmount });
      // Payment routing is needed only at the original SELL submission point.
      const payment = await paymentReady;
      await sellPosition(wallet, payment, position, topic, targets, quoteResult, evaluation);
    }

    // Preserve the original one-payment-lookup-per-tick error/refresh behavior.
    await paymentReady;
    cleanupSellState(activeTokens);
  } catch (e) {
    log('risk_tick_exception', { error: e?.message || String(e) });
  } finally {
    health.lastTickFinishedAt = new Date().toISOString();
    workerBusy = false;
  }
}

log('risk_worker_started', {
  takeProfitEnabled: TAKE_PROFIT_ENABLED,
  takeProfitPercent: TAKE_PROFIT_PERCENT,
  stopLossEnabled: STOP_LOSS_ENABLED,
  stopLossPercent: STOP_LOSS_PERCENT,
  pollMs: POLL_MS,
  retryMs: RETRY_MS,
  retrySlowAfterFailures: 3,
  unknownSellPolicy: 'VERIFY_EXCHANGE_HISTORY_OR_BLOCK',
  scope: SCOPE,
  hasCredentials: Boolean(API_KEY && API_SECRET),
  hasWalletAddress: Boolean(ENV_WALLET_ADDRESS),
  hasWalletId: Boolean(ENV_WALLET_ID),
});

const healthTimer = setInterval(emitHealth, 2000);
healthTimer.unref();
emitHealth();
setInterval(tick, POLL_MS);
void tick();
