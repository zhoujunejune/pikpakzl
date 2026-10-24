import test from "node:test";
import assert from "node:assert/strict";
import {buildDecisionReview,REVIEW_VERSION} from "./decision-review.mjs";
function base(){
 return {openPrice:100,features:{
  ema1m9:102,ema1m21:103,ema5m9:103,ema5m21:104,
  momentum1m5Pct:-.12,momentum5m15Pct:-.24,
  location1m20:.99,volumeRatio1m:8,
 },enrichment:{features:{
  fifteenMinute:{ema9:101,ema21:104,moveLast45mPct:-.2},
  aggressiveFlow:{takerBuyFraction:.76,deltaNotionalUsd:2000000,verifiedPriceResponse:true,futuresPriceMovePct:-.09},
  orderBook:{imbalanceTop20:-.85},
  openInterestChange:{change5mPct:-.2}
 }},featureAvailability:{
  fifteenMinute:{available:true},orderBook:{available:true},
  aggressiveFlow:{available:true},continuousAggTrade:{available:false,error:"INCOMPLETE"}
 }};
}
test("three-level downtrend with buy pressure is flagged for absorption and contradictory book",()=>{
 const r=buildDecisionReview(base());
 assert.equal(r.version,REVIEW_VERSION);
 assert.equal(r.timeframeSummary.higherAligned,"DOWN");
 assert.ok(r.warnings.some(x=>x.startsWith("POSSIBLE_BUY_ABSORPTION")));
 assert.ok(r.warnings.some(x=>x.startsWith("ORDERBOOK_VS_FLOW_CONFLICT")));
 assert.ok(r.warnings.some(x=>x.startsWith("HIGH_VOLUME_RANGE_HIGH")));
 assert.ok(r.warnings.some(x=>x.startsWith("NO_VERIFIED_CONTINUOUS_FLOW")));
 assert.equal("direction" in r,false);
 assert.equal("confidence" in r,false);
});
test("mirror image bullish trend, heavy aggressive sells and rising price gets symmetrical warning",()=>{
 const s=base();
 s.features={...s.features,ema1m9:103,ema1m21:101,ema5m9:104,ema5m21:102,
  momentum1m5Pct:.1,location1m20:.1,volumeRatio1m:2};
 s.openPrice=104;
 s.enrichment.features.fifteenMinute={ema9:105,ema21:102,moveLast45mPct:.11};
 s.enrichment.features.aggressiveFlow={takerBuyFraction:.20,deltaNotionalUsd:-2000000,verifiedPriceResponse:true,futuresPriceMovePct:.11};
 s.enrichment.features.orderBook={imbalanceTop20:.88};
 const r=buildDecisionReview(s);
 assert.equal(r.timeframeSummary.higherAligned,"UP");
 assert.ok(r.warnings.some(x=>x.startsWith("POSSIBLE_SELL_ABSORPTION")));
 assert.ok(r.warnings.some(x=>x.startsWith("HIGHER_TIMEFRAME_VS_FLOW_CONFLICT")));
 assert.equal("direction" in r,false);
});
test("continuous valid window used once, not converted to fake confidence score",()=>{
 const s=base();
 s.continuousTradeFlow={windows:{"300s":{windowSeconds:300,buyFraction:.44}}};
 s.featureAvailability.continuousAggTrade={available:true,windows:["300s"]};
 const r=buildDecisionReview(s);
 assert.ok(r.independentChecks.some(x=>x.label==="continuous verified taker flow"));
 assert.ok(!r.warnings.some(x=>x.startsWith("NO_VERIFIED_CONTINUOUS_FLOW")));
 assert.ok(!r.warnings.some(x=>x.startsWith("MISSING_CONTINUOUSAGGTRADE")));
 assert.equal(typeof r.riskOfOverconfidentDecision,"string");
});
test("all inputs missing: quality review does not fabricate evidence",()=>{
 const r=buildDecisionReview({features:{},enrichment:{features:{}},
  featureAvailability:{fifteenMinute:{available:false,error:"HTTP_451"}}});
 assert.equal(r.trend.length,0);
 assert.ok(r.warnings.some(x=>x.startsWith("MISSING_FIFTEENMINUTE")));
 assert.equal("direction" in r,false);
});

test("different reference and futures prices NEVER prove absorption without same-market price response",()=>{
 const s=base();
 s.openPrice=90000;
 s.features.ema1m9=100000;
 s.enrichment.features.aggressiveFlow.verifiedPriceResponse=false;
 s.enrichment.features.aggressiveFlow.futuresPriceMovePct=null;
 const r=buildDecisionReview(s);
 assert.equal(r.priceScopes.cannotCompareCrossMarketPricesDirectly,true);
 assert.equal(r.priceScopes.futuresPriceResponseVerified,false);
 assert.ok(!r.warnings.some(x=>x.startsWith("POSSIBLE_BUY_ABSORPTION")));
 assert.ok(r.warnings.some(x=>x.startsWith("FLOW_PRICE_RESPONSE_UNVERIFIED")));
});
test("15m RSI oversold plus short price rebound is flagged, NEVER forces the UP direction",()=>{
 const s=base();
 s.enrichment.features.fifteenMinute.rsi14=22.5;
 s.features.momentum1m5Pct=.14;
 const r=buildDecisionReview(s);
 assert.equal(r.timeframeSummary.rsi15m,22.5);
 assert.ok(r.warnings.some(x=>x.startsWith("OVERSOLD_REVERSAL_RISK")));
 assert.ok(r.warnings.some(x=>x.startsWith("OVERSOLD_SHORT_TERM_RECOVERY")));
 assert.equal("direction" in r,false);
});
test("overbought deterioration is symmetric, no automatic DOWN signal",()=>{
 const s=base();
 s.enrichment.features.fifteenMinute.rsi14=78;
 s.features.momentum1m5Pct=-.14;
 const r=buildDecisionReview(s);
 assert.ok(r.warnings.some(x=>x.startsWith("OVERBOUGHT_PULLBACK_RISK")));
 assert.ok(r.warnings.some(x=>x.startsWith("OVERBOUGHT_SHORT_TERM_WEAKENING")));
 assert.equal("direction" in r,false);
});
