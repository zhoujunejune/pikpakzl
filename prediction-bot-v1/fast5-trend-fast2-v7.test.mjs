import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,calculateTrendContext,STRATEGY_VERSION,
 SIGNAL_END_MS,FAST_MODEL_ID,TREND_VERSION} from './fast5-real-market-calculator.mjs';
const R=1793095800000;
function market(t,{sign=1,offset=250,eventLag=40,marker=R,
 rows15=true,breakRows=false,openMove=0}={}){
 const n=rows15?15:3,rows=[];
 for(let i=n;i>=1;i--){
  const start=R-i*60000,index=n-i,px=80000+sign*index*offset;
  rows.push({startMs:start,endMs:start+59999,
   open:px,close:px+sign*offset,closed:true});
 }
 if(breakRows)rows.splice(1,1);
 const p=rows.at(-1).close+sign*0.10;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:t-eventLag,marketFeedConnected:true,roundStartMs:marker,
   lastPrice:p,roundOpenPrice:p-openMove},
  candles:{'1m':{rows}}};
}
test('V7 removes 5bps gate and enforces immutable 2s decision end',()=>{
 assert.equal(STRATEGY_VERSION,'FAST5_BULL_BEAR_TREND_2S_V7');
 assert.equal(SIGNAL_END_MS,2000);
 assert.equal(TREND_VERSION,'MULTISCALE_15S_120S_15M_REAL_MARKET_V1');
 for(const delta of [1,5,25,100]){
  const t=R+150,c=createFast5Calculator({now:()=>t});
  const a=c.update(market(t,{sign:1,offset:delta}));
  assert.equal(a.locked,true);assert.equal(a.signal.direction,'UP');
  assert.equal(a.signal.round,R);assert.equal(a.signal.model,FAST_MODEL_ID);
  assert.equal(a.signal.strategyVersion,STRATEGY_VERSION);
  assert.ok(a.signal.lockedAt<R+2000);
  assert.equal(a.signal.requiresDeepSeek,false);assert.equal(a.signal.orders,false);
 }
});
test('faster than 100ms can lock with verified cached market snapshot',()=>{
 const t=R+60,c=createFast5Calculator({now:()=>t});
 const a=c.update(market(t,{sign:-1,eventLag:20}));
 assert.equal(a.locked,true);
 assert.equal(a.signal.direction,'DOWN');
 assert.equal(a.signal.lockedAt,R+60);
});
test('1.9s live short trend can still lock; exactly 2s becomes WAIT',()=>{
 let t=R+1900,c=createFast5Calculator({now:()=>t});
 const a=c.update(market(t,{sign:-1}));
 assert.equal(a.locked,true);assert.equal(a.signal.direction,'DOWN');
 t=R+2000;
 const d=createFast5Calculator({now:()=>t}),b=d.update(market(t));
 assert.equal(b.locked,false);assert.equal(b.reason,'OPEN_2S_DEADLINE_MISSED');
 assert.equal(d.status().provisionalDirection,null);
 t=R+3200;
 const after=d.update(market(t));
 assert.equal(after.locked,false);assert.equal(after.reason,'OPEN_2S_DEADLINE_MISSED');
});
test('a frozen signal never changes UP to DOWN after its first real lock',()=>{
 let t=R+150,c=createFast5Calculator({now:()=>t});
 const a=c.update(market(t,{sign:1})).signal;
 t=R+1500;
 const b=c.update(market(t,{sign:-1})).signal;
 assert.deepEqual(b,a);
});
test('no fake lock with disconnected, expired, wrong-round or non-BTC data',()=>{
 const t=R+110,c=createFast5Calculator({now:()=>t});
 const expired=market(t,{eventLag:4000});
 assert.equal(c.update(expired).locked,false);
 const disconnected=market(t);disconnected.latest.marketFeedConnected=false;
 assert.equal(c.update(disconnected).locked,false);
 const other=market(t,{marker:R-300000});
 assert.equal(c.update(other).locked,false);
 const symbol=market(t);symbol.symbol='ETHUSDT';
 assert.equal(c.update(symbol).locked,false);
 assert.equal(c.status().latest,null);
});
test('missing 15m data does not prohibit valid 2m movement',()=>{
 let t=R+175,c=createFast5Calculator({now:()=>t});
 const a=c.update(market(t,{rows15:false,offset:100}));
 assert.equal(a.locked,true);assert.equal(a.signal.trendLongBps,null);
});
test('requires genuine completed candles and refuses fake forming bars',()=>{
 let t=R+175,c=createFast5Calculator({now:()=>t});
 const m=market(t,{rows15:false,breakRows:true});
 m.candles['1m'].rows=[{startMs:R,endMs:R+59999,open:80000,close:89000,closed:false}];
 const a=c.update(m);
 assert.equal(a.locked,false);assert.equal(c.status().latest,null);
});
test('prior real ticks provide near-term signed trend context',()=>{
 let t=R-1800,c=createFast5Calculator({now:()=>t});
 // Collect live prior-round ticks with the old round marker.
 for(const [delta,price] of [[-1800,80002],[-1500,80001],[-800,79999]]){
  t=R+delta;const m=market(t,{sign:-1});
  m.latest.roundStartMs=R-300000;m.latest.lastPrice=price;
  c.update(m);
 }
 t=R+100;
 const a=c.update(market(t,{sign:-1}));
 assert.equal(a.locked,true);assert.equal(a.signal.direction,'DOWN');
 assert.equal(a.signal.currentRoundQuoteVerified,true);
});
