import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
const readySource=source.match(/function guardianExitMonitorReady\(now=Date\.now\(\)\) \{[\s\S]*?\n\}/)?.[0];
const helper=source.match(/function guardianRiskState\(paths\) \{[\s\S]*?\n\}/)?.[0];
if(!readySource||!helper)throw Error('GUARDIAN_FIXED_EXIT_READY_FUNCTION_NOT_FOUND');
const now=1800000000000;

function evaluate({tp=true,sl=true,dynamic=false,worker=true,configApplied=true,
  statusAge=1000,positionAge=1500,positionsSeen=0,transitioning=false}={}) {
 const data={
  '/tmp/risk-control.json':{takeProfitEnabled:tp,stopLossEnabled:sl},
  '/tmp/risk-runtime-status.json':{
   enabled:tp||sl,workerRunning:worker,configApplied,
   guardianDynamicExitEnabled:dynamic,transitioning,
   at:new Date(now-statusAge).toISOString()},
  '/tmp/risk-worker-health.json':{
   lastSuccessfulPositionsAt:new Date(now-positionAge).toISOString(),positionsSeen}
 };
 const fake={readFileSync(name){if(!(name in data))throw Error('missing');
   return JSON.stringify(data[name]);}};
 const fn=new Function('fs','GUARDIAN_ID',helper+'\nreturn ('+readySource+')')(
   fake,'ZL_GUARDIAN_5M_V1');
 return fn(now);
}
test('fixed-only Guardian readiness requires both actual enabled controls, not merely saved percentages',()=>{
 assert.equal(evaluate(),true);
 assert.equal(evaluate({tp:false}),false);
 assert.equal(evaluate({sl:false}),false);
 assert.equal(evaluate({tp:false,sl:false}),false);
});
test('no fallback to dynamic Guardian exits, irrespective of their reported liveness',()=>{
 assert.equal(evaluate({dynamic:true}),false);
 assert.equal(evaluate({tp:false,dynamic:true}),false);
});
test('fixed exit readiness fails closed for stopped, transitioning or stale risk worker',()=>{
 assert.equal(evaluate({worker:false}),false);
 assert.equal(evaluate({configApplied:false}),false);
 assert.equal(evaluate({transitioning:true}),false);
 assert.equal(evaluate({statusAge:7000}),false);
 assert.equal(evaluate({statusAge:-500}),false);
 assert.equal(evaluate({positionAge:11000}),false);
 assert.equal(evaluate({positionAge:-500}),false);
 assert.equal(evaluate({positionsSeen:null}),false);
});
