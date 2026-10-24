import test from "node:test";
import assert from "node:assert/strict";
import {buildDecisionReview,REVIEW_VERSION} from "./decision-review.mjs";
function caseStudy(){
 return {source:"PROXY",openPrice:81000,openedAt:1000000,features:{
  momentum1m5Pct:.11,momentum5m15Pct:-.23,atr1m14:44},
  rollingTenMinutes:{movePct:.01},enrichment:{features:{
   fifteenMinute:{ema9:80700,ema21:80800,rsi14:24},
   aggressiveFlow:{verifiedPriceResponse:true,tradeSpanMs:35000,
    takerBuyFraction:.32,deltaNotionalUsd:-1000000,futuresPriceMovePct:.08}
  }},continuousTradeFlow:{windows:{"600s":{windowSeconds:600,complete:true,observedGroups:2100,
   buyFraction:.35,netTakerNotionalUsd:-7000000}}}};
}
test("V6 captures reversal risks and same-futures response, without forcing UP or DOWN",()=>{
 const d=buildDecisionReview(caseStudy());
 assert.equal(d.version,REVIEW_VERSION);
 assert.ok(d.warnings.some(x=>x.startsWith("OVERSOLD_REVERSAL_RISK")));
 assert.ok(d.warnings.some(x=>x.startsWith("TIMEFRAME_TREND_CONFLICT")));
 assert.ok(d.warnings.some(x=>x.startsWith("POSSIBLE_SELL_ABSORPTION")));
 assert.equal("direction" in d,false);
 assert.equal("confidence" in d,false);
});
test("without verified same-market price move there is no fabricated absorption warning",()=>{
 const x=caseStudy();
 x.enrichment.features.aggressiveFlow.verifiedPriceResponse=false;
 assert.ok(!buildDecisionReview(x).warnings.some(w=>w.startsWith("POSSIBLE_SELL_ABSORPTION")));
});
test("missing inputs are noted but not silently replaced or scored",()=>{
 const d=buildDecisionReview({features:{},enrichment:{features:{}},rollingTenMinutes:{}});
 assert.equal(d.missingVerifiedSections.length,5);
 assert.equal("direction" in d,false);
 assert.equal("trend" in d,false);
});
test("overbought context is symmetric",()=>{
 const x=caseStudy();
 x.enrichment.features.fifteenMinute.rsi14=82;
 assert.ok(buildDecisionReview(x).warnings.some(w=>w.startsWith("OVERBOUGHT_PULLBACK_RISK")));
});
