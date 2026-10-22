import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFastProductionProvider,buildFastSignal} from './deepseek-single5-production.mjs';

const ROUND=1792626900000;
function market(now){
  return {ok:true,readOnly:true,symbol:'BTCUSDT',
   latest:{eventMs:now,roundStartMs:ROUND,lastPrice:101,roundOpenPrice:100,marketFeedConnected:true}};
}
const tick=()=>new Promise(r=>setImmediate(r));
const file=tag=>'/tmp/deepseek15-scope-'+tag+'-'+process.pid+'.json';
function cleanup(p){try{fs.unlinkSync(p)}catch{};try{fs.unlinkSync(p.replace(/\.json$/,'.ndjson'))}catch{}}
test('No price fallback even after T+4.45 seconds, AI locks after T+10 seconds',async()=>{
 let now=ROUND+1000;
 let resolveAI,aiCalls=0;
 const f=file('yes');
 const p=createFastProductionProvider({env:{DEEPSEEK_API_KEY:'test',LLM_STATE_FILE:f,AI15_DIAGNOSTIC_FILE:f.replace(/\.json$/,'.ndjson')},
 clock:()=>now,fetcher:async (uri,opts)=>{
  if(uri.includes('shadow-market-data'))return {ok:true,json:async()=>market(now)};
  aiCalls++;
  return new Promise(resolve=>{resolveAI=()=>resolve({ok:true,json:async()=>({
    choices:[{message:{content:'{"direction":"DOWN","reason":"DeepSeek trend inference"}'}}],
    usage:{total_tokens:77}})})});
 }});
 try{
  await p.tick();await tick();
  assert.equal(aiCalls,1);
  now=ROUND+4700;
  await p.tick();
  assert.equal(p.status().signal,null,'No synthetic price decision at 4.45s');
  now=ROUND+10200;
  await p.tick();
  resolveAI();
  await tick();
  const s=p.status();
  assert.equal(s.signal.latest.direction,'DOWN');
  assert.equal(s.signal.latest.decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
  assert.equal(s.signal.latest.lockedAt,now);
  assert.equal(s.decisionWindowEndMs,ROUND+15000);
  assert.equal(s.maxCallsPerRound,1);
  assert.equal(s.learningDisabled,true);
  assert.equal(s.trainingDisabled,true);
  assert.equal(s.statisticsDisabled,true);
  assert.equal(s.decisionRule,'DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK');
 }finally{cleanup(f)}
});
test('Invalid AI response is logged and no UP/DOWN signal is manufactured at 15 seconds',async()=>{
 let now=ROUND+1100;
 const f=file('bad');
 const p=createFastProductionProvider({env:{DEEPSEEK_API_KEY:'test',LLM_STATE_FILE:f,AI15_DIAGNOSTIC_FILE:f.replace(/\.json$/,'.ndjson')},
 clock:()=>now,fetcher:async (uri)=>{
  if(uri.includes('shadow-market-data'))return {ok:true,json:async()=>market(now)};
  return {ok:true,json:async()=>({choices:[{message:{content:'{"direction":"WAIT"}'}}],usage:{total_tokens:12}})};
 }});
 try{
  await p.tick();await tick();
  assert.equal(p.status().error,'INVALID_AI_DIRECTION');
  now=ROUND+4650;await p.tick();
  assert.equal(p.status().signal,null);
  now=ROUND+15002;await p.tick();
  const s=p.status();
  assert.equal(s.roundDecision.status,'UNAVAILABLE');
  assert.equal(s.roundDecision.reason,'INVALID_AI_DIRECTION');
  assert.equal(s.signal,null);
  const log=fs.readFileSync(f.replace(/\.json$/,'.ndjson'),'utf8');
  assert.match(log,/deepseek15_analysis_failed/);
  assert.match(log,/deepseek15_round_unavailable/);
 }finally{cleanup(f)}
});
test('After 15 seconds an in-flight DeepSeek response never enters previous or next round',async()=>{
 let now=ROUND+1000;let resolveAI;
 const f=file('late');
 const p=createFastProductionProvider({env:{DEEPSEEK_API_KEY:'test',LLM_STATE_FILE:f,AI15_DIAGNOSTIC_FILE:f.replace(/\.json$/,'.ndjson')},
 clock:()=>now,fetcher:async(uri)=>{
  if(uri.includes('shadow-market-data'))return {ok:true,json:async()=>market(now)};
  return new Promise(resolve=>{resolveAI=()=>resolve({ok:true,json:async()=>({
   choices:[{message:{content:'{"direction":"UP","reason":"late"}'}}]})})});
 }});
 try{
  await p.tick();await tick();
  now=ROUND+15005;await p.tick();
  assert.equal(p.status().signal,null);
  assert.equal(p.status().roundDecision.status,'UNAVAILABLE');
  resolveAI();await tick();
  assert.equal(p.status().signal,null);
  assert.equal(p.status().lastFailure.reason,'AI_RESPONSE_AFTER_15S');
 }finally{cleanup(f)}
});
test('15 second signal build enforces deadline and refuses other rounds',()=>{
 const base={round:ROUND,tick:{round:ROUND,at:ROUND+12900,open:100,price:99},
  decision:{direction:'DOWN',method:'DEEPSEEK_SINGLE_CALL_15S'},providerModel:'deepseek-flash'};
 assert.equal(buildFastSignal({...base,at:ROUND+14200}).latest.direction,'DOWN');
 assert.throws(()=>buildFastSignal({...base,at:ROUND+15000}),/INVALID_15_SECOND_REAL_SIGNAL/);
});

test('successfully locks fresh DeepSeek direction in every successive 5-minute round',async()=>{
 let now=ROUND+900,requests=0;
 const f=file('crossround'),df=f.replace(/\.json$/,'.ndjson');
 const provider=createFastProductionProvider({
  env:{DEEPSEEK_API_KEY:'test',LLM_STATE_FILE:f,AI15_DIAGNOSTIC_FILE:df},
  clock:()=>now,
  fetcher:async (url)=>{
   if(url.includes('shadow-market-data')){
    return {ok:true,json:async()=>({ok:true,readOnly:true,symbol:'BTCUSDT',
     latest:{eventMs:now,roundStartMs:Math.floor(now/300000)*300000,
      lastPrice:101,roundOpenPrice:100,marketFeedConnected:true}})};
   }
   const direction=++requests===1?'UP':'DOWN';
   return {ok:true,json:async()=>({choices:[{message:{
    content:JSON.stringify({direction,reason:'current round AI answer'})}}],usage:{total_tokens:50}})};
  }
 });
 try{
  await provider.tick();await tick();
  assert.equal(provider.status().signal?.latest.direction,'UP');
  assert.equal(provider.status().signal?.latest.decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
  assert.equal(provider.status().signal?.round,ROUND);
  now=ROUND+300000+950;
  await provider.tick();await tick();
  assert.equal(requests,2,'Model must actually be invoked for the new round');
  assert.equal(provider.status().signal?.round,ROUND+300000);
  assert.equal(provider.status().signal?.latest.direction,'DOWN','Old saved pointer must not suppress a new AI decision');
  assert.equal(provider.status().signal?.latest.decisionMethod,'DEEPSEEK_SINGLE_CALL_15S');
  assert.equal(provider.status().lastDecision?.round,ROUND+300000);
  now=ROUND+600000+1050;
  await provider.tick();await tick();
  assert.equal(requests,3,'Third round must also analyze');
  assert.equal(provider.status().signal?.round,ROUND+600000);
  assert.equal(provider.status().signal?.latest.direction,'DOWN');
  const lines=fs.readFileSync(df,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter(z=>z.event==='deepseek15_locked').length,3);
 }finally{cleanup(f)}
});
