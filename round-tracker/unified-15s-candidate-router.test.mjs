import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeNoBase15s,V3_NO_BASE_15S_VERSION,V3_NO_BASE_15S_CONFIGS} from './v3-no-base-15s-audit.mjs';
import {
  ALL_15S_IDS,LIVE_OPT_IN_15S_IDS,FORWARD_GATED_15S_IDS,
  candidateProductionSource,forward15sProofPass,selectForwardGated15sCandidates,
} from './unified-15s-candidate-router.mjs';
const round=Date.parse('2026-10-10T17:00:00.000Z');
const facts={
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'verified-topic-for-round',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.66,currentScore:0.66,currentTrendScore:0.75,
  liveScore:0.80,distanceFromOpenBps:1.25,tradeCount15s:22,
  depthAgeMs:100,lastAggTradeAgeMs:200,tradeStreamStalled:false,
  absorptionRisk:false,regimeDirection:'UP',regimeAgreement:0.80,
  regimeScore:0.78, predictionMarketConflict:false,
};
function makeRow(f=facts){
  const r={roundStartMs:round,prediction:null,predictedAt:null};
  return {...r,v3NoBase15sShadow:freezeNoBase15s(r,f,round+15500)};
}
function proof(id){
  return {
    candidateId:id,status:'ELIGIBLE_FOR_INDEPENDENT_REVIEW',
    strictForwardSamples:80,forwardAccuracy:0.80,
    recent20:{samples:20,accuracy:0.80},
    recent10:{samples:10,accuracy:0.80},
    up:{samples:40,accuracy:0.80},down:{samples:40,accuracy:0.80},
    upRecent6:{samples:6,accuracy:0.8333},downRecent6:{samples:6,accuracy:0.8333},
    maxConsecutiveMisses:2,
  };
}
const stats=(items)=>({
  version:V3_NO_BASE_15S_VERSION,
  scope:'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S',
  observedNoBaseSettledRounds:120,candidates:items,
});

test('all eleven candidate ids registered once; exactly two already opted-in',()=>{
  assert.equal(ALL_15S_IDS.length,11);
  assert.deepEqual(ALL_15S_IDS,V3_NO_BASE_15S_CONFIGS.map(x=>x.id));
  assert.equal(new Set(ALL_15S_IDS).size,11);
  assert.equal(LIVE_OPT_IN_15S_IDS.length,2);
  assert.equal(FORWARD_GATED_15S_IDS.length,9);
  assert.equal(FORWARD_GATED_15S_IDS.filter(x=>LIVE_OPT_IN_15S_IDS.includes(x)).length,0);
  for(const id of FORWARD_GATED_15S_IDS){
    assert.equal(candidateProductionSource(id),'VERIFIED_V3_NO_BASE_15S_'+id+'_PRIMARY');
  }
});

test('no new pilot can be promoted without all strict-forward directional gates',()=>{
  const a=proof('PM_FLOW15_CURRENT_03');
  assert.equal(forward15sProofPass(a),true);
  for(const changed of [
    {...a,status:'COLLECTING'},
    {...a,strictForwardSamples:59},
    {...a,forwardAccuracy:0.74},
    {...a,recent20:{samples:20,accuracy:0.70}},
    {...a,recent10:{samples:10,accuracy:0.60}},
    {...a,up:{samples:9,accuracy:1}},
    {...a,down:{samples:40,accuracy:0.69}},
    {...a,upRecent6:{samples:6,accuracy:0.66}},
    {...a,maxConsecutiveMisses:3},
  ]) assert.equal(forward15sProofPass(changed),false);
});

test('genuinely frozen clean 15s candidates qualify only with prospective proof',()=>{
  const r=makeRow();
  const s=stats([proof('PM_FLOW15_CURRENT_03'),proof('PM_TREND_045_CURRENT_03')]);
  const selected=selectForwardGated15sCandidates(r,s,round+17000);
  assert.equal(selected.candidates.length,2);
  assert.equal(selected.candidates[0].direction,'UP');
  assert.ok(selected.candidates.every(x=>FORWARD_GATED_15S_IDS.includes(x.id)));
  const noProof=selectForwardGated15sCandidates(r,stats([]),round+17000);
  assert.equal(noProof.candidates.length,0);
  assert.equal(noProof.reason,'NO_FORWARD_QUALIFIED_MODEL');
});

test('candidate live qualifiers never re-evaluate settled, shifted, stale or backfilled rounds',()=>{
  const r=makeRow(),s=stats([proof('PM_FLOW15_CURRENT_03')]);
  for(const time of [round+14999,round+20001,round+300000])
    assert.equal(selectForwardGated15sCandidates(r,s,time).candidates.length,0);
  for(const patch of [
    {prediction:'UP'}, {predictedAt:round+16000},{productionPrediction:'DOWN'},
    {actual:'UP'},{settledAt:round+299000},{roundStartMs:round+300000}
  ])assert.equal(selectForwardGated15sCandidates({...r,...patch},s,round+17000).candidates.length,0);
  assert.equal(selectForwardGated15sCandidates({
    ...r,v3NoBase15sShadow:{...r.v3NoBase15sShadow,observedAt:round+17500}
  },s,round+19000).candidates.length,0);
});

test('ordinary candidates cannot bypass stale quote, absorption or missing topic',()=>{
  const s=stats([proof('PM_FLOW15_CURRENT_03')]);
  for(const patch of [
    {predictionMarketBookAgeMs:7000}, {predictionMarketMappingReliable:false},
    {predictionMarketRoundAligned:false},{predictionMarketTopicId:null},
    {absorptionRisk:true},{tradeStreamStalled:true},{depthAgeMs:2000}
  ])assert.equal(selectForwardGated15sCandidates(makeRow({...facts,...patch}),s,round+17000).candidates.length,0,
  JSON.stringify(patch));
});

test('absorption pilots qualify only for exactly absorption-risk scenarios',()=>{
  const s=stats([proof('ABS_PM_CURRENT15'),proof('ABS_PM_REGIME35'),proof('PM_FLOW15_CURRENT_03')]);
  const clean=selectForwardGated15sCandidates(makeRow(),s,round+17000);
  assert.ok(clean.candidates.every(x=>!x.id.startsWith('ABS_')));
  const absorb=makeRow({...facts,absorptionRisk:true});
  const candidates=selectForwardGated15sCandidates(absorb,s,round+17000).candidates;
  assert.ok(candidates.length>0);
  assert.ok(candidates.every(x=>x.id.startsWith('ABS_')));
  const stale=makeRow({...facts,absorptionRisk:true,depthAgeMs:5000});
  assert.equal(selectForwardGated15sCandidates(stale,s,round+17000).candidates.length,0);
});

test('live priority prefers stronger qualified proof over weaker one',()=>{
  const r=makeRow();
  const strong={...proof('PM_FLOW15_CURRENT_03'),forwardAccuracy:0.85};
  const weak={...proof('PM_TREND_045_CURRENT_03'),forwardAccuracy:0.76};
  const x=selectForwardGated15sCandidates(r,stats([weak,strong]),round+17000);
  assert.equal(x.candidates[0].id,strong.candidateId);
  assert.equal(x.candidates[1].id,weak.candidateId);
});
