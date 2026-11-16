import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
const start=wrapper.indexOf('function retryGuardianBeforePost(');
const end=wrapper.indexOf('\nasync function inspectOrdersAfterUnknown(',start);
assert.ok(start>0 && end>start,'GUARDIAN_PREPOST_RETRY_HELPER_NOT_FOUND');
const helper=wrapper.slice(start,end);
const round=1793287200000;
function setup(){
  const scheduled=[],submitted=[];
  const p={round,signalModelChoice:'ZL_GUARDIAN_5M_V1',signalId:'immutable-up'};
  const scope={
    GUARDIAN_ID:'ZL_GUARDIAN_5M_V1',AUTO_CONFIRM_ENABLED:true,
    GUARDIAN_PREPOST_RETRY_MAX:2,GUARDIAN_PREPOST_RETRY_DELAY_MS:600,
    GUARDIAN_ORDER_DEADLINE_MS:300000,submittedRounds:new Set(),
    pendingAction:p,enabled:true,autoConfirmHalted:false,
    Date:{now:()=>round+1000},console:{log(){}},
    orderSubmitWindowOpen:(r,now)=>r===round&&now<round+300000,
    submitPendingOrder:async(x,options)=>{submitted.push({x,options});return {status:202}},
    setTimeout:(fn,ms)=>{scheduled.push({fn,ms});},
  };
  const retry=vm.runInNewContext(helper+'\nretryGuardianBeforePost',scope);
  return {p,scope,retry,scheduled,submitted};
}

test('explicit pre-POST quote failure schedules bounded same-round replay',async()=>{
  const x=setup();
  assert.equal(x.retry(x.p,'QUOTE_REJECTED_BEFORE_POST'),true);
  assert.equal(x.p.state,'AUTO_RETRY_WAIT');
  assert.equal(x.p.prePostRetries,1);
  assert.equal(x.scheduled.length,1);
  assert.equal(x.scheduled[0].ms,600);
  x.scheduled[0].fn();
  await Promise.resolve();
  assert.equal(x.submitted.length,1);
  assert.equal(x.submitted[0].x,x.p);
  assert.equal(x.submitted[0].options.prePostRetry,true);
});

test('retries have a hard cap and do not queue when disabled, unknown or expired',()=>{
  const x=setup();
  assert.equal(x.retry(x.p,'REGISTRY_WRITE_FAILED_BEFORE_POST'),true);
  assert.equal(x.retry(x.p,'REGISTRY_WRITE_FAILED_BEFORE_POST'),true);
  assert.equal(x.retry(x.p,'REGISTRY_WRITE_FAILED_BEFORE_POST'),false);
  assert.equal(x.scheduled.length,2);
  const y=setup();y.scope.enabled=false;
  assert.equal(y.retry(y.p,'OFF'),false);
  const z=setup();z.scope.submittedRounds.add(String(round));
  assert.equal(z.retry(z.p,'ORDER_ALREADY_POSTED'),false);
  const w=setup();w.scope.pendingAction={...w.p};
  assert.equal(w.retry(w.p,'NOT_SAME_ACTION'),false);
});

test('queued retry cancels after follow off or next round and never calls POST',()=>{
  const x=setup();
  assert.equal(x.retry(x.p,'QUOTE_FAILED'),true);
  x.scope.enabled=false;
  x.scheduled[0].fn();
  assert.equal(x.submitted.length,0);
  const y=setup();
  assert.equal(y.retry(y.p,'QUOTE_FAILED'),true);
  y.scope.submittedRounds.add(String(round));
  y.scheduled[0].fn();
  assert.equal(y.submitted.length,0);
});

test('GUARDIAN unknown POST states keep replay fences and no blind retry',()=>{
  assert.ok(wrapper.includes("submittedRounds.add(String(p.round));"));
  assert.ok(wrapper.includes("closeOrderSubmitRound(p.round,'UNKNOWN')"));
  assert.ok(wrapper.includes("if (autoAttemptedRounds.has(String(p.round)) && !prePostRetry)"));
  assert.ok(wrapper.includes("GUARDIAN_RISK_REGISTRY_UNAVAILABLE"));
  assert.ok(wrapper.includes("retryGuardianBeforePost(p,'REGISTRY_WRITE_FAILED_BEFORE_POST')"));
  assert.ok(wrapper.includes("retryGuardianBeforePost(p,'FRESH_QUOTE_FAILED_BEFORE_POST')"));
  assert.ok(wrapper.includes("current.signalId!==p.signalId"));
});

test('healthy fixed SL alone suffices; TP-off must not silently block GUARDIAN BUY',()=>{
  const a=wrapper.indexOf('function guardianRiskState(');
  const b=wrapper.indexOf('\nlet autoConfirmHalted',a);
  assert.ok(a>=0&&b>a,'GUARDIAN_FIXED_EXIT_HELPER_MISSING');
  const source=wrapper.slice(a,b);
  const now=Date.now();
  const config={takeProfitEnabled:false,stopLossEnabled:true};
  const runtime={at:new Date(now).toISOString(),enabled:true,workerRunning:true,
    configApplied:true,guardianDynamicExitEnabled:false,transitioning:false};
  const health={lastSuccessfulPositionsAt:new Date(now).toISOString(),positionsSeen:0};
  const fsMock={readFileSync:(p)=>{
    if(String(p).includes('risk-control'))return JSON.stringify(config);
    if(String(p).includes('risk-runtime'))return JSON.stringify(runtime);
    if(String(p).includes('risk-worker-health'))return JSON.stringify(health);
    throw new Error('MISSING');
  }};
  const ready=vm.runInNewContext(source+'\n guardianExitMonitorReady',
    {fs:fsMock,process:{env:{}},Date,Number,JSON});
  assert.equal(ready(now),true,'GUARDIAN must allow SL-only');
  config.stopLossEnabled=false;
  assert.equal(ready(now),false,'GUARDIAN must still require fixed SL');
  config.stopLossEnabled=true;
  runtime.workerRunning=false;
  assert.equal(ready(now),false,'GUARDIAN must still require a live monitor');
});

test('cross-round auto cooldown cannot abandon an otherwise valid GUARDIAN signal',()=>{
  assert.ok(wrapper.includes("p.signalModelChoice!==GUARDIAN_ID &&\n        Date.now() - lastAutoSubmitAt < AUTO_CONFIRM_COOLDOWN_MS"));
  assert.ok(wrapper.includes("retryGuardianBeforePost(p,'QUOTE_EXPIRED_BEFORE_POST')"));
  assert.ok(wrapper.includes("retryGuardianBeforePost(p,'QUOTE_INVALID_OR_EXPIRED_BEFORE_POST')"));
  assert.ok(wrapper.includes("p.blockReason=!fixedExitReady?'GUARDIAN_FIXED_STOP_LOSS_UNREADY'"));
});
