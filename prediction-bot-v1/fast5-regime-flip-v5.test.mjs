import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,classifyPreRoundRegime,STRATEGY_VERSION,REGIME_VERSION} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
function market(t,{netBps=0,orig='UP',missing=false,stale=false}={}){
 const openPrice=80000;
 const rows=Array.from({length:15},(_,index)=>{
  const start=R-(15-index)*60000;
  const from=openPrice*Math.exp(netBps*index/15/10000);
  const to=openPrice*Math.exp(netBps*(index+1)/15/10000);
  return {startMs:start,endMs:start+59999,open:from,close:to,closed:true};
 });
 if(missing)rows.splice(7,1);
 const op=80000,cur=orig==='UP'?80005:79995;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
   eventMs:stale?t-5000:t-40,roundStartMs:R,marketFeedConnected:true,
   lastPrice:cur,roundOpenPrice:op},
  candles:{'1m':{rows}}};
}
function result(netBps,orig='UP',other={}){
 const t=R+300,calc=createFast5Calculator({now:()=>t});
 return calc.update(market(t,{netBps,orig,...other}));
}
test('V5 uses exactly last 15 closed minutes, no current/future bar',()=>{
 assert.equal(STRATEGY_VERSION,'FAST5_REGIME_FLIP_GT5BPS_15M_V5');
 assert.equal(REGIME_VERSION,'REGIME_PREV15_CLOSED_1M_NET_BPS_V1');
 const regime=classifyPreRoundRegime(market(R+300,{netBps:8}),R);
 assert.equal(regime.regime,'MEDIUM');
 assert.equal(regime.firstStartMs,R-900000);
 assert.equal(regime.lastEndMs,R-1);
});
test('small price movement <=5bps preserves original UP or DOWN',()=>{
 for(const bps of [-5,0,4.9]){
  for(const original of ['UP','DOWN']){
   const r=result(bps,original);
   assert.equal(r.locked,true);
   assert.equal(r.signal.regime,'SMALL');
   assert.equal(r.signal.originalDirection,original);
   assert.equal(r.signal.direction,original);
   assert.equal(r.signal.invertByRegime,false);
  }
 }
});
test('medium movement >5bps and <12bps flips original UP and DOWN',()=>{
 for(const move of [-8,8]){
  for(const original of ['UP','DOWN']){
   const r=result(move,original);
   assert.equal(r.locked,true);
   assert.equal(r.signal.regime,'MEDIUM');
   assert.equal(r.signal.invertByRegime,true);
   assert.equal(r.signal.originalDirection,original);
   assert.equal(r.signal.direction,original==='UP'?'DOWN':'UP');
  }
 }
});
test('large movement >=12bps flips original direction',()=>{
 for(const move of [-20,20]){
  const r=result(move,'DOWN');
  assert.equal(r.locked,true);
  assert.equal(r.signal.regime,'LARGE');
  assert.equal(r.signal.direction,'UP');
  assert.equal(r.signal.invertByRegime,true);
 }
});
test('no complete 15 closed candles, or stale source, never fabricates direction',()=>{
 assert.equal(result(8,'UP',{missing:true}).locked,false);
 assert.equal(result(8,'UP',{stale:true}).locked,false);
});
test('after +5 sec no locking, even with complete trend bars',()=>{
 const t=R+5000,calc=createFast5Calculator({now:()=>t});
 assert.equal(calc.update(market(t,{netBps:22})).reason,'OPEN_5S_DEADLINE_MISSED');
});
