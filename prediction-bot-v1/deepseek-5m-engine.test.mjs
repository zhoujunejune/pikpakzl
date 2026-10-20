import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {roundOf,marketInput,parseDirection,parseDecision,createSignal,createEngine,SIGNAL_DEADLINE_MS} from './deepseek-5m-engine.mjs';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';

const round=roundOf(1800000130000),now=round+45000;
const bars=(ms,count)=>{
 const arr=[];
 const start=round-((count+1)*ms);
 for(let i=0;i<count;i++){
  const open=67000+i*2;
  arr.push({startMs:start+i*ms,endMs:start+(i+1)*ms-1,
   open,high:open+8,low:open-9,close:open+2,volume:100+i,closed:true});
 }
 return arr;
};
const marketAt=(t=now)=>({
 ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:t-1000,roundStartMs:round,lastPrice:67001,roundOpenPrice:67000,marketFeedConnected:true},
 candles:{'1m':{rows:bars(60000,90)},'5m':{rows:bars(300000,70)}}
});
test('real candle rows yield causal RSI MACD ATR and volume features',()=>{
 const f=extractFeatures(marketAt(),now);
 assert.equal(f.dataQuality.indicatorsReady,true);
 assert.equal(f.oneMinute.closedCount,90);
 assert.equal(f.fiveMinute.closedCount,70);
 assert.ok(Number.isFinite(f.oneMinute.rsi14));
 assert.ok(Number.isFinite(f.fiveMinute.atr14));
 assert.ok(Number.isFinite(f.oneMinute.volumeRelative));
 assert.ok(Number.isFinite(f.oneMinute.macd.macd));
 const input=marketInput(marketAt(),now);
 assert.equal(input.features.oneMinute.closedCount,90);
 assert.throws(()=>marketInput(marketAt(now-20000),now));
});
test('WAIT allowed as observation, never locked as order signal',()=>{
 assert.equal(parseDecision('{"direction":"WAIT","nextReviewSec":30}').direction,'WAIT');
 assert.throws(()=>parseDirection('{"direction":"WAIT"}'));
 assert.equal(parseDirection('{"direction":"UP","confidence":0.55}').direction,'UP');
});
test('signal generated after 30 sec and as late as 4m27 sec; last-30-second cutoff',()=>{
 const input=marketInput(marketAt(),now);
 const late={...input,marketAt:round+245000};
 const s=createSignal(late,{direction:'DOWN',confidence:0.5},round+267000,'deepseek-flash');
 assert.equal(s.orders,false);
 assert.equal(s.round,round);
 assert.equal(s.expiryAt,round+270000);
 assert.equal(SIGNAL_DEADLINE_MS,270000);
 assert.throws(()=>createSignal(late,{direction:'UP'},round+270000,'deepseek-flash'));
});
test('missing API secret cannot call external model',async()=>{
 let count=0;
 const e=createEngine({env:{DEEPSEEK_LEARNING_FILE:'/tmp/deepseek-no-secret-'+Date.now(),LLM_STATE_FILE:'/tmp/deepseek-none-'+Date.now()},
  clock:()=>now,fetcher:async()=>{count++;throw Error('UNEXPECTED_NETWORK')}});
 await e.tick();
 assert.equal(count,0);
 assert.equal(e.status().signal,null);
});
test('thinking enabled; no signal on WAIT, then locks on UP and never calls model again',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-v2-'));
 let calls=0,modelRequests=0,t=now;
 const fetcher=async(url,options)=>{
  calls++;
  if(String(url).includes('round-stats'))return {ok:true,json:async()=>({ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',records:[]})};
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>marketAt(t)};
  modelRequests++;
  const payload=JSON.parse(options.body);
  assert.equal(payload.thinking.type,'enabled');
  assert.equal(payload.reasoning_effort,'high');
  assert.equal(payload.messages[1].content.includes('rsi14'),true);
  return {ok:true,json:async()=>({choices:[{message:{content:modelRequests===1?
   '{"direction":"WAIT","reason":"need more evidence","nextReviewSec":25}':
   '{"direction":"UP","confidence":0.52,"reason":"momentum"}'}}]})};
 };
 try{
  const e=createEngine({
   env:{DEEPSEEK_API_KEY:'test-secret',DEEPSEEK_LEARNING_FILE:path.join(dir,'learning.json'),
    LLM_STATE_FILE:path.join(dir,'signal.json')},
   clock:()=>t,fetcher
  });
  await e.tick();assert.equal(e.status().signal,null);assert.equal(modelRequests,1);
  t+=26000;await e.tick();assert.equal(modelRequests,2);
  assert.equal(e.status().signal.latest.direction,'UP');
  assert.equal(e.status().signal.readOnly,true);
  assert.equal(e.status().learning.predictions,1);
  await e.tick();assert.equal(modelRequests,2);
  assert.equal(fs.readFileSync(path.join(dir,'signal.json'),'utf8').includes('test-secret'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('official settlement learner delays feedback until published official label',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-learn-'));
 let t=round+700000;
 try{
  const learner=newLearner(path.join(dir,'learn.json'),()=>t);
  const sig={round,providerModel:'deepseek-flash',latest:{direction:'UP',lockedAt:round+60000,confidence:0.5}};
  learner.record(sig,{oneMinute:{ready:true,ema9:67000,ema21:66900},fiveMinute:{ready:true,ema9:67000,ema21:66900}},2);
  assert.equal(learner.summary().officialSamples,0);
  const stats={ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
   records:[{roundStartMs:round,productionActual:'UP',productionSettledAt:round+301000,
     officialSettlementAudit:{source:'Binance'}}]};
  assert.equal(learner.settle(stats),1);
  assert.equal(learner.summary().officialHits,1);
  assert.equal(learner.settle(stats),0);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
