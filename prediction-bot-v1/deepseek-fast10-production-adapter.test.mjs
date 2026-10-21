import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildCompatibleSignal,createFast10ProductionProvider} from './deepseek-fast10-production-adapter.mjs';
const target=1800000300000;
const bars=(ms,n,t)=>Array.from({length:n},(_,i)=>({
 startMs:t-(n+10-i)*ms,open:67000+i,high:67005+i,
 low:66995+i,close:67001+i,volume:90+i,closed:true
}));
const quote=t=>({
 ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:t,roundStartMs:Math.floor(t/300000)*300000,
   lastPrice:t>=target?68000+1.5*(t-target)/1000:67000+.5*(t-(target-120000))/1000,
   roundOpenPrice:t>=target?68000:67000,marketFeedConnected:true},
 candles:{'1m':{rows:bars(60000,90,t)},'5m':{rows:bars(300000,70,t)}}
});
test('cannot transform a late or fake shadow decision into an order signal',()=>{
 const candidate={round:target,orders:false,productionIntegration:false,
  latest:{direction:'UP',marketAt:target+8000,rawHybridScore:.6}};
 assert.throws(()=>buildCompatibleSignal(candidate,target+10000,'deepseek-flash'),/INVALID/);
 assert.throws(()=>buildCompatibleSignal({...candidate,orders:true},target+8500,'deepseek-flash'),/INVALID/);
 const result=buildCompatibleSignal(candidate,target+8500,'deepseek-flash');
 assert.equal(result.model,'DEEPSEEK_5M_V1');
 assert.equal(result.expiryAt,target+270000);
 assert.equal(result.latest.lockedAt,target+8500);
 assert.equal(result.latest.entry.modelVersion,'DEEPSEEK_5M_V1');
 assert.equal(result.latest.confidence,null);
 assert.equal(result.orders,false);
});
test('fast10 provider preserves /signal contract, persists one prediction and feeds official learner',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-fast10-prod-'));
 let t=target-120000,providerCalls=0,officialPolls=0;
 const env={DEEPSEEK_API_KEY:'mock-secret',DEEPSEEK_MODEL:'deepseek-flash',
  LLM_STATE_FILE:path.join(dir,'signal.json'),
  DEEPSEEK_LEARNING_FILE:path.join(dir,'learning.json')};
 const fetcher=async(url,opts)=>{
  if(String(url).includes('round-stats')){officialPolls++;return {ok:true,json:async()=>({
    ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',records:[]})}}
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>quote(t)};
  providerCalls++;
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{
   content:'{"direction":"UP","confidence":0.6,"reason":"prev window trend"}'}}]})};
 };
 try{
  const p=createFast10ProductionProvider({env,clock:()=>t,fetcher});
  for(t=target-120000;t<=target+9000;t+=1000)await p.tick();
  const s=p.status();
  assert.equal(providerCalls,1);
  assert.ok(officialPolls>=1);
  assert.equal(s.model,'DEEPSEEK_5M_V1');
  assert.equal(s.maxCallsPerRound,1);
  assert.equal(s.decisionWindowEndMs,target+10000);
  assert.equal(s.signal.latest.status,'LOCKED');
  assert.equal(s.signal.latest.entry.direction,s.signal.latest.direction);
  assert.equal(s.signal.latest.marketAt>=target,true);
  assert.equal(s.signal.generatedAt<target+10000,true);
  assert.equal(s.signal.providerModel,'deepseek-flash');
  assert.equal(s.realOrderEnabled,false);
  assert.equal(p.history(10).summary.predictions,1);
  assert.equal(JSON.parse(fs.readFileSync(env.LLM_STATE_FILE,'utf8')).round,target);
  assert.equal(fs.readFileSync(env.LLM_STATE_FILE,'utf8').includes('mock-secret'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
