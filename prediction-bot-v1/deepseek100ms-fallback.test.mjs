import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFastProductionProvider} from './deepseek-single5-production.mjs';

const ROUND=1792626900000;
const next=()=>new Promise(r=>setImmediate(r));
const file=(label)=>'/tmp/ai100-fallback-'+label+'-'+process.pid+'.json';
function remove(p){for(const f of [p,p.replace(/\.json$/,'.ndjson')]){try{fs.unlinkSync(f)}catch{}}}
const quote=(now,round,price=101,open=100)=>({
 ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{roundStartMs:round,eventMs:now,lastPrice:price,roundOpenPrice:open,marketFeedConnected:true}
});
function newBot(label,clock,fetcher){
 const f=file(label);
 const p=createFastProductionProvider({
  env:{DEEPSEEK_API_KEY:'test',LLM_STATE_FILE:f,
   AI15_DIAGNOSTIC_FILE:f.replace(/\.json$/,'.ndjson')},
  clock,fetcher});
 return {p,f};
}
test('DeepSeek can win if its actual valid UP is returned within 100ms',async()=>{
 let now=ROUND+18,apiCalls=0;
 const {p,f}=newBot('fast-ai',()=>now,async url=>{
  if(url.includes('shadow-market-data'))return {ok:true,json:async()=>quote(now,ROUND)};
  apiCalls++;return {ok:true,json:async()=>({
   choices:[{message:{content:'{"direction":"UP","reason":"fast"}'}}],usage:{total_tokens:12}})};
 });
 try{
  await p.tick();await next();
  const s=p.status();
  assert.equal(apiCalls,1);
  assert.equal(s.roundDecision.status,'LOCKED');
  assert.equal(s.signal.latest.direction,'UP');
  assert.equal(s.signal.latest.decisionMethod,'DEEPSEEK_SINGLE_CALL_5S');
  assert.equal(s.signal.latest.lockedAt,ROUND+18);
  assert.equal(s.decisionWindowEndMs,ROUND+100);
  assert.equal(s.fallbackMarketDeadlineMs,ROUND+15000);
  assert.equal(s.maxCallsPerRound,1);
 }finally{remove(f)}
});
test('At 100ms, valid current-round price produces UP without waiting for slow DeepSeek',async()=>{
 let now=ROUND+22,apiCalls=0,answer;
 const {p,f}=newBot('fallback',()=>now,async url=>{
  if(url.includes('shadow-market-data'))return {ok:true,json:async()=>quote(now,ROUND,100.5,100)};
  apiCalls++;return new Promise(resolve=>{answer=()=>resolve({ok:true,json:async()=>({
    choices:[{message:{content:'{"direction":"DOWN"}'}}]})})});
 });
 try{
  await p.tick();await next();
  assert.equal(apiCalls,1);
  assert.equal(p.status().signal,null);
  now=ROUND+110;await p.tick();
  let s=p.status();
  assert.equal(s.signal.latest.direction,'UP');
  assert.equal(s.signal.latest.decisionMethod,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
  assert.equal(s.signal.latest.lockedAt,ROUND+110);
  assert.equal(s.signal.latest.marketAt,ROUND+22);
  answer();await next();
  assert.equal(p.status().signal.latest.direction,'UP','late model DOWN never overrides locked UP');
  assert.equal(p.status().lastDecision.method,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
  assert.equal(p.status().error,null);
 }finally{remove(f)}
});
test('When the first valid quote arrives at T+2s, lock honestly at T+2s, not fake 100ms',async()=>{
 let now=ROUND+90,feedValid=false,aiCalls=0;
 const {p,f}=newBot('late-quote',()=>now,async url=>{
  if(url.includes('shadow-market-data'))return {ok:true,json:async()=>feedValid?
    quote(now,ROUND,99,100):quote(now,ROUND-300000,99,100)};
  aiCalls++;throw Error('MODEL_CALL_NOT_EXPECTED');
 });
 try{
  await p.tick();
  now=ROUND+105;await p.tick();
  assert.equal(p.status().signal,null);
  assert.equal(p.status().fallbackPending,true);
  feedValid=true;now=ROUND+2000;await p.tick();
  const s=p.status();
  assert.equal(s.signal.latest.direction,'DOWN');
  assert.equal(s.signal.latest.lockedAt,ROUND+2000);
  assert.equal(s.signal.latest.decisionMethod,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
  assert.equal(aiCalls,0);
  assert.equal(s.maxCallsPerRound,1);
 }finally{remove(f)}
});
test('No previous-round quote can ever manufacture the next round prediction',async()=>{
 let now=ROUND+500,aiCalls=0,valid=true;
 const {p,f}=newBot('cross-round',()=>now,async url=>{
  if(url.includes('shadow-market-data')){
   const thisRound=Math.floor(now/300000)*300000;
   return {ok:true,json:async()=>quote(now,valid?thisRound:thisRound-300000,100.1,100)};
  }
  aiCalls++;throw Error('SHOULD_NOT_CALL_SLOW_MODEL');
 });
 try{
  await p.tick();assert.equal(p.status().signal?.latest.direction,'UP');
  now=ROUND+300000+500;valid=false;
  await p.tick();
  assert.equal(p.status().signal,null,'must never republish old UP');
  now=ROUND+300000+16000;await p.tick();
  assert.equal(p.status().roundDecision.status,'UNAVAILABLE');
  assert.equal(p.status().signal,null);
  now=ROUND+600000+400;valid=true;
  await p.tick();
  assert.equal(p.status().signal?.round,ROUND+600000);
  assert.equal(p.status().signal?.latest.decisionMethod,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
  assert.equal(aiCalls,0);
 }finally{remove(f)}
});
test('At t<100ms, no current quote means no signal and never previous round fallback',async()=>{
 let now=ROUND+60,requests=0;
 const {p,f}=newBot('before-target',()=>now,async url=>{
  if(url.includes('shadow-market-data'))return {ok:true,json:async()=>quote(now,ROUND-300000)};
  requests++;return {ok:true,json:async()=>({})};
 });
 try{
  await p.tick();assert.equal(p.status().signal,null);
  assert.equal(p.status().roundDecision.status,'ANALYZING');
  assert.equal(requests,0);
 }finally{remove(f)}
});
