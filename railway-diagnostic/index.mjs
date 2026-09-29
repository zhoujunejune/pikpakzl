import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';
const BINANCE_API_KEY = process.env.BINANCE_PREDICTION_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_PREDICTION_API_SECRET || '';
const ENV_WALLET_ADDRESS = process.env.BINANCE_PREDICTION_WALLET_ADDRESS || '';
const ENV_WALLET_ID = process.env.BINANCE_PREDICTION_WALLET_ID || '';
const API = 'https://api.binance.com';

let enabled = false;
let tradeAmountText = null;
let startAfterRound = null;
let pendingAction = null;
let lastBalance = null;
let lastOrder = null;
let prepareInFlight = false;
let lastPrepareAttemptAt = 0;
const submittedRounds = new Set();

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

async function getSignal() {
  if (!SITE_ORIGIN) return null;
  try {
    const r = await fetch(`${SITE_ORIGIN}/api/local-predictions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const json = await r.json();
    const source = json?.live || null;
    if (!source) return null;
    return {
      round: source.round ?? source.input?.round ?? null,
      status: source.status ?? (source.signal ? 'LOCKED' : 'WAIT'),
      direction: source.signal?.direction ?? null,
      score: source.signal?.score ?? null,
    };
  } catch {
    return null;
  }
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
  const wallet = await resolveWallet();
  if (!wallet.ok) return wallet;

  const marketResult = await discoverTopic(signal.round);
  if (!marketResult.ok) return marketResult;

  const token = chooseToken(marketResult.topic, signal.direction);
  if (!token.ok) return token;

  const amountIn = amountToWei(tradeAmountText);
  const balance = lastBalance?.ok ? lastBalance : await getPaymentBalances();
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

async function prepareWorker() {
  if (!enabled || !tradeAmountText || prepareInFlight) return;
  const signal = await getSignal();
  if (!signal || signal.status !== 'LOCKED' || !signal.round || !['UP', 'DOWN'].includes(signal.direction)) return;
  if (startAfterRound != null && String(signal.round) === String(startAfterRound)) return;
  if (submittedRounds.has(String(signal.round))) return;
  if (pendingAction?.state === 'READY' && String(pendingAction.round) === String(signal.round)) return;
  if (pendingAction?.state === 'QUOTING' || pendingAction?.state === 'SUBMITTING') return;
  if (Date.now() - lastPrepareAttemptAt < 2500) return;

  prepareInFlight = true;
  lastPrepareAttemptAt = Date.now();
  try {
    const intent = await prepareIntent(signal);
    if (!intent.ok) {
      pendingAction = {
        state: 'PREPARE_ERROR',
        round: signal.round,
        signal: signal.direction,
        score: signal.score,
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
      signal: signal.direction,
      score: signal.score,
      action: signal.direction === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
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

function terminalFailureStatus(status) {
  const s = norm(status);
  return ['FAILED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(s);
}

function terminalSuccessStatus(status) {
  const s = norm(status);
  return ['FILLED', 'SUCCESS', 'COMPLETED', 'COMPLETE'].includes(s);
}

async function refreshLastOrderStatus(force = false) {
  if (!lastOrder?.orderId || !lastOrder?.walletAddress) return;
  if (!force && Date.now() - Number(lastOrder.lastCheckedAt || 0) < 2500) return;
  lastOrder.lastCheckedAt = Date.now();
  const found = await lookupOrder(lastOrder.orderId, lastOrder.walletAddress);
  if (!found.ok) return;

  const before = lastOrder.status;
  lastOrder.status = found.order.status ?? lastOrder.status;
  lastOrder.fillPercentage = found.order.fillPercentage ?? lastOrder.fillPercentage;
  lastOrder.filledUsdtAmount = found.order.filledUsdtAmount ?? lastOrder.filledUsdtAmount;
  lastOrder.price = found.order.price ?? lastOrder.price;
  lastOrder.checkedAt = new Date().toISOString();
  const filled = terminalSuccessStatus(lastOrder.status) || Number(lastOrder.fillPercentage || 0) >= 1 || Number(lastOrder.filledUsdtAmount || 0) > 0;
  const failed = terminalFailureStatus(lastOrder.status);
  lastOrder.state = filled ? 'CONFIRMED_FILLED' : failed ? 'CONFIRMED_FAILED' : 'SUBMITTED_PENDING_CONFIRMATION';

  if (before !== lastOrder.status || filled || failed) {
    console.log(JSON.stringify({
      event: 'order_status_updated',
      orderId: lastOrder.orderId,
      status: lastOrder.status,
      state: lastOrder.state,
      fillPercentage: lastOrder.fillPercentage,
      filledUsdtAmount: lastOrder.filledUsdtAmount,
    }));
  }
}

setInterval(prepareWorker, 1200);
setInterval(() => refreshLastOrderStatus(false), 2500);

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5分钟 API 实盘确认控制台</title><style>
body{font-family:system-ui,-apple-system;background:#0f1117;color:#fff;margin:0;padding:18px}.w{max-width:580px;margin:auto}.c{background:#191d27;border-radius:18px;padding:18px;margin:14px 0}.big{font-size:25px;font-weight:800}.on{color:#3ddc84}.off,.bad{color:#ff6868}.ok{color:#3ddc84}.warn{color:#f0b90b}.muted{color:#a8b0bd;font-size:14px;line-height:1.55}input,button{width:100%;box-sizing:border-box;padding:15px;border-radius:12px;margin-top:10px;font-size:17px}input{background:#0d1016;color:#fff;border:1px solid #3b4352}button{border:0;font-weight:800}.start{background:#28c76f;color:#06150b}.stop{background:#ff5c62;color:#fff}.confirm{background:#f0b90b;color:#161616;font-size:19px}.confirm:disabled{opacity:.45}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kv{background:#10141c;padding:12px;border-radius:12px}.k{font-size:12px;color:#8f98a8}.v{font-size:17px;font-weight:700;margin-top:4px}.wallet{font-size:30px;font-weight:900;margin-top:6px}.pending{border:1px solid #454d5f}.hidden{display:none}</style></head><body><div class="w">
<h2>5分钟 API 实盘确认控制台</h2>
<div class="c"><div id="switch" class="big">加载中...</div><div class="muted">流程：新一轮 LOCKED → 后端先准备市场/方向（不提前拿 Quote）→ 你点一次“确认下单” → 后端即时获取最新 Quote → 立刻调用 Binance Prediction 下单 API → 再核验真实订单状态。</div></div>
<div class="c"><div class="k">Prediction 可用余额</div><div class="wallet" id="walletBalance">读取中...</div><div class="muted" id="walletMeta">正在连接 Binance Prediction...</div></div>
<div class="c"><div class="grid"><div class="kv"><div class="k">当前轮次</div><div class="v" id="round">-</div></div><div class="kv"><div class="k">状态</div><div class="v" id="status">-</div></div><div class="kv"><div class="k">方向</div><div class="v" id="direction">-</div></div><div class="kv"><div class="k">Score</div><div class="v" id="score">-</div></div><div class="kv"><div class="k">每轮金额</div><div class="v" id="amountView">-</div></div><div class="kv"><div class="k">模式</div><div class="v">API_CONFIRM_LIVE</div></div></div></div>
<div class="c pending"><div class="k">API 已准备的实盘订单</div><div class="big" id="pendingTitle">暂无</div><div class="muted" id="pendingMeta">开启后等待下一轮 LOCKED 信号。</div><button id="confirmBtn" class="confirm hidden" onclick="confirmOrder()">确认下单</button></div>
<div class="c"><div class="k">最近一笔 API 下单结果</div><div class="big" id="orderTitle">暂无</div><div class="muted" id="orderMeta">-</div></div>
<div class="c"><input id="amount" type="number" inputmode="decimal" min="1.5" step="0.01" placeholder="每轮金额，例如 2"><input id="pin" inputmode="numeric" placeholder="控制 PIN"><button class="start" onclick="setV(true)">开始跟随新信号</button><button class="stop" onclick="setV(false)">停止跟随</button><div class="muted">确认按钮出现时只代表方向/市场已经准备好，尚未拿 Quote。点击确认后才会即时获取 Quote 并马上提交；若报价剩余有效期不足，系统会拒绝提交，避免使用过期 Quote。</div></div>
</div><script>
let currentPending=null;
function el(id){return document.getElementById(id)}
async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});const j=await r.json();el('switch').innerHTML=j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>';const s=j.signal||{};el('round').textContent=s.round??'-';el('status').textContent=s.status??'-';el('direction').textContent=s.direction??'-';el('score').textContent=s.score==null?'-':Number(s.score).toFixed(2);el('amountView').textContent=j.amount??'-';if(document.activeElement!==el('amount')&&j.amount!=null)el('amount').value=j.amount;const b=j.balance||{};const first=(b.items||[]).find(x=>x.enabled&&Number(x.availableBalanceDisplay)>0)||(b.items||[]).find(x=>x.enabled)||(b.items||[])[0];if(b.ok&&first){el('walletBalance').innerHTML='<span class="ok">'+first.availableBalanceDisplay+' USDT</span>';el('walletMeta').textContent='账户：'+first.accountType+' · Binance Prediction 实时可用余额'}else{el('walletBalance').innerHTML='<span class="bad">读取失败</span>';el('walletMeta').textContent=(b.error||'未返回余额')+(b.code!=null?' ('+b.code+')':'')}
currentPending=j.pendingAction||null;const btn=el('confirmBtn');if(!currentPending){el('pendingTitle').textContent='暂无';el('pendingMeta').textContent=j.enabled?'正在等待下一轮 LOCKED，并准备市场/方向...':'开启后等待下一轮 LOCKED 信号。';btn.classList.add('hidden')}else if(currentPending.state==='READY'){el('pendingTitle').textContent=(currentPending.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+currentPending.amount+' USDT';el('pendingMeta').textContent='市场 '+(currentPending.marketTitle||'-')+' / '+(currentPending.outcome||'-')+' · 支付 '+(currentPending.paymentAccount||'-')+' · Quote：点击确认后即时获取';btn.textContent='确认 '+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT（即时Quote后API下单）';btn.disabled=false;btn.classList.remove('hidden')}else if(currentPending.state==='PREPARE_ERROR'){el('pendingTitle').textContent='准备失败';el('pendingMeta').textContent=(currentPending.error||currentPending.state)+(currentPending.code!=null?' ('+currentPending.code+')':'');btn.classList.add('hidden')}else{el('pendingTitle').textContent=currentPending.state==='QUOTING'?'正在获取最新 Quote...':'正在提交...';el('pendingMeta').textContent='请稍候，不要重复点击。';btn.classList.add('hidden')}
const o=j.lastOrder;if(o){const filled=o.state==='CONFIRMED_FILLED'||Number(o.fillPercentage||0)>=1||Number(o.filledUsdtAmount||0)>0;const failed=o.state==='CONFIRMED_FAILED';if(filled){el('orderTitle').innerHTML='<span class="ok">已成交</span>'}else if(failed){el('orderTitle').innerHTML='<span class="bad">下单失败</span>'}else{el('orderTitle').innerHTML='<span class="warn">已提交，核验中</span>'}el('orderMeta').textContent='orderId '+(o.orderId||'-')+' · '+(o.action||'-')+' · '+(o.amount||'-')+' USDT · 状态 '+(o.status||o.state||'-')+(o.filledUsdtAmount?' · 已成交 '+o.filledUsdtAmount+' USDT':'')+(o.error?' · '+o.error:'')}else{el('orderTitle').textContent='暂无';el('orderMeta').textContent='-' }}catch(e){el('switch').textContent='状态读取失败'}}
async function setV(v){const a=Number(el('amount').value);if(v&&(!Number.isFinite(a)||a<1.5)){alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准');return}const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:v,amount:v?el('amount').value:undefined,pin:el('pin').value})});const j=await r.json();if(!r.ok){alert(j.error||'操作失败');return}refresh()}
async function confirmOrder(){if(!currentPending||currentPending.state!=='READY')return;if(!confirm('确认提交真实订单：'+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT？\n确认后后台会即时获取最新 Quote 并立即提交。'))return;const btn=el('confirmBtn');btn.disabled=true;btn.textContent='正在获取最新 Quote 并提交...';const r=await fetch('/api/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:el('pin').value,confirmationToken:currentPending.confirmationToken})});const j=await r.json();if(r.ok){alert('订单已提交，正在核验 Binance 成交状态。orderId：'+j.orderId)}else{alert((j.error||'下单失败')+(j.code!=null?' ('+j.code+')':''))}refresh()}
refresh();setInterval(refresh,2500);
</script></body></html>`;

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      mode: 'API_CONFIRM_LIVE',
      quoteMode: 'FRESH_ON_CONFIRM',
      hasSiteOrigin: Boolean(SITE_ORIGIN),
      hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
      hasPredictionWallet: Boolean(ENV_WALLET_ADDRESS),
      hasWalletId: Boolean(ENV_WALLET_ID),
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) {
    return send(res, 200, page, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [signal, balance] = await Promise.all([getSignal(), getPaymentBalances()]);
    lastBalance = balance;
    return send(res, 200, {
      ok: true,
      enabled,
      amount: tradeAmountText,
      mode: 'API_CONFIRM_LIVE',
      quoteMode: 'FRESH_ON_CONFIRM',
      signal,
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
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });
    const nextEnabled = Boolean(body.enabled);
    if (nextEnabled) {
      const amount = cleanAmount(body.amount);
      if (!amount || Number(amount) < 1.5) {
        return send(res, 400, { ok: false, error: 'MARKET 市价单金额请至少填写 1.5 USDT，实际最低值以 Binance 为准' });
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
    if (body.confirmationToken !== p.confirmationToken) return send(res, 409, { ok: false, error: '订单确认令牌已失效，请刷新页面' });
    if (submittedRounds.has(String(p.round))) return send(res, 409, { ok: false, error: '本轮已经提交过订单' });

    p.state = 'QUOTING';
    const quoteRequestStartedAt = Date.now();
    const [current, freshQuote] = await Promise.all([
      getSignal(),
      getFreshQuote(p._internal),
    ]);

    if (!current || current.status !== 'LOCKED' || String(current.round) !== String(p.round) || current.direction !== p.signal) {
      pendingAction = null;
      return send(res, 409, { ok: false, error: '当前信号或轮次已经变化，已阻止旧订单提交' });
    }

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
  console.log(JSON.stringify({
    event: 'prediction_balance_check',
    ok: lastBalance.ok,
    items: lastBalance.items || [],
    error: lastBalance.error || null,
  }));
});
