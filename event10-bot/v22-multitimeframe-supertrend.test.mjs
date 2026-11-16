import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {aggregateBars,analyzeMultiTimeframes,supertrend} from "./multi-timeframe-trend.mjs";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,MAX_SIGNALS_PER_10M,SIGNAL_WINDOW_MS} from "./manual-engine.mjs";
const BASE=Date.parse("2026-11-12T06:00:31Z");
const json=v=>({ok:true,json:async()=>v});
function rows(now,interval,n,ms,side=1){
 const end=Math.floor(now/ms)*ms,arr=[];
 for(let i=0;i<n;i++){
   const close=70000+side*(i-n+1)*1.6;
   const open=close-side*0.4;
   arr.push({startMs:end-(n-i)*ms,closed:true,open,close,
     high:Math.max(open,close)+1.1,low:Math.min(open,close)-1.1,
     volume:80+(i%5)});
 }
 return arr;
}
function feed(now,side=1,missing=[]){
 const candles={};
 for(const [interval,n,ms] of [["1m",245,60000],["5m",83,300000],
    ["15m",83,900000],["30m",83,1800000]]){
   if(!missing.includes(interval))candles[interval]=rows(now,interval,n,ms,side);
 }
 return {ok:true,readOnly:true,symbol:"BTCUSDT",
   marketSource:"VERIFIED_BINANCE_SPOT_TEST_FIXTURE",
   latest:{marketFeedConnected:true,eventMs:now-200,lastPrice:70000},candles};
}
function args(now,price=70002,prev=null,f=feed(now)){
 return {feed:f,reference:{observedAt:now},
   indexSnapshot:{price,observedAt:now-100,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"},
   previousIndexSnapshot:prev};
}
const file=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"v22-event10-")),"sessions.json");
test("six real closed-candle timeframes with aligned synthetic 2m/10m and supertrend",()=>{
 const a=evaluatePureSignal(args(BASE));
 assert.equal(RULE_VERSION,"EVENT10_MULTI_TF_SUPERTREND_V22_20261112");
 assert.equal(AUTO_SLOT_MS,12000);
 assert.equal(a.evidence.timeframeCoverage,6);
 assert.equal(a.evidence.aggregationSource,"CLOSED_BINANCE_SPOT_1M_ALIGNED_2M_10M");
 assert.deepEqual(Object.keys(a.evidence.timeframes),["1m","2m","5m","10m","15m","30m"]);
 for(const tf of Object.values(a.evidence.timeframes)){
   assert.equal(tf.available,true);
   assert.ok(tf.supertrend?.line>0);
   assert.ok(tf.emaFast>0);
   assert.ok(tf.rsi14>=0);
 }
 assert.equal(a.evidence.currentIndexPrice,70002);
 assert.equal(a.evidence.currentPriceUsedForDirection,true);
 assert.equal(a.evidence.confidenceCalibrated,false);
 assert.equal(a.direction,"UP");
});
test("2m and 10m aggregation drops incomplete candles, never includes future minute",()=>{
 const one=rows(BASE,"1m",25,60000).map(x=>({t:x.startMs,o:x.open,
   h:x.high,l:x.low,c:x.close,v:x.volume}));
 const t2=aggregateBars(one,2),t10=aggregateBars(one,10);
 assert.ok(t2.length>=10&&t10.length>=2);
 for(const tf of [t2,t10]){
   assert.ok(tf.every(x=>x.t+((tf===t2)?120000:600000)<=BASE));
   assert.ok(tf.every(x=>x.o>0&&x.h>=x.c&&x.l<=x.c));
 }
 assert.equal(t10.at(-1).t%600000,0);
 assert.equal(t2.at(-1).t%120000,0);
});
test("Supertrend(10,3) recognizes sustained uptrend and downtrend",()=>{
 const up=rows(BASE,"5m",83,300000,1).map(x=>({
   t:x.startMs,o:x.open,c:x.close,h:x.high,l:x.low,v:x.volume}));
 const down=rows(BASE,"5m",83,300000,-1).map(x=>({
   t:x.startMs,o:x.open,c:x.close,h:x.high,l:x.low,v:x.volume}));
 assert.equal(supertrend(up)?.direction,"UP");
 assert.equal(supertrend(down)?.direction,"DOWN");
});
test("missing 15m or 30m is explicitly unavailable, never faked",()=>{
 const out=evaluatePureSignal(args(BASE,70003,null,feed(BASE,1,["15m","30m"])));
 assert.equal(out.evidence.timeframes["15m"].available,false);
 assert.equal(out.evidence.timeframes["30m"].available,false);
 assert.equal(out.evidence.timeframeCoverage,4);
 assert.ok(out.direction==="UP"||out.direction==="DOWN");
});
test("live index moves change current-price evidence at 12-second cadence",()=>{
 const prev={price:70040,observedAt:BASE-100};
 const out=evaluatePureSignal(args(BASE+12000,70020,prev));
 assert.equal(out.evidence.currentPriceDirection,"DOWN");
 assert.equal(out.evidence.liveIndexDelta,-20);
 assert.ok(out.evidence.liveIndexChangeBps<0);
});
test("missing or stale current index is rejected; no fabricated direction",()=>{
 assert.throws(()=>evaluatePureSignal(args(BASE,0)),/REALTIME_BINANCE_INDEX_REQUIRED/);
 const stale=args(BASE);
 stale.indexSnapshot.observedAt=BASE-10000;
 assert.throws(()=>evaluatePureSignal(stale),/REALTIME_BINANCE_INDEX_REQUIRED/);
 const staleBars=feed(BASE);
 staleBars.candles["1m"]=staleBars.candles["1m"].slice(0,-2);
 assert.throws(()=>evaluatePureSignal(args(BASE,70002,null,staleBars)),/REQUIRED_1m_STALE_1m/);
});
test("auto/manual share rolling 3/10m cap, keep 600s outcome, and never place orders",async()=>{
 assert.equal(MAX_SIGNALS_PER_10M,3);assert.equal(SIGNAL_WINDOW_MS,600000);
 const target=file();let now=BASE,index=70004;
 const source=async url=>{
   if(url.includes("shadow-market-data"))return json(feed(now));
   if(url.includes("premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(index),time:now-100});
   throw Error("UNEXPECTED_URL");
 };
 const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:target},fetcher:source});
 for(let i=0;i<3;i++){
   now=BASE+i*12000;index=70004+i;
   const x=await engine.start("auto-v22-signal-case-"+i+"-0001");
   assert.ok(["UP","DOWN"].includes(x.direction));
   assert.equal(x.realOrderPlaced,false);
   assert.equal(x.expiresAt-x.openedAt,600000);
   assert.equal(x.ruleChecks.evidence.timeframeCoverage,6);
 }
 assert.equal(engine.signals().total,3);
 assert.equal(engine.status().autoIntervalMs,12000);
 assert.deepEqual(engine.status().multiTimeframeIntervals,["1m","2m","5m","10m","15m","30m"]);
 now=BASE+36000;index=70020;
 assert.equal((await engine.start("manual-v22-fourth-0001")).eventTag,"V21_ROLLING_10M_CAP");
 const restored=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:target},fetcher:source});
 assert.equal((await restored.start("manual-v22-fifth-0001")).eventTag,"V21_ROLLING_10M_CAP");
 now=BASE+600001;index=70035;
 assert.ok((await restored.start("auto-v22-sixth-0001")).direction);
 assert.equal(restored.signals().total,4);
 assert.equal(restored.status().autoTradingEnabled,false);
 assert.equal(restored.status().modelCalls,0);
});
