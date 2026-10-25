import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {injectAi40Dashboard,statsFromFiles,AI40_CUTOVER_ROUND_MS} from './ai40-dashboard-inject.mjs';
const R=AI40_CUTOVER_ROUND_MS;
const card='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">旧版5秒记录</section>';
const oldScript="<script>(function(){var rrMeta=document.getElementById('rrMeta');var z='/api/deepseek-round-results?limit=100';})();</script>";
const base='<html><body><nav id="botSelector">双机器人菜单</nav><button onclick="setV(true)">开始跟随</button>'+
 card+oldScript+'<section id="tpEditor">止盈止损控制</section></body></html>';

test('remove entire 5s HTML and collector; keep all existing trading controls untouched',()=>{
 const updated=injectAi40Dashboard(base);
 assert.ok(updated.includes('id="zlDeepSeek40Card"'));
 assert.ok(updated.includes('120秒'));
 assert.ok(updated.includes('15～40秒'));
 assert.ok(updated.includes('45秒'));
 assert.ok(updated.includes('High思考'));
 assert.ok(updated.includes('PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'));
 assert.ok(updated.includes("'/api/ai40-round-stats'"));
 assert.ok(!updated.includes('id="roundResultsOnlyCard"'));
 assert.ok(!updated.includes('旧版5秒记录'));
 assert.ok(!updated.includes('/api/deepseek-round-results?limit='));
 assert.ok(updated.includes('<nav id="botSelector">双机器人菜单</nav>'));
 assert.ok(updated.includes('<button onclick="setV(true)">开始跟随</button>'));
 assert.ok(updated.includes('<section id="tpEditor">止盈止损控制</section>'));
 assert.equal(updated.split('id="zlDeepSeek40Card"').length-1,1);
 const scripts=[...updated.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,1);
 assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));
 assert.ok(!scripts[0][1].includes("method:'POST'"));
});
test('no duplicate cards or changes to unrelated HTML',()=>{
 const updated=injectAi40Dashboard(base);
 assert.equal(injectAi40Dashboard(updated),updated);
 assert.equal(injectAi40Dashboard('<html><body>unrelated</body></html>'),'<html><body>unrelated</body></html>');
});
test('forward-only separate stats: 5 AI WAIT, 1 technical WAIT, old wins excluded and no fake 0% accuracy',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai40-stats-'));
 try{
  const learning=path.join(dir,'learner.json'),wait=path.join(dir,'wait.json');
  fs.writeFileSync(learning,JSON.stringify({schema:1,predictions:[
   {round:R-300000,direction:'UP',signalLatencyMs:35000,provider:'deepseek-flash',actual:'UP',hit:true},
   {round:R,direction:'DOWN',signalLatencyMs:17000,provider:'deepseek-flash',actual:null},
   {round:R+300000,direction:'UP',signalLatencyMs:25000,provider:'deepseek-flash',actual:'DOWN',hit:false},
   {round:R+600000,direction:'DOWN',signalLatencyMs:5000,provider:'deepseek-flash',actual:'DOWN',hit:true},
  ]}));
  const waits=Array.from({length:6},(_,i)=>({round:R+(i+3)*300000,direction:'WAIT',
    reason:'DEADLINE_40S_EXPIRED',detail:i===5?'NO_VALID_CURRENT_ROUND_DEEPSEEK_REVIEW':'DEEPSEEK_CHOSE_WAIT'}));
  fs.writeFileSync(wait,JSON.stringify({schema:1,records:waits}));
  const result=statsFromFiles(learning,wait,R+10*300000);
  assert.equal(result.ok,true);
  assert.equal(result.summary.rounds,8);
  assert.equal(result.summary.signals,2);
  assert.equal(result.summary.settled,1);
  assert.equal(result.summary.hits,0);
  assert.equal(result.summary.misses,1);
  assert.equal(result.summary.pending,1);
  assert.equal(result.summary.aiWait,5);
  assert.equal(result.summary.technicalWait,1);
  assert.equal(result.summary.accuracy,0);
  const onlyWaits=statsFromFiles(learning,wait,R+10*300000);
  assert.equal(onlyWaits.records.filter(x=>x.direction==='WAIT').length,6);
  const emptyLearning=path.join(dir,'empty.json');
  fs.writeFileSync(emptyLearning,JSON.stringify({schema:1,predictions:[]}));
  const none=statsFromFiles(emptyLearning,wait,R+10*300000);
  assert.equal(none.summary.settled,0);
  assert.equal(none.summary.accuracy,null);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('inaccessible or unknown legacy storage produces visible error, never misleading empty stats',()=>{
 const r=statsFromFiles('/tmp/no-such-ai40-learner.json','/tmp/no-such-ai40-wait.json');
 assert.equal(r.ok,false);
 assert.equal(r.error,'LEARNING_FILE_UNREADABLE');
});
