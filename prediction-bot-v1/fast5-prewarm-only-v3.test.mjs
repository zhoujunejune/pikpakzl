import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,STRATEGY_VERSION} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
function feed(time,{lag=1200,round=R,close=80012,open=80000,current=80010,connected=true}={}){
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
  roundStartMs:round,eventMs:time-lag,lastPrice:current,roundOpenPrice:open,
  marketFeedConnected:connected
 },candles:{'1m':{rows:[
  {startMs:R-120000,endMs:R-60001,open:80000,close:80008,closed:true},
  {startMs:R-60000,endMs:R-1,open:80008,close,closed:true}
 ]}}};
}
test('authentic lagged previous-round tick with 120s closed evidence locks in first second',()=>{
 let now=R+300,calc=createFast5Calculator({now:()=>now});
 const r=calc.update(feed(now,{lag:1200}));
 assert.equal(r.locked,true);
 assert.equal(r.signal.direction,'UP');
 assert.equal(r.signal.strategyVersion,STRATEGY_VERSION);
 assert.equal(r.signal.prewarmOnly,true);
 assert.equal(r.signal.currentRoundQuoteVerified,false);
 assert.equal(r.signal.signalReason,'PREWARM120_ONLY_VERIFIED_PRIOR_DATA');
 assert.equal(r.signal.roundOpenPrice,null);
 assert.ok(r.signal.lockedAt>=R+100&&r.signal.lockedAt<=R+1000);
 assert.equal(calc.status().latest.direction,'UP');
});
test('live current-round opening quote always has priority over prior trend',()=>{
 let now=R+350,c=createFast5Calculator({now:()=>now});
 const r=c.update(feed(now,{lag:120,open:80010,current:79999}));
 assert.equal(r.locked,true);
 assert.equal(r.signal.prewarmOnly,false);
 assert.equal(r.signal.currentRoundQuoteVerified,true);
 assert.equal(r.signal.direction,'DOWN');
});
test('missing verified prewarm or missing market connection cannot auto-lock',()=>{
 let now=R+300;
 const c=createFast5Calculator({now:()=>now});
 const bad=feed(now);bad.candles['1m'].rows=[];
 assert.equal(c.update(bad).locked,false);
 const d=createFast5Calculator({now:()=>now});
 assert.equal(d.update(feed(now,{connected:false})).locked,false);
});
test('older than 3000ms market event cannot become real locked signal',()=>{
 let now=R+400,c=createFast5Calculator({now:()=>now});
 const r=c.update(feed(now,{lag:3900}));
 assert.equal(r.locked,false);assert.equal(c.status().latest,null);
});
test('expired 5s prediction never locks late, even with previous 120s candles',()=>{
 let now=R+5000,c=createFast5Calculator({now:()=>now});
 const r=c.update(feed(now,{lag:900}));
 assert.equal(r.locked,false);
});
