import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoreSupplementGate } from './edge-first-production-gate.mjs';

function row(i, correct = true, direction = i%2 ? 'UP' : 'DOWN') {
  const start = 1791540000000 + i*300000;
  return {
    roundStartMs:start, roundEndMs:start+300000, predictedAt:start+12000,
    prediction:direction, actual:correct?direction:(direction==='UP'?'DOWN':'UP'),
    lockQualitySelectiveV2:{version:'LOCK_QUALITY_SELECTIVE_V2',pass:true}
  };
}
const now = 1791540000000 + 100*300000;
test('60 frozen settled correct signals qualify either direction', () => {
  const rows = Array.from({length:60},(_,i)=>row(i));
  assert.equal(evaluateCoreSupplementGate(rows,'UP',now).allowed,true);
  assert.equal(evaluateCoreSupplementGate(rows,'DOWN',now).allowed,true);
});
test('less than 60 signals never qualify despite perfect accuracy', () => {
  const g = evaluateCoreSupplementGate(Array.from({length:59},(_,i)=>row(i)),'UP',now);
  assert.equal(g.allowed,false);
  assert.ok(g.reasons.includes('NEED_60_FROZEN_CORE_SAMPLES'));
});
test('reject poor recent quality despite 75%+ overall', () => {
  const rows = Array.from({length:60},(_,i)=>row(i,i<50));
  const g = evaluateCoreSupplementGate(rows,'UP',now);
  assert.equal(g.allowed,false);
  assert.ok(g.reasons.includes('CORE_RECENT10_BELOW_75'));
});
test('exclude unsettled, future, retroactive and invalid lock timestamps', () => {
  const rows = Array.from({length:60},(_,i)=>row(i));
  rows[0].actual='PENDING';
  rows[1].predictedAt=rows[1].roundEndMs+1;
  rows[2].roundStartMs=now+300000;
  rows[3].lockQualitySelectiveV2.pass=false;
  const g = evaluateCoreSupplementGate(rows,'UP',now);
  assert.equal(g.allowed,false);
  assert.equal(g.observedFrozenSamples,56);
});
test('block weak UP without blocking independently healthy DOWN', () => {
  const rows=Array.from({length:80},(_,i)=>row(i, i%2===0 || i%5===0));
  const up=evaluateCoreSupplementGate(rows,'UP',now);
  assert.equal(up.allowed,false);
});
