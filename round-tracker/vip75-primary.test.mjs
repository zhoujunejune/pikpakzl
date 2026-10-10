import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVip75Primary, shouldUseVip75Backup, VIP75_PRIMARY_SOURCE } from './vip75-primary.mjs';
const start=1791600000000;
function row(overrides={}) {
  const obs=start+15000,trained=start-300000;
  return {roundStartMs:start,roundEndMs:start+300000,settledAt:null,
    shadowObservedAt:obs,shadowFacts:{microScore:0.3},
    independentDirectionShadow:{modelName:'zl_new_vip75',
      modelVersion:'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3_'+trained,
      direction:'UP',probability:0.512345,roundStartMs:start,
      observedAt:obs,trainedAt:trained},...overrides};
}
test('frozen UP is locked as primary with immutable model source',()=>{
  const x=selectVip75Primary(row(),start+16000);
  assert.equal(x.ready,true);assert.equal(x.direction,'UP');
  assert.equal(x.confidence,0.512345);assert.equal(x.upProbability,0.512345);
  assert.equal(x.generatedAt,start+15000);
  assert.equal(VIP75_PRIMARY_SOURCE,'ZL_NEW_VIP75_PRIMARY');
});
test('frozen DOWN and confidence reflect UP-probability complement',()=>{
  const r=row();r.independentDirectionShadow.direction='DOWN';
  r.independentDirectionShadow.probability=0.48;
  const x=selectVip75Primary(r,start+17000);
  assert.equal(x.ready,true);assert.equal(x.direction,'DOWN');
  assert.equal(x.confidence,0.52);
});
test('not ready before freeze; delayed V2 backup only from 24s',()=>{
  const r=row({independentDirectionShadow:null});
  assert.equal(selectVip75Primary(r,start+17000).ready,false);
  assert.equal(shouldUseVip75Backup(r,start+23999),false);
  assert.equal(shouldUseVip75Backup(r,start+24000),true);
  assert.equal(shouldUseVip75Backup(r,start+300000),false);
});
test('fail closed for wrong round, model, future and post-settlement snapshots',()=>{
  for(const mutate of [
    r=>{r.independentDirectionShadow.roundStartMs+=300000;},
    r=>{r.independentDirectionShadow.modelVersion='wrong';},
    r=>{r.independentDirectionShadow.modelName='another';},
    r=>{r.independentDirectionShadow.observedAt=start+22001;},
    r=>{r.independentDirectionShadow.observedAt=start+20000;},
    r=>{r.independentDirectionShadow.trainedAt=start+16000;},
    r=>{r.settledAt=start+300000;},
    r=>{r.shadowFacts=null;},
    r=>{r.independentDirectionShadow.probability=null;},
    r=>{r.independentDirectionShadow.direction='WAIT';},
  ]){const r=row();mutate(r);assert.equal(selectVip75Primary(r,start+18000).ready,false);}
});
test('a replay at or after settlement cannot create a new prediction',()=>{
  assert.equal(selectVip75Primary(row(),start+300000).ready,false);
  assert.equal(selectVip75Primary(row(),start-1).ready,false);
});
