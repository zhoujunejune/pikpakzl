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
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
  try {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    q.append('signature', sign(q.toString()));
    const r = await fetch(`${API}${path}?${q.toString()}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, network: true, error: e?.message || 'NETWORK_ERROR', data: null };
  }
}

async function signedPost(path, bodyObj = {}) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return { ok: false, status: 500, data: { msg: 'BINANCE_API_CREDENTIALS_MISSING' } };
  try {
    const q = new URLSearchParams();
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyObj)) if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
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
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
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
  let s = String(value ?? '').trim();
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
    const r = await fetch(`${SITE_ORIGIN}/api/local-predictions`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
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
  const items = Array.isArray(call.data?.items) ? call.data.items.map(x => ({
    accountType: x.accountType ?? null,
    availableBalanceDisplay: x.availableBalanceDisplay ?? null,
    enabled: Boolean(x.enabled),
  })) : [];
  return { ok: true, items, checkedAt: new Date().toISOString() };
}

async function resolveWallet() {
  if (ENV_WALLET_ADDRESS && ENV_WALLET_ID) return { ok: true, walletAddress: ENV_WALLET_ADDRESS, walletId: ENV_WALLET_ID };
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
  const s = Number(topic?.startDate), e = Number(topic?.endDate);
  const d = e - s;
  return Number.isFinite(d) && d >= 240000 && d <= 360000;
}

function topicScore(topic, targetStart) {
  const s = Number(topic?.startDate), e = Number(topic?.endDate);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return Number.POSITIVE_INFINITY;
  return Math.abs(s - targetStart) + Math.abs(e - (targetStart + 300000));
}

async function discoverTopic(round) {
  const target = roundToMs(round);
  if (!target) return { ok: false, error: 'INVALID_SIGNAL_ROUND' };

  const listCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/list', {
    l1Category: 'crypto', l2Category: 'up-down', sortBy: 'CREATED_TIME', orderBy: 'DESC', offset: 0, limit: 100,
  });
  let topics = listCall.ok && Array.isArray(listCall.data?.marketTopics) ? listCall.data.marketTopics : [];

  if (!topics.length) {
    const searchCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/search', { query: 'BTC 5m', topK: 50 });
    if (searchCall.ok && Array.isArray(searchCall.data)) topics = searchCall.data;
  }

  const btc = topics.filter(t => String(t?.symbol || '').toUpperCase() === 'BTCUSDT' && durationLooks5m(t));
  const close = btc.filter(t => topicScore(t, target) <= 180000).sort((a, b) => topicScore(a, target) - topicScore(b, target));
  const now = Date.now();
  const active = btc.filter(t => Number(t.startDate) <= now + 30000 && Number(t.endDate) >= now - 30000).sort((a, b) => topicScore(a, target) - topicScore(b, target));
  const topic = close[0] || active[0];
  if (!topic?.marketTopicId) {
    return { ok: false, error: 'BTC_5M_PREDICTION_MARKET_NOT_FOUND', diagnostics: { targetRound: target, btc5mCandidates: btc.length } };
  }

  const detailCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/detail', { marketTopicId: topic.marketTopicId });
  if (!detailCall.ok) return asError(detailCall, 'PREDICTION_MARKET_DETAIL_FAILED');
  return { ok: true, topic: { ...topic, ...detailCall.data } };
}

function norm(v) { return String(v || '').trim().toUpperCase(); }

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

async function prepareQuote(signal) {
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
  const quoteBody = {
    walletAddress: wallet.walletAddress,
    tokenId: token.outcome.tokenId,
    side: 'BUY',
    amountIn,
    orderType: 'MARKET',
    slippageBps,
    chainId: marketResult.topic?.chainId || '56',
    feeRateBps,
    fundingSource: payment.fundingSource,
  };
  if (payment.fundingSource === 'CEX') quoteBody.fundTransferAmount = amountIn;

  const quoteCall = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote', quoteBody);
  if (!quoteCall.ok) return asError(quoteCall, 'PREDICTION_GET_QUOTE_FAILED');
  const q = quoteCall.data || {};
  if (!q.quoteId) return { ok: false, error: 'QUOTE_ID_MISSING' };

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
    quote: q,
  };
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
  if (pendingAction?.state === 'SUBMITTING') return;
  if (Date.now() - lastPrepareAttemptAt < 5000) return;

  prepareInFlight = true;
  lastPrepareAttemptAt = Date.now();
  try {
    const prepared = await prepareQuote(signal);
    if (!prepared.ok) {
      pendingAction = {
        state: 'PREPARE_ERROR', round: signal.round, signal: signal.direction, score: signal.score,
        amount: tradeAmountText, error: prepared.error, code: prepared.code ?? null, httpStatus: prepared.httpStatus ?? null,
        at: new Date().toISOString(),
      };
      console.log(JSON.stringify({ event: 'quote_prepare_failed', ...pendingAction }));
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
      marketTopicId: prepared.topic.marketTopicId,
      marketTitle: prepared.market?.title || prepared.quote?.marketTitle || signal.direction,
      outcome: prepared.outcome?.name || 'YES',
      chance: prepared.quote?.chance ?? null,
      averagePrice: prepared.quote?.averagePrice ?? null,
      feeAmountWei: prepared.quote?.feeAmount ?? null,
      amountOutWei: prepared.quote?.amountOut ?? null,
      expireAt: prepared.quote?.expireAt ?? null,
      paymentAccount: prepared.payment.displayAccount,
      confirmationToken: crypto.randomBytes(16).toString('hex'),
      _internal: prepared,
    };
    console.log(JSON.stringify({ event: 'api_order_ready', round: pendingAction.round, signal: pendingAction.signal, amount: pendingAction.amount, marketTopicId: pendingAction.marketTopicId, chance: pendingAction.chance, expireAt: pendingAction.expireAt }));
  } finally {
    prepareInFlight = false;
  }
}

async function refreshQuoteForPending(p) {
  const current = await getSignal();
  if (!current || current.status !== 'LOCKED' || String(current.round) !== String(p.round) || current.direction !== p.signal) {
    return { ok: false, error: 'CURRENT_SIGNAL_CHANGED' };
  }
  return await prepareQuote(current);
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

async function refreshLastOrderStatus() {
  if (!lastOrder?.orderId || !lastOrder?.walletAddress) return;
  if (Date.now() - Number(lastOrder.lastCheckedAt || 0) < 5000) return;
  lastOrder.lastCheckedAt = Date.now();
  const found = await lookupOrder(lastOrder.orderId, lastOrder.walletAddress);
  if (found.ok) {
    lastOrder.status = found.order.status ?? lastOrder.status;
    lastOrder.fillPercentage = found.order.fillPercentage ?? lastOrder.fillPercentage;
    lastOrder.filledUsdtAmount = found.order.filledUsdtAmount ?? lastOrder.filledUsdtAmount;
    lastOrder.price = found.order.price ?? lastOrder.price;
    lastOrder.checkedAt = new Date().toISOString();
  }
}

setInterval(prepareWorker, 2500);
setInterval(refreshLastOrderStatus, 5000);

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5分钟 API 实盘确认控制台</title><style>
body{font-family:system-ui,-apple-system;background:#0f1117;color:#fff;margin:0;padding:18px}.w{max-width:580px;margin:auto}.c{background:#191d27;border-radius:18px;padding:18px;margin:14px 0}.big{font-size:25px;font-weight:800}.on{color:#3ddc84}.off,.bad{color:#ff6868}.ok{color:#3ddc84}.warn{color:#f0b90b}.muted{color:#a8b0bd;font-size:14px;line-height:1.55}input,button{width:100%;box-sizing:border-box;padding:15px;border-radius:12px;margin-top:10px;font-size:17px}input{background:#0d1016;color:#fff;border:1px solid #3b4352}button{border:0;font-weight:800}.start{background:#28c76f;color:#06150b}.stop{background:#ff5c62;color:#fff}.confirm{background:#f0b90b;color:#161616;font-size:19px}.confirm:disabled{opacity:.45}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kv{background:#10141c;padding:12px;border-radius:12px}.k{font-size:12px;color:#8f98a8}.v{font-size:17px;font-weight:700;margin-top:4px}.wallet{font-size:30px;font-weight:900;margin-top:6px}.pending{border:1px solid #454d5f}.hidden{display:none}</style></head><body><div class="w">
<h2>5分钟 API 实盘确认控制台</h2>
<div class="c"><div id="switch" class="big">加载中...</div><div class="muted">流程：新一轮 LOCKED → 后端自动找 Binance BTC 5分钟市场 → 获取真实 Quote → 你点一次“确认下单” → 后端调用 Binance Prediction 下单 API。</div></div>
<div class="c"><div class="k">Prediction 可用余额</div><div class="wallet" id="walletBalance">读取中...</div><div class="muted" id="walletMeta">正在连接 Binance Prediction...</div></div>
<div class="c"><div class="grid"><div class="kv"><div class="k">当前轮次</div><div class="v" id="round">-</div></div><div class="kv"><div class="k">状态</div><div class="v" id="status">-</div></div><div class="kv"><div class="k">方向</div><div class="v" id="direction">-</div></div><div class="kv"><div class="k">Score</div><div class="v" id="score">-</div></div><div class="kv"><div class="k">每轮金额</div><div class="v" id="amountView">-</div></div><div class="kv"><div class="k">模式</div><div class="v">API_CONFIRM_LIVE</div></div></div></div>
<div class="c pending"><div class="k">API 已准备的真实订单</div><div class="big" id="pendingTitle">暂无</div><div class="muted" id="pendingMeta">开启后等待下一轮 LOCKED 信号。</div><button id="confirmBtn" class="confirm hidden" onclick="confirmOrder()">确认下单</button></div>
<div class="c"><div class="k">最近一笔 API 下单结果</div><div class="big" id="orderTitle">暂无</div><div class="muted" id="orderMeta">-</div></div>
<div class="c"><input id="amount" type="number" inputmode="decimal" min="1.5" step="0.01" placeholder="每轮金额，例如 2"><input id="pin" inputmode="numeric" placeholder="控制 PIN"><button class="start" onclick="setV(true)">开始跟随新信号</button><button class="stop" onclick="setV(false)">停止跟随</button><div class="muted">开始时会跳过当前 round，只处理之后的新轮次。同一 round 成功提交后不会再次提交。市价单最低金额由 Binance 流动性决定，通常约 1.5 USDT。</div></div>
</div><script>
let currentPending=null;
function fmtWei(v){try{return (Number(BigInt(v))/1e18).toFixed(4)}catch{return '-'}}
async function refresh(){try{const j=await(await fetch('/api/status',{cache:'no-store'})).json();document.getElementById('switch').innerHTML=j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>';const s=j.signal||{};round.textContent=s.round??'-';status.textContent=s.status??'-';direction.textContent=s.direction??'-';score.textContent=s.score==null?'-':Number(s.score).toFixed(2);amountView.textContent=j.amount??'-';if(document.activeElement!==amount&&j.amount!=null)amount.value=j.amount;const b=j.balance||{};const first=(b.items||[]).find(x=>x.enabled&&Number(x.availableBalanceDisplay)>0)||(b.items||[]).find(x=>x.enabled)||(b.items||[])[0];if(b.ok&&first){walletBalance.innerHTML='<span class="ok">'+first.availableBalanceDisplay+' USDT</span>';walletMeta.textContent='账户：'+first.accountType+' · Binance Prediction 实时可用余额'}else{walletBalance.innerHTML='<span class="bad">读取失败</span>';walletMeta.textContent=(b.error||'未返回余额')+(b.code!=null?' ('+b.code+')':'')}
currentPending=j.pendingAction||null;const btn=document.getElementById('confirmBtn');if(!currentPending){pendingTitle.textContent='暂无';pendingMeta.textContent=j.enabled?'正在等待下一轮 LOCKED 并获取真实 Quote...':'开启后等待下一轮 LOCKED 信号。';btn.classList.add('hidden')}else if(currentPending.state==='READY'){pendingTitle.textContent=(currentPending.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+currentPending.amount+' USDT';pendingMeta.textContent='市场 '+(currentPending.marketTitle||'-')+' / '+(currentPending.outcome||'-')+' · 概率 '+(currentPending.chance??'-')+' · 均价 '+(currentPending.averagePrice??'-')+' · 费用约 '+fmtWei(currentPending.feeAmountWei)+' USDT · 支付 '+(currentPending.paymentAccount||'-');btn.textContent='确认 '+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT（API下单）';btn.disabled=false;btn.classList.remove('hidden')}else{pendingTitle.textContent=currentPending.state==='PREPARE_ERROR'?'准备失败':'处理中';pendingMeta.textContent=(currentPending.error||currentPending.state)+(currentPending.code!=null?' ('+currentPending.code+')':'');btn.classList.add('hidden')}
const o=j.lastOrder;if(o){const filled=Number(o.fillPercentage||0)>=1||Number(o.filledUsdtAmount||0)>0;orderTitle.innerHTML=filled?'<span class="ok">已成交</span>':'<span class="warn">'+(o.status||o.state||'已提交')+'</span>';orderMeta.textContent='orderId '+(o.orderId||'-')+' · '+(o.action||'-')+' · '+(o.amount||'-')+' USDT'+(o.filledUsdtAmount?' · 已成交 '+o.filledUsdtAmount+' USDT':'')+(o.error?' · '+o.error:'')}else{orderTitle.textContent='暂无';orderMeta.textContent='-' }}catch(e){switch.textContent='状态读取失败'}}
async function setV(v){const a=Number(amount.value);if(v&&(!Number.isFinite(a)||a<1.5)){alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准');return}const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:v,amount:v?amount.value:undefined,pin:pin.value})});const j=await r.json();if(!r.ok){alert(j.error||'操作失败');return}refresh()}
async function confirmOrder(){if(!currentPending||currentPending.state!=='READY')return;if(!confirm('确认提交真实订单：'+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT？'))return;const btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='正在通过 API 提交...';const r=await fetch('/api/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin.value,confirmationToken:currentPending.confirmationToken})});const j=await r.json();if(r.ok){alert('API 下单已提交，orderId：'+j.orderId)}else{alert((j.error||'下单失败')+(j.code!=null?' ('+j.code+')':''))}refresh()}
refresh();setInterval(refresh,3000);
</script></body></html>`;

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, {
    ok: true, mode: 'API_CONFIRM_LIVE', hasSiteOrigin: Boolean(SITE_ORIGIN),
    hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET), hasPredictionWallet: Boolean(ENV_WALLET_ADDRESS), hasWalletId: Boolean(ENV_WALLET_ID),
  });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return send(res, 200, page, 'text/html; charset=utf-8');

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [signal, balance] = await Promise.all([getSignal(), getPaymentBalances()]);
    lastBalance = balance;
    return send(res, 200, { ok: true, enabled, amount: tradeAmountText, mode: 'API_CONFIRM_LIVE', signal, balance, startAfterRound, pendingAction: publicPending(), lastOrder: lastOrder ? { ...lastOrder, walletAddress: undefined, lastCheckedAt: undefined } : null });
  }

  if (req.method === 'GET' && url.pathname === '/api/balance') {
    const balance = await getPaymentBalances(); lastBalance = balance; return send(res, balance.ok ? 200 : 502, balance);
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    const body = await readBody(req);
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });
    const nextEnabled = Boolean(body.enabled);
    if (nextEnabled) {
      const amount = cleanAmount(body.amount);
      if (!amount || Number(amount) < 1.5) return send(res, 400, { ok: false, error: 'MARKET 市价单金额请至少填写 1.5 USDT，实际最低值以 Binance 为准' });
      tradeAmountText = amount;
      const current = await getSignal();
      startAfterRound = current?.round ?? null;
      pendingAction = null;
    } else {
      pendingAction = null;
    }
    enabled = nextEnabled;
    console.log(JSON.stringify({ event: 'api_confirm_control', enabled, amount: tradeAmountText, startAfterRound, at: new Date().toISOString() }));
    return send(res, 200, { ok: true, enabled, amount: tradeAmountText, startAfterRound, mode: 'API_CONFIRM_LIVE' });
  }

  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });
    const p = pendingAction;
    if (!p || p.state !== 'READY') return send(res, 409, { ok: false, error: '当前没有可确认的 API 订单' });
    if (body.confirmationToken !== p.confirmationToken) return send(res, 409, { ok: false, error: '订单确认令牌已失效，请刷新页面' });
    if (submittedRounds.has(String(p.round))) return send(res, 409, { ok: false, error: '本轮已经提交过订单' });

    const current = await getSignal();
    if (!current || current.status !== 'LOCKED' || String(current.round) !== String(p.round) || current.direction !== p.signal) {
      pendingAction = null;
      return send(res, 409, { ok: false, error: '当前信号或轮次已经变化，已阻止旧订单提交' });
    }

    let prepared = p._internal;
    if (!prepared?.quote?.quoteId || (Number(prepared.quote.expireAt || 0) > 0 && Number(prepared.quote.expireAt) <= Date.now() + 3000)) {
      const refreshed = await refreshQuoteForPending(p);
      if (!refreshed.ok) return send(res, 502, refreshed);
      prepared = refreshed;
      p._internal = refreshed;
      p.chance = refreshed.quote?.chance ?? p.chance;
      p.averagePrice = refreshed.quote?.averagePrice ?? p.averagePrice;
      p.expireAt = refreshed.quote?.expireAt ?? p.expireAt;
    }

    p.state = 'SUBMITTING';
    const placeBody = {
      walletAddress: prepared.wallet.walletAddress,
      walletId: prepared.wallet.walletId,
      quoteId: prepared.quote.quoteId,
      timeInForce: 'FOK',
      accountType: prepared.payment.accountType,
      orderType: 'MARKET',
      slippageBps: prepared.slippageBps,
      fundingSource: prepared.payment.fundingSource,
    };
    if (prepared.payment.fundingSource === 'CEX') placeBody.fundTransferAmount = prepared.amountIn;

    const startedAt = new Date().toISOString();
    const call = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle', placeBody);
    if (!call.ok) {
      const err = asError(call, 'PREDICTION_PLACE_ORDER_FAILED');
      const unknown = call.network || Number(call.status) >= 500;
      p.state = unknown ? 'SUBMISSION_UNKNOWN' : 'PLACE_ERROR';
      p.error = err.error; p.code = err.code; p.httpStatus = err.httpStatus;
      lastOrder = { state: p.state, orderId: null, action: p.action, amount: p.amount, round: p.round, error: err.error, code: err.code, startedAt };
      console.log(JSON.stringify({ event: 'api_order_failed', round: p.round, action: p.action, amount: p.amount, ...err }));
      return send(res, unknown ? 502 : 400, err);
    }

    const orderId = call.data?.orderId;
    if (!orderId) {
      p.state = 'SUBMISSION_UNKNOWN';
      return send(res, 502, { ok: false, error: 'Binance 返回成功但缺少 orderId，状态未知，请勿重复提交' });
    }
    submittedRounds.add(String(p.round));
    p.state = 'SUBMITTED';
    lastOrder = {
      state: 'SUBMITTED', orderId: String(orderId), action: p.action, amount: p.amount, round: p.round,
      walletAddress: prepared.wallet.walletAddress, submittedAt: new Date().toISOString(), status: 'PLACED', fillPercentage: null, filledUsdtAmount: null,
    };
    console.log(JSON.stringify({ event: 'api_order_submitted', orderId: String(orderId), round: p.round, action: p.action, amount: p.amount }));
    setTimeout(refreshLastOrderStatus, 1200);
    return send(res, 200, { ok: true, orderId: String(orderId), state: 'SUBMITTED' });
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}).listen(PORT, '0.0.0.0', async () => {
  console.log(JSON.stringify({ event: 'control_panel_started', port: PORT, mode: 'API_CONFIRM_LIVE', hasSiteOrigin: Boolean(SITE_ORIGIN), hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET), hasPredictionWallet: Boolean(ENV_WALLET_ADDRESS), hasWalletId: Boolean(ENV_WALLET_ID) }));
  lastBalance = await getPaymentBalances();
  console.log(JSON.stringify({ event: 'prediction_balance_check', ok: lastBalance.ok, items: lastBalance.items || [], error: lastBalance.error || null }));
});
