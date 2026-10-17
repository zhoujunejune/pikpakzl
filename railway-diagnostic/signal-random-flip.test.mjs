import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRandomSignalFlip,shouldFlipSignal,SIGNAL_RANDOM_FLIP_VERSION} from './signal-random-flip.mjs';
import {BASE_MODEL,NOVICE_MODEL} from './production-signal-choice.mjs';
import {applyDirectionSettings,mappedOrderSignal,invalidateDirectionSettings} from './order-direction-policy.mjs';

const ROUND=1792166400000;
function raw(model,round,side='UP'){
 return {status:'LOCKED',round,direction:side,
   upstreamModel:model,source:'SELECTIVE_V2_FAST8_PRIMARY',signalId:'signal:'+round,
   score:.34,executionEligible:true,lockedAt:round+5400};
}
test('both models: exactly one stable output transform per round, across repeated reads',()=>{
 for(const model of [BASE_MODEL,NOVICE_MODEL]){
  for(let i=0;i<240;i++){
   const input=raw(model,ROUND+i*300000,i%2?'DOWN':'UP');
   const transformed=applyRandomSignalFlip(input,model);
   assert.equal(input.direction,i%2?'DOWN':'UP'); // immutable upstream source
   assert.equal(transformed.rawDirection,input.direction);
   assert.equal(transformed.randomFlipVersion,SIGNAL_RANDOM_FLIP_VERSION);
   assert.equal(transformed.randomFlipProbability,0.5);
   assert.equal(transformed.direction,transformed.randomFlipApplied?
     (input.direction==='UP'?'DOWN':'UP'):input.direction);
   assert.deepEqual(applyRandomSignalFlip(raw(model,input.round,input.direction),model),transformed);
   assert.equal(applyRandomSignalFlip(transformed,model),transformed); // no double flip
  }
 }
});
test('flip hash is independent across model identities, approximately half across rounds',()=>{
 for(const model of [BASE_MODEL,NOVICE_MODEL]){
  let flips=0;
  for(let i=0;i<1000;i++)flips+=Number(shouldFlipSignal(model,ROUND+i*300000));
  assert.ok(flips>=420&&flips<=580,'expected approximately 50% flip, observed '+flips);
 }
 assert.throws(()=>shouldFlipSignal('UNKNOWN',ROUND),/INVALID_RANDOM_FLIP_IDENTITY/);
 assert.throws(()=>shouldFlipSignal(BASE_MODEL,ROUND+1),/INVALID_RANDOM_FLIP_IDENTITY/);
});
test('reverse/forward mapping applies to FINAL emitted signal, never the original',()=>{
 applyDirectionSettings({revision:'flip-check',modes:{
  SELECTIVE_V2_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'INVERSE'},
  EDGE_RESCUE_FAST8_PRIMARY:{UP:'OFF',DOWN:'OFF'},
  SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION:{UP:'OFF',DOWN:'OFF'}
 }});
 try{
  for(const model of [BASE_MODEL,NOVICE_MODEL]){
   for(let i=0;i<100;i++){
    const s=applyRandomSignalFlip(raw(model,ROUND+i*300000),model);
    const mapped=mappedOrderSignal(s);
    assert.equal(mapped.productionSignal,s.direction);
    assert.equal(mapped.orderSignal,s.direction==='UP'?'UP':'UP');
    assert.equal(mapped.mappingMode,s.direction==='UP'?'FORWARD':'INVERSE');
   }
  }
 }finally{invalidateDirectionSettings();}
});
test('nonlocked signals are not randomized, invalid locked signals fail closed',()=>{
 const waiting={round:ROUND,status:'WAIT',direction:null};
 assert.equal(applyRandomSignalFlip(waiting,BASE_MODEL),waiting);
 assert.throws(()=>applyRandomSignalFlip({status:'LOCKED',round:ROUND,direction:'WAIT'},BASE_MODEL),/INVALID_RANDOM_FLIP_DIRECTION/);
});
