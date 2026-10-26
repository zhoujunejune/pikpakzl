import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,FAST_MODEL_ID,STRATEGY_VERSION} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
function market(ts,{price=80020,open=80000,round=R,trend=1,stale=false,withHistory=true}={}){
  const rows=withHistory?[
    {startMs:R-120000,endMs:R-60001,open:80000,close:80000+trend*10,closed:true},
    {startMs:R-60000,endMs:R-1,open:80000+trend*10,close:80000+trend*20,closed:true}
  ]:[];
  return {ok:true,readOnly:true,symbol:'BTCUSDT',
    latest:{eventMs:stale?ts-5000:ts-15,lastPrice:price,roundOpenPrice:open,
      roundStartMs:round,marketFeedConnected:true},
    candles:{'1m':{rows}}};
}
test('first verified 0.1-1s opening price above open emits UP without DeepSeek',()=>{
 let now=R+200,c=createFast5Calculator({now:()=>now});
 const result=c.update(market(now,{price:80010}));
 assert.equal(result.locked,true);
 assert.equal(result.signal.direction,'UP');
 assert.equal(result.signal.model,FAST_MODEL_ID);
 assert.equal(result.signal.strategyVersion,STRATEGY_VERSION);
 assert.equal(result.signal.signalReason,'CURRENT_OPEN_PRICE_DELTA');
 assert.equal(result.signal.requiresDeepSeek,false);
 assert.ok(result.signal.lockedAt>=R+100&&result.signal.lockedAt<=R+1000);
});
test('negative move versus opening reference emits DOWN regardless prior trend',()=>{
 let now=R+350,c=createFast5Calculator({now:()=>now});
 const result=c.update(market(now,{price:79990,trend:1}));
 assert.equal(result.signal?.direction,'DOWN');
});
test('opening price tie uses verified prewarm 120s trend',()=>{
 let now=R+400,c=createFast5Calculator({now:()=>now});
 const result=c.update(market(now,{price:80000,open:80000,trend:-1}));
 assert.equal(result.signal?.direction,'DOWN');
 assert.equal(result.signal?.prewarmSource,'CLOSED_1M_120S');
 assert.equal(result.signal?.signalReason,'PREWARM120_TIEBREAK');
});
test('actual prior 120s ticks are collected before rollover; no future ticks',()=>{
 let now=R-119900,c=createFast5Calculator({now:()=>now});
 const samples=[[-119900,80000],[-90000,80004],[-60000,80009],[-30000,80013],[-700,80018]];
 for(const [offset,price] of samples){
   now=R+offset;
   const m=market(now,{round:R-300000,price,withHistory:false});
   const result=c.update(m);
   assert.equal(result.locked,false);
 }
 now=R+300;
 const r=c.update(market(now,{open:80020,price:80020,withHistory:false}));
 assert.equal(r.locked,true);
 assert.equal(r.signal.direction,'UP');
 assert.equal(r.signal.prewarmSource,'PREVIOUS_120S_REAL_TICKS');
});
test('stale current tick gets preview but cannot become executable signal',()=>{
 let now=R+300,c=createFast5Calculator({now:()=>now});
 const r=c.update(market(now,{price:80007,stale:true}));
 assert.equal(r.locked,false);
 assert.equal(r.provisionalDirection,'UP');
 assert.equal(c.status().latest,null);
});
test('no prewarm evidence or late opening tick does not fabricate production signal',()=>{
 let now=R+200,c=createFast5Calculator({now:()=>now});
 assert.equal(c.update(market(now,{withHistory:false})).locked,false);
 now=R+1200;
 assert.equal(c.update(market(now,{withHistory:true})).locked,false);
 assert.equal(c.status().latest,null);
});
