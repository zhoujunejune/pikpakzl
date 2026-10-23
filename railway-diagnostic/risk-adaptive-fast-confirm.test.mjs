import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');

function near({tpEnabled=true,slEnabled=true}={}){
 const a=source.indexOf('function isNearRealQuoteThreshold(');
 const b=source.indexOf('function quoteTooCloseToExpiry(',a);
 assert.ok(a>0&&b>a);
 const ctx={TAKE_PROFIT_ENABLED:tpEnabled,STOP_LOSS_ENABLED:slEnabled,
  NEAR_TARGET_DISTANCE_PCT:8,Number,Math};
 vm.runInNewContext(source.slice(a,b)+'\nthis.testNear=isNearRealQuoteThreshold',ctx);
 return ctx.testNear;
}
const targets={totalCost:100,tpTarget:130,slTarget:65};
function quote(currentSellAmount,triggered=false){
 return {ok:true,currentSellAmount,triggered};
}
test('only executable fresh Binance SELL quote near a threshold permits fast wakeup',()=>{
 const f=near();
 assert.equal(f(targets,quote(123)),true);
 assert.equal(f(targets,quote(129)),true);
 assert.equal(f(targets,quote(72)),true);
 assert.equal(f(targets,quote(98)),false);
 assert.equal(f(targets,quote(80)),false);
});
test('never activate fast wakeup on invalid, stale or triggered evaluation',()=>{
 const f=near();
 assert.equal(f(targets,quote(125,true)),false);
 assert.equal(f(targets,{ok:false,currentSellAmount:125,triggered:false}),false);
 assert.equal(f({totalCost:0,tpTarget:0,slTarget:0},quote(0)),false);
 assert.equal(f(targets,quote(Infinity)),false);
 assert.equal(f(targets,{ok:true,triggered:false,currentSellAmount:NaN}),false);
});
test('disabled TP or SL cannot accidentally enable fast mode',()=>{
 assert.equal(near({tpEnabled:false})(targets,quote(128)),false);
 assert.equal(near({slEnabled:false})(targets,quote(65)),false);
 assert.equal(near({tpEnabled:false,slEnabled:false})(targets,quote(129)),false);
});
test('baseline 300ms watchdog remains; faster 200ms wakeup is bounded and non-overlapping',()=>{
 for(const text of [
  'const NEAR_TARGET_FAST_POLL_MS = 200;',
  'const NEAR_TARGET_DISTANCE_PCT = 8;',
  'const NEAR_TARGET_WINDOW_MS = 2500;',
  "const POLL_MS = Math.max(300,",
  "if ((!TAKE_PROFIT_ENABLED && !STOP_LOSS_ENABLED) || workerBusy) return;",
  'if(lastTickStartedMs && now - lastTickStartedMs < minimumBetweenStartsMs) return;',
  'fastPollUntilMs = Date.now() + NEAR_TARGET_WINDOW_MS;',
  'setInterval(tick, POLL_MS);',
  'const nearTargetTimer = setInterval(() => {',
  'if(Date.now() < fastPollUntilMs) void tick();',
 ])assert.ok(source.includes(text),text);
});
test('new speed path preserves SELL quote freshness, threshold, durable pre-POST and order finality fences',()=>{
 for(const marker of [
  'const QUOTE_MIN_REMAINING_MS = 250;',
  'const SUBMITTED_RECONCILE_MS = 2500;',
  "await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote', body)",
  "await signedPost('/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle', body)",
  "timeInForce: 'FOK'",
  "persistPendingSellState(); // must succeed BEFORE sending a real SELL",
  "risk_sell_not_submitted_journal_unavailable",
  "if (state?.statusUnknown)",
  "if(state?.submitted){",
  "safeToRetryUnfilledSubmitted({",
  "risk_sell_final_failed_retry_scheduled",
  "risk_sell_fill_confirmed",
  "risk_sell_journal_ready",
 ])assert.ok(source.includes(marker),marker);
});
test('metrics distinguish quote fetch, order POST response and observed exchange history confirmation',()=>{
 for(const marker of [
  'quoteRequestAtMs','quoteFetchMs',
  'exchangePostResponseMs:Date.now()-sellPostStartedAt',
  'confirmationObservedMs:Math.max(0,now-Number(state.submittedAt||now))',
  "EXCHANGE_HISTORY_CONFIRMED_NOT_EXCHANGE_FILL_TIMESTAMP",
 ])assert.ok(source.includes(marker),marker);
});
