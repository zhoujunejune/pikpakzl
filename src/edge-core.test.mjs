import test from 'node:test';
import assert from 'node:assert/strict';
import {EDGE_MODEL,INPUT_VERSION,MIN_TRAINING_ROUNDS,roundAt,extractFeatures,
  scoreDirection,trainOnOfficial,summarize} from './edge-core.mjs';
const ROUND=1792166400000;
const t=ROUND+6000;
const trail=[
 {at:t-8000,spotPrice:70000,perpPrice:70008},
 {at:t-6500,spotPrice:70002,perpPrice:70014},
 {at:t-4000,spotPrice:70003,perpPrice:70018},
 {at:t-2200,spotPrice:70004,perpPrice:70020}
];
const observation={
 spotPrice:70010,perpPrice:70025,spotAt:t-100,perpAt:t-70,
 bids:Array.from({length:5},(_,i)=>[70000-i,2.5]),
 asks:Array.from({length:5},(_,i)=>[70011+i,1.5]),
 trades:[
  {T:t-900,q:'0.2',m:false},{T:t-780,q:'0.4',m:false},
  {T:t-510,q:'0.1',m:true},{T:t-340,q:'0.2',m:false}
 ]};
test('all five causal features require real synchronized book, trades, spot and perp',()=>{
 const f=extractFeatures(observation,trail,t);
 assert.equal(EDGE_MODEL,'EDGE_5M_V1');
 assert.equal(f.inputVersion,INPUT_VERSION);
 assert.equal(f.values.length,5);
 assert.equal(f.round,roundAt(t));
 assert.ok(f.values.every(Number.isFinite));
 for(const patch of [{bids:[]},{trades:[]},{spotAt:t-9000},
   {perpAt:t+2000},{perpPrice:null}]){
   const source={...observation,...patch};
   // The invalid-perp-price case must NOT synthesize a midpoint.
   assert.equal(extractFeatures(source,trail,t),null,JSON.stringify(patch));
 }
 assert.equal(extractFeatures(observation,[],t),null);
});
test('direction is observable before calibration but never executable',()=>{
 const features=extractFeatures(observation,trail,t);
 const raw=scoreDirection(features,null);
 assert.ok(['UP','DOWN'].includes(raw.direction));
 assert.equal(raw.calibrationReady,false);
 assert.equal(raw.executionEligible,false);
 assert.equal(raw.modelProbability,null);
 const calibrated=scoreDirection(features,{weights:[0,1,0,0,0,0],
   calibration:[0,1],calibrationReady:true});
 assert.equal(calibrated.executionEligible,true);
 assert.ok(calibrated.modelProbability>=.5&&calibrated.modelProbability<=1);
});
test('training cannot borrow predictions from unverified or un-settled rounds',()=>{
 assert.equal(MIN_TRAINING_ROUNDS,5000);
 const probe=extractFeatures(observation,trail,t);
 const rows=[{round:ROUND,direction:'UP',probe,actual:'UP',
   settledAt:ROUND+300000+100},{round:ROUND+300000,direction:'UP',probe,
   actual:null,settledAt:null}];
 const result=trainOnOfficial(rows);
 assert.equal(result.status,'COLLECTING');
 assert.equal(result.samples,1);
 assert.equal(result.calibrationReady,false);
 assert.equal(summarize(rows).overall.samples,1);
});
