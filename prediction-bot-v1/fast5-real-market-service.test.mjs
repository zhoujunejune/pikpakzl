import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Service,serveFast5,FAST5_MARKET_URL} from './fast5-real-market-service.mjs';
import {FAST_MODEL_ID} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
function make(now){
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
  roundStartMs:R,eventMs:now-20,roundOpenPrice:80000,lastPrice:80000+Math.round((now-R)/600),
  marketFeedConnected:true},
  candles:{'1m':{rows:Array.from({length:12},(_,i)=>({
   startMs:R-(12-i)*60000,endMs:R-(11-i)*60000-1,
   close:80000+i*3,closed:true}))}}};
}
test('loopback fast producer uses GET market snapshots and never calls AI or order endpoint',async()=>{
 let now=R+400;const called=[];
 const service=createFast5Service({clock:()=>now,fetcher:async(url,init)=>{
  called.push({url,method:init.method||'GET'});
  return {ok:true,json:async()=>make(now)};
 }});
 for(const elapsed of [400,1600,2850,4500]){
  now=R+elapsed;await service.poll();
 }
 const s=service.status();
 assert.equal(s.model,FAST_MODEL_ID);
 assert.equal(s.requiresDeepSeek,false);
 assert.equal(s.orders,false);
 assert.equal(s.latest?.direction,'UP');
 assert.ok(called.every(x=>x.url===FAST5_MARKET_URL&&x.method==='GET'));
});
test('all read-only HTTP routes preserve no-order contract',async()=>{
 const service=createFast5Service({fetcher:async()=>({ok:false,status:503})});
 const server=serveFast5(service,0);
 try{
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const health=await (await fetch(url+'/healthz')).json();
  assert.equal(health.orders,false);
  assert.equal(health.requiresDeepSeek,false);
  const signal=await (await fetch(url+'/api/signal')).json();
  assert.equal(signal.productionIntegration,false);
  assert.equal(signal.latest,null);
  const attempt=await fetch(url+'/trade/place-order',{method:'POST'});
  assert.equal(attempt.status,405);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
