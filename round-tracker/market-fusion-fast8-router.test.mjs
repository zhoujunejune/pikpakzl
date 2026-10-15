import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMarketFusionFast8,VERSION,SOURCE,DEADLINE_MS} from './market-fusion-fast8-router.mjs';

const start=1800000000000;
const prior=facts=>({sourceRound:start-300000,facts});
const run=(props={})=>evaluateMarketFusionFast8({round:start,now:start+6800,...props});

test('market fusion locks UP from observed positive BTC momentum/flow/trend within eight seconds',()=>{
 const result=run({prior:prior({regimeScore:0.5,normalizedMomentum15s:0.31,
   normalizedMomentum60s:0.25,tradePressure15s:0.35,ofiNormalized5s:0.2})});
 assert.equal(result.status,'LOCKED');
 assert.equal(result.direction,'UP');
 assert.equal(result.source,SOURCE);
 assert.equal(result.model,VERSION);
 assert.equal(result.executionEligible,true);
 assert.ok(result.elapsedMs<DEADLINE_MS);
 assert.equal(result.evidence.previousContractQuoteUsed,false);
});
test('market fusion locks DOWN for aligned negative flow and momentum',()=>{
 const result=run({prior:prior({normalizedMomentum15s:-0.25,tradePressure15s:-0.4,
   currentTrendScore:-0.35,regimeScore:-0.4})});
 assert.equal(result.status,'LOCKED');
 assert.equal(result.direction,'DOWN');
 assert.equal(result.evidence.probabilityCalibrated,false);
});
test('prior prediction-market quote is NEVER a predictor of the next contract',()=>{
 const x=run({prior:prior({predictionMarketUpMid:0.99,normalizedMomentum15s:-0.4})});
 assert.equal(x.status,'LOCKED');
 assert.equal(x.direction,'DOWN');
 assert.equal(x.evidence.currentContractQuoteUsed,false);
 const y=run({currentFacts:{predictionMarketUpMid:0.99,normalizedMomentum15s:-0.2},
   currentRoundAligned:true,currentObservedAt:start+6500});
 assert.equal(y.evidence.currentContractQuoteUsed,false);
 const z=run({currentFacts:{predictionMarketUpMid:0.99,normalizedMomentum15s:-0.2,
   predictionMarketRoundAligned:true},currentRoundAligned:true,currentObservedAt:start+6500});
 assert.equal(z.evidence.currentContractQuoteUsed,true);
});
test('no data does not invent clock parity, confidence, or order eligibility',()=>{
 const early=run({now:start+3000});
 assert.equal(early.status,'PENDING');
 const end=run();
 assert.equal(end.status,'DATA_UNAVAILABLE');
 assert.equal(end.executionEligible,false);
 assert.equal(end.direction,undefined);
});
test('stale or mismatched previous-round data is excluded',()=>{
 const stale=run({prior:{sourceRound:start-600000,facts:{regimeScore:0.9}}});
 assert.equal(stale.status,'DATA_UNAVAILABLE');
 const missing=run({currentRoundAligned:false,currentObservedAt:start+6600,
   currentFacts:{normalizedMomentum15s:0.8}});
 assert.equal(missing.status,'DATA_UNAVAILABLE');
});
test('strong current-round signal can lock before 6.5 seconds',()=>{
 const result=run({now:start+1400,
   currentRoundAligned:true,currentObservedAt:start+1200,
   currentFacts:{normalizedMomentum15s:0.35,tradePressure15s:0.45,
     currentTrendScore:0.5,ofiNormalized5s:0.4}});
 assert.equal(result.status,'LOCKED');
 assert.equal(result.direction,'UP');
 assert.ok(result.elapsedMs<6500);
});
test('model never locks after the 8-second deadline',()=>{
 const x=run({now:start+8000,prior:prior({regimeScore:0.9})});
 assert.equal(x.status,'DATA_UNAVAILABLE');
 assert.equal(x.executionEligible,false);
});
