import test from "node:test";
import assert from "node:assert/strict";
import {compactEvidence,COMPACT_VERSION} from "./compact-evidence.mjs";
function sample(){
 return {source:"PUBLIC_PROXY",openedAt:1000000,openPrice:100000,
  priceStructure:{source:"SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES",lastClosedCandleAt:940000,
   adaptiveLookbackBars:60,lastThreeClosedBarsTrend:"UP",confirmedThreeBarBreakout:"NONE"},
  features:{
   momentum1m5Pct:.11,momentum5m15Pct:-.02,atr1m14:80,
   macd1m:{histogram:9999},rsi1m14:44,ema1m9:9000,
   location1m20:.77,volumeRatio1m:4
  },rollingTenMinutes:{movePct:.03,volume:999},
  enrichment:{features:{
    fifteenMinute:{ema9:101000,ema21:100000,rsi14:55,macd:{histogram:777}},
    aggressiveFlow:{verifiedPriceResponse:true,tradeSpanMs:24000,
      takerBuyFraction:.4,deltaNotionalUsd:-420000,futuresPriceMovePct:.06},
    orderBook:{imbalanceTop20:999},
    futuresIndex:{indexPrice:444},
    openInterest:{openInterestBtc:999}
  }},
  continuousTradeFlow:{windows:{
   "60s":{complete:true,buyFraction:.01},
   "300s":{complete:true,buyFraction:.99},
   "600s":{complete:true,buyFraction:.34,netTakerNotionalUsd:-600000,observedGroups:1000}
  }}};
}
test("DeepSeek V6 receives five curated evidence groups, no duplicated indicators",()=>{
 const c=compactEvidence(sample()),str=JSON.stringify(c);
 assert.equal(c.version,COMPACT_VERSION);
 assert.deepEqual(Object.keys(c),["version","forecastTarget","shortPriceTrend","priceStructure","fifteenMinuteContext",
   "continuousFlow10m","shortFuturesPriceResponse","limitations"]);
 for(const removed of ["macd","orderBook","openInterest","futuresIndex","ema1m9","rsi1m14",
   "volumeRatio1m","location1m20","60s","300s","funding"])
   assert.equal(str.includes(removed),false,removed);
 assert.equal(c.continuousFlow10m.takerBuyFraction,.34);
 assert.equal(c.shortFuturesPriceResponse.sameInstrumentPriceMovePct,.06);
 assert.equal(c.fifteenMinuteContext.trend,"UP");
 assert.equal(c.forecastTarget.referencePrice,100000);
 assert.equal(c.priceStructure.lastThreeClosedBarsTrend,"UP");
 assert.equal(c.limitations.referencePriceNotComparableInAbsoluteTermsToFutures,true);
});
test("incomplete 600s tape and short sample are omitted, not replaced with 60s or 300s",()=>{
 const s=sample();
 s.continuousTradeFlow.windows["600s"].complete=false;
 s.enrichment.features.aggressiveFlow.tradeSpanMs=5000;
 const c=compactEvidence(s);
 assert.equal(c.continuousFlow10m,null);
 assert.equal(c.shortFuturesPriceResponse,null);
 assert.ok(c.limitations.missingVerifiedSections.includes("fullTenMinuteFlow"));
 assert.ok(c.limitations.missingVerifiedSections.includes("shortSameMarketResponse"));
});
