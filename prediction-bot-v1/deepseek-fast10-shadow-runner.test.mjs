import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunner} from './deepseek-fast10-shadow-runner.mjs';
const target=1800000300000;
const bars=(ms,count,at)=>{
 const start=at-(count+10)*ms;
 return Array.from({length:count},(_,i)=>({
   startMs:start+i*ms,open:67000+i,high:67005+i,low:66995+i,
   close:67001+i,volume:100+i,closed:true
 }));
};
const market=t=>{
 const r=Math.floor(t/300000)*300000;
 const nextRound=t>=target;
 const p=nextRound?68000+(t-target)/1000*1.5:67000+(t-(target-120000))/1000*.5;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:t,roundStartMs:r,lastPrice:p,
    roundOpenPrice:nextRound?68000:67000,marketFeedConnected:true},
  candles:{'1m':{rows:bars(60000,90,t)},'5m':{rows:bars(300000,70,t)}}};
};
test('isolated runner prewarms in prior round, blends next open, locks before +10sec and never places orders',async()=>{
 let t=target-120000,ai=0,markets=0,firstRequestAt=null;
 const fetcher=async(url,options)=>{
  if(String(url).includes('shadow-market-data')){markets++;return {ok:true,json:async()=>market(t)}}
  ai++;firstRequestAt=t;
  const body=JSON.parse(options.body);
  assert.equal(body.messages[1].content.includes('"targetRound"'),true);
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:
    '{"direction":"UP","confidence":0.62,"reason":"trend from previous round"}'}}]})};
 };
 const engine=createRunner({clock:()=>t,fetcher,env:{FAST10_SHADOW_ENABLE_AI:'1',
  DEEPSEEK_API_KEY:'mock-test-only',DEEPSEEK_MODEL:'deepseek-flash'}});
 for(t=target-120000;t<=target+9000;t+=1000)await engine.tick();
 const s=engine.status();
 assert.equal(ai,1);
 assert.ok(firstRequestAt<target);
 assert.ok(markets>=130);
 assert.equal(s.lastSignal.round,target);
 assert.ok(s.lastSignal.lockedAt<target+10000);
 assert.equal(s.window.signal.latest.openPrice,68000);
 assert.equal(s.window.signal.orders,false);
 assert.equal(s.window.signal.productionIntegration,false);
});
test('does not fake LLM output or emit a trade when paid inference is disabled',async()=>{
 let t=target-120000,calledApi=0;
 const fetcher=async(url)=>{
  if(!String(url).includes('shadow-market-data')){calledApi++;throw Error('PAID_API_UNEXPECTED')}
  return {ok:true,json:async()=>market(t)}
 };
 const runner=createRunner({clock:()=>t,fetcher,env:{FAST10_SHADOW_ENABLE_AI:'0'}});
 for(t=target-120000;t<=target+9000;t+=1000)await runner.tick();
 assert.equal(calledApi,0);
 assert.equal(runner.status().window.signal,null);
 assert.equal(runner.status().orders,false);
});
