import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveExitV2,compareQuoteReplay,executableNetValue,GUARDIAN_MODEL} from './guardian-adaptive-exit-v2.mjs';
const ROUND=1793182200000;
const row=(i,value,opts={})=>({
 source:'BINANCE_PREDICTION_SELL_QUOTE',side:'SELL',quoteId:'q-'+i,
 tokenId:'token-001',round:ROUND,at:ROUND+10000+i*1000,
 expireAt:ROUND+12000+i*1000,amountOut:value,feeAmount:0,
 slippageBufferAmount:0,...opts
});
const args=(values,at)=>({
 model:GUARDIAN_MODEL,round:ROUND,tokenId:'token-001',orderId:'order-001',
 cost:1,quotes:values.map((v,i)=>row(i,v)),now:at??ROUND+10000+(values.length-1)*1000
});
test('refuses fake, stale, missing-fee and cross-token quotes',()=>{
 assert.equal(executableNetValue(row(0,1,{feeAmount:undefined})),null);
 assert.equal(adaptiveExitV2(args([1],ROUND+20000)).reason,'SELL_QUOTE_STALE_OR_EXPIRED');
 assert.equal(adaptiveExitV2({...args([1]),quotes:[row(0,1,{tokenId:'wrong'})]}).ok,false);
 assert.equal(adaptiveExitV2({...args([1,1]),quotes:[row(1,1),row(0,1)]}).ok,false);
 assert.equal(adaptiveExitV2({...args([1]),quotes:[row(0,1,{side:'BUY'})]}).ok,false);
});
test('hard 10% stop is never widened even when history incomplete',()=>{
 const r=adaptiveExitV2(args([.89]));
 assert.equal(r.reason,'V2_HARD_LOSS_CAP');
 assert.equal(r.triggered,true);
 assert.equal(r.stopFloor,.90);
});
test('calm quotes tighten stop, volatile quotes retain original cap',()=>{
 const calm=[1,1,1,1,1,1,1,.939];
 const a=adaptiveExitV2(args(calm));
 assert.equal(a.adaptive,true);assert.equal(a.kind,'STOP_LOSS');
 assert.equal(a.reason,'V2_ADAPTIVE_STOP');
 const volatile=[1,.95,1.03,.96,1.04,.97,1.05,.91];
 const b=adaptiveExitV2(args(volatile));
 assert.equal(b.adaptive,true);assert.equal(b.triggered,false);
 assert.equal(b.stopFloor,.90);
});
test('trail follows executable quote peak and not spot price',()=>{
 const p=[1,1.02,1.05,1.08,1.12,1.17,1.20,1.19,1.18,1.14];
 const r=adaptiveExitV2(args(p));
 assert.equal(r.kind,'TAKE_PROFIT');assert.equal(r.peak,1.2);
 assert.equal(r.reason,'V2_ADAPTIVE_TRAIL');
});
test('near settlement loss exit and future observations rejected',()=>{
 const now=ROUND+295000;
 const q=row(0,.98,{at:now,expireAt:now+1500});
 const p=args([1]);p.quotes=[q];p.now=now;
 const r=adaptiveExitV2(p);
 assert.equal(r.reason,'V2_NEAR_SETTLEMENT_LOSS');
 assert.equal(adaptiveExitV2({...p,now:now-1}).reason,'NON_CAUSAL_OR_CROSS_POSITION_QUOTE');
});
test('small history stays on baseline behavior',()=>{
 const r=adaptiveExitV2(args([1.01,1.015,1.02]));
 assert.equal(r.adaptive,false);
 assert.equal(r.reason,'V2_INSUFFICIENT_HISTORY_FALLBACK');
 assert.equal(r.trailGivebackPct,.04);
});
test('replay reports quote proxy and never actual realized PnL',()=>{
 const data=args([1,1.02,1.04,1.08,1.12,1.17,1.20,1.19,1.14]);
 const v=compareQuoteReplay(data);
 assert.equal(v.ok,true);assert.equal(v.observations,9);
 assert.equal(v.actualFillVerified,false);assert.equal(v.settledTradePnl,null);
 assert.equal(v.bothExit,true);assert.ok(Number.isFinite(v.proxyDifferenceBothExits));
});
test('missing fee and slippage evidence is not guessed',()=>{
 const data=args([1]);data.quotes[0].slippageBufferAmount=undefined;
 const r=compareQuoteReplay(data);
 assert.equal(r.ok,false);assert.equal(r.reason,'UNVERIFIED_SELL_QUOTE_OR_COSTS');
});
