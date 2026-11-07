import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardianRegisterIntent,guardianMarkSubmitted} from './guardian-live-bridge.mjs';
import {guardianRiskQuote,guardianRiskHeartbeat} from './guardian-risk-integration.mjs';

test('Guardian risk is off until an explicit opt-in',()=>{
 assert.equal(guardianRiskQuote({tokenId:'token-001',cost:1,current:.8},{enabled:false}),null);
});
test('only Binance-accepted registered Guardian token can trigger real-quote SELL decision',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-risk-'));
 const registryFile=path.join(dir,'orders.json'),peakFile=path.join(dir,'peaks.json');
 const round=Math.floor(Date.now()/300000)*300000,at=round+90000;
 const opts={enabled:true,registryFile,peakFile};
 try{
  guardianRegisterIntent({round,tokenId:'token-001'},{file:registryFile});
  assert.equal(guardianRiskQuote({tokenId:'token-001',cost:1,current:.89,at},opts),null);
  guardianMarkSubmitted({round,tokenId:'token-001'},'binance-accepted-001',{file:registryFile});
  assert.equal(guardianRiskQuote({tokenId:'other-token',cost:1,current:.50,at},opts),null);
  const a=guardianRiskQuote({tokenId:'token-001',cost:1,current:.89,at},opts);
  assert.equal(a.ok,true);assert.equal(a.dynamic,true);
  assert.equal(a.triggered,true);assert.equal(a.kind,'STOP_LOSS');
  const stored=JSON.parse(fs.readFileSync(peakFile,'utf8'));
  assert.equal(stored.entries.length,1);
  assert.equal(stored.entries[0].peak,.89);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('peak survives across independent risk evaluations and triggers trailing profit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-peak-'));
 const registryFile=path.join(dir,'orders.json'),peakFile=path.join(dir,'peaks.json');
 const round=Math.floor(Date.now()/300000)*300000,opts={enabled:true,registryFile,peakFile};
 try{
  guardianRegisterIntent({round,tokenId:'token-002'},{file:registryFile});
  guardianMarkSubmitted({round,tokenId:'token-002'},'order-002',{file:registryFile});
  const first=guardianRiskQuote({tokenId:'token-002',cost:1,current:1.17,at:round+50000},opts);
  assert.equal(first.triggered,false);
  const second=guardianRiskQuote({tokenId:'token-002',cost:1,current:1.12,at:round+70000},opts);
  assert.equal(second.reason,'GUARDIAN_DYNAMIC_TRAILING_TAKE_PROFIT');
  assert.equal(second.kind,'TAKE_PROFIT');
  assert.equal(second.targetAmount,1.13);
  assert.equal(guardianRiskQuote({tokenId:'token-002',cost:1,current:NaN,at:round+80000},opts).ok,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('heartbeat never claims readiness while disabled',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-heartbeat-'));
 const file=path.join(dir,'heartbeat.json');
 try{
  guardianRiskHeartbeat(true,{enabled:false,file});
  assert.equal(fs.existsSync(file),false);
  guardianRiskHeartbeat(true,{enabled:true,file,at:1793182200000});
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(r.model,'ZL_GUARDIAN_5M_V1');
  assert.equal(r.enabled,true);assert.equal(r.realSellQuote,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
