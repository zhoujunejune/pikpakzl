import test from 'node:test';
import assert from 'node:assert/strict';
import {
 freezeNoBase20s,summarizeNoBase20s,V3_NO_BASE_20S_VERSION
} from './v3-no-base-20s-audit.mjs';
const round=Date.parse('2026-10-09T06:00:00.000Z');
const facts={
 predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
 predictionMarketBookAgeMs:100,predictionMarketUpMid:0.59,
 currentScore:0.50,currentTrendScore:0.70,liveScore:0.12,
 distanceFromOpenBps:1.2,tradeCount15s:30,depthAgeMs:100,
 lastAggTradeAgeMs:100,tradeStreamStalled:false,absorptionRisk:false,
 regimeDirection:'RANGE',regimeAgreement:0.33,predictionMarketTopicId:'test-topic'
};
const row=()=>({roundStartMs:round,prediction:null,predictedAt:null});
test('20s real no-base observation accepts only fresh, aligned signals; production unaffected',()=>{
 const f=freezeNoBase20s(row(),facts,round+20500);
 assert.equal(f.version,V3_NO_BASE_20S_VERSION);
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 assert.equal(f.baseAbsentAtObservation,true);
 assert.equal(f.candidates.CURRENT_04_TREND_055_PM05.decision,'UP');
 assert.equal(f.candidates.PM_LEAN_03.decision,'UP');
 assert.equal(f.facts.dataFresh,true);
});
test('null book or depth age is NOT converted to fresh age zero',()=>{
 for(const key of ['predictionMarketBookAgeMs','depthAgeMs','lastAggTradeAgeMs']){
   const bad=freezeNoBase20s(row(),{...facts,[key]:null},round+20500);
   assert.ok(bad);
   assert.equal(bad.facts.dataFresh,false);
   assert.equal(bad.candidates.PM_LEAN_03.decision,'WAIT');
   assert.ok(bad.facts.gateFailures.length>0);
 }
});
test('frozen 20s snapshot counts despite later raw base direction',()=>{
 const f=freezeNoBase20s(row(),facts,round+20500);
 const r={...row(),prediction:'UP',predictedAt:round+24000,
   actual:'UP',officialDirection:'UP',roundEndMs:round+300000,
   resolutionEvidence:'OFFICIAL_UP:variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
   v3NoBase20sShadow:f};
 const s=summarizeNoBase20s(new Map([[round,r]]));
 assert.equal(s.observedNoBaseSettledRounds,1);
 assert.equal(s.candidates.find(x=>x.candidateId==='CURRENT_04_TREND_055_PM05').hits,1);
 assert.equal(s.autoProduction,false);
});
test('reject backfill, future observation, pre-observation lock and nonofficial outcome',()=>{
 assert.equal(freezeNoBase20s(row(),facts,round+19999),null);
 assert.equal(freezeNoBase20s(row(),facts,round+22001),null);
 assert.equal(freezeNoBase20s({...row(),predictedAt:round+10000},facts,round+20010),null);
 const f=freezeNoBase20s(row(),facts,round+20500);
 const record={...row(),actual:'UP',officialDirection:'UP',
    resolutionEvidence:'MANUAL_UP',v3NoBase20sShadow:f};
 assert.equal(summarizeNoBase20s(new Map([[round,record]])).observedNoBaseSettledRounds,0);
 record.resolutionEvidence='OFFICIAL_UP:variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC';
 record.v3NoBase20sShadow={...f,observedAt:round+300001};
 assert.equal(summarizeNoBase20s(new Map([[round,record]])).observedNoBaseSettledRounds,0);
});
test('shadow has explicit rejection reasons instead of silent WAIT',()=>{
 const r=freezeNoBase20s(row(),{...facts,predictionMarketUpMid:0.51},round+20500);
 assert.equal(r.candidates.CURRENT_04_TREND_055_PM05.decision,'WAIT');
 assert.ok(r.candidates.CURRENT_04_TREND_055_PM05.reasons.includes('PM_NEUTRAL'));
});

test('new independent confirmation candidates stay shadow-only and require agreement',()=>{
 const f=freezeNoBase20s(row(),facts,round+20500);
 assert.equal(f.candidates.PM_FLOW15_CURRENT_03.decision,'UP');
 assert.equal(f.candidates.PM_TREND_045_CURRENT_03.decision,'UP');
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 const conflict=freezeNoBase20s(row(),{...facts,currentScore:-0.4},round+20500);
 assert.equal(conflict.candidates.PM_FLOW15_CURRENT_03.decision,'WAIT');
 assert.equal(conflict.candidates.PM_TREND_045_CURRENT_03.decision,'WAIT');
 const stale=freezeNoBase20s(row(),{...facts,depthAgeMs:5001},round+20500);
 assert.equal(stale.candidates.PM_FLOW15_CURRENT_03.decision,'WAIT');
});
