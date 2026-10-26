import test from 'node:test';
import assert from 'node:assert/strict';
import {createFast5Calculator,classifyPreRoundRegime,STRATEGY_VERSION,REGIME_VERSION} from './fast5-real-market-calculator.mjs';
const R=1792945200000;
function market(t,{netBps=0,dir='UP',missing=false,currentCandle=false}={}){
 const price=80000;
 const rows=Array.from({length:15},(_,i)=>{
  const start=R-(15-i)*60000,from=price*Math.exp(netBps*i/15/10000);
  const to=price*Math.exp(netBps*(i+1)/15/10000);
  return {startMs:start,endMs:start+59999,open:from,close:to,closed:true};
 });
 if(missing)rows.splice(8,1);
 if(currentCandle)rows.push({startMs:R,endMs:R+59999,open:80000,close:85000,closed:false});
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:t-30,roundStartMs:R,lastPrice:dir==='UP'?80006:79994,
   roundOpenPrice:80000,marketFeedConnected:true},
  candles:{'1m':{rows}}};
}
const decide=(netBps,dir='UP',extra={})=>{
 let time=R+300,calc=createFast5Calculator({now:()=>time});
 return calc.update(market(time,{netBps,dir,...extra}));
};
test('V6 uses exactly previous 15 completed minutes, not future candles',()=>{
 assert.equal(STRATEGY_VERSION,'FAST5_SMALL_ONLY_LE5BPS_15M_V6');
 assert.equal(REGIME_VERSION,'REGIME_PREV15_CLOSED_1M_NET_BPS_V1');
 assert.equal(classifyPreRoundRegime(market(R+300,{netBps:8,currentCandle:true}),R).regime,'MEDIUM');
});
test('small regime at or below 5bps locks original UP and DOWN without model inversion',()=>{
 for(const netBps of [-5,-4.99,0,4.99,5])
  for(const dir of ['UP','DOWN']){
   const r=decide(netBps,dir);
   assert.equal(r.locked,true,'failed to lock '+netBps+' '+dir);
   assert.equal(r.signal.direction,dir);
   assert.equal(r.signal.regime,'SMALL');
   assert.equal(r.signal.invertByRegime,false);
   assert.equal(r.signal.originalDirection,dir);
  }
});
test('medium and large regime is WAIT, no executable signal at any time',()=>{
 for(const netBps of [-20,-8,-5.1,5.1,8,20]){
  let time=R+300,calc=createFast5Calculator({now:()=>time});
  let r=calc.update(market(time,{netBps,dir:'UP'}));
  assert.equal(r.locked,false);
  assert.equal(r.signal,null);
  assert.equal(r.reason,'REGIME_GT5_BPS_WAIT');
  assert.equal(calc.status().latest,null);
  assert.equal(calc.status().filteredOut,true);
  assert.ok(calc.status().regimeMagnitudeBps>5);
  time=R+1000;
  r=calc.update(market(time,{netBps:0,dir:'DOWN'})); // Simulated data mutation cannot reopen round.
  assert.equal(r.reason,'REGIME_GT5_BPS_WAIT');
  assert.equal(r.locked,false);
  time=R+6000;
  r=calc.update(market(time,{netBps:0}));
  assert.equal(r.reason,'REGIME_GT5_BPS_WAIT');
  assert.equal(r.locked,false);
 }
});
test('incomplete 15m candles never produce trade signal and late data cannot lock after 5s',()=>{
 let time=R+300,calc=createFast5Calculator({now:()=>time});
 assert.equal(calc.update(market(time,{missing:true})).locked,false);
 time=R+5000;
 const r=calc.update(market(time,{netBps:1}));
 assert.equal(r.locked,false);
 assert.equal(r.reason,'OPEN_5S_DEADLINE_MISSED');
});
