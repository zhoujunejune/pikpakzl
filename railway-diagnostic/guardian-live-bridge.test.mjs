import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardianOrderSignal,guardianQuoteGate,guardianRegisterIntent,guardianMarkSubmitted,GUARDIAN_ID} from './guardian-live-bridge.mjs';
import {dynamicExit,registeredGuardianToken} from './guardian-dynamic-exit.mjs';
function fixture(now,direction='UP',statistics={settled:0,validated:false,wilsonLower:null}){
 const round=Math.floor(now/300000)*300000;
 return {ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-500,
  latest:{direction,round,status:'SHADOW_OBSERVATION'},
  records:[{round,at:now-1500,marketAt:now-2000,status:'PREDICTED',predictedDirection:direction}],
  stats:statistics,officialPriceFeedVerified:false};
}
test('TC-01/02: valid Guardian signal may pass with zero samples and low confidence',()=>{
 const now=1793182500000+72000;
 const signal=guardianOrderSignal(fixture(now),now);
 assert.equal(signal.ok,true);
 assert.equal(signal.executionEligible,true);
 assert.equal(signal.source,'FAST5_SPOT_MOMENTUM_V1');
 assert.equal(signal.modelProbability,null);
 assert.equal(signal.calibrationReady,false);
 assert.equal(guardianQuoteGate(signal,{quoteId:'binance-quote',chance:.98,expireAt:now+8000},{now}).ok,true);
});
test('no invented quote or expired quote can authorize a real BUY',()=>{
 const now=1793182500000+72000,signal=guardianOrderSignal(fixture(now),now);
 for(const quote of [{quoteId:'q',chance:.2},{quoteId:'q',chance:0,expireAt:now+6000},
  {quoteId:'q',chance:.2,expireAt:now+500},{quoteId:null,chance:.2,expireAt:now+6000}]){
  assert.equal(guardianQuoteGate(signal,quote,{now}).ok,false);
 }
});
test('TC-07: no arbitrary 15s replay or 25s end-of-round cutoff',()=>{
 const round=1793182200000,now=round+299000,payload=fixture(now,'DOWN');
 payload.records[0].at=round+1000;
 payload.records[0].marketAt=round+1000;
 const signal=guardianOrderSignal(payload,now);
 assert.equal(signal.ok,true);
 assert.equal(guardianQuoteGate(signal,{quoteId:'q',chance:.98,expireAt:now+5000},{now}).ok,true);
 assert.equal(guardianQuoteGate(signal,{quoteId:'q',chance:.98,expireAt:now+5000},{now:round+300000}).ok,false);
});
test('malformed or untrusted source and stale live feed fail closed',()=>{
 const now=1793182500000+72000,payload=fixture(now);
 assert.equal(guardianOrderSignal({...payload,orders:true},now).ok,false);
 assert.equal(guardianOrderSignal({...payload,observedAt:now-12000},now).ok,false);
 assert.equal(guardianOrderSignal({...payload,latest:{...payload.latest,direction:'WAIT'}},now).ok,false);
});

test('persisted GUARDIAN UP/DOWN remains locked when service reports OBSERVED next tick',()=>{
 const now=1793182500000+72000,original=fixture(now,'DOWN');
 const before=guardianOrderSignal(original,now);
 const observed={...original,latest:{direction:'OBSERVED',round:before.round,reason:'本轮已记录一次AI信号'}};
 const after=guardianOrderSignal(observed,now+5000);
 assert.equal(before.ok,true);
 assert.equal(after.ok,true);
 assert.equal(after.direction,'DOWN');
 assert.equal(after.signalId,before.signalId);
 assert.equal(after.executionEligible,true);
});
test('OBSERVED does not restore missing, settled, cross-round or stale signals',()=>{
 const now=1793182500000+72000,original=fixture(now,'UP');
 const observed={...original,latest:{direction:'OBSERVED',round:original.latest.round}};
 assert.equal(guardianOrderSignal({...observed,records:[]},now).ok,false);
 assert.equal(guardianOrderSignal({...observed,records:[{...original.records[0],status:'SETTLED'}]},now).ok,false);
 assert.equal(guardianOrderSignal({...observed,latest:{direction:'OBSERVED',round:original.latest.round-300000}},now).ok,false);
 assert.equal(guardianOrderSignal({...observed,observedAt:now-15000},now).ok,false);
 assert.equal(guardianOrderSignal({...observed,latest:{direction:'WAIT',round:original.latest.round}},now).ok,false);
});

test('registry only enables dynamic exits for order IDs accepted by Binance',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-registry-')),file=path.join(dir,'r.json');
 const round=1793182200000,tokenId='token-12345';
 try{
  guardianRegisterIntent({round,tokenId},{file});
  assert.equal(registeredGuardianToken(JSON.parse(fs.readFileSync(file)),tokenId,round),false);
  guardianMarkSubmitted({round,tokenId},'order-123',{file});
  assert.equal(registeredGuardianToken(JSON.parse(fs.readFileSync(file)),tokenId,round),true);
  assert.equal(registeredGuardianToken(JSON.parse(fs.readFileSync(file)),'wrong',round),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('dynamic exit uses real sell quote and peak, not BTC spot guess',()=>{
 const r=1793182200000,n=r+150000;
 assert.equal(dynamicExit({round:r,now:n,cost:1,current:.89,peak:1.1}).reason,'GUARDIAN_DYNAMIC_STOP_LOSS');
 assert.equal(dynamicExit({round:r,now:n,cost:1,current:1.12,peak:1.17}).reason,'GUARDIAN_DYNAMIC_TRAILING_TAKE_PROFIT');
 assert.equal(dynamicExit({round:r,now:n,cost:1,current:1.05,peak:1.05}).triggered,false);
 assert.equal(dynamicExit({round:r,now:r+296000,cost:1,current:.98,peak:1}).reason,'GUARDIAN_EXIT_BEFORE_SETTLEMENT');
 assert.equal(dynamicExit({round:r,now:n,cost:1,current:NaN,peak:1}).triggered,false);
});

