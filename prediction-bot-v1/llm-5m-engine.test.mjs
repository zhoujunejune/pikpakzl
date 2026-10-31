import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {roundOf,marketInput,parseDirection,createSignal,createEngine} from './llm-5m-engine.mjs';
const round=roundOf(1800000130000),now=round+30000;
const market={ok:true,readOnly:true,symbol:'BTCUSDT',latest:{eventMs:now-1000,roundStartMs:round,lastPrice:67001,roundOpenPrice:67000,marketFeedConnected:true},candles:{'1m':[],'5m':[]}};
test('market requires live current-round data',()=>{
 assert.equal(marketInput(market,now).round,round);
 assert.throws(()=>marketInput({...market,latest:{...market.latest,eventMs:now-19000}},now));
});
test('only UP or DOWN accepted; no false direction',()=>{
 assert.equal(parseDirection('{"direction":"UP","confidence":0.4}').direction,'UP');
 assert.throws(()=>parseDirection('{"direction":"WAIT"}'));
});
test('signals have no order capabilities; expiration enforced',()=>{
 const s=createSignal(marketInput(market,now),{direction:'DOWN',confidence:0.2},now,'qwen-flash');
 assert.equal(s.latest.direction,'DOWN');assert.equal(s.orders,false);
 assert.throws(()=>createSignal(marketInput(market,now),{direction:'UP'},round+285000,'qwen-flash'));
});
test('no API key never sends external calls or invents signal',async()=>{
 let count=0;
 const e=createEngine({env:{LLM_STATE_FILE:'/tmp/unused-llm5-'+Date.now()},clock:()=>now,fetcher:async()=>{count++;throw Error('wrong')}});
 await e.tick();assert.equal(count,0);assert.equal(e.status().signal,null);
});
test('real market mock followed by Qwen mock writes one signal per round',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'llm5-'));let calls=0;
 const fetcher=async(url,options)=>{
  calls++;
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>market};
  assert.match(options.headers.Authorization,/Bearer/);
  return {ok:true,json:async()=>({choices:[{message:{content:'{"direction":"DOWN","confidence":0.6}'}}]})};
 };
 try{
  const e=createEngine({env:{DASHSCOPE_API_KEY:'test-secret',LLM_STATE_FILE:path.join(dir,'signal.json')},clock:()=>now,fetcher});
  await e.tick();await e.tick();assert.equal(calls,2);
  assert.equal(e.status().signal.latest.direction,'DOWN');
  assert.equal(e.status().signal.readOnly,true);
  assert.equal(fs.readFileSync(path.join(dir,'signal.json'),'utf8').includes('test-secret'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
