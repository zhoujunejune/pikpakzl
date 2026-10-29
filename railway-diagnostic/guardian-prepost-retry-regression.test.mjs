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
