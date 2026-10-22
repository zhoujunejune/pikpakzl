import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDisplayWatcher,serveWatcher} from './round-results-display-watcher.mjs';
import {createRoundResultsJournal} from './round-results-only-journal.mjs';
const R=1792626900000;
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ai15-watch-'));
function model(now,direction='DOWN'){
 const locked=now>=R+10500;
 return {ok:true,model:'DEEPSEEK_5M_V1',maxCallsPerRound:1,learningDisabled:true,
  signal:locked?{model:'DEEPSEEK_5M_V1',round:R,
   latest:{status:'LOCKED',direction,lockedAt:R+10450,
    decisionMethod:'DEEPSEEK_SINGLE_CALL_15S'}}:null,
  roundDecision:{status:locked?'LOCKED':'ANALYZING'}};
}
test('a 15s DeepSeek AI lock at T+10s is not marked NO_SIGNAL at T+5s',async()=>{
 const dir=mk(),f=path.join(dir,'display.ndjson');let now=R+300;let p;
 const watcher=createDisplayWatcher({clock:()=>now,journal:createRoundResultsJournal({clock:()=>now,file:f}),
   fetcher:async()=>({ok:true,json:async()=>model(now)})});
 try{
  await watcher.tick();
  now=R+6700;await watcher.tick();
  assert.equal(watcher.history().summary.noSignal,0);
  now=R+10600;await watcher.tick();
  const row=watcher.history().records[0];
  assert.equal(row.status,'LOCKED');
  assert.equal(row.direction,'DOWN');
  assert.equal(row.decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
  assert.equal(row.latencyMs,10450);
  now=R+15300;await watcher.tick();
  assert.equal(watcher.history().summary.noSignal,0);
  assert.equal(watcher.history().summary.signals,1);
  assert.equal(createRoundResultsJournal({file:f,clock:()=>now}).history().records[0].decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('never claim no signal at 5s when AI analysis still underway; mark NO_SIGNAL after 15s if genuine miss',async()=>{
 const dir=mk();let now=R+300;
 const watcher=createDisplayWatcher({clock:()=>now,journal:createRoundResultsJournal({clock:()=>now,file:path.join(dir,'x.ndjson')}),
  fetcher:async()=>({ok:true,json:async()=>({ok:true,model:'DEEPSEEK_5M_V1',maxCallsPerRound:1,
   learningDisabled:true,roundDecision:{status:'ANALYZING'},signal:null})})});
 try{
  await watcher.tick();now=R+7800;await watcher.tick();
  assert.equal(watcher.history().summary.rounds,0);
  now=R+15500;await watcher.tick();
  assert.equal(watcher.history().records[0].status,'NO_SIGNAL');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('15s journal accepts existing pre-upgrade rows and never relabels actual method as price fallback',()=>{
 const dir=mk(),f=path.join(dir,'historic.ndjson');
 const ev=[
  {schema:1,kind:'ROUND',round:R,status:'LOCKED',direction:'DOWN',lockedAt:R+4600,
   decisionMethod:'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK',recordedAt:R+4600},
  {schema:1,kind:'ROUND',round:R+300000,status:'LOCKED',direction:'UP',
   lockedAt:R+312700,decisionMethod:'DEEPSEEK_SINGLE_CALL_15S',recordedAt:R+312700}
 ];
 fs.writeFileSync(f,ev.map(x=>JSON.stringify(x)).join('\n')+'\n');
 try{
  const journal=createRoundResultsJournal({file:f,clock:()=>R+650000});
  assert.equal(journal.history().ok,true);
  assert.equal(journal.history().records[0].decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
  assert.equal(journal.history().records[1].decisionMethod,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
