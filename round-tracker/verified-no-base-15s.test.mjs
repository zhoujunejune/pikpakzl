import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVerifiedNoBase15s } from './verified-no-base-15s.mjs';
import { V3_NO_BASE_15S_VERSION } from './v3-no-base-15s-audit.mjs';

const START = Date.parse('2026-10-10T11:00:00.000Z');
const proof = { candidateId:'PM_LEAN_03', status:'ELIGIBLE_FOR_INDEPENDENT_REVIEW',
  strictForwardSamples:80, forwardAccuracy:0.80,
  recent20:{samples:20,accuracy:0.80},recent10:{samples:10,accuracy:0.80},
  up:{samples:40,accuracy:0.80},down:{samples:40,accuracy:0.80},
  upRecent6:{samples:6,accuracy:0.8333},downRecent6:{samples:6,accuracy:0.8333},
  maxConsecutiveMisses:2 };
const stats = () => ({version:V3_NO_BASE_15S_VERSION,scope:'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S',
  observedNoBaseSettledRounds:200,candidates:[structuredClone(proof)]});
const row = () => ({roundStartMs:START,prediction:'WAIT',productionPrediction:null,actual:null,
  v3NoBase15sShadow:{
    version:V3_NO_BASE_15S_VERSION,round:START,observedAt:START+15200,
    baseAbsentAtObservation:true,inputFrozenBeforeSettlement:true,
    facts:{dataFresh:true,bookMappingReliable:true,bookRoundAligned:true,gateFailures:[],
      upMid:0.72,currentScore:0.62},
    candidates:{PM_LEAN_03:{decision:'UP',qualified:true,reasons:[]}},
  },
});

test('promotes only independently tracked qualified prospective direction inside lock window',()=>{
  const r=selectVerifiedNoBase15s(row(),stats(),START+15800);
  assert.equal(r.allowed,true);
  assert.equal(r.candidate.direction,'UP');
  assert.equal(r.candidate.strictForwardSamples,80);
});
test('rejects missing or weak forward evidence',()=>{
  const bad=stats();bad.candidates[0].forwardAccuracy=0.62;
  assert.equal(selectVerifiedNoBase15s(row(),bad,START+16000).allowed,false);
  const sparse=stats();sparse.candidates[0].strictForwardSamples=20;
  assert.equal(selectVerifiedNoBase15s(row(),sparse,START+16000).allowed,false);
  assert.equal(selectVerifiedNoBase15s(row(),null,START+16000).allowed,false);
});
test('rejects leaking post-settlement or incorrect round frozen records',()=>{
  const r=row();r.v3NoBase15sShadow.observedAt=START+300001;
  assert.equal(selectVerifiedNoBase15s(r,stats(),START+300002).allowed,false);
  const r2=row();r2.v3NoBase15sShadow.round=START-300000;
  assert.equal(selectVerifiedNoBase15s(r2,stats(),START+16000).allowed,false);
  const r3=row();r3.v3NoBase15sShadow.observedAt=START+10000;
  assert.equal(selectVerifiedNoBase15s(r3,stats(),START+16000).allowed,false);
});
test('keeps stale, risky, cross-round and mismatched market signals as WAIT',()=>{
  for(const key of ['dataFresh','bookMappingReliable','bookRoundAligned']){
    const r=row();r.v3NoBase15sShadow.facts[key]=false;
    assert.equal(selectVerifiedNoBase15s(r,stats(),START+16000).allowed,false);
  }
  const r=row();r.v3NoBase15sShadow.facts.gateFailures=['ABSORPTION_RISK'];
  assert.equal(selectVerifiedNoBase15s(r,stats(),START+16000).allowed,false);
  const r2=row();r2.v3NoBase15sShadow.facts.upMid=0.48;
  assert.equal(selectVerifiedNoBase15s(r2,stats(),START+16000).allowed,false);
});
test('never overrides an existing production freeze or accepts future input',()=>{
  const r=row();r.productionPrediction='DOWN';
  assert.equal(selectVerifiedNoBase15s(r,stats(),START+16000).allowed,false);
  assert.equal(selectVerifiedNoBase15s(row(),stats(),START+14000).allowed,false);
  assert.equal(selectVerifiedNoBase15s(row(),stats(),START+26000).allowed,false);
});
