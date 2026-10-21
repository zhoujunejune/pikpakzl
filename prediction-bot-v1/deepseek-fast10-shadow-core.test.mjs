import test from 'node:test';
import assert from 'node:assert/strict';
import {ROUND_MS,PREWARM_LOOKBACK_MS,LOCK_DEADLINE_MS,roundOf,newWindow,observe,normalizeMarket,parsePrewarm,prewarmRequest,finalize,stateInfo} from './deepseek-fast10-shadow-core.mjs';
const r=1800000000000,target=r+ROUND_MS;
const fake=(when,price,opened=67000,round=roundOf(when))=>({
 ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:when,roundStartMs:round,lastPrice:price,
  roundOpenPrice:opened,marketFeedConnected:true}});
function prepare(){
 const w=newWindow(target);
 for(let i=0;i<120;i++)observe(w,normalizeMarket(fake(target-120000+i*1000,67000+i*.2,66000,r),target-120000+i*1000));
 w.prewarm=parsePrewarm('{"direction":"UP","confidence":0.61,"reason":"prior BTC structure"}',target,target-15000);
 return w;
}
test('new round always uses exchange feed opening price, not previous open',()=>{
 const w=prepare();
 for(let i=0;i<9;i++)observe(w,normalizeMarket(fake(target+i*1000,68000+i*2,68000,target),target+i*1000));
 const d=finalize(w,target+8500);
 assert.equal(d.latest.openPrice,68000);
 assert.equal(d.latest.previousTwoMinuteBps>0,true);
 assert.equal(d.latest.earlySnapshots,9);
 assert.ok(d.generatedAt<target+10000);
 assert.equal(d.orders,false);assert.equal(d.productionIntegration,false);
 assert.equal(d.latest.scoreIsCalibratedProbability,false);
});
test('strongly negative next-round early move can counter earlier bullish DeepSeek lean',()=>{
 const w=prepare();
 for(let i=0;i<9;i++)observe(w,normalizeMarket(fake(target+i*1000,68000-i*7,68000,target),target+i*1000));
 const d=finalize(w,target+8500);
 assert.equal(d.latest.rawPrewarmDirection,'UP');
 assert.equal(d.latest.direction,'DOWN');
});
test('no lookahead, never publish after ten seconds, only one decision',()=>{
 const w=prepare();
 for(let i=0;i<9;i++)observe(w,normalizeMarket(fake(target+i*1000,68000+i,68000,target),target+i*1000));
 assert.throws(()=>finalize(w,target+10000),/OUTSIDE_FAST10_FINAL_WINDOW/);
 const d=finalize(w,target+8200);
 assert.equal(d.latest.direction,'UP');
 assert.throws(()=>finalize(w,target+8500),/ALREADY_LOCKED/);
 assert.equal(LOCK_DEADLINE_MS,10000);assert.equal(PREWARM_LOOKBACK_MS,120000);
});
test('forbid signals without a real pre-round DeepSeek direction',()=>{
 const w=prepare();w.prewarm=null;
 for(let i=0;i<9;i++)observe(w,normalizeMarket(fake(target+i*1000,68000+i,68000,target),target+i*1000));
 assert.throws(()=>finalize(w,target+8500),/VALID_DEEPSEEK_PREWARM_REQUIRED/);
});
test('stale or wrong-round or invented feeds rejected',()=>{
 assert.throws(()=>normalizeMarket({...fake(target,68000),readOnly:false},target),/UNTRUSTED/);
 assert.throws(()=>normalizeMarket(fake(target-9000,68000),target),/INVALID_OR_STALE/);
 assert.throws(()=>normalizeMarket({...fake(target,68000),latest:{...fake(target,68000).latest,roundStartMs:r}},target+1000),/INVALID_OR_STALE/);
});
test('avoid hallucinating opening price and future labels in prewarm prompt',()=>{
 const w=prepare();const p=prewarmRequest(w,target-10000,{rsi14:51});
 const text=p.messages[1].content;
 assert.ok(text.includes('targetRound'));
 assert.equal(text.includes('"officialActual"'),false);
 assert.equal(p.thinking.type,'enabled');
 assert.throws(()=>prewarmRequest(w,target+1000),/NOT_IN_PREWARM_PERIOD/);
 assert.throws(()=>parsePrewarm('{"direction":"UP","confidence":0.9}',target,target),/PREWARM_MUST_BE_CAUSAL/);
 assert.throws(()=>parsePrewarm('{"direction":"WAIT","confidence":0.5}',target,target-10000),/PREWARM_DIRECTION_REQUIRED/);
});
test('must get fresh actual early ticks and stable round open; never reuse last round ticker',()=>{
 const w=prepare();
 for(let i=0;i<9;i++)observe(w,normalizeMarket(fake(target+i*1000,68000+i,68000,target),target+i*1000));
 w.early.at(-1).at=target+2000;
 assert.throws(()=>finalize(w,target+8500),/NEW_ROUND_TICK_STALE/);
 w.early.at(-1).at=target+8000;
 w.early.at(-1).open=68008;
 assert.throws(()=>finalize(w,target+8500),/ROUND_OPEN_PRICE_CHANGED/);
});
test('shadow-only status explains coverage and deadline',()=>{
 const w=prepare();const s=stateInfo(w,target+6000);
 assert.equal(s.orders,false);
 assert.equal(s.strictLockDeadlineMs,target+10000);
 assert.equal(s.prewarmSnapshots,120);
});
