import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';
const round=1800000300000;
const candles=(ms,n,t)=>Array.from({length:n},(_,i)=>({
 startMs:t-(n+10-i)*ms,open:67000+i,high:67005+i,low:66995+i,
 close:67001+i,volume:100+i,closed:true
}));
const market=t=>{
 const cur=Math.floor(t/300000)*300000,early=t>=round;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:t,roundStartMs:cur,lastPrice:early?68000+1.5*(t-round)/1000:
   67000+(t-(round-120000))/1000*.5,roundOpenPrice:early?68000:67000,
   marketFeedConnected:true},
 candles:{'1m':{rows:candles(60000,70,t)},'5m':{rows:candles(300000,70,t)}}};
};
async function run({second='UP',first='UP',key='mock-secret',feedback={usable:true,samples:60,
 upSamples:32,upHistoricalAccuracy:.6,downSamples:28,downHistoricalAccuracy:.5}}={}){
 let t=round-120000,calls=[],locks=[];
 const fetcher=async(url,options)=>{
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>market(t)};
  calls.push({at:t,payload:JSON.parse(options.body)});
  const direction=calls.length===1?first:second;
  return {ok:true,json:async()=>({usage:{total_tokens:231},choices:[{finish_reason:'stop',
   message:{content:JSON.stringify({direction,confidence:.8,reason:'fresh causal momentum'})}}]})};
 };
 const runner=createAdaptiveRunner({clock:()=>t,fetcher,
   env:{ADAPTIVE15_ENABLE_AI:'1',DEEPSEEK_API_KEY:key,DEEPSEEK_MODEL:'deepseek-flash'},
   getHistoricalFeedback:()=>feedback,
   onLocked:(signal)=>locks.push(signal)});
 for(t=round-120000;t<=round+14500;t+=500)await runner.tick();
 return {calls,locks,status:runner.status()};
}
test('calls DeepSeek at -75 and -30, allows review to reverse, locks within 15s',async()=>{
 const x=await run({first:'DOWN',second:'UP'});
 assert.equal(x.calls.length,2);
 assert.ok(x.calls[0].at<=round-74000&&x.calls[0].at>=round-76000);
 assert.ok(x.calls[1].at<=round-29000&&x.calls[1].at>=round-31000);
 assert.equal(JSON.parse(x.calls[1].payload.messages[1].content).priorModelAnalysis.direction,'DOWN');
 assert.equal(x.locks.length,1);
 assert.equal(x.locks[0].latest.direction,'UP');
 assert.equal(x.locks[0].latest.selectedAnalysis,'review');
 assert.ok(x.locks[0].generatedAt>=round+8000);
 assert.ok(x.locks[0].generatedAt<round+15000);
 assert.equal(x.status.orders,false);
});
test('unexpected WAIT review does not discard valid initial UP',async()=>{
 const x=await run({first:'UP',second:'WAIT'});
 assert.equal(x.calls.length,2);
 assert.equal(x.locks.length,1);
 assert.equal(x.locks[0].latest.direction,'UP');
 assert.equal(x.locks[0].latest.selectedAnalysis,'initial');
});
test('model without configured key does not forge a decision',async()=>{
 let t=round-120000,ai=0;
 const runner=createAdaptiveRunner({
  clock:()=>t,env:{ADAPTIVE15_ENABLE_AI:'0'},fetcher:async url=>{
   if(!String(url).includes('shadow-market-data')){ai++;throw Error('FORBIDDEN')}
   return {ok:true,json:async()=>market(t)}}});
 for(t=round-120000;t<round+15000;t+=1000)await runner.tick();
 assert.equal(ai,0);assert.equal(runner.status().window.signal,null);
 assert.equal(runner.status().orders,false);
});
