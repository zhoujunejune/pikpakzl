import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSelectiveV2Fast8 as route,LOCK_DEADLINE_MS,PRIMARY_SOURCE,RESCUE_SOURCE,
  UNVERIFIED_SOURCE,INPUT_VERSION} from './selective-v2-fast8-router.mjs';
const round=1791977400000;
const base={currentScore:0.8,normalizedMomentum15s:0.2,liveScore:0.72,
  predictionMarketUpMid:0.7,absorptionRisk:false};
const opts={round,now:round+200,sourceRound:round-300000,
  previousRoundFeatureCount:17,currentRoundFeatureCount:1,
  previousInputVersion:'PRIOR_ROUND_TAIL_22_TO_10S_RESERVE120_STRICT_V2'};
test('main Selective V2 qualifies within 8s without changed thresholds',()=>{
 const a=route({...opts,facts:base,quality:()=>({pass:true,reasons:[]}),
   edge:()=>{throw Error('should not evaluate rescue')}});
 assert.equal(a.status,'LOCKED');assert.equal(a.direction,'UP');
 assert.equal(a.source,PRIMARY_SOURCE);assert.equal(a.executionEligible,true);
 assert.equal(a.inputVersion,INPUT_VERSION);assert.ok(a.elapsedMs<LOCK_DEADLINE_MS);
});
test('only when V2 fails does original Edge Rescue qualify',()=>{
 const a=route({...opts,facts:base,quality:()=>({pass:false,reasons:['REJECT']}),
   edge:()=>({pass:true,reasons:[]})});
 assert.equal(a.status,'LOCKED');assert.equal(a.source,RESCUE_SOURCE);
 assert.equal(a.executionEligible,true);assert.equal(a.direction,'UP');
});
test('low-confidence direction is labeled and eligible before the deadline',()=>{
 const a=route({...opts,now:round+7800,facts:base,
   quality:()=>({pass:false,reasons:['FILTER']}),
   edge:()=>({pass:false,reasons:['FILTER']})});
 assert.equal(a.source,UNVERIFIED_SOURCE);assert.equal(a.status,'LOCKED');
 assert.equal(a.executionEligible,true);assert.equal(a.fallbackUsed,true);
 assert.equal(a.confidence,null);assert.equal(a.direction,'UP');
});
test('missing contract quote cannot qualify the filters',()=>{
 const f={...base,predictionMarketUpMid:null};
 const a=route({...opts,now:round+7900,facts:f,currentRoundFeatureCount:0,
   quality:()=>{throw Error('no valid contract quote')},
   edge:()=>{throw Error('no valid contract quote')}});
 assert.equal(a.executionEligible,true);assert.equal(a.direction,'UP');
});
test('no measurements means explicit DATA_UNAVAILABLE, never fabricate UP/DOWN',()=>{
 const a=route({...opts,facts:{},now:round+7800});
 assert.equal(a.status,'DATA_UNAVAILABLE');assert.equal(a.signal,null);
 assert.equal(a.executionEligible,false);assert.equal(a.direction,undefined);
});
test('missing values and booleans are not silently converted to zero',()=>{
 const a=route({...opts,facts:{currentScore:null,
  normalizedMomentum15s:undefined,currentTrendScore:false,
  normalizedMomentum30s:'',regimeScore:null},now:round+7900});
 assert.equal(a.status,'DATA_UNAVAILABLE');
});
test('DOWN direction is propagated, not a clock-parity fallback',()=>{
 const a=route({...opts,facts:{...base,currentScore:-0.9},quality:()=>({pass:true})});
 assert.equal(a.direction,'DOWN');
});
test('too late cannot claim a qualified 8-second production signal',()=>{
 const a=route({...opts,facts:base,now:round+9000,quality:()=>({pass:true})});
 assert.equal(a.status,'DATA_UNAVAILABLE');assert.equal(a.executionEligible,false);
});
