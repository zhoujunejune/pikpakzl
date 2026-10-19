import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSelectiveV2Fast8,PRIMARY_SOURCE,RESCUE_SOURCE,UNVERIFIED_SOURCE,
 POLICY_VERSION,LOCK_DEADLINE_MS,FALLBACK_COMMIT_MS} from '../round-tracker/selective-v2-fast8-router.mjs';
import {SELECTIVE8_MODEL,ORDER_SIGNAL_MODELS,validateSelective8ProductionLive,
 SELECTIVE8_INPUT_VERSION,BASE_MODEL,EDGE_MODEL} from './production-signal-choice.mjs';
const R=1792387800000;
const market={currentScore:-0.32,currentTrendScore:-0.1,
 normalizedMomentum15s:-0.3,regimeScore:-0.2,
 predictionMarketUpMid:0.41,absorptionRisk:false,liveScore:-1};
const low=()=>({pass:false,reasons:['NO_QUALIFICATION']});
const edgeLow=()=>({pass:false,reasons:['EDGE_NOT_QUALIFIED']});
const quality=()=>({pass:true});
const base={round:R,facts:market,sourceRound:R-300000,previousRoundFeatureCount:4,
 currentRoundFeatureCount:1,previousInputVersion:SELECTIVE8_INPUT_VERSION};

test('the only real-order model is exactly screenshot Selective V2 8-sec router',()=>{
 assert.deepEqual(ORDER_SIGNAL_MODELS.map(x=>x.id),[POLICY_VERSION]);
 assert.equal(SELECTIVE8_MODEL,POLICY_VERSION);
 assert.notEqual(BASE_MODEL,SELECTIVE8_MODEL);
 assert.notEqual(EDGE_MODEL,SELECTIVE8_MODEL);
});
test('original first-tier Selective emits unmodified direction from real currentScore',()=>{
 const x=routeSelectiveV2Fast8({...base,now:R+1500,quality,edge:edgeLow});
 assert.equal(x.status,'LOCKED');assert.equal(x.direction,'DOWN');
 assert.equal(x.source,PRIMARY_SOURCE);assert.equal(x.executionEligible,true);
});
test('original second-tier Edge Rescue emits same market direction',()=>{
 const x=routeSelectiveV2Fast8({...base,now:R+1500,quality:low,edge:()=>({pass:true})});
 assert.equal(x.status,'LOCKED');assert.equal(x.source,RESCUE_SOURCE);
 assert.equal(x.direction,'DOWN');
});
test('third-tier low-evidence market direction is frozen at +7 seconds',()=>{
 const x=routeSelectiveV2Fast8({...base,now:R+FALLBACK_COMMIT_MS,quality:low,edge:edgeLow});
 assert.equal(x.status,'LOCKED');assert.equal(x.source,UNVERIFIED_SOURCE);
 assert.equal(x.executionEligible,true);assert.equal(x.direction,'DOWN');
 assert.equal(x.fallbackUsed,true);
 const y=routeSelectiveV2Fast8({...base,now:R+6999,quality:low,edge:edgeLow});
 assert.equal(y.status,'PENDING');
 const z=routeSelectiveV2Fast8({...base,now:R+LOCK_DEADLINE_MS,quality,edge:edgeLow});
 assert.notEqual(z.status,'LOCKED');
});
test('no real market score never invents a direction, regardless of deadline',()=>{
 const x=routeSelectiveV2Fast8({...base,facts:{},now:R+7500,quality:low,edge:edgeLow});
 assert.notEqual(x.status,'LOCKED');
});
function live({source=UNVERIFIED_SOURCE,lockTime=7076,mode=POLICY_VERSION,round=R,
 enabled=true,dir='DOWN'}={}){
 return {ok:true,live:{round,status:'LOCKED',model:mode,modelVersion:mode,
   source,signal:{direction:dir,score:null},generatedAt:R+lockTime,
   productionLockedAt:R+lockTime,executionEligible:enabled,
   fallbackUsed:source===UNVERIFIED_SOURCE,
   fallbackReason:source===UNVERIFIED_SOURCE?'UNVERIFIED_REAL_MARKET_DIRECTION':null,
   frozen:true}};
}
test('validates actual immutable frozen V2 source, which no longer has transient fast8Quality',()=>{
 const good=validateSelective8ProductionLive(live(),R+8500);
 assert.equal(good.ok,true);assert.equal(good.model,POLICY_VERSION);
 assert.equal(good.fallbackUsed,true);assert.equal(good.direction,'DOWN');
});
test('reject unrelated models and stale/incorrect or unfrozen signals before trading',()=>{
 assert.equal(validateSelective8ProductionLive(live({mode:BASE_MODEL}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live({source:'RSI_ONLY'}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live({lockTime:8000}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live({enabled:false}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live({round:R-300000}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live({dir:'WAIT'}),R+8500).ok,false);
 assert.equal(validateSelective8ProductionLive(live(),R+300001).ok,false);
 const fabricated=live();fabricated.live.fallbackReason='ANOTHER_REASON';
 assert.equal(validateSelective8ProductionLive(fabricated,R+8500).ok,false);
});
