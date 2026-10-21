import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeWindow,closeExpiredWindow,finalize} from './deepseek-adaptive15-core.mjs';
import {createAdaptive15ProductionProvider,serveAdaptiveProduction} from './deepseek-adaptive15-production-adapter.mjs';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';

const round=1800000300000;
function providerAt(start,stored=null){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-hard-'));
 const signal=path.join(root,'signal.json');
 if(stored)fs.writeFileSync(signal,JSON.stringify(stored));
 let time=start;
 const prod=createAdaptive15ProductionProvider({clock:()=>time,
  env:{LLM_STATE_FILE:signal,DEEPSEEK_LEARNING_FILE:path.join(root,'learning.json'),
       DEEPSEEK_MODEL:'deepseek-flash'}});
 return {prod,setTime:n=>time=n,done:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('at exactly +15s an unfinalized round becomes permanent WAIT; cannot late lock',()=>{
 const w=makeWindow(round);
 assert.equal(closeExpiredWindow(w,round+14999),false);
 assert.equal(closeExpiredWindow(w,round+15000),true);
 assert.deepEqual({status:w.terminal.status,direction:w.terminal.direction,
    reason:w.terminal.reason},
    {status:'WAIT',direction:'WAIT',reason:'DEADLINE_15S_EXPIRED'});
 assert.equal(closeExpiredWindow(w,round+30000),false);
 assert.equal(w.terminal.at,round+15000);
 const out=finalize(w,round+16000);
 assert.equal(out.direction,'WAIT');
 assert.equal(out.skip,true);
});
test('no signal at +15 is WAIT, not thinking; fails closed',()=>{
 const x=providerAt(round+14999);
 try{
  assert.equal(x.prod.status().roundDecision.status,'ANALYZING');
  x.setTime(round+15000);
  const s=x.prod.status();
  assert.equal(s.roundDecision.status,'WAIT');
  assert.equal(s.roundDecision.direction,'WAIT');
  assert.equal(s.roundDecision.reason,'DEADLINE_15S_EXPIRED');
  assert.equal(s.signal,null);
  assert.equal(s.noSignalAfterDeadline,true);
 }finally{x.done()}
});
test('previously valid +10s lock remains in history but /signal is unavailable after +15s',async()=>{
 const s={ok:true,model:'DEEPSEEK_5M_V1',round,generatedAt:round+10000,
  readOnly:true,orders:false,productionIntegration:false,providerModel:'deepseek-flash',
  latest:{round,status:'LOCKED',direction:'UP',lockedAt:round+10000,
   marketAt:round+8500,entry:{direction:'UP',modelVersion:'DEEPSEEK_5M_V1'}}};
 const x=providerAt(round+14000,s);
 const server=serveAdaptiveProduction(x.prod,0);
 try{
  await new Promise(resolve=>server.once('listening',resolve));
  const port=server.address().port;
  assert.equal(x.prod.status().signal.round,round);
  x.setTime(round+15000);
  const d=x.prod.status();
  assert.equal(d.signal,null);
  assert.equal(d.roundDecision.status,'LOCKED'); // historical lock remains real, not wrongly flipped to WAIT
  const res=await fetch('http://127.0.0.1:'+port+'/signal');
  assert.equal(res.status,503);
  const payload=await res.json();
  assert.equal(payload.signalAvailable,false);
  assert.equal(payload.lateOrdersForbidden,true);
 }finally{
  await new Promise(resolve=>server.close(resolve));
  x.done();
 }
});
test('runner explicitly settles expired no-signal as WAIT once, even if a polling tick arrives late',async()=>{
 let now=round+12000,lockCount=0;
 const runner=createAdaptiveRunner({clock:()=>now,env:{ADAPTIVE15_ENABLE_AI:'0'},
  onLocked:()=>lockCount++,
  fetcher:async()=>{throw Error('NETWORK_NEVER_NEEDED')}});
 let first=runner.status();
 assert.equal(first.currentDecisionStatus,'ANALYZING');
 // create current through a prior warm step instead
 now=round-119000;await runner.tick();
 now=round+15000;
 const s=runner.status();
 assert.equal(s.lastCompleted.result,'WAIT');
 assert.equal(s.lastCompleted.direction,'WAIT');
 assert.equal(s.lastCompleted.reason,'DEADLINE_15S_EXPIRED');
 assert.equal(s.currentDecisionStatus,'WAIT');
 const count=s.skippedRounds;
 now=round+30000;
 const s2=runner.status();
 assert.equal(s2.skippedRounds,count);
 assert.equal(lockCount,0);
});
