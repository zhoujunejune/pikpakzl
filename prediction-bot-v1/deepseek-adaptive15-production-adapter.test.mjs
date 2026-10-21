import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildAdaptive15CompatibleSignal,createAdaptive15ProductionProvider}
  from './deepseek-adaptive15-production-adapter.mjs';
const target=1800000300000;
const candles=(ms,n,t)=>Array.from({length:n},(_,i)=>({
 startMs:t-(n+10-i)*ms,open:67000+i,high:67005+i,
 low:66995+i,close:67001+i,volume:100+i,closed:true
}));
const quote=t=>{
 const early=t>=target;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:t,roundStartMs:Math.floor(t/300000)*300000,
   lastPrice:early?68000+2*(t-target)/1000:67000+.4*(t-(target-120000))/1000,
   roundOpenPrice:early?68000:67000,marketFeedConnected:true},
  candles:{'1m':{rows:candles(60000,90,t)},'5m':{rows:candles(300000,90,t)}}};
};
test('compatible production envelope uses 15-second deadline, no order API',()=>{
 const candidate={round:target,orders:false,productionIntegration:false,
  latest:{direction:'UP',marketAt:target+11200,hybridScore:.72,
   firstAnalysis:'DOWN',reviewAnalysis:'UP',selectedAnalysis:'review'}};
 assert.throws(()=>buildAdaptive15CompatibleSignal(candidate,target+15000,'deepseek-flash'),/INVALID/);
 const s=buildAdaptive15CompatibleSignal(candidate,target+11300,'deepseek-flash');
 assert.equal(s.model,'DEEPSEEK_5M_V1');
 assert.equal(s.latest.decisionMethod,'DEEPSEEK_TWO_PASS_ADAPTIVE15_V1');
 assert.equal(s.latest.reviewDirection,'UP');
 assert.equal(s.expiryAt,target+270000);
 assert.equal(s.latest.entry.modelVersion,'DEEPSEEK_5M_V1');
 assert.equal(s.orders,false);
});
test('provider gives official learner records after two valid model reviews',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adaptive15-prod-'));
 let t=target-120000,apiCalls=0,officialPolls=0;
 const env={DEEPSEEK_API_KEY:'mock-secret',DEEPSEEK_MODEL:'deepseek-flash',
  LLM_STATE_FILE:path.join(dir,'signal.json'),
  DEEPSEEK_LEARNING_FILE:path.join(dir,'learning.json')};
 const fetcher=async url=>{
  if(String(url).includes('round-stats')){
   officialPolls++;return {ok:true,json:async()=>({
    ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',records:[]})};
  }
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>quote(t)};
  apiCalls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',
   message:{content:JSON.stringify({direction:'UP',confidence:.84,reason:'momentum and recent cases'})}}]})};
 };
 try{
  const p=createAdaptive15ProductionProvider({env,clock:()=>t,fetcher});
  for(t=target-120000;t<=target+14500;t+=500)await p.tick();
  // Loop increment reaches exactly +15s; order-facing /signal must have closed.
  t=target+14500;
  const s=p.status();
  assert.equal(apiCalls,2);
  assert.ok(officialPolls>=1);
  assert.equal(s.model,'DEEPSEEK_5M_V1');
  assert.equal(s.maxCallsPerRound,2);
  assert.equal(s.decisionWindowEndMs,target+15000);
  assert.equal(s.signal.latest.direction,'UP');
  assert.ok(s.signal.generatedAt<target+15000);
  assert.equal(s.signal.latest.reviewDirection,'UP');
  assert.equal(s.realOrderEnabled,false);
  assert.equal(p.history(10).summary.predictions,1);
  assert.equal(JSON.parse(fs.readFileSync(env.LLM_STATE_FILE,'utf8')).round,target);
  assert.equal(fs.readFileSync(env.LLM_STATE_FILE,'utf8').includes('mock-secret'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('WAIT after review never persists forced UP or DOWN as a trade signal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adaptive15-wait-'));
 let t=target-120000,calls=0;
 const env={DEEPSEEK_API_KEY:'mock-secret',DEEPSEEK_MODEL:'deepseek-flash',
  LLM_STATE_FILE:path.join(dir,'signal.json'),DEEPSEEK_LEARNING_FILE:path.join(dir,'learning.json')};
 const fetcher=async url=>{
  if(String(url).includes('round-stats'))return {ok:true,json:async()=>({
   ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',records:[]})};
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>quote(t)};
  calls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',
   message:{content:JSON.stringify({direction:calls===1?'UP':'WAIT',confidence:.76})}}]})};
 };
 try{
  const p=createAdaptive15ProductionProvider({env,clock:()=>t,fetcher});
  for(t=target-120000;t<=target+14500;t+=500)await p.tick();
  assert.equal(calls,2);
  assert.equal(p.status().signal,null);
  assert.equal(p.history(10).summary.predictions,0);
  assert.equal(fs.existsSync(env.LLM_STATE_FILE),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
