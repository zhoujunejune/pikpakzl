import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMarketFusionFast8,VERSION,SOURCE,DEADLINE_MS,LOCK_BY_MS,INPUT_VERSION} from './market-fusion-fast8-router.mjs';

const round=1800000000000;
const prior=facts=>({sourceRound:round-300000,facts});
const run=(extra={})=>evaluateMarketFusionFast8({round,now:round+6800,...extra});

test('V2 version and cutoff isolate old settlement statistics',()=>{
 assert.equal(VERSION,'MARKET_FUSION_FAST8_V2');
 assert.match(INPUT_VERSION,/CURRENT1_TREND_MARKET_CAUSAL_V2_PRIOR80_CURRENT20/);
 assert.equal(LOCK_BY_MS,1000);
 assert.equal(DEADLINE_MS,8000);
});
test('prior trend can lock a genuine UP direction with unchanged order-policy source',()=>{
 const r=run({prior:prior({regimeScore:0.5})});
 assert.equal(r.status,'LOCKED');assert.equal(r.direction,'UP');assert.equal(r.source,SOURCE);
 assert.equal(r.model,VERSION);assert.equal(r.executionEligible,true);
 assert.equal(r.evidence.previousContractQuoteUsed,false);
});
test('momentum and order flow do not influence the scoring or direction fallback',()=>{
 const r=run({prior:prior({regimeScore:-0.5,normalizedMomentum15s:1,
   tradePressure15s:1,ofiNormalized5s:1})});
 assert.equal(r.direction,'DOWN');assert.equal(r.evidence.previousFeatureCount,1);
 assert.deepEqual(Object.keys(r.evidence.previousGroups),['trend']);
 const onlyRemoved=run({prior:prior({normalizedMomentum15s:1,tradePressure15s:1,
   ofiNormalized5s:1,microScore:1})});
 assert.equal(onlyRemoved.status,'DATA_UNAVAILABLE');
 assert.equal(onlyRemoved.executionEligible,false);
});
test('both rounds use 80 percent prior and 20 percent current when valid',()=>{
 const r=run({now:round+1100,prior:prior({regimeScore:0.55}),
   currentFacts:{regimeScore:-0.55},currentRoundAligned:true,
   currentObservedAt:round+1050});
 assert.equal(r.status,'LOCKED');assert.equal(r.direction,'UP');
 assert.equal(r.score,0.6);assert.equal(r.evidence.previousFeatureCount,1);
 assert.equal(r.evidence.currentFeatureCount,1);
});
test('previous-contract quotes never leak; aligned current contract quote can count',()=>{
 const x=run({prior:prior({predictionMarketUpMid:0.99,regimeScore:-0.5})});
 assert.equal(x.direction,'DOWN');assert.equal(x.evidence.currentContractQuoteUsed,false);
 const y=run({currentFacts:{predictionMarketUpMid:0.99,regimeScore:-0.2},
   currentRoundAligned:true,currentObservedAt:round+6500});
 assert.equal(y.direction,'DOWN');assert.equal(y.evidence.currentContractQuoteUsed,false);
 const z=run({currentFacts:{predictionMarketUpMid:0.99,regimeScore:-0.2,
   predictionMarketRoundAligned:true},currentRoundAligned:true,
   currentObservedAt:round+6500});
 assert.equal(z.direction,'UP');assert.equal(z.evidence.currentContractQuoteUsed,true);
});
test('T+1 second target never locks earlier even if valid prewarm exists',()=>{
 const input={prior:prior({regimeScore:-0.3})};
 assert.equal(run({...input,now:round+999}).status,'PENDING');
 const r=run({...input,now:round+1000});
 assert.equal(r.status,'LOCKED');assert.equal(r.direction,'DOWN');
});
test('missing/stale facts never result in a fabricated order-eligible direction',()=>{
 assert.equal(run({now:round+400}).status,'PENDING');
 assert.equal(run().status,'DATA_UNAVAILABLE');
 assert.equal(run({prior:{sourceRound:round-600000,facts:{regimeScore:0.9}}}).status,'DATA_UNAVAILABLE');
 assert.equal(run({currentRoundAligned:false,currentObservedAt:round+6500,
   currentFacts:{regimeScore:0.9}}).status,'DATA_UNAVAILABLE');
});
test('no signal may be locked after the original 8-second deadline',()=>{
 const r=run({now:round+8000,prior:prior({regimeScore:0.9})});
 assert.equal(r.status,'DATA_UNAVAILABLE');assert.equal(r.executionEligible,false);
});
