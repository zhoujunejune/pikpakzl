import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardianFixedReadiness} from './guardian-fixed-readiness.mjs';

// Test the same helper imported by both the protected wrapper and /api/status.
// Never start a trading listener or call the exchange.
const now=1800000000000;
function evaluate({tp=true,sl=true,dynamic=false,worker=true,configApplied=true,
  statusAge=1000,healthAge=1000,positionAge=1500,positionsSeen=0,
  transitioning=false,pid=4242,healthPid=4242}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-fixed-exits-'));
 const paths={
  control:path.join(dir,'risk-control.json'),
  status:path.join(dir,'risk-runtime-status.json'),
  health:path.join(dir,'risk-worker-health.json'),
 };
 try {
  fs.writeFileSync(paths.control,JSON.stringify({
    takeProfitEnabled:tp,stopLossEnabled:sl,
    takeProfitPercent:95,stopLossPercent:85,
  }));
  fs.writeFileSync(paths.status,JSON.stringify({
    enabled:tp||sl,workerRunning:worker,configApplied,
    guardianDynamicExitEnabled:dynamic,transitioning,workerPid:pid,
    at:new Date(now-statusAge).toISOString(),
  }));
  fs.writeFileSync(paths.health,JSON.stringify({
    pid:healthPid,at:new Date(now-healthAge).toISOString(),
    lastSuccessfulPositionsAt:new Date(now-positionAge).toISOString(),
    positionsSeen,
  }));
  return guardianFixedReadiness({now,paths}).ready;
 } finally {
  fs.rmSync(dir,{recursive:true,force:true});
 }
}
test('fixed-only Guardian readiness requires both controls and real worker health',()=>{
 assert.equal(evaluate(),true);
 assert.equal(evaluate({tp:false}),false);
 assert.equal(evaluate({sl:false}),false);
 assert.equal(evaluate({tp:false,sl:false}),false);
});
test('dynamic exit is never a substitute for fixed exits',()=>{
 assert.equal(evaluate({dynamic:true}),false);
 assert.equal(evaluate({tp:false,dynamic:true}),false);
});
test('fixed exit readiness fails closed on stale, mismatched, or transitioning worker',()=>{
 for(const change of [
  {worker:false},{configApplied:false},{transitioning:true},
  {statusAge:7000},{statusAge:-500},{healthAge:7000},
  {positionAge:11000},{positionAge:-500},{positionsSeen:null},
  {healthPid:9999},
 ]) assert.equal(evaluate(change),false,JSON.stringify(change));
});
