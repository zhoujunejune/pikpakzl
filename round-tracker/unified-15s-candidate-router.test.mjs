import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeNoBase15s, V3_NO_BASE_15S_VERSION, V3_NO_BASE_15S_CONFIGS } from './v3-no-base-15s-audit.mjs';
import {
  ALL_15S_IDS, LIVE_OPT_IN_15S_IDS, FORWARD_GATED_15S_IDS,
  candidateProductionSource, forward15sProofPass, wilsonLower95,
  selectForwardGated15sCandidates
} from './unified-15s-candidate-router.mjs';

const round=Date.parse('2026-10-10T17:00:00.000Z');
const facts={
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'verified-topic-for-round',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.66,currentScore:0.66,currentTrendScore:0.75,
  liveScore:0.80,distanceFromOpenBps:1.25,tradeCount15s:22,
  depthAgeMs:100,lastAggTradeAgeMs:200,tradeStreamStalled:false,
  absorptionRisk:false,regimeDirection:'UP',regimeAgreement:0.80,
  regimeScore:0.78,predictionMarketConflict:false
};
function makeRow(f=facts){
  const r={roundStartMs:round,prediction:null,predictedAt:null};
  return {...r,v3NoBase15sShadow:freezeNoBase15s(r,f,round+15500)};
}
function proof(id){
  return {candidateId:id,status:'ELIGIBLE_FOR_INDEPENDENT_REVIEW',
    strictForwardSamples:120,hits:104,misses:16,forwardAccuracy:0.8667,
    recent30:{samples:30,accuracy:0.8667},recent20:{samples:20,accuracy:0.85},
    recent10:{samples:10,accuracy:0.8},
    up:{samples:70,accuracy:0.8571},down:{samples:50,accuracy:0.88},
    upRecent6:{samples:6,accuracy:0.8333},downRecent6:{samples:6,accuracy:0.8333},
    maxConsecutiveMisses:4,currentMissStreak:0
  };
}
const stats=(items)=>({
  version:V3_NO_BASE_15S_VERSION,
  scope:'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S',
  observedNoBaseSettledRounds:180,candidates:items
});
const choose=(row,items,time=round+26000,phase='late')=>
  selectForwardGated15sCandidates(row,stats(items),time,phase);

test('deleted 15s strategies cannot re-enter the active candidate registry',()=>{
  assert.equal(ALL_15S_IDS.length,9);
  assert.deepEqual(ALL_15S_IDS,V3_NO_BASE_15S_CONFIGS.map(x=>x.id));
  assert.equal(new Set(ALL_15S_IDS).size,9);
  assert.equal(LIVE_OPT_IN_15S_IDS.length,2);
  assert.equal(FORWARD_GATED_15S_IDS.length,8);
  assert.equal(candidateProductionSource('PM_LEAN_03'),null);
  assert.equal(candidateProductionSource('BLENDED_04_PM_AGREE'),null);
  assert.equal(ALL_15S_IDS.includes('BLENDED_04_PM_AGREE'),false);
  assert.equal(candidateProductionSource('PM_CURRENT25_SUPPORT08'),'PM_CURRENT25_SUPPORT08_15S_PRIMARY');
  assert.equal(candidateProductionSource('CURRENT_03_PM_AGREE'),'CURRENT_03_PM_AGREE_15S_PRIMARY');
  assert.equal(candidateProductionSource('ABS_PM_CURRENT15'),'LOW_PRIORITY_15S_ABS_PM_CURRENT15_PRIMARY');
});

test('minimum 100 independent forward outcomes plus Wilson and rolling risk gates',()=>{
  const x=proof('PM_FLOW15_CURRENT_03');
  assert.equal(forward15sProofPass(x),true);
  assert.ok(wilsonLower95(x.hits,x.strictForwardSamples)>0.7);
  assert.equal(wilsonLower95(4,0),null);
  for(const bad of [
    {...x,status:'COLLECTING'},
    {...x,strictForwardSamples:99,hits:83,misses:16},
    {...x,strictForwardSamples:120,hits:85,misses:35,forwardAccuracy:0.7083},
    {...x,recent30:{samples:30,accuracy:0.70}},
    {...x,recent20:{samples:20,accuracy:0.70}},
    {...x,recent10:{samples:10,accuracy:0.60}},
    {...x,up:{samples:9,accuracy:1}},
    {...x,down:{samples:50,accuracy:0.69}},
    {...x,upRecent6:{samples:6,accuracy:0.66}},
    {...x,downRecent6:{samples:6,accuracy:0.66}},
    {...x,currentMissStreak:3},
    {...x,hits:110,misses:11},
    {...x,strictForwardSamples:120,hits:90,misses:30,forwardAccuracy:0.75},
  ])assert.equal(forward15sProofPass(bad),false,JSON.stringify(bad));
});

test('only auto-qualified 15s candidates can preempt V2 at original 15-20s lock window',()=>{
  const row=makeRow(), p=proof('PM_FLOW15_CURRENT_03');
  for(const delay of [0,14999,20001,22000,25000,35000,300000])
    assert.equal(choose(row,[p],round+delay,'early').candidates.length,0,delay);
  for(const delay of [15500,17000,20000])
    assert.equal(choose(row,[p],round+delay,'early').candidates.length,1,delay);
  const first=choose(row,[p],round+15500,'early').candidates[0];
  assert.equal(first.source,candidateProductionSource('PM_FLOW15_CURRENT_03'));
  assert.equal(first.observedAt,round+15500);
  assert.equal(choose(row,[{...p,status:'COLLECTING'}],round+15500,'early').candidates.length,0);
  assert.equal(choose(row,[{...p,currentMissStreak:3}],round+15500,'early').candidates.length,0);
  assert.equal(choose(row,[{...p,strictForwardSamples:99}],round+15500,'early').candidates.length,0);
});

test('qualified 15s candidates may also rescue V2/Edge WAIT only at 25-35s',()=>{
  const row=makeRow(),p=proof('PM_FLOW15_CURRENT_03');
  for(const delay of [0,14999,16000,20000,24999,35001,300000])
    assert.equal(choose(row,[p],round+delay,'late').candidates.length,0,delay);
  assert.equal(choose(row,[p],round+25000,'late').candidates.length,1);
  assert.equal(choose(row,[p],round+35000,'late').candidates.length,1);
});

test('all ten lanes require identical auto promotion evidence, including former early opt-ins',()=>{
  const row=makeRow();
  for(const id of ['CURRENT_03_PM_AGREE','PM_CURRENT25_SUPPORT08','PM_FLOW15_CURRENT_03']){
    const passed=choose(row,[proof(id)]);
    assert.equal(passed.candidates.length,1,id);
    assert.equal(passed.candidates[0].source,candidateProductionSource(id));
    assert.equal(choose(row,[{...proof(id),status:'COLLECTING'}]).candidates.length,0,id);
  }
  assert.equal(choose(row,[]).reason,'NO_FORWARD_QUALIFIED_MODEL');
});

test('post-V2 rejected base may be rescued only in matching direction and after 15s freeze',()=>{
  const row=makeRow(),p=proof('PM_FLOW15_CURRENT_03');
  assert.equal(choose({...row,prediction:'UP',predictedAt:round+22000},[p]).candidates.length,1);
  assert.equal(choose({...row,prediction:'DOWN',predictedAt:round+22000},[p]).candidates.length,0);
  assert.equal(choose({...row,prediction:'UP',predictedAt:round+14000},[p]).candidates.length,0);
  for(const change of [
    {productionPrediction:'UP'},{actual:'UP'},{settledAt:round+300000},
    {productionSettledAt:round+300000},{roundStartMs:round+300000}
  ])assert.equal(choose({...row,...change},[p]).candidates.length,0);
});

test('never count retroactive/future, stale, cross-round or malformed captures',()=>{
  const p=proof('PM_FLOW15_CURRENT_03'), row=makeRow();
  for(const capture of [
    {observedAt:round+18000},{round:round-300000},
    {inputFrozenBeforeSettlement:false},{baseAbsentAtObservation:false},
    {observedAt:round+300001}
  ]){
    const changed={...row,v3NoBase15sShadow:{...row.v3NoBase15sShadow,...capture}};
    assert.equal(choose(changed,[p]).candidates.length,0);
  }
  for(const change of [
    {predictionMarketBookAgeMs:7000},{predictionMarketMappingReliable:false},
    {predictionMarketRoundAligned:false},{predictionMarketTopicId:null},
    {absorptionRisk:true},{tradeStreamStalled:true},{depthAgeMs:2000}
  ])assert.equal(choose(makeRow({...facts,...change}),[p]).candidates.length,0);
});

test('absorption pilots must not escape absorption-only safety scope',()=>{
  const p=proof('ABS_PM_CURRENT15');
  const clean=choose(makeRow(),[p]);
  assert.equal(clean.candidates.length,0);
  const risky=makeRow({...facts,absorptionRisk:true});
  assert.equal(choose(risky,[p]).candidates.length,1);
  const unsafe=makeRow({...facts,absorptionRisk:true,depthAgeMs:5000});
  assert.equal(choose(unsafe,[p]).candidates.length,0);
});

test('conservative market mid-price proxy blocks overpriced binary signals',()=>{
  const p=proof('CURRENT_03_PM_AGREE');
  assert.equal(choose(makeRow({...facts,predictionMarketUpMid:0.91}),[p]).candidates.length,0);
  const safe=choose(makeRow(),[p]);
  assert.equal(safe.candidates.length,1);
  assert.ok(safe.candidates[0].proof.estimatedNetEdge>0.02);
});

test('auto demotes on deteriorating recent evidence and can re-promote without deploying code',()=>{
  const row=makeRow(), good=proof('PM_FLOW15_CURRENT_03');
  assert.equal(choose(row,[good]).candidates.length,1);
  assert.equal(choose(row,[{...good,recent30:{samples:30,accuracy:0.66}}]).candidates.length,0);
  assert.equal(choose(row,[{...good,currentMissStreak:3}]).candidates.length,0);
  assert.equal(choose(row,[good]).candidates.length,1);
});

test('higher strict-forward rate wins ties only among independently qualified candidates',()=>{
  const row=makeRow();
  const good=proof('PM_FLOW15_CURRENT_03'),weak={...proof('PM_TREND_045_CURRENT_03'),forwardAccuracy:0.78};
  const selected=choose(row,[weak,good]);
  assert.equal(selected.candidates.length,2);
  assert.equal(selected.candidates[0].id,good.candidateId);
});

test('early priority still respects immutable lock, official-settlement and frozen-data guards',()=>{
  const row=makeRow(),p=proof('PM_FLOW15_CURRENT_03');
  for(const patch of [
    {productionPrediction:'DOWN'},{productionPrediction:'UP'},
    {actual:'UP'},{settledAt:round+300000},
    {roundStartMs:round+300000}
  ])assert.equal(choose({...row,...patch},[p],round+15500,'early').candidates.length,0);
  assert.equal(choose(makeRow({...facts,depthAgeMs:2500}),[p],round+15500,'early').candidates.length,0);
  assert.equal(choose({...row,prediction:'DOWN',predictedAt:round+14000},[p],round+16000,'early').candidates.length,0);
  assert.equal(choose(row,[p],round+15500,'unknown').candidates.length,0);
});

test('both former early opt-ins face full forward qualification before preempting V2',()=>{
  const row=makeRow();
  for(const id of ['PM_CURRENT25_SUPPORT08','CURRENT_03_PM_AGREE']){
    const p=proof(id);
    assert.equal(choose(row,[p],round+15500,'early').candidates.length,1,id);
    assert.equal(choose(row,[{...p,recent30:{samples:30,accuracy:0.7}}],round+15500,'early').candidates.length,0,id);
  }
});
