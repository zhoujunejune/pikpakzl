import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,STRATEGY_VERSION,SIGNAL_END_MS} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
const feed=(ts,{lag=1800,dir=1,ready=true,closed=true}={})=>({
 ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:ts-lag,roundStartMs:R,roundOpenPrice:80000,
   lastPrice:80000+dir*18,marketFeedConnected:ready},
 candles:{'1m':{rows:closed?[
  {startMs:R-120000,endMs:R-60001,open:80000,close:80000+dir*12,closed:true},
  {startMs:R-60000,endMs:R-1,open:80000+dir*12,close:80000+dir*18,closed:true}
 ]:[]}}
});
test('strictly 5 seconds decision window; V4 strategy id',()=>{
 assert.equal(SIGNAL_END_MS,5000);
 assert.equal(STRATEGY_VERSION,'FAST5_PREWARM120_5S_V4');
});
test('can lock prewarm UP at +4.9 seconds using legitimate recent BTC market evidence',()=>{
 let time=R+4900,c=createFast5Calculator({now:()=>time});
 const q=c.update(feed(time));
 assert.equal(q.locked,true);
 assert.equal(q.signal.direction,'UP');
 assert.equal(q.signal.prewarmOnly,true);
 assert.equal(q.signal.lockedAt,R+4900);
 assert.equal(q.signal.strategyVersion,STRATEGY_VERSION);
});
test('5s boundary gives permanent WAIT, no prewarm direction misleadingly exposed',()=>{
 let time=R+5000,c=createFast5Calculator({now:()=>time});
 const q=c.update(feed(time));
 assert.equal(q.locked,false);
 assert.equal(q.reason,'OPEN_5S_DEADLINE_MISSED');
 assert.equal(c.status().provisionalDirection,null);
 time=R+7000;const late=c.update(feed(time,{lag:100,ready:true}));
 assert.equal(late.locked,false);
 assert.equal(late.reason,'OPEN_5S_DEADLINE_MISSED');
 assert.equal(c.status().latest,null);
});
test('wait while feed missing but lock as soon as good evidence arrives before 5s',()=>{
 let time=R+400,c=createFast5Calculator({now:()=>time});
 assert.equal(c.update(feed(time,{ready:false})).locked,false);
 time=R+3500;
 const p=c.update(feed(time,{dir:-1,lag:1300}));
 assert.equal(p.locked,true);
 assert.equal(p.signal.direction,'DOWN');
 assert.ok(p.signal.lockedAt<R+5000);
});
test('genuinely stale feed or missing prewarm will not yield fake locked direction',()=>{
 let time=R+4900,c=createFast5Calculator({now:()=>time});
 assert.equal(c.update(feed(time,{lag:4900})).locked,false);
 time=R+5000;
 assert.equal(c.update(feed(time,{lag:300})).reason,'OPEN_5S_DEADLINE_MISSED');
 const d=createFast5Calculator({now:()=>R+4800});
 assert.equal(d.update(feed(R+4800,{closed:false})).locked,false);
});
test('valid first-second real opening quote remains higher priority than prewarm',()=>{
 let time=R+250,c=createFast5Calculator({now:()=>time});
 const q=c.update(feed(time,{lag:40,dir:-1}));
 assert.equal(q.locked,true);
 assert.equal(q.signal.direction,'DOWN');
 assert.equal(q.signal.prewarmOnly,false);
});
