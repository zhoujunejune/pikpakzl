import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
const match=source.match(/function guardianExitMonitorReady\(now=Date\.now\(\)\) \{[\s\S]*?\n\}/);
if(!match)throw Error('GUARDIAN_EXIT_READY_FUNCTION_NOT_FOUND');

const now=1800000000000;
function evaluate({dynamic=true,fixed=false,worker=true,updated=now-1000,
  lastPositions=now-1500,guardian=true}={}){
 const data={
  '/tmp/risk-control.json':{dynamicExitEnabled:dynamic,stopLossEnabled:fixed,takeProfitEnabled:false},
  '/tmp/risk-runtime-status.json':{workerRunning:worker,configApplied:true,
   guardianDynamicExitEnabled:guardian,at:new Date(updated).toISOString()},
  '/tmp/risk-worker-health.json':{lastSuccessfulPositionsAt:new Date(lastPositions).toISOString()},
  '/tmp/guardian-risk-ready.json':{model:'ZL_GUARDIAN_5M_V1',enabled:true,
   realSellQuote:true,orderRegistry:true,at:now-500},
 };
 const fake={readFileSync(name){if(!(name in data))throw Error('missing');
  return JSON.stringify(data[name]);}};
 const ready=new Function('fs','GUARDIAN_ID','return ('+match[0].replace(/^function /,'function ')+')')(
  fake,'ZL_GUARDIAN_5M_V1');
 return ready(now);
}
test('dynamic exit requires functioning worker and a real guardian sell quote monitor',()=>{
 assert.equal(evaluate(),true);
 assert.equal(evaluate({worker:false}),false);
 assert.equal(evaluate({guardian:false}),false);
 assert.equal(evaluate({updated:now-8000}),false);
 assert.equal(evaluate({lastPositions:now-12000}),false);
});
test('dynamic OFF explicitly requires active fixed position protection',()=>{
 assert.equal(evaluate({dynamic:false,fixed:true,guardian:false}),true);
 assert.equal(evaluate({dynamic:false,fixed:false}),false);
});
