import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardianFixedReadiness} from './guardian-fixed-readiness.mjs';
import {guardianOrderSignal,guardianQuoteGate,GUARDIAN_ID} from './guardian-live-bridge.mjs';

const now=Date.parse('2026-10-29T09:00:15Z');
function fixture(changes={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-risk-'));
  const paths={control:path.join(dir,'control.json'),status:path.join(dir,'status.json'),health:path.join(dir,'health.json')};
  const control={takeProfitEnabled:true,takeProfitPercent:95,stopLossEnabled:true,stopLossPercent:85};
  const runtime={at:new Date(now-1000).toISOString(),enabled:true,workerRunning:true,configApplied:true,guardianDynamicExitEnabled:false,transitioning:false,workerPid:4242};
  const health={at:new Date(now-1000).toISOString(),pid:4242,lastSuccessfulPositionsAt:new Date(now-2000).toISOString(),positionsSeen:0};
  Object.assign(control,changes.control);Object.assign(runtime,changes.runtime);Object.assign(health,changes.health);
  for(const [key,filename] of Object.entries(paths)) fs.writeFileSync(filename,JSON.stringify({control,runtime:runtime,health}[key]|| (key==='status'?runtime:null)));
  return {paths,dir};
}
test('fixed-only readiness becomes true only on the current worker and current position heartbeat',t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  const r=guardianFixedReadiness({now,paths:f.paths});
  assert.equal(r.ready,true);assert.equal(r.reason,null);
  assert.equal(r.fixedTakeProfitEnabled,true);assert.equal(r.fixedStopLossEnabled,true);
  assert.equal(r.dynamicExitEnabled,false);assert.equal(r.positionsSeen,0);
});
const failures=[
 ['disabled TP',{control:{takeProfitEnabled:false}},'FIXED_EXIT_DISABLED'],
 ['disabled SL',{control:{stopLossEnabled:false}},'FIXED_EXIT_DISABLED'],
 ['dynamic exit',{runtime:{guardianDynamicExitEnabled:true}},'DYNAMIC_EXIT_NOT_RETIRED'],
 ['worker stopped',{runtime:{workerRunning:false}},'RISK_WORKER_NOT_READY'],
 ['config not applied',{runtime:{configApplied:false}},'RISK_WORKER_NOT_READY'],
 ['transition',{runtime:{transitioning:true}},'RISK_WORKER_NOT_READY'],
 ['stale runtime',{runtime:{at:new Date(now-30000).toISOString()}},'RISK_HEARTBEAT_STALE'],
 ['stale positions',{health:{lastSuccessfulPositionsAt:new Date(now-30000).toISOString()}},'RISK_HEARTBEAT_STALE'],
 ['worker mismatch',{health:{pid:5}},'RISK_WORKER_HEALTH_MISMATCH'],
 ['unknown positions',{health:{positionsSeen:null}},'RISK_POSITION_CHECK_UNCONFIRMED'],
];
for(const [name,changes,reason] of failures)test(name+' fails closed',t=>{
 const f=fixture(changes);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
 const r=guardianFixedReadiness({now,paths:f.paths});
 assert.equal(r.ready,false);assert.equal(r.reason,reason);
});
test('missing health file never yields true',t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
 fs.unlinkSync(f.paths.health);
 assert.equal(guardianFixedReadiness({now,paths:f.paths}).reason,'RISK_STATE_UNAVAILABLE');
});
test('GUARDIAN current-round signal and non-expired real quote; WAIT and expired quote rejected',()=>{
 const round=Math.floor(now/300000)*300000,at=round+5000;
 const status={ok:true,model:GUARDIAN_ID,readOnly:true,orders:false,configured:true,observedAt:at,
   latest:{round,direction:'UP',status:'SHADOW_OBSERVATION'},
   records:[{round,predictedDirection:'UP',status:'PREDICTED',at,marketAt:at}],stats:{settled:1}};
 const s=guardianOrderSignal(status,at+500);
 assert.equal(s.ok,true);assert.equal(s.executionEligible,true);
 assert.equal(guardianQuoteGate(s,{quoteId:'quote-1',chance:0.53,expireAt:at+10000},{now:at+500}).ok,true);
 assert.equal(guardianQuoteGate(s,{quoteId:'quote-1',chance:0.53,expireAt:at+600},{now:at+500}).ok,false);
 status.latest.direction='WAIT';assert.equal(guardianOrderSignal(status,at+500).ok,false);
});
