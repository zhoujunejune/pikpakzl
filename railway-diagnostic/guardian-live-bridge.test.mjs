import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardianOrderSignal,guardianQuoteGate,guardianRegisterIntent,guardianMarkSubmitted,GUARDIAN_ID} from './guardian-live-bridge.mjs';
import {dynamicExit,registeredGuardianToken} from './guardian-dynamic-exit.mjs';
test('guardian read-only source cannot authorize trades without independent qualification',()=>{
 const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
 const row={round,at:now-1500,marketAt:now-2000,status:'PREDICTED',predictedDirection:'UP'};
 const payload={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-500,
  latest:{direction:'UP',round,status:'SHADOW_OBSERVATION'},records:[row],
  stats:{settled:0,validated:false,wilsonLower:null},officialPriceFeedVerified:false};
 const signal=guardianOrderSignal(payload,now);
 assert.equal(signal.ok,true);
 assert.equal(signal.executionEligible,false);
 assert.equal(guardianQuoteGate(signal,{quoteId:'q',chance:.2,expireAt:now+4000},{now}).ok,false);
});
test('qualified Guardian can only execute if market net edge is positive',()=>{
 const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
 const row={round,at:now-1500,marketAt:now-2000,status:'PREDICTED',predictedDirection:'DOWN'};
 const payload={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-500,
  latest:{direction:'DOWN',round,status:'SHADOW_OBSERVATION'},records:[row],
  stats:{settled:600,validated:true,wilsonLower:.80},officialPriceFeedVerified:true};
 const signal=guardianOrderSignal(payload,now);
 assert.equal(signal.executionEligible,true);
 assert.equal(guardianQuoteGate(signal,{quoteId:'q',chance:.60,expireAt:now+4000},{now}).ok,true);
 assert.equal(guardianQuoteGate(signal,{quoteId:'q',chance:.79,expireAt:now+4000},{now}).ok,false);
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

test('previous signal cannot be replayed more than 15s later',()=>{
 const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
 const row={round,at:now-16000,marketAt:now-17000,status:'PREDICTED',predictedDirection:'UP'};
 const payload={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,
   observedAt:now-500,latest:{direction:'UP',round,status:'SHADOW_OBSERVATION'},
   records:[row],stats:{settled:400,validated:true,wilsonLower:.8},
   officialPriceFeedVerified:true};
 assert.equal(guardianOrderSignal(payload,now).ok,false);
});

test('owner-authorized mode can bypass research thresholds but never invent win probability',()=>{
 const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
 const payload={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-500,
  latest:{direction:'DOWN',round,status:'SHADOW_OBSERVATION'},
  records:[{round,at:now-1800,marketAt:now-2000,status:'PREDICTED',predictedDirection:'DOWN'}],
  stats:{settled:30,validated:false,wilsonLower:.79},officialPriceFeedVerified:false};
 const normal=guardianOrderSignal(payload,now);
 assert.equal(normal.executionEligible,false);
 const owner=guardianOrderSignal(payload,now,{ownerAllowsUncalibrated:true});
 assert.equal(owner.ok,true);
 assert.equal(owner.executionEligible,true);
 assert.equal(owner.calibrationReady,false);
 assert.equal(owner.modelProbability,null);
 assert.equal(owner.riskMode,'OWNER_UNCALIBRATED');
 assert.equal(owner.qualityGate,'OWNER_AUTHORIZED_UNCALIBRATED_NO_KNOWN_EDGE');
 const goodQuote={quoteId:'real-quote',chance:.63,expireAt:now+5000};
 const allowed=guardianQuoteGate(owner,goodQuote,{now});
 assert.equal(allowed.ok,true);assert.equal(allowed.edge,null);
 assert.equal(allowed.validatedProbability,false);
 assert.equal(guardianQuoteGate(owner,{...goodQuote,chance:.93},{now}).ok,false);
 assert.equal(guardianQuoteGate(owner,{...goodQuote,expireAt:now+100},{now}).ok,false);
 assert.equal(guardianQuoteGate(owner,{...goodQuote,quoteId:null},{now}).ok,false);
});
test('owner override cannot reopen stale, wrong-round, or almost-settled signals',()=>{
 const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
 const payload={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-500,
  latest:{direction:'UP',round,status:'SHADOW_OBSERVATION'},
  records:[{round,at:now-16000,marketAt:now-2000,status:'PREDICTED',predictedDirection:'UP'}],
  stats:{settled:30,validated:false,wilsonLower:.79},officialPriceFeedVerified:false};
 assert.equal(guardianOrderSignal(payload,now,{ownerAllowsUncalibrated:true}).ok,false);
 payload.records[0].at=now-1000;
 assert.equal(guardianOrderSignal(payload,round+299000,{ownerAllowsUncalibrated:true}).ok,false);
 assert.equal(guardianOrderSignal({...payload,model:'OTHER'},now,{ownerAllowsUncalibrated:true}).ok,false);
});
