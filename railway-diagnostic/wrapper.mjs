// V8 backend auto-confirm patch for Binance Prediction trade control.
// The Railway service intentionally boots through this wrapper. It loads the
// current index.mjs, injects one shared submitPendingOrder() path, and keeps
// MANUAL_CONFIRM as a fallback while allowing AUTO_CONFIRM to trigger server-side.
import fs from 'node:fs';

let source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

const backendPatch = String.raw`
const AUTO_CONFIRM_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.AUTO_CONFIRM_ENABLED || 'false'));
const AUTO_CONFIRM_AMOUNT = String(process.env.AUTO_CONFIRM_AMOUNT || '').trim();
const AUTO_CONFIRM_MAX_ORDERS_PER_ROUND = Math.max(1, Number(process.env.AUTO_CONFIRM_MAX_ORDERS_PER_ROUND || 1));
const AUTO_CONFIRM_COOLDOWN_MS = Math.max(0, Number(process.env.AUTO_CONFIRM_COOLDOWN_MS || 2500));
const AUTO_CONFIRM_STOP_ON_ERROR = !/^(0|false|no|off)$/i.test(String(process.env.AUTO_CONFIRM_STOP_ON_ERROR || 'true'));
const EV_FILTER_ENABLED = false; // EV 仅保留计算/展示，不再作为实盘下单拦截条件
const EV_FILTER_REQUIRE_CALIBRATED = !/^(0|false|no|off)$/i.test(String(process.env.PREDICTION_EV_REQUIRE_CALIBRATED || 'true'));
const EV_MIN_EDGE = Math.max(0, Math.min(0.50, Number(process.env.PREDICTION_EV_MIN_EDGE || 0.04)));
let autoConfirmHalted = false;
let lastAutoSubmitAt = 0;
const autoAttemptedRounds = new Set();

async function inspectOrdersAfterUnknown(walletAddress) {
  const [history, active] = await Promise.all([
    signedGet('/sapi/v1/w3w/wallet/prediction/order/history', { walletAddress, offset: 0, limit: 100 }),
    signedGet('/sapi/v1/w3w/wallet/prediction/order/list', { walletAddress, offset: 0, limit: 100 }),
  ]);
  return {
    historyOk: Boolean(history?.ok),
    activeOk: Boolean(active?.ok),
    historyCount: Array.isArray(history?.data?.orders) ? history.data.orders.length : null,
    activeCount: Array.isArray(active?.data?.orders) ? active.data.orders.length : null,
    historyHttpStatus: history?.status ?? null,
    activeHttpStatus: active?.status ?? null,
  };
}

async function submitPendingOrder(p, { source = 'manual' } = {}) {
  const isAuto = source === 'auto';
  if (!p || p !== pendingAction || p.state !== 'READY') {
    return { status: 409, body: { ok: false, error: '当前没有可提交的 API 订单' } };
  }
  if (!enabled) {
    return { status: 409, body: { ok: false, error: '跟随已经停止，已阻止订单提交' } };
  }
  if (submittedRounds.has(String(p.round))) {
    return { status: 409, body: { ok: false, error: '本轮已经提交过订单' } };
  }
  if (AUTO_CONFIRM_MAX_ORDERS_PER_ROUND <= 0) {
    return { status: 409, body: { ok: false, error: 'AUTO_CONFIRM_MAX_ORDERS_PER_ROUND 配置无效' } };
  }

  if (isAuto) {
    if (!AUTO_CONFIRM_ENABLED) return { status: 409, body: { ok: false, error: 'AUTO_CONFIRM 未开启' } };
    if (autoConfirmHalted) return { status: 409, body: { ok: false, error: 'AUTO_CONFIRM 已因严重错误停止' } };
    if (autoAttemptedRounds.has(String(p.round))) {
      return { status: 409, body: { ok: false, error: '本轮已经执行过自动提交，不会重复尝试' } };
    }
    if (Date.now() - lastAutoSubmitAt < AUTO_CONFIRM_COOLDOWN_MS) {
      return { status: 429, body: { ok: false, error: 'AUTO_CONFIRM 冷却中' } };
    }
    autoAttemptedRounds.add(String(p.round));
    lastAutoSubmitAt = Date.now();
    console.log(JSON.stringify({
      event: 'auto_submit_triggered',
      round: p.round,
      direction: p.signal,
      action: p.action,
      amount: p.amount,
      at: new Date().toISOString(),
    }));
  }

  p.state = 'QUOTING';
  p.error = null;
  p.code = null;

  const current = await getSignal({ forceHttp: true });
  if (!current || current.status !== 'LOCKED' || String(current.round) !== String(p.round) || current.direction !== p.signal) {
    pendingAction = null;
    console.log(JSON.stringify({
      event: 'submit_blocked_signal_changed',
      round: p.round,
      direction: p.signal,
      currentRound: current?.round ?? null,
      currentDirection: current?.direction ?? null,
      currentStatus: current?.status ?? null,
      source,
    }));
    return { status: 409, body: { ok: false, error: '当前信号或轮次已经变化，已阻止旧订单提交' } };
  }

  const quoteRequestStartedAt = Date.now();
  const freshQuote = await getFreshQuote(p._internal);
  if (!freshQuote.ok) {
    p.state = isAuto ? 'AUTO_FAILED' : 'READY';
    p.error = freshQuote.error;
    p.code = freshQuote.code ?? null;
    console.log(JSON.stringify({
      event: 'fresh_quote_failed',
      round: p.round,
      direction: p.signal,
      action: p.action,
      amount: p.amount,
      error: freshQuote.error,
      code: freshQuote.code ?? null,
      httpStatus: freshQuote.httpStatus ?? null,
      source,
    }));
    return { status: 502, body: freshQuote };
  }

  const quote = freshQuote.quote;
  const expireAt = Number(quote.expireAt || 0);
  const remainingMs = expireAt > 0 ? expireAt - Date.now() : null;
  console.log(JSON.stringify({
    event: 'fresh_quote_ready',
    round: p.round,
    direction: p.signal,
    action: p.action,
    amount: p.amount,
    quoteId: quote.quoteId,
    chance: quote.chance ?? null,
    expireAt: quote.expireAt ?? null,
    quoteRemainingMs: remainingMs,
    quoteLatencyMs: freshQuote.receivedAt - freshQuote.startedAt,
    triggerToQuoteMs: Date.now() - quoteRequestStartedAt,
    source,
  }));

  if (EV_FILTER_ENABLED) {
    const modelProbability = Number(current?.modelProbability);
    const calibrationSamples = Number(current?.calibrationSamples || 0);
    const quoteChance = Number(quote?.chance);
    const calibrated = current?.calibrationReady === true && Number.isFinite(modelProbability);

    if (EV_FILTER_REQUIRE_CALIBRATED && !calibrated) {
      p.state = isAuto ? 'EV_FILTERED' : 'READY';
      p.error = '模型尚未完成概率校准，本轮不自动下单。';
      p.blockReason = 'MODEL_NOT_CALIBRATED';
      p.calibrationSamples = calibrationSamples;
      console.log(JSON.stringify({
        event: 'ev_filter_blocked',
        reason: 'MODEL_NOT_CALIBRATED',
        round: p.round,
        direction: p.signal,
        calibrationSamples,
        requiredCalibrated: true,
        source,
      }));
      return { status: 409, body: { ok:false, error:p.error, reason:'MODEL_NOT_CALIBRATED', calibrationSamples } };
    }

    if (calibrated && Number.isFinite(quoteChance)) {
      const edge = modelProbability - quoteChance;
      if (edge < EV_MIN_EDGE) {
        p.state = isAuto ? 'EV_FILTERED' : 'READY';
        p.error = '当前赔率优势不足，本轮不下单。';
        p.blockReason = 'INSUFFICIENT_EDGE';
        p.modelProbability = modelProbability;
        p.quoteChance = quoteChance;
        p.edge = Number(edge.toFixed(6));
        p.minEdge = EV_MIN_EDGE;
        p.calibrationSamples = calibrationSamples;
        console.log(JSON.stringify({
          event: 'ev_filter_blocked',
          reason: 'INSUFFICIENT_EDGE',
          round: p.round,
          direction: p.signal,
          modelProbability,
          quoteChance,
          edge: Number(edge.toFixed(6)),
          minEdge: EV_MIN_EDGE,
          calibrationSamples,
          source,
        }));
        return {
          status: 409,
          body: {
            ok:false,
            error:p.error,
            reason:'INSUFFICIENT_EDGE',
            modelProbability,
            quoteChance,
            edge:Number(edge.toFixed(6)),
            minEdge:EV_MIN_EDGE,
            calibrationSamples,
          },
        };
      }

      console.log(JSON.stringify({
        event: 'ev_filter_passed',
        round: p.round,
        direction: p.signal,
        modelProbability,
        quoteChance,
        edge: Number(edge.toFixed(6)),
        minEdge: EV_MIN_EDGE,
        calibrationSamples,
        source,
      }));
    }
  }

  if (remainingMs !== null && remainingMs < 1200) {
    p.state = isAuto ? 'AUTO_FAILED' : 'READY';
    p.error = '最新 Quote 剩余有效期不足，未提交。';
    console.log(JSON.stringify({
      event: 'fresh_quote_too_close_to_expiry',
      round: p.round,
      direction: p.signal,
      remainingMs,
      expireAt,
      source,
    }));
    return { status: 409, body: { ok: false, error: p.error, expireAt, remainingMs } };
  }

  if (!enabled) {
    p.state = 'CANCELLED_BEFORE_SUBMIT';
    p.error = '跟随已经停止，已在 Binance 提交前取消';
    return { status: 409, body: { ok: false, error: p.error } };
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
    const unknown = Boolean(call.network) || Number(call.status) >= 500 || Number(call.status) === 0;
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
      direction: p.signal,
      action: p.action,
      amount: p.amount,
      quoteId: quote.quoteId,
      quoteRemainingAtSubmitMs: expireAt > 0 ? expireAt - placeStartedAtMs : null,
      submitLatencyMs: placeFinishedAtMs - placeStartedAtMs,
      source,
      ...err,
    }));

    if (unknown) {
      const audit = await inspectOrdersAfterUnknown(intent.wallet.walletAddress);
      console.log(JSON.stringify({
        event: 'submission_unknown',
        round: p.round,
        direction: p.signal,
        action: p.action,
        amount: p.amount,
        quoteId: quote.quoteId,
        ...audit,
      }));
      if (isAuto && AUTO_CONFIRM_STOP_ON_ERROR) {
        autoConfirmHalted = true;
        enabled = false;
        console.log(JSON.stringify({
          event: 'auto_confirm_halted',
          reason: 'SUBMISSION_UNKNOWN',
          round: p.round,
          at: new Date().toISOString(),
        }));
      }
    }
    return { status: unknown ? 502 : 400, body: err };
  }

  const orderId = call.data?.orderId;
  if (!orderId) {
    p.state = 'SUBMISSION_UNKNOWN';
    p.error = 'Binance 返回成功但缺少 orderId，状态未知，请勿重复提交';
    const audit = await inspectOrdersAfterUnknown(intent.wallet.walletAddress);
    console.log(JSON.stringify({
      event: 'submission_unknown',
      round: p.round,
      direction: p.signal,
      action: p.action,
      amount: p.amount,
      quoteId: quote.quoteId,
      reason: 'ORDER_ID_MISSING',
      ...audit,
    }));
    if (isAuto && AUTO_CONFIRM_STOP_ON_ERROR) {
      autoConfirmHalted = true;
      enabled = false;
    }
    lastOrder = {
      state: 'SUBMISSION_UNKNOWN',
      status: 'SUBMISSION_UNKNOWN',
      orderId: null,
      action: p.action,
      amount: p.amount,
      round: p.round,
      error: p.error,
      startedAt,
    };
    return { status: 502, body: { ok: false, error: p.error } };
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
    direction: p.signal,
    action: p.action,
    amount: p.amount,
    quoteId: quote.quoteId,
    quoteRemainingAtSubmitMs: lastOrder.quoteRemainingAtSubmitMs,
    submitLatencyMs: lastOrder.submitLatencyMs,
    source,
  }));

  setTimeout(() => refreshLastOrderStatus(true), 700);
  setTimeout(() => refreshLastOrderStatus(true), 1800);
  setTimeout(() => refreshLastOrderStatus(true), 3500);
  return { status: 202, body: { ok: true, orderId: String(orderId), state: 'SUBMITTED_PENDING_CONFIRMATION' } };
}
`;

const prepareMarker = "async function prepareWorker(signalOverride = null, trigger = 'poll') {";
if (!source.includes(prepareMarker)) throw new Error('PREPARE_WORKER_MARKER_NOT_FOUND');
source = source.replace(prepareMarker, backendPatch + '\n' + prepareMarker);

const submittedGuard = "  if (submittedRounds.has(String(signal.round))) return;";
if (!source.includes(submittedGuard)) throw new Error('SUBMITTED_GUARD_NOT_FOUND');
source = source.replace(
  submittedGuard,
  submittedGuard + "\n  if (AUTO_CONFIRM_ENABLED && autoAttemptedRounds.has(String(signal.round))) return;"
);

const amountLine = '      const amount = cleanAmount(body.amount);';
if (!source.includes(amountLine)) throw new Error('CONTROL_AMOUNT_MARKER_NOT_FOUND');
source = source.replace(
  amountLine,
  "      const amount = cleanAmount(body.amount || (AUTO_CONFIRM_ENABLED ? AUTO_CONFIRM_AMOUNT : null));"
);

const enableAssign = '    enabled = nextEnabled;';
if (!source.includes(enableAssign)) throw new Error('ENABLE_ASSIGN_MARKER_NOT_FOUND');
source = source.replace(
  enableAssign,
  "    enabled = nextEnabled;\n    if (nextEnabled) autoConfirmHalted = false;"
);

const readyLogEnd = "      quoteMode: pendingAction.quoteMode,\n    }));";
if (!source.includes(readyLogEnd)) throw new Error('READY_LOG_MARKER_NOT_FOUND');
source = source.replace(
  readyLogEnd,
  readyLogEnd + "\n\n    if (AUTO_CONFIRM_ENABLED && enabled && !autoConfirmHalted) {\n      await submitPendingOrder(pendingAction, { source: 'auto' });\n    }"
);

const confirmStart = "  if (req.method === 'POST' && url.pathname === '/api/confirm') {";
const notFoundMarker = "\n\n  return send(res, 404, { ok: false, error: 'Not found' });";
const confirmStartIndex = source.indexOf(confirmStart);
const notFoundIndex = source.indexOf(notFoundMarker, confirmStartIndex);
if (confirmStartIndex < 0 || notFoundIndex < 0) throw new Error('CONFIRM_ROUTE_MARKERS_NOT_FOUND');
const newConfirmRoute = String.raw`  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });

    const p = pendingAction;
    if (!p || p.state !== 'READY') return send(res, 409, { ok: false, error: '当前没有可确认的 API 订单' });
    if (body.confirmationToken !== p.confirmationToken) return send(res, 409, { ok: false, error: '订单确认令牌已失效，请刷新页面' });

    const result = await submitPendingOrder(p, { source: 'manual' });
    return send(res, result.status, result.body);
  }`;
source = source.slice(0, confirmStartIndex) + newConfirmRoute + source.slice(notFoundIndex);

source = source.replace(
  "      enabled,\n      amount: tradeAmountText,",
  "      enabled,\n      autoConfirmEnabled: AUTO_CONFIRM_ENABLED,\n      autoConfirmHalted,\n      amount: tradeAmountText,"
);
source = source.replace(
  "      hasWalletId: Boolean(ENV_WALLET_ID),",
  "      hasWalletId: Boolean(ENV_WALLET_ID),\n      autoConfirmEnabled: AUTO_CONFIRM_ENABLED,\n      autoConfirmHalted,\n      autoConfirmCooldownMs: AUTO_CONFIRM_COOLDOWN_MS,\n      autoConfirmStopOnError: AUTO_CONFIRM_STOP_ON_ERROR,"
);

source = source.replace('<div class=\\"v\\">API_CONFIRM_LIVE</div>', '<div class=\\"v\\" id=\\"modeView\\">模式读取中...</div>');
source = source.replace(
  '流程：新一轮 LOCKED → 后端先准备市场/方向（不提前拿 Quote）→ 你点一次“确认下单” → 后端即时获取最新 Quote → 立刻调用 Binance Prediction 下单 API → 再核验真实订单状态。',
  '流程：新一轮 LOCKED → 后端准备市场/方向 → READY → 按当前模式自动提交或人工一键提交 → Fresh Quote → Binance Prediction API → 最终订单核验。'
);
source = source.replace(
  '确认按钮出现时只代表方向/市场已经准备好，尚未拿 Quote。点击确认后才会即时获取 Quote 并马上提交；若报价剩余有效期不足，系统会拒绝提交，避免使用过期 Quote。',
  'AUTO_CONFIRM：READY 后由后端自动获取 Fresh Quote 并提交；MANUAL_CONFIRM：保留一键确认。停止跟随后不会再产生新的自动订单。'
);

const clientJs = String.raw`(function(){
  'use strict';
  var currentPending = null;
  var autoMode = false;
  function el(id){ return document.getElementById(id); }
  function text(id,v){ var n=el(id); if(n) n.textContent=String(v); }
  function html(id,v){ var n=el(id); if(n) n.innerHTML=v; }

  function request(method,url,body,cb){
    var x=new XMLHttpRequest();
    x.open(method,url,true);
    x.setRequestHeader('Cache-Control','no-cache');
    if(method!=='GET') x.setRequestHeader('Content-Type','application/json');
    x.onreadystatechange=function(){
      if(x.readyState!==4) return;
      var j={};
      try{ j=JSON.parse(x.responseText||'{}'); }catch(e){ j={error:'返回数据无法解析'}; }
      cb(x.status,j);
    };
    x.onerror=function(){ cb(0,{error:'网络请求失败'}); };
    x.send(body?JSON.stringify(body):null);
  }

  function refresh(){
    request('GET','/api/status?ts='+Date.now(),null,function(code,j){
      if(code!==200){
        html('switch','<span class="bad">● 状态读取失败</span>');
        text('walletMeta',(j&&j.error)||'无法连接 /api/status');
        return;
      }
      autoMode=!!j.autoConfirmEnabled;
      html('switch',j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>');
      text('modeView',autoMode?'AUTO_CONFIRM':'MANUAL_CONFIRM');
      var s=j.signal||{};
      text('round',s.round==null?'-':s.round);
      text('status',s.status==null?'-':s.status);
      text('direction',s.direction==null?'-':s.direction);
      text('score',s.score==null?'-':Number(s.score).toFixed(2));
      text('amountView',j.amount==null?'-':j.amount);
      var amount=el('amount');
      if(amount&&document.activeElement!==amount&&j.amount!=null) amount.value=j.amount;

      var b=j.balance||{},items=b.items||[],first=null,i;
      for(i=0;i<items.length;i++){ if(items[i].enabled&&Number(items[i].availableBalanceDisplay)>0){ first=items[i]; break; } }
      if(!first){ for(i=0;i<items.length;i++){ if(items[i].enabled){ first=items[i]; break; } } }
      if(!first&&items.length) first=items[0];
      if(b.ok&&first){
        html('walletBalance','<span class="ok">'+first.availableBalanceDisplay+' USDT</span>');
        text('walletMeta','账户：'+first.accountType+' · Binance Prediction 实时可用余额');
      }else{
        html('walletBalance','<span class="bad">读取失败</span>');
        text('walletMeta',(b.error||'未返回余额')+(b.code!=null?' ('+b.code+')':''));
      }

      currentPending=j.pendingAction||null;
      var btn=el('confirmBtn');
      if(!currentPending){
        text('pendingTitle','暂无');
        text('pendingMeta',j.enabled?'正在等待下一轮 LOCKED，并准备市场/方向...':'开启后等待下一轮 LOCKED 信号。');
        if(btn) btn.classList.add('hidden');
      }else if(currentPending.state==='READY'){
        text('pendingTitle',(currentPending.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+currentPending.amount+' USDT');
        text('pendingMeta','市场 '+(currentPending.marketTitle||'-')+' / '+(currentPending.outcome||'-')+' · 支付 '+(currentPending.paymentAccount||'-')+(autoMode?' · 后端自动确认已启用':' · 点击按钮即直接提交真实订单'));
        if(btn){
          if(autoMode){ btn.classList.add('hidden'); }
          else{
            btn.textContent='确认并直接下单 '+(currentPending.signal==='UP'?'BUY_UP ':'BUY_DOWN ')+currentPending.amount+' USDT';
            btn.disabled=false;
            btn.classList.remove('hidden');
          }
        }
      }else if(currentPending.state==='EV_FILTERED'){
        if(currentPending.blockReason==='INSUFFICIENT_EDGE'){
          var mp=Number(currentPending.modelProbability),qc=Number(currentPending.quoteChance),ed=Number(currentPending.edge),me=Number(currentPending.minEdge);
          text('pendingTitle','已跳过本轮：EV 优势不足');
          text('pendingMeta','模型概率 '+(isFinite(mp)?(mp*100).toFixed(2)+'%':'-')+' · 市场报价 '+(isFinite(qc)?(qc*100).toFixed(2)+'%':'-')+' · Edge '+(isFinite(ed)?(ed*100).toFixed(2)+'%':'-')+' · 最低要求 '+(isFinite(me)?'+'+(me*100).toFixed(2)+'%':'-')+'。未向 Binance 提交订单。');
        }else if(currentPending.blockReason==='MODEL_NOT_CALIBRATED'){
          text('pendingTitle','已跳过本轮：模型尚未完成概率校准');
          text('pendingMeta','当前校准样本 '+(currentPending.calibrationSamples==null?'-':currentPending.calibrationSamples)+'，本轮未向 Binance 提交订单。');
        }else{
          text('pendingTitle','已跳过本轮：风控未通过');
          text('pendingMeta',(currentPending.error||'本轮未满足下单条件')+' 未向 Binance 提交订单。');
        }
        if(btn) btn.classList.add('hidden');
      }else if(currentPending.state==='PREPARE_ERROR'||currentPending.state==='AUTO_FAILED'||currentPending.state==='PLACE_ERROR'){
        text('pendingTitle',currentPending.state==='AUTO_FAILED'?'自动提交失败':'准备/提交失败');
        text('pendingMeta',(currentPending.error||currentPending.state)+(currentPending.code!=null?' ('+currentPending.code+')':''));
        if(btn) btn.classList.add('hidden');
      }else if(currentPending.state==='SUBMISSION_UNKNOWN'){
        text('pendingTitle','订单状态未知，已停止重复提交');
        text('pendingMeta',(currentPending.error||'正在通过历史订单/活动订单排查；不会自动重发。'));
        if(btn) btn.classList.add('hidden');
      }else if(currentPending.state==='SUBMITTED_PENDING_CONFIRMATION'){
        text('pendingTitle','已提交，正在核验');
        text('pendingMeta','已获得 orderId，正在查询最终成交状态。');
        if(btn) btn.classList.add('hidden');
      }else{
        text('pendingTitle',currentPending.state==='QUOTING'?'正在获取最新 Quote...':'正在提交...');
        text('pendingMeta','正在处理，请不要重复操作。');
        if(btn) btn.classList.add('hidden');
      }

      if(j.autoConfirmHalted){
        html('switch','<span class="bad">● AUTO_CONFIRM 已因未知提交状态停止</span>');
      }

      var o=j.lastOrder;
      if(o){
        var filled=o.state==='CONFIRMED_FILLED'||Number(o.fillPercentage||0)>=1||Number(o.filledUsdtAmount||0)>0;
        var failed=o.state==='CONFIRMED_FAILED'||o.state==='PLACE_ERROR';
        var unknown=o.state==='SUBMISSION_UNKNOWN';
        html('orderTitle',filled?'<span class="ok">已成交</span>':(failed?'<span class="bad">下单失败</span>':(unknown?'<span class="warn">状态未知，禁止重发</span>':'<span class="warn">已提交，核验中</span>')));
        text('orderMeta','orderId '+(o.orderId||'-')+' · '+(o.action||'-')+' · '+(o.amount||'-')+' USDT · 状态 '+(o.status||o.state||'-')+(o.filledUsdtAmount?' · 已成交 '+o.filledUsdtAmount+' USDT':'')+(o.error?' · '+o.error:''));
      }else{
        text('orderTitle','暂无'); text('orderMeta','-');
      }
    });
  }

  window.setV=function(v){
    var amountEl=el('amount'),pinEl=el('pin');
    var a=Number(amountEl&&amountEl.value);
    if(v&&amountEl&&amountEl.value&&(!isFinite(a)||a<1)){ alert('请输入至少 1 USDT；实际最低金额仍以 Binance 返回为准'); return; }
    request('POST','/api/control',{enabled:v,amount:v&&amountEl?amountEl.value:undefined,pin:pinEl?pinEl.value:''},function(code,j){
      if(code<200||code>=300){ alert((j&&j.error)||'操作失败'); return; }
      refresh();
    });
  };

  window.confirmOrder=function(){
    if(autoMode) return;
    if(!currentPending||currentPending.state!=='READY') return;
    var btn=el('confirmBtn'),pinEl=el('pin');
    if(btn){ btn.disabled=true; btn.textContent='正在获取最新 Quote 并提交...'; }
    request('POST','/api/confirm',{pin:pinEl?pinEl.value:'',confirmationToken:currentPending.confirmationToken},function(code,j){
      if(code<200||code>=300){ alert(((j&&j.error)||'下单失败')+(j&&j.code!=null?' ('+j.code+')':'')); }
      refresh();
    });
  };

  function boot(){
    html('switch','<span class="warn">● V8 正在读取状态...</span>');
    refresh();
    setInterval(refresh,2000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();`;

const scriptPattern=/<script>[\s\S]*?<\/script>/;
if(!scriptPattern.test(source)) throw new Error('INLINE_SCRIPT_NOT_FOUND');
source=source.replace(scriptPattern,'<script src="/panel-client.js?v=8" defer></script>');
source=source.replace('加载中...','V8 页面已加载，等待状态...');

const marker="  if (req.method === 'GET' && url.pathname === '/healthz') {";
if(!source.includes(marker)) throw new Error('HEALTH_ROUTE_MARKER_NOT_FOUND');
const route="  if (req.method === 'GET' && url.pathname === '/panel-client.js') {\n    return send(res, 200, "+JSON.stringify(clientJs)+", 'application/javascript; charset=utf-8');\n  }\n\n";
source=source.replace(marker,route+marker);

fs.writeFileSync('/tmp/trade-control-fixed.mjs',source);
await import('file:///tmp/trade-control-fixed.mjs');
