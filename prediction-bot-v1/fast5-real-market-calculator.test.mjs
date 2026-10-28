import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,FAST_MODEL_ID} from './fast5-real-market-calculator.mjs';

const R=1792945200000;
function feed(round=R,at=R+200,price=80000,dir=1){
 const rows=Array.from({length:14},(_,i)=>({
  startMs:round-(14-i)*60000,
  endMs:round-(13-i)*60000-1,
  open:80000+dir*i*2,
  high:80001+dir*i*2,
  low:79999+dir*i*2,
  close:80000+dir*i*2,
  volume:3.2,
  closed:true
 }));
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{marketFeedConnected:true,eventMs:at-20,lastPrice:price,roundOpenPrice:80000,roundStartMs:round},
  candles:{'1m':{rows}}};
}
test('local signal needs current-round real snapshots and never uses DeepSeek',()=>{
 let t=R+500;
 const calculator=createFast5Calculator({now:()=>t});
 assert.equal(calculator.update(feed(R,t,80000)).locked,false);
 t=R+1550;assert.equal(calculator.update(feed(R,t,80004)).locked,false);
 t=R+2850;assert.equal(calculator.update(feed(R,t,80007)).locked,false);
 t=R+4300;
 const q=calculator.update(feed(R,t,80012));
 assert.equal(q.locked,true);
 assert.equal(q.signal.direction,'UP');
 assert.equal(q.signal.model,FAST_MODEL_ID);
 assert.equal(q.signal.requiresDeepSeek,false);
 assert.equal(q.signal.analysisCalls,0);
 assert.equal(q.signal.orders,false);
 assert.equal(q.signal.confidence,null);
 assert.equal(q.signal.officialOracleLiveQuoteUsed,false);
 assert.ok(q.signal.lockedAt<R+12000);
 const again=calculator.update(feed(R,t,80001));
 assert.deepEqual(again.signal,q.signal);
});
test('falling tick price and falling prior trend yields DOWN',()=>{
 let t=R+500,c=createFast5Calculator({now:()=>t});
 for(let i=0;i<3;i++){
  t=R+500+i*1200;
  c.update(feed(R,t,80000-i*4,-1));
 }
 t=R+4200;
 assert.equal(c.update(feed(R,t,79986,-1)).signal?.direction,'DOWN');
});
test('no signal with bad timestamps, prior-round tick or gap',()=>{
 let t=R+500,c=createFast5Calculator({now:()=>t});
 const previous=feed(R,t,80001);previous.latest.eventMs=R-10;
 assert.equal(c.update(previous).reason,'STALE_OR_UNTRUSTED_MARKET');
 const stale=feed(R,t,80001);stale.latest.eventMs=R-5000;
 assert.equal(c.update(stale).reason,'STALE_OR_UNTRUSTED_MARKET');
 const future=feed(R,t,80001);future.latest.eventMs=t+400;
 assert.equal(c.update(future).reason,'STALE_OR_UNTRUSTED_MARKET');
 assert.equal(c.status().observedSamples,0);
});
test('conflicting genuine 1m trend never produces fake conviction',()=>{
 let t=R+300,c=createFast5Calculator({now:()=>t});
 for(const [ms,p] of [[300,80000],[1550,80004],[2800,80008],[4300,80012]]){
  t=R+ms;const r=c.update(feed(R,t,p,-1));
  if(ms===4300)assert.equal(r.reason,'CONFLICT_WITH_REAL_CLOSED_1M_TREND');
 }
 assert.equal(c.status().locked,false);
});
test('forming and future candles ignored, missing closed history means no signal',()=>{
 let t=R+300,c=createFast5Calculator({now:()=>t});
 for(const [ms,p] of [[300,80000],[1550,80004],[2800,80008],[4300,80012]]){
  t=R+ms;const market=feed(R,t,p);market.candles['1m'].rows=
   market.candles['1m'].rows.filter(x=>x.endMs>=R-60000);
  market.candles['1m'].rows.push({startMs:R,endMs:R+59999,close:100000,closed:false});
  const v=c.update(market);
  if(ms===4300)assert.equal(v.reason,'INSUFFICIENT_REAL_CLOSED_CANDLES');
 }
 assert.equal(c.status().locked,false);
});
test('end of decision window rejects late or replayed signals and round rolls',()=>{
 let t=R+12000,c=createFast5Calculator({now:()=>t});
 assert.equal(c.update(feed(R,t,80020)).reason,'ROUND_SIGNAL_WINDOW_EXPIRED');
 t=R+300000+600;
 const o=c.update(feed(R+300000,t,80000));
 assert.equal(o.locked,false);
 assert.equal(c.status().round,R+300000);
});
