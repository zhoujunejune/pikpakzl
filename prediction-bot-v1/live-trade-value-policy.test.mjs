import test from 'node:test';
import assert from 'node:assert/strict';
import {decideLiveTradeValue,MIN_PRIOR_SIDE_RESULTS,COST_BUFFER} from './live-trade-value-policy.mjs';
const learning=(samples=90,hits=56)=>({upDown:{UP:{samples,hits},DOWN:{samples:68,hits:41}}});
test('only official historic directional evidence plus a real quote can authorize a trade',()=>{
 const x=decideLiveTradeValue({learning:learning(),originalDirection:'UP',orderDirection:'UP',quoteChance:.30});
 assert.equal(x.decision,'TRADE');assert.equal(x.valid,true);
 assert.equal(x.probabilityNotCalibrated,true);
 assert.equal(x.assumedCostBuffer,COST_BUFFER);
 assert.equal(x.samples,90);
});
test('rejects overpriced quote, even when AI forecasts UP',()=>{
 const x=decideLiveTradeValue({learning:learning(),originalDirection:'UP',orderDirection:'UP',quoteChance:.65});
 assert.equal(x.decision,'NO_TRADE');assert.equal(x.reason,'QUOTE_PRICE_NOT_WORTH_RISK');
});
test('unavailable empirical official evidence must never be fabricated or treated as confidence',()=>{
 const x=decideLiveTradeValue({learning:null,originalDirection:'UP',orderDirection:'UP',quoteChance:.3});
 assert.equal(x.decision,'NO_TRADE');assert.equal(x.reason,'OFFICIAL_EXPERIENCE_UNAVAILABLE');
});
test('short samples block real orders',()=>{
 const x=decideLiveTradeValue({learning:learning(MIN_PRIOR_SIDE_RESULTS-1,25),originalDirection:'UP',orderDirection:'UP',quoteChance:.02});
 assert.equal(x.decision,'NO_TRADE');assert.equal(x.reason,'INSUFFICIENT_OFFICIAL_SAMPLES');
});
test('direction reversal computes hit rate of inverted direction, not the original forecast',()=>{
 const x=decideLiveTradeValue({learning:learning(100,75),originalDirection:'UP',orderDirection:'DOWN',quoteChance:.38});
 assert.equal(x.decision,'NO_TRADE');assert.equal(x.hits,25);
});
test('invalid quote/direction must be NO_TRADE',()=>{
 for(const q of [-1,0,1,NaN,undefined])
  assert.equal(decideLiveTradeValue({learning:learning(),originalDirection:'UP',orderDirection:'UP',quoteChance:q}).decision,'NO_TRADE');
 assert.equal(decideLiveTradeValue({learning:learning(),originalDirection:'UP',orderDirection:'WAIT',quoteChance:.4}).decision,'NO_TRADE');
});
