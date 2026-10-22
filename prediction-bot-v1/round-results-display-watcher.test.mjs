import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRoundResultsJournal} from './round-results-only-journal.mjs';
import {createDisplayWatcher} from './round-results-display-watcher.mjs';
const R=1792626900000;
const valid=(round,at)=>({round,model:'DEEPSEEK_5M_V1',
 latest:{round,status:'LOCKED',direction:'DOWN',lockedAt:at,
 decisionMethod:'DEEPSEEK_SINGLE_CALL_5S'}});
test('separate display watcher reads locked round + official only, no model training',async()=>{
 let now=R+1100;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zl-display-'));
 const journal=createRoundResultsJournal({file:path.join(dir,'results.ndjson'),clock:()=>now});
 let officialCalls=0,modelCalls=0;
 const watcher=createDisplayWatcher({clock:()=>now,journal,
   modelUrl:'http://mock/model',officialUrl:'http://mock/official',fetcher:async url=>{
    if(url==='http://mock/model'){
     modelCalls++;return {ok:true,json:async()=>({ok:true,model:'DEEPSEEK_5M_V1',
      maxCallsPerRound:1,learningDisabled:true,
      roundDecision:{status:'LOCKED'},signal:valid(R,R+1050)})};
    }
    if(url==='http://mock/official'){
     officialCalls++;return {ok:true,json:async()=>({ok:true,
      settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
      records:[{roundStartMs:R,productionActual:'DOWN',
       productionSettledAt:R+302000,officialSettlementAudit:{verified:true}}]})};
    }
    throw Error('unknown route');
   }});
 try{
  await watcher.tick();
  assert.equal(watcher.history().records[0].lockedAt,R+1050);
  assert.equal(watcher.history().summary.settled,0);
  now=R+310000;await watcher.tick();await watcher.settleOnce();
  assert.equal(watcher.history().summary.wins,1);
  assert.equal(watcher.history().summary.accuracy,100);
  assert.equal(watcher.status().learningDisabled,true);
  assert.equal(watcher.status().orderEnabled,false);
  assert.equal(officialCalls,1);
  assert.equal(modelCalls,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('display failure cannot modify model or fabricate direction',async()=>{
 let now=R+500;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zl-display-'));
 const journal=createRoundResultsJournal({file:path.join(dir,'results.ndjson'),clock:()=>now});
 const watcher=createDisplayWatcher({clock:()=>now,journal,fetcher:async()=>{throw Error('offline')}});
 try{
  await watcher.tick();now=R+16000;await watcher.tick();
  assert.equal(watcher.history().summary.noSignal,1);
  assert.equal(watcher.history().summary.signals,0);
  assert.equal(watcher.status().lastModelError,'offline');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
