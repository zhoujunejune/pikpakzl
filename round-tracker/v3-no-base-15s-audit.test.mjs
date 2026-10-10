import test from 'node:test';
import assert from 'node:assert/strict';
import {
 freezeNoBase15s,summarizeNoBase15s,V3_NO_BASE_15S_VERSION
} from './v3-no-base-15s-audit.mjs';
const round=Date.parse('2026-10-10T11:00:00.000Z');
const facts={
 predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
 predictionMarketBookAgeMs:100,predictionMarketUpMid:0.59,
 currentScore:0.50,currentTrendScore:0.70,liveScore:0.12,
 distanceFromOpenBps:1.2,tradeCount15s:30,depthAgeMs:100,
 lastAggTradeAgeMs:100,tradeStreamStalled:false,absorptionRisk:false,
 regimeDirection:'RANGE',regimeAgreement:0.33,predictionMarketTopicId:'test-topic'
};
const row=()=>({roundStartMs:round,prediction:null,predictedAt:null});
test('15s real no-base observation accepts only fresh, aligned signals; production unaffected',()=>{
 const f=freezeNoBase15s(row(),facts,round+15500);
 assert.equal(f.version,V3_NO_BASE_15S_VERSION);
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 assert.equal(f.baseAbsentAtObservation,true);
 assert.equal(f.candidates.CURRENT_04_TREND_055_PM05.decision,'UP');
 assert.equal(f.candidates.PM_LEAN_03.decision,'UP');
 assert.equal(f.facts.dataFresh,true);
});
test('null book or depth age is NOT converted to fresh age zero',()=>{
 for(const key of ['predictionMarketBookAgeMs','depthAgeMs','lastAggTradeAgeMs']){
   const bad=freezeNoBase15s(row(),{...facts,[key]:null},round+15500);
   assert.ok(bad);
   assert.equal(bad.facts.dataFresh,false);
   assert.equal(bad.candidates.PM_LEAN_03.decision,'WAIT');
   assert.ok(bad.facts.gateFailures.length>0);
 }
});
test('frozen 15s snapshot counts despite later raw base direction',()=>{
 const f=freezeNoBase15s(row(),facts,round+15500);
 const r={...row(),prediction:'UP',predictedAt:round+24000,
   actual:'UP',officialDirection:'UP',roundEndMs:round+300000,
   resolutionEvidence:'OFFICIAL_UP:variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
   v3NoBase15sShadow:f};
 const s=summarizeNoBase15s(new Map([[round,r]]));
 assert.equal(s.observedNoBaseSettledRounds,1);
 assert.equal(s.candidates.find(x=>x.candidateId==='CURRENT_04_TREND_055_PM05').hits,1);
 assert.equal(s.autoProduction,false);
});
test('reject backfill, future observation, pre-observation lock and nonofficial outcome',()=>{
 assert.equal(freezeNoBase15s(row(),facts,round+14999),null);
 assert.equal(freezeNoBase15s(row(),facts,round+17001),null);
 assert.equal(freezeNoBase15s({...row(),predictedAt:round+10000},facts,round+15010),null);
 const f=freezeNoBase15s(row(),facts,round+15500);
 const record={...row(),actual:'UP',officialDirection:'UP',
    resolutionEvidence:'MANUAL_UP',v3NoBase15sShadow:f};
 assert.equal(summarizeNoBase15s(new Map([[round,record]])).observedNoBaseSettledRounds,0);
 record.resolutionEvidence='OFFICIAL_UP:variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC';
 record.v3NoBase15sShadow={...f,observedAt:round+300001};
 assert.equal(summarizeNoBase15s(new Map([[round,record]])).observedNoBaseSettledRounds,0);
});
test('shadow has explicit rejection reasons instead of silent WAIT',()=>{
 const r=freezeNoBase15s(row(),{...facts,predictionMarketUpMid:0.51},round+15500);
 assert.equal(r.candidates.CURRENT_04_TREND_055_PM05.decision,'WAIT');
 assert.ok(r.candidates.CURRENT_04_TREND_055_PM05.reasons.includes('PM_NEUTRAL'));
});

test('new independent confirmation candidates stay shadow-only and require agreement',()=>{
 const f=freezeNoBase15s(row(),facts,round+15500);
 assert.equal(f.candidates.PM_FLOW15_CURRENT_03.decision,'UP');
 assert.equal(f.candidates.PM_TREND_045_CURRENT_03.decision,'UP');
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 const conflict=freezeNoBase15s(row(),{...facts,currentScore:-0.4},round+15500);
 assert.equal(conflict.candidates.PM_FLOW15_CURRENT_03.decision,'WAIT');
 assert.equal(conflict.candidates.PM_TREND_045_CURRENT_03.decision,'WAIT');
 const stale=freezeNoBase15s(row(),{...facts,depthAgeMs:5001},round+15500);
 assert.equal(stale.candidates.PM_FLOW15_CURRENT_03.decision,'WAIT');
});


test('flat-price no-base PM/regime pilots are prospective-only and never bypass quality gates',()=>{
 const flat={...facts,distanceFromOpenBps:0,regimeScore:0.56};
 const f=freezeNoBase15s(row(),flat,round+15500);
 assert.equal(f.candidates.PM_REGIME35_SUPPORT08.decision,'UP');
 assert.equal(f.candidates.PM_CURRENT25_SUPPORT08.decision,'UP');
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 const conflict=freezeNoBase15s(row(),{...flat,regimeScore:-0.9,regimeDirection:'DOWN',regimeAgreement:0.9},round+15500);
 assert.equal(conflict.candidates.PM_REGIME35_SUPPORT08.decision,'WAIT');
 assert.equal(conflict.candidates.PM_CURRENT25_SUPPORT08.decision,'WAIT');
 const bad=freezeNoBase15s(row(),{...flat,predictionMarketConflict:true},round+15500);
 assert.equal(bad.candidates.PM_REGIME35_SUPPORT08.decision,'WAIT');
 assert.equal(bad.candidates.PM_CURRENT25_SUPPORT08.decision,'WAIT');
 const stale=freezeNoBase15s(row(),{...flat,predictionMarketBookAgeMs:6000},round+15500);
 assert.equal(stale.candidates.PM_REGIME35_SUPPORT08.decision,'WAIT');
 assert.equal(stale.candidates.PM_CURRENT25_SUPPORT08.decision,'WAIT');
});
test('new pilots cannot backfill old frozen observations',()=>{
 const frozen=freezeNoBase15s(row(),{...facts,regimeScore:0.56},round+15500);
 delete frozen.candidates.PM_REGIME35_SUPPORT08;
 delete frozen.candidates.PM_CURRENT25_SUPPORT08;
 const historical={...row(),actual:'UP',officialDirection:'UP',
   resolutionEvidence:'OFFICIAL_UP:canonical_outcome_winner_direct:STRICT_ROUND_ALIGNED_TOPIC',
   v3NoBase15sShadow:frozen};
 const status=summarizeNoBase15s(new Map([[round,historical]]));
 for(const id of ['PM_REGIME35_SUPPORT08','PM_CURRENT25_SUPPORT08']){
   const candidate=status.candidates.find(x=>x.candidateId===id);
   assert.equal(candidate.strictForwardSamples,0);
   assert.equal(candidate.status,'COLLECTING');
 }
});




test('absorption-only pilots preserve original WAIT and never waive feed quality',()=>{
 const start=Date.parse('2026-10-10T12:00:00.000Z');
 const r={roundStartMs:start,prediction:'WAIT',predictedAt:null};
 const absorbed={...facts,absorptionRisk:true,regimeScore:0.56,
   predictionMarketUpMid:0.61,currentScore:0.30};
 const f=freezeNoBase15s(r,absorbed,start+15500);
 assert.deepEqual(f.facts.gateFailures,['ABSORPTION_RISK']);
 assert.equal(f.facts.dataFresh,false);
 assert.equal(f.facts.absorptionRiskAtFreeze,true);
 assert.equal(f.candidates.PM_LEAN_03.decision,'WAIT');
 assert.equal(f.candidates.ABS_PM_CURRENT15.decision,'UP');
 assert.equal(f.candidates.ABS_PM_REGIME35.decision,'UP');
 const stale=freezeNoBase15s(r,{...absorbed,depthAgeMs:8000},start+15500);
 assert.equal(stale.candidates.ABS_PM_CURRENT15.decision,'WAIT');
 assert.equal(stale.candidates.ABS_PM_REGIME35.decision,'WAIT');
 const weak=freezeNoBase15s(r,{...absorbed,predictionMarketUpMid:0.52},start+15500);
 assert.equal(weak.candidates.ABS_PM_CURRENT15.decision,'WAIT');
 const conflicting=freezeNoBase15s(r,{...absorbed,currentScore:-0.5,regimeScore:-0.5},start+15500);
 assert.equal(conflicting.candidates.ABS_PM_CURRENT15.decision,'WAIT');
 assert.equal(conflicting.candidates.ABS_PM_REGIME35.decision,'WAIT');
 const clean=freezeNoBase15s(r,{...absorbed,absorptionRisk:false},start+15500);
 assert.equal(clean.candidates.ABS_PM_CURRENT15.decision,'WAIT');
 assert.equal(clean.candidates.PM_LEAN_03.decision,'UP');
});
test('new absorption candidate histories cannot be backfilled or retrofitted',()=>{
 const oldStart=Date.parse('2026-10-10T11:45:00.000Z');
 const oldRow={roundStartMs:oldStart,prediction:'WAIT',predictedAt:null};
 const f=freezeNoBase15s(oldRow,{...facts,absorptionRisk:true,regimeScore:0.56},oldStart+15500);
 assert.equal(f.candidates.ABS_PM_CURRENT15.decision,'WAIT');
 assert.ok(f.candidates.ABS_PM_CURRENT15.reasons.includes('PILOT_NOT_STARTED'));
 const settled={...oldRow,actual:'UP',officialDirection:'UP',
   resolutionEvidence:'OFFICIAL_UP:canonical_outcome_winner_direct:STRICT_ROUND_ALIGNED_TOPIC',
   v3NoBase15sShadow:f};
 const summary=summarizeNoBase15s(new Map([[oldStart,settled]]));
 assert.equal(summary.candidates.find(c=>c.candidateId==='ABS_PM_CURRENT15').strictForwardSamples,0);
});
