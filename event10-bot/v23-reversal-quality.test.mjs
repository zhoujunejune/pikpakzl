import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {selectTenMinuteDirection,aggregateBars,supertrend,closedSpotPriceAction,analyzeEntryHorizons,assessEntryTiming,TEN_MINUTE_WEIGHTS} from "./multi-timeframe-trend.mjs";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,MAX_SIGNALS_PER_10M,SIGNAL_WINDOW_MS} from "./manual-engine.mjs";
const BASE=Date.parse("2026-11-13T00:00:31Z");
const json=x=>({ok:true,json:async()=>x});
const temp=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-v23-")),"sessions.json");
function fixture(now,side=1){
 const candles={};
 for(const [tf,n,ms] of [["1m",245,60000],["5m",83,300000],["15m",83,900000],["30m",83,1800000]]){
  const end=Math.floor(now/ms)*ms;
  candles[tf]=Array.from({length:n},(_,i)=>{
   const close=70000+side*(i-n+1)*1.6,open=close-side*0.4;
   return {startMs:end-(n-i)*ms,closed:true,open,close,
     high:Math.max(open,close)+1.1,low:Math.min(open,close)-1.1,volume:81+i%5};
  });
 }
 return {ok:true,readOnly:true,symbol:"BTCUSDT",
   latest:{marketFeedConnected:true,lastPrice:70000,eventMs:now-100},candles};
}
function scoring(votes,liveBps=null){
 const t={};
 for(const [tf,vote] of Object.entries(votes))t[tf]={available:true,vote};
 return selectTenMinuteDirection(t,liveBps);
}
test("normalized votes: six correlated down trends no longer overpower a near-term three-timeframe up reversal",()=>{
 const weights=Object.values(TEN_MINUTE_WEIGHTS).reduce((a,b)=>a+b,0);
 assert.equal(weights,1);
 const r=scoring({"1m":5.2,"2m":5.2,"5m":5.2,"10m":-5.2,"15m":-5.2,"30m":-5.2},2.2);
 assert.equal(r.direction,"UP");
 assert.ok(r.trendScore>0&&r.trendScore<1.01);
 assert.equal(r.currentPriceDirection,"UP");
 assert.equal(r.noCalibratedConfidence,true);
});
test("emerging countertrend with 1m+2m reversal against 5m is not auto-followed",()=>{
 const r=scoring({"1m":5.2,"2m":5.2,"5m":-5.2,"10m":-5.2,"15m":-5.2,"30m":-5.2},1.6);
 assert.equal(r.direction,null);
 assert.equal(r.decisionReason,"V23_EARLY_REVERSAL_UNCONFIRMED");
 const slow=scoring({"1m":5.2,"2m":5.2,"5m":-5.2,"10m":-5.2,"15m":-5.2,"30m":-5.2},0.1);
 assert.equal(slow.direction,null);
 assert.equal(slow.decisionReason,"V23_EARLY_REVERSAL_UNCONFIRMED");
});
test("strong live adverse tick pauses instead of blindly following a stale trend",()=>{
 const r=scoring({"1m":-5.2,"2m":-5.2,"5m":-5.2,"10m":-5.2,"15m":-5.2,"30m":-5.2},5.6);
 assert.equal(r.direction,null);
 assert.equal(r.decisionReason,"V23_STRONG_LIVE_PRICE_CONFLICT");
});
test("strong confirmed trend and quiet index still emit both DOWN and UP",()=>{
 for(const sign of [-1,1]){
  const votes=Object.fromEntries(Object.keys(TEN_MINUTE_WEIGHTS).map(t=>[t,sign*5.2]));
  const r=scoring(votes,0.3);
  assert.equal(r.direction,sign>0?"UP":"DOWN");
  assert.equal(r.decisionReason,"V23_NORMALIZED_TREND");
  assert.equal(r.currentPriceDirection,null);
 }
});
test("future/incomplete data is excluded and actual Supertrend still computes",()=>{
 const now=BASE,one=fixture(now).candles["1m"].map(x=>({
   t:x.startMs,o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume}));
 const bars=aggregateBars(one,10);
 assert.ok(bars.every(b=>b.t+600000<=now));
 assert.equal(supertrend(bars)?.direction,"UP");
});
test("full evaluation includes all six timeframes and fresh price, no real order",()=>{
 assert.equal(RULE_VERSION,"EVENT10_MULTI_HORIZON_ENTRY_V25_20261113");
 assert.equal(AUTO_SLOT_MS,12000);
 let f=fixture(BASE);
 const a=evaluatePureSignal({feed:f,reference:{observedAt:BASE},
   indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(a.direction,"UP");
 assert.equal(a.evidence.timeframeCoverage,6);
 assert.equal(a.evidence.trendDecisionReason,"V23_NORMALIZED_TREND");
 assert.equal(a.evidence.confidenceCalibrated,false);
 assert.equal(a.evidence.referenceIsActualEventContractStrike,false);
 assert.ok(a.evidence.timeframes["2m"].supertrend);
 assert.ok(a.evidence.timeframes["30m"].supertrend);
 assert.throws(()=>evaluatePureSignal({feed:f,reference:{observedAt:BASE},
   indexSnapshot:{price:70005,observedAt:BASE-6000}}),/REALTIME_BINANCE_INDEX_REQUIRED/);
});
test("same-side 12-second duplicates stopped; new independent 2m bars release signals; rolling 3/10m cap",async()=>{
 assert.equal(MAX_SIGNALS_PER_10M,3);assert.equal(SIGNAL_WINDOW_MS,600000);
 let now=BASE,price=70007;const file=temp();
 const fetcher=async url=>{
   if(url.includes("shadow-market-data"))return json(fixture(now));
   if(url.includes("premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(price),time:now-100});
   throw Error("UNEXPECTED_URL_"+url);
 };
 const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},fetcher});
 const first=await engine.start("auto-v23-one-00001");
 assert.equal(first.direction,"UP");assert.equal(first.realOrderPlaced,false);
 now=BASE+12000;price+=1;
 let d=await engine.start("auto-v23-dupe-0002");
 assert.equal(d.direction,null);assert.equal(d.eventTag,"V23_DUPLICATE_TREND");
 assert.equal(engine.signals().total,1);
 now=BASE+120001;price+=2;
 const second=await engine.start("manual-v23-two-00003");
 assert.equal(second.direction,"UP");
 assert.ok(second.ruleChecks.evidence.timeframes["2m"].lastClosedAt>first.ruleChecks.evidence.timeframes["2m"].lastClosedAt);
 now=BASE+240002;price+=3;
 const third=await engine.start("auto-v23-three-0004");
 assert.equal(third.direction,"UP");
 assert.equal(engine.signals().total,3);
 now=BASE+360003;price+=1;
 const capped=await engine.start("auto-v23-cap-000005");
 assert.equal(capped.direction,null);assert.equal(capped.eventTag,"V21_ROLLING_10M_CAP");
 const restarted=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},fetcher});
 assert.equal((await restarted.start("manual-v23-cap-0006")).eventTag,"V21_ROLLING_10M_CAP");
 now=BASE+600001;price+=2;
 const fourth=await restarted.start("auto-v23-four-00007");
 assert.equal(fourth.direction,"UP");
 assert.equal(restarted.signals().total,4);
 assert.equal(restarted.status().minDuplicateSameDirectionMs,120000);
 assert.equal(restarted.status().modelCalls,0);
 assert.equal(restarted.status().autoTradingEnabled,false);
 assert.equal(restarted.status().executionAvailable,false);
});
test("new-version ledger retains per-signal trend evidence for later retrospective audit",async()=>{
 let now=BASE,price=70008;const file=temp();
 const e=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},
   fetcher:async url=>url.includes("shadow-market-data")?json(fixture(now)):
     url.includes("premiumIndex")?json({symbol:"BTCUSDT",indexPrice:String(price),time:now-100}):
     Promise.reject(Error("UNEXPECTED_URL"))});
 const s=await e.start("manual-v23-ledger-0001");
 const out=e.signals(10,0).records[0];
 assert.equal(out.direction,s.direction);
 assert.ok(Number.isSafeInteger(out.twoMinuteBarAt));
 assert.equal(typeof out.trendScore,"number");
 assert.equal(out.trendDecisionReason,"V23_NORMALIZED_TREND");
});

test("V24: clear closed spot price reversal blocks chasing stale DOWN and UP symmetrically",()=>{
 const allDown=Object.fromEntries(Object.keys(TEN_MINUTE_WEIGHTS).map(k=>[k,-5.2]));
 const down=scoring(allDown,0.2);
 assert.equal(down.direction,"DOWN");
 const trendDown=Object.fromEntries(Object.keys(allDown).map(k=>[k,{available:true,vote:-5.2}]));
 const rejectedDown=selectTenMinuteDirection(trendDown,0.2,{
   threeMinuteBps:12,fiveMinuteBps:18,upCloses:3,downCloses:0});
 assert.equal(rejectedDown.direction,null);
 assert.equal(rejectedDown.decisionReason,"V24_SPOT_REVERSAL_CONFLICT");
 const trendUp=Object.fromEntries(Object.keys(allDown).map(k=>[k,{available:true,vote:5.2}]));
 const rejectedUp=selectTenMinuteDirection(trendUp,-0.1,{
   threeMinuteBps:-11,fiveMinuteBps:-16,upCloses:0,downCloses:2});
 assert.equal(rejectedUp.direction,null);
 assert.equal(rejectedUp.decisionReason,"V24_SPOT_REVERSAL_CONFLICT");
});
test("V24: 1m+2m+live-index confirm an emerging UP turn, not a forced reversal",()=>{
 const votes={"1m":5.2,"2m":5.2,"5m":-5.2,"10m":-5.2,"15m":-5.2,"30m":-5.2};
 const tf=Object.fromEntries(Object.entries(votes).map(([k,v])=>[k,{available:true,vote:v}]));
 const waiting=selectTenMinuteDirection(tf,1.7,{threeMinuteBps:2,fiveMinuteBps:-8,upCloses:2,downCloses:1});
 assert.equal(waiting.direction,null);
 const confirmed=selectTenMinuteDirection(tf,1.7,{threeMinuteBps:12,fiveMinuteBps:-8,upCloses:3,downCloses:0});
 assert.equal(confirmed.direction,"UP");
 assert.equal(confirmed.decisionReason,"V24_CONFIRMED_EARLY_REVERSAL");
 const opposite=selectTenMinuteDirection(tf,-1.7,{threeMinuteBps:12,fiveMinuteBps:-8,upCloses:3,downCloses:0});
 assert.notEqual(opposite.direction,"UP");
});
test("V24: price return is measured inside closed spot only, not index/spot basis",()=>{
 const now=BASE, f=fixture(now);
 const bars=f.candles["1m"].map(b=>({t:b.startMs,o:b.open,c:b.close,h:b.high,l:b.low,v:b.volume}));
 const p=closedSpotPriceAction(bars);
 assert.equal(p.available,true);
 assert.equal(p.source,"VERIFIED_CLOSED_SPOT_1M_SAME_BASIS");
 assert.ok(p.threeMinuteBps>0&&p.threeMinuteBps<2);
 const r=evaluatePureSignal({feed:f,reference:{observedAt:now},
   indexSnapshot:{price:72000,observedAt:now-200},previousIndexSnapshot:null});
 assert.equal(r.change3mPct,Number((p.threeMinuteBps/100).toFixed(5)));
 assert.ok(r.change3mPct<0.02);
 assert.equal(r.evidence.spotPriceAction.source,"VERIFIED_CLOSED_SPOT_1M_SAME_BASIS");
 assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
});

test("V25: context checks actual closed spot 6m/15m/60m/2h/4h/24h ranges",()=>{
 const f=fixture(BASE);
 const r=evaluatePureSignal({feed:f,reference:{observedAt:BASE},
   indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(r.strategyVersion,RULE_VERSION);
 assert.equal(r.evidence.entryHorizons.source,"CLOSED_BINANCE_SPOT_HORIZON_CONTEXT");
 for(const label of ["6m","15m","60m","2h","4h","24h"]){
   const h=r.evidence.entryHorizons.ranges[label];
   assert.equal(h.available,true,label);
   assert.ok(h.high>=h.low,label);
   assert.ok(h.position>=0&&h.position<=1,label);
   assert.ok(h.lastClosedAt<=BASE,label);
 }
 assert.equal(r.evidence.entryReady,true);
 assert.equal(r.evidence.waitForEntryImprovement,false);
 assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
});
test("V25: symmetric short-window entry wait near hourly or two-hour extreme",()=>{
 const ctx={available:true,spotClose:70000,atr1mBps:3,
   ranges:{"60m":{available:true,position:0.07},
     "2h":{available:true,position:0.09},
     "4h":{available:true,position:0.31,changeBps:40},
     "24h":{available:true,position:0.40,changeBps:100}}};
 const down=assessEntryTiming("DOWN",ctx,{threeMinuteBps:4});
 assert.equal(down.ready,false);
 assert.equal(down.reason,"V25_ENTRY_EDGE_REVERSAL_OR_EXHAUSTION");
 const stretched=assessEntryTiming("DOWN",ctx,{threeMinuteBps:-26});
 assert.equal(stretched.ready,false);
 const normal=assessEntryTiming("DOWN",ctx,{threeMinuteBps:-6});
 assert.equal(normal.ready,true);
 const upCtx={...ctx,ranges:{...ctx.ranges,"60m":{available:true,position:0.93}}};
 const up=assessEntryTiming("UP",upCtx,{threeMinuteBps:-4});
 assert.equal(up.ready,false);
 const upNormal=assessEntryTiming("UP",upCtx,{threeMinuteBps:5});
 assert.equal(upNormal.ready,true);
});
test("V25: missing optional long 30m candles does not fabricate a 24h context or disable 1m/5m decisions",()=>{
 const f=fixture(BASE);
 delete f.candles["30m"];
 const r=evaluatePureSignal({feed:f,reference:{observedAt:BASE},
   indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(r.evidence.entryHorizons.ranges["4h"].available,false);
 assert.equal(r.evidence.entryHorizons.ranges["24h"].available,false);
 assert.equal(r.evidence.entryHorizons.ranges["60m"].available,true);
 assert.equal(r.evidence.entryHorizons.ranges["2h"].available,true);
 assert.equal(r.direction,"UP");
});
test("V25: directional range filter uses only supplied closed-candle horizons, without inventing index basis",()=>{
 const f=fixture(BASE);
 const one=f.candles["1m"].map(b=>({t:b.startMs,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}));
 const five=f.candles["5m"].map(b=>({t:b.startMs,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}));
 const thirty=f.candles["30m"].map(b=>({t:b.startMs,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}));
 const ctx=analyzeEntryHorizons({one,five,thirty});
 assert.equal(ctx.source,"CLOSED_BINANCE_SPOT_HORIZON_CONTEXT");
 assert.equal(ctx.spotClose,one.at(-1).c);
 assert.equal(ctx.asOf,one.at(-1).t+60000);
 assert.ok(ctx.ranges["24h"].lastClosedAt<=BASE);
});
