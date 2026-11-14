import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {selectTenMinuteDirection,aggregateBars,supertrend,closedSpotPriceAction,analyzeEntryHorizons,assessEntryTiming,ema921EntrySnapshot,assessEmaEntry,assessTrendConflict,TEN_MINUTE_WEIGHTS} from "./multi-timeframe-trend.mjs";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,renewedAfterSettledMiss,chooseFrequencyPriorityDirection,MAX_SIGNALS_PER_10M,SIGNAL_WINDOW_MS} from "./manual-engine.mjs";
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
 assert.equal(RULE_VERSION,"EVENT10_HIGH_FREQUENCY_DIRECTION_V33_20261114");
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

test("V26: EMA9/21 is evaluated from completed spot 1m, 2m and 5m bars",()=>{
 const f=fixture(BASE),r=evaluatePureSignal({feed:f,
   reference:{observedAt:BASE},indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(r.strategyVersion,RULE_VERSION);
 for(const k of ["1m","2m","5m"]){
   const e=r.evidence.emaEntry[k];
   assert.equal(e.available,true,k);
   assert.equal(e.source,"VERIFIED_CLOSED_SPOT_EMA_9_21");
   assert.ok(Number.isFinite(e.ema9)&&Number.isFinite(e.ema21),k);
   assert.ok(Number.isFinite(e.spreadBps),k);
   assert.ok(Number.isFinite(e.ema9SlopeBps),k);
   assert.ok(e.lastClosedAt<=BASE,k);
 }
 assert.equal(r.evidence.emaTiming.ready,true);
 assert.equal(r.evidence.entryReady,true);
 assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
});
test("V26: EMA9/21 cross and widening spread are computed from actual closed bars",()=>{
 const make=(trend)=>Array.from({length:40},(_,i)=>{
   const v=70000+trend*i*2;
   return {t:i*60000,c:v,o:v-trend,h:v+2,l:v-2,v:10};
 });
 const up=ema921EntrySnapshot(make(1),"1m"),down=ema921EntrySnapshot(make(-1),"1m");
 assert.equal(up.direction,"UP");assert.ok(up.spreadBps>0);
 assert.ok(up.ema9SlopeBps>0);assert.ok(up.closeDistanceEma9Bps>0);
 assert.equal(down.direction,"DOWN");assert.ok(down.spreadBps<0);
 assert.ok(down.ema9SlopeBps<0);assert.ok(down.closeDistanceEma9Bps<0);
 const flat=make(0).map(x=>({...x,h:x.h+2,l:x.l-2}));
 const rising=flat.map((x,i)=>i<28?x:{...x,c:x.c+(i-27)*14,h:x.h+(i-27)*14});
 const turns=rising.map((_,i)=>ema921EntrySnapshot(rising.slice(0,i+1),"1m"))
    .filter(x=>x.available&&x.crossover==="GOLDEN");
 assert.equal(turns.length,1);
});
test("V26: opposing short EMA slopes and adverse 3-minute return defer entry in both directions",()=>{
 const mk=(dir,slope,dist)=>({available:true,direction:dir,ema9SlopeBps:slope,
   closeDistanceEma9Bps:dist,crossover:null});
 const context={atr1mBps:5,ranges:{"15m":{position:0.5},"60m":{position:0.5}}};
 const againstUP={"1m":mk("DOWN",-2,-2),"2m":mk("DOWN",-1,-3),"5m":mk("DOWN",-1,-2)};
 const u=assessEmaEntry("UP",againstUP,context,{threeMinuteBps:-9});
 assert.equal(u.ready,false);assert.equal(u.reason,"V26_EMA_AGAINST_ENTRY");
 const againstDOWN={"1m":mk("UP",2,2),"2m":mk("UP",1,3),"5m":mk("UP",1,2)};
 const d=assessEmaEntry("DOWN",againstDOWN,context,{threeMinuteBps:9});
 assert.equal(d.ready,false);assert.equal(d.reason,"V26_EMA_AGAINST_ENTRY");
 assert.equal(assessEmaEntry("DOWN",againstDOWN,context,{threeMinuteBps:-5}).ready,true);
});
test("V26: EMA distance guard blocks only a stretched edge, not all trend continuation",()=>{
 const mk=(direction,dist)=>({available:true,direction,ema9SlopeBps:3,
   closeDistanceEma9Bps:dist,crossover:null});
 const snapshots={"1m":mk("UP",32),"2m":mk("UP",26),"5m":mk("UP",10)};
 const extremes={atr1mBps:5,ranges:{"15m":{position:0.93},"60m":{position:0.96}}};
 const middle={...extremes,ranges:{"15m":{position:0.55},"60m":{position:0.55}}};
 const stretched=assessEmaEntry("UP",snapshots,extremes,{threeMinuteBps:24});
 assert.equal(stretched.ready,false);assert.equal(stretched.reason,"V26_EMA_OVEREXTENDED_ENTRY");
 assert.equal(assessEmaEntry("UP",snapshots,middle,{threeMinuteBps:24}).ready,true);
 assert.equal(assessEmaEntry("UP",snapshots,extremes,{threeMinuteBps:6}).ready,true);
 const pullback={"1m":mk("UP",1),"2m":mk("UP",2),"5m":mk("UP",3)};
 assert.equal(assessEmaEntry("UP",pullback,middle,{threeMinuteBps:3}).entryType,"EMA_PULLBACK_CONTINUATION");
});
test("V26: missing optional 30m context never disables verified EMA9/21 entry features",()=>{
 const f=fixture(BASE);delete f.candles["30m"];
 const r=evaluatePureSignal({feed:f,reference:{observedAt:BASE},
   indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(r.evidence.emaEntry["1m"].available,true);
 assert.equal(r.evidence.emaEntry["2m"].available,true);
 assert.equal(r.evidence.emaEntry["5m"].available,true);
 assert.equal(r.evidence.entryReady,true);
});

test("V27: decaying EMA9 acceleration and contracting EMA9/21 spread pause late entry symmetrically",()=>{
 const ctx={atr1mBps:4,ranges:{"15m":{available:true,position:0.52},
   "60m":{available:true,position:0.53}}};
 const mk=(side,spreadChange,acc,slope=1)=>({
   available:true,direction:side,spreadChangeBps:spreadChange,
   ema9AccelerationBps:acc,ema9SlopeBps:slope,
   closeDistanceEma9Bps:2,crossover:null});
 const up={"1m":mk("UP",-0.9,-0.8,0.4),"2m":mk("UP",-0.5,0.1,0.4),
   "5m":mk("UP",0,0,0.4)};
 const failUp=assessEmaEntry("UP",up,ctx,{threeMinuteBps:0.5});
 assert.equal(failUp.ready,false);
 assert.equal(failUp.reason,"V27_EMA_MOMENTUM_DECAY");
 const down={"1m":mk("DOWN",0.9,0.8,-0.4),"2m":mk("DOWN",0.5,-0.1,-0.4),
   "5m":mk("DOWN",0,0,-0.4)};
 const failDown=assessEmaEntry("DOWN",down,ctx,{threeMinuteBps:-0.5});
 assert.equal(failDown.ready,false);
 assert.equal(failDown.reason,"V27_EMA_MOMENTUM_DECAY");
 const healthy={"1m":mk("UP",0.8,0.6,1.6),"2m":mk("UP",0.6,0.4,1.1),
   "5m":mk("UP",0.2,0.2,0.6)};
 const good=assessEmaEntry("UP",healthy,ctx,{threeMinuteBps:6});
 assert.equal(good.ready,true);
 assert.equal(good.reason,"V29_EMA_ENTRY_OK");
});
test("V27: small adverse 3m move plus EMA trend weakening protects early UP and DOWN turns",()=>{
 const ctx={atr1mBps:4,ranges:{"15m":{available:true,position:0.45},
   "60m":{available:true,position:0.47}}};
 const mk=(side,slope,change)=>({
   available:true,direction:side,spreadChangeBps:change,
   ema9AccelerationBps:0,ema9SlopeBps:slope,
   closeDistanceEma9Bps:1,crossover:null});
 for(const [side,d] of [["UP",1],["DOWN",-1]]){
   const snap={"1m":mk(side,-d*0.8,-d*0.9),"2m":mk(side,d*0.2,-d*0.2),
     "5m":mk(side,d*0.8,d*0.3)};
   const result=assessEmaEntry(side,snap,ctx,{threeMinuteBps:-d*4});
   assert.equal(result.ready,false,side);
   assert.equal(result.reason,"V27_EMA_EARLY_COUNTERMOVE",side);
 }
});

test("V32: a settled miss adds no extra cooldown beyond new-bar duplicates",async()=>{
 const now=BASE+720000,price=70007;
 async function attempt(previousDirection,previousHit=false,settledAgo=120000){
   const file=temp(),ledger=path.join(path.dirname(file),"rule-signals-v1.ndjson");
   const closed=now-settledAgo;
   const previous={id:"legacy-known-outcome",strategyVersion:"EVENT10_EMA_921_ENTRY_V26_20261113",
     direction:previousDirection,openedAt:closed-600000,expiresAt:closed,
     closeObservedAt:closed,proxyHit:previousHit,status:"SETTLED",
     settlementStatus:"INDEX_SIGNAL_TPLUS10_PROXY_ONLY",openPrice:70000,
     twoMinuteBarAt:closed-720000};
   fs.writeFileSync(ledger,JSON.stringify({kind:"SIGNAL",signal:previous})+"\n");
   const engine=createEngine({clock:()=>now,
     env:{EVENT10_STATE_FILE:file},
     fetcher:async url=>url.includes("shadow-market-data")?json(fixture(now)):
       url.includes("premiumIndex")?json({symbol:"BTCUSDT",indexPrice:String(price),time:now-100}):
       Promise.reject(Error("UNEXPECTED_URL"))});
   return engine.start("manual-v27-reentry-test");
 }
 const blocked=await attempt("UP",false);
 assert.equal(blocked.direction,"UP");
 const opposite=await attempt("DOWN",false);
 assert.equal(opposite.direction,"UP");
 const afterExpiry=await attempt("UP",false,420000);
 assert.equal(afterExpiry.direction,"UP");
 const priorWin=await attempt("UP",true);
 assert.equal(priorWin.direction,"UP");
});

test("V28: do not chase against 5m+30m, or weak 5m+short conflict; symmetric UP/DOWN",()=>{
 const tf=(side,opposite)=>Object.fromEntries(
   ["1m","2m","5m","10m","15m","30m"].map(name=>[name,
    {available:true,trend:opposite.includes(name)?(side==="UP"?"DOWN":"UP"):side}]));
 for(const side of ["UP","DOWN"]){
   const selection={trendScore:side==="UP"?0.22:-0.22,
     decisionReason:"V23_NORMALIZED_TREND"};
   const actual=assessTrendConflict(side,selection,tf(side,["5m","30m"]),
     {"1m":{available:true,direction:side}},{threeMinuteBps:0.5});
   assert.equal(actual.ready,false,side);
   assert.equal(actual.reason,"V28_CONFLICTED_MULTITIMEFRAME_ENTRY");
   assert.equal(assessTrendConflict(side,{...selection,trendScore:0.8},
     tf(side,[]),{"1m":{available:true,direction:side}},
     {threeMinuteBps:10}).ready,true,side);
   const weakFive=assessTrendConflict(side,selection,tf(side,["5m"]),
     {"1m":{available:true,direction:side}},{threeMinuteBps:0});
   assert.equal(weakFive.ready,false,side);
 }
});
test("V28: price-confirmed 1m/2m early reversal is still permitted when old 5m/30m oppose",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1,against=side==="UP"?"DOWN":"UP";
   const timeframes={"1m":{available:true,trend:side},"2m":{available:true,trend:side},
    "5m":{available:true,trend:against},"10m":{available:true,trend:against},
    "15m":{available:true,trend:against},"30m":{available:true,trend:against}};
   const decision={trendScore:d*0.25,decisionReason:"V24_CONFIRMED_EARLY_REVERSAL"};
   assert.equal(assessTrendConflict(side,decision,timeframes,
     {"1m":{available:true,direction:side}},{threeMinuteBps:d*12}).ready,true);
   assert.equal(assessTrendConflict(side,decision,timeframes,
     {"1m":{available:true,direction:side}},{threeMinuteBps:d*1}).ready,false);
 }
});
test("V28: both hourly and 2h extremes plus closed 3m/5m exhaustion stop late UP/DOWN chases",()=>{
 const mk=(hour,two,atr=8)=>({available:true,spotClose:70000,atr1mBps:atr,
    ranges:{"60m":{available:true,position:hour},
     "2h":{available:true,position:two},
     "4h":{available:true,changeBps:0},"24h":{available:true,changeBps:0}}});
 const up=assessEntryTiming("UP",mk(.956,.967),{threeMinuteBps:1.754,fiveMinuteBps:24.564});
 assert.equal(up.ready,false);
 assert.equal(up.reason,"V28_DOUBLE_HORIZON_PRICE_EXHAUSTION");
 const down=assessEntryTiming("DOWN",mk(.064,0,16),{threeMinuteBps:-34.78,fiveMinuteBps:-50.86});
 assert.equal(down.ready,false);
 assert.equal(down.reason,"V28_DOUBLE_HORIZON_PRICE_EXHAUSTION");
 // Identical move in middle of the range is not a reason to halt.
 assert.equal(assessEntryTiming("UP",mk(.51,.55),{threeMinuteBps:1.754,fiveMinuteBps:24.564}).ready,true);
 assert.equal(assessEntryTiming("DOWN",mk(.43,.44),{threeMinuteBps:-34.78,fiveMinuteBps:-50.86}).ready,true);
 // Missing optional 2h range must never be invented.
 assert.equal(assessEntryTiming("UP",mk(.97,.5),{threeMinuteBps:1.754,fiveMinuteBps:24.564}).ready,true);
});
test("V28: loss-reentry reads persisted twoMinuteBarAt and requires NEW verified 2m bar + EMA renewal",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1;
   const previous={proxyHit:false,twoMinuteBarAt:120000};
   const rule={evidence:{timeframes:{"2m":{lastClosedAt:240000}},
      spotPriceAction:{threeMinuteBps:d*8},
      emaEntry:{"1m":{direction:side,spreadChangeBps:d*.55},
                "2m":{direction:side,ema9SlopeBps:d*.75}}}};
   assert.equal(renewedAfterSettledMiss(rule,previous,side),true,side);
   assert.equal(renewedAfterSettledMiss(rule,{...previous,twoMinuteBarAt:240000},side),false);
   assert.equal(renewedAfterSettledMiss(rule,{...previous,twoMinuteBarAt:null},side),false);
   assert.equal(renewedAfterSettledMiss(rule,{...previous,proxyHit:null},side),false);
   assert.equal(renewedAfterSettledMiss(rule,{...previous,proxyHit:true},side),false);
   assert.equal(renewedAfterSettledMiss(rule,previous,side==="UP"?"DOWN":"UP"),false);
 }
});

test("V29: 4h/24h adverse regime never bypassed by 1m/2m early turn unless independently requalified",()=>{
 const tf=(side)=>{
   const opposite=side==="UP"?"DOWN":"UP";
   return Object.fromEntries(["1m","2m","5m","10m","15m","30m"].map((name,i)=>
     [name,{available:true,trend:i<2?side:opposite}]));
 };
 const ctx={ranges:{"60m":{available:true,position:.58}}};
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1;
   const entryTiming={farTrendAgainst:true};
   const ema={"1m":{available:true,direction:side,ema9AccelerationBps:d*.5},
     "2m":{available:true,direction:side,ema9SlopeBps:d*2}};
   const early={decisionReason:"V24_CONFIRMED_EARLY_REVERSAL",trendScore:d*(-.02)};
   const bad=assessTrendConflict(side,early,tf(side),ema,{threeMinuteBps:d*18},entryTiming,ctx);
   assert.equal(bad.confirmedTurn,true,side);
   assert.equal(bad.ready,false,side);
   assert.equal(bad.reason,"V29_UNCONFIRMED_4H_24H_COUNTERTREND",side);
   const recovered=assessTrendConflict(side,{...early,trendScore:d*.2},tf(side),
     ema,{threeMinuteBps:d*12.5},entryTiming,ctx);
   assert.equal(recovered.ready,true,side);
   assert.equal(recovered.requalified,true,side);
   const staleEma=assessTrendConflict(side,{...early,trendScore:d*.2},tf(side),
     {...ema,"2m":{...ema["2m"],direction:side==="UP"?"DOWN":"UP"}},
     {threeMinuteBps:d*12.5},entryTiming,ctx);
   assert.equal(staleEma.ready,false,side);
   const nearTop=assessTrendConflict(side,{...early,trendScore:d*.2},tf(side),
     ema,{threeMinuteBps:d*12.5},entryTiming,
     {ranges:{"60m":{available:true,position:side==="UP"?.94:.06}}});
   assert.equal(nearTop.ready,false,side);
   const noLongRisk=assessTrendConflict(side,early,tf(side),ema,
     {threeMinuteBps:d*12.5},{farTrendAgainst:false},ctx);
   assert.equal(noLongRisk.ready,true,side);
 }
});
test("V29: chronic 24h extreme chase and 3m EMA countermove veto risk in both directions",()=>{
 const mk=(side,acc,spread=-1,emaDirection=side)=>({
   available:true,direction:emaDirection,ema9SlopeBps:side==="UP"?1:-1,
   ema9AccelerationBps:acc,spreadChangeBps:spread,
   closeDistanceEma9Bps:2,crossover:null});
 const wrap=(side,h,t,d)=>({
   available:true,atr1mBps:8,ranges:{
     "60m":{available:true,position:h},
     "2h":{available:true,position:t},
     "24h":{available:true,position:d},
     "15m":{available:true,position:.5}
   }
 });
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1;
   const ctx=wrap(side,side==="UP"?.86:.14,side==="UP"?.91:.09,side==="UP"?1:0);
   const ema={"1m":mk(side,-d*5.7,-d*.4),"2m":mk(side,d*.1,0),
     "5m":mk(side,d*.1,0)};
   const late=assessEmaEntry(side,ema,ctx,{threeMinuteBps:d*19.4,fiveMinuteBps:d*23.3});
   assert.equal(late.ready,false,side);
   assert.equal(late.reason,"V29_24H_EXTREME_CHASE",side);
   const middle={...ctx,ranges:{...ctx.ranges,
     "24h":{available:true,position:.5}}};
   assert.equal(assessEmaEntry(side,ema,middle,
     {threeMinuteBps:d*19.4,fiveMinuteBps:d*23.3}).ready,true,side);
   const wide=wrap(side,.5,.5,side==="UP"?.9:.1);
   const peak=assessEmaEntry(side,ema,wide,{threeMinuteBps:d*76.8,fiveMinuteBps:d*78.1});
   assert.equal(peak.ready,false,side);
   assert.equal(peak.reason,"V29_24H_EXTREME_CHASE",side);
   const moving={"1m":mk(side,-d*.82,-d*.333),"2m":mk(side,d*.3,0),
     "5m":mk(side,d*.5,0)};
   const counter=assessEmaEntry(side,moving,middle,
     {threeMinuteBps:-d*16.6,fiveMinuteBps:-d*3.6});
   assert.equal(counter.ready,false,side);
   assert.equal(counter.reason,"V29_FAST_COUNTERMOVE_EMA_DECAY",side);
   assert.equal(assessEmaEntry(side,moving,middle,
     {threeMinuteBps:-d*2,fiveMinuteBps:0}).ready,true,side);
 }
});
test("V29: no historical or unconfirmed 4h/24h context may fabricate an entry veto",()=>{
 const good=fixture(BASE);
 delete good.candles["30m"];
 const out=evaluatePureSignal({feed:good,reference:{observedAt:BASE},
    indexSnapshot:{price:70005,observedAt:BASE-100}});
 assert.equal(out.direction,"UP");
 assert.equal(out.evidence.trendConflict.severeLongConflict,false);
 assert.equal(out.evidence.entryReady,true);
});

test("V30: closed-spot 3m/5m and all 10/15/30m allow confirmed 1/2m reversal with quiet live tick",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1;
   const t={};
   for(const name of ["1m","2m","5m","10m","15m","30m"]){
     t[name]={available:true,vote:d*(name==="5m"?-5.2:5.2)};
   }
   const pa={threeMinuteBps:d*12,fiveMinuteBps:d*11,
     upCloses:side==="UP"?2:1,downCloses:side==="DOWN"?2:1};
   const r=selectTenMinuteDirection(t,0,pa);
   assert.equal(r.direction,side);
   assert.equal(r.decisionReason,"V24_CONFIRMED_EARLY_REVERSAL");
   assert.equal(r.closedReversal,true);
   t["30m"].vote=-d*5.2;
   const unconfirmed=selectTenMinuteDirection(t,0,pa);
   assert.notEqual(unconfirmed.decisionReason,"V24_CONFIRMED_EARLY_REVERSAL");
 }
});
test("V30: 5/10/15/30m trend can resume only with fresh 3m+5m and recovering EMA; symmetric",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1,opposite=side==="UP"?"DOWN":"UP";
   const votes={};const tf={};
   for(const name of ["1m","2m","5m","10m","15m","30m"]){
     const shorter=name==="1m"||name==="2m";
     votes[name]={available:true,vote:d*(shorter?-1.8:5.2)};
     tf[name]={available:true,trend:shorter?opposite:side};
   }
   const pa={threeMinuteBps:d*12,fiveMinuteBps:d*16,
     upCloses:side==="UP"?2:1,downCloses:side==="DOWN"?2:1};
   const selection=selectTenMinuteDirection(votes,0,pa);
   assert.equal(selection.direction,side);
   assert.equal(selection.decisionReason,"V30_TREND_RESUMPTION_SPOT_CONFIRMED");
   const ema={"1m":{available:true,direction:opposite,
       spreadChangeBps:d*.5,ema9AccelerationBps:d*.8},
     "2m":{available:true,direction:opposite,ema9SlopeBps:d*.1}};
   const valid=assessTrendConflict(side,selection,tf,ema,pa,
     {farTrendAgainst:false},{ranges:{"60m":{available:true,position:.5}}});
   assert.equal(valid.ready,true,side);
   assert.equal(valid.resumption,true,side);
   assert.equal(assessTrendConflict(side,selection,tf,
     {...ema,"1m":{...ema["1m"],ema9AccelerationBps:-d*1}},
     pa,{farTrendAgainst:false},{}).ready,false,side);
   const adverse={...tf,"30m":{available:true,trend:opposite}};
   assert.equal(assessTrendConflict(side,selection,adverse,ema,pa,
     {farTrendAgainst:true},{}).ready,false,side);
   const bad3=selectTenMinuteDirection(votes,0,{...pa,threeMinuteBps:d*2});
   assert.notEqual(bad3.decisionReason,"V30_TREND_RESUMPTION_SPOT_CONFIRMED");
 }
});

test("V31: 5/15/30m dominant recovery produces UP/DOWN when 10m and 1/2m lag, with two independent closed spot moves",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1,other=side==="UP"?"DOWN":"UP";
   const votes={},tf={};
   for(const name of ["1m","2m","5m","10m","15m","30m"]){
     const lag=["1m","2m","10m"].includes(name);
     votes[name]={available:true,vote:d*(lag?-5.2:5.2)};
     tf[name]={available:true,trend:lag?other:side};
   }
   const price={threeMinuteBps:d*14,fiveMinuteBps:d*21,
     upCloses:side==="UP"?2:0,downCloses:side==="DOWN"?2:0};
   const result=selectTenMinuteDirection(votes,0,price);
   assert.equal(result.direction,side,side);
   assert.equal(result.decisionReason,"V31_DOMINANT_TREND_SPOT_RECOVERY");
   assert.equal(result.dominantRecovery,true);
   const ema={"1m":{available:true,direction:other,
       spreadChangeBps:d*.55,ema9AccelerationBps:d*.8},
     "2m":{available:true,direction:other,ema9SlopeBps:d*.1}};
   const noConflict={farTrendAgainst:false};
   const allowed=assessTrendConflict(side,result,tf,ema,price,noConflict,{ranges:{}});
   assert.equal(allowed.ready,true,side);
   assert.equal(allowed.dominant,true,side);
   assert.equal(assessTrendConflict(side,result,tf,ema,price,
     {farTrendAgainst:true},{ranges:{}}).ready,false,side);
   assert.equal(assessTrendConflict(side,result,tf,
     {...ema,"1m":{...ema["1m"],ema9AccelerationBps:-d*2}},
     price,noConflict,{}).ready,false,side);
   assert.equal(assessTrendConflict(side,result,tf,
     {...ema,"1m":{...ema["1m"],spreadChangeBps:d*.1}},
     price,noConflict,{}).ready,false,side);
   const noFive=selectTenMinuteDirection(votes,0,{...price,fiveMinuteBps:d*4});
   assert.notEqual(noFive.decisionReason,"V31_DOMINANT_TREND_SPOT_RECOVERY");
   const indexOpposed=selectTenMinuteDirection(votes,-d*5,price);
   assert.notEqual(indexOpposed.decisionReason,"V31_DOMINANT_TREND_SPOT_RECOVERY");
   tf["15m"]={available:true,trend:other};
   assert.equal(assessTrendConflict(side,result,tf,ema,price,noConflict,{}).ready,false);
   const changed=Object.fromEntries(Object.entries(votes).map(([k,v])=>[k,{...v}]));
   changed["30m"].vote=-d*5.2;
   assert.notEqual(selectTenMinuteDirection(changed,0,price).decisionReason,
     "V31_DOMINANT_TREND_SPOT_RECOVERY");
 }
});

test("V32: confirmed 3m+5m price, short vote and independent long vote allow both directions",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1,opposite=side==="UP"?"DOWN":"UP";
   const votes={"1m":d*5.2,"2m":-d*5.2,"5m":d*5.2,"10m":-d*5.2,
     "15m":d*5.2,"30m":-d*5.2};
   const frames=Object.fromEntries(Object.entries(votes).map(([name,vote])=>[name,{available:true,vote}]));
   const p={threeMinuteBps:d*6,fiveMinuteBps:d*7,upCloses:side==="UP"?2:1,downCloses:side==="DOWN"?2:1};
   const r=selectTenMinuteDirection(frames,0,p);
   assert.equal(r.direction,side);
   assert.equal(r.decisionReason,"V32_FREQUENCY_CLOSED_SPOT");
   assert.equal(r.highFrequency,true);
   assert.equal(selectTenMinuteDirection(frames,-d*4,p).direction,null);
   assert.equal(selectTenMinuteDirection(frames,0,{...p,threeMinuteBps:0}).highFrequency,false);
   assert.equal(selectTenMinuteDirection(frames,0,{...p,threeMinuteBps:d*2}).highFrequency,false);
   assert.equal(selectTenMinuteDirection(frames,0,{...p,fiveMinuteBps:0}).highFrequency,true);
   const trends=Object.fromEntries(Object.entries(votes).map(([name,vote])=>
     [name,{available:true,trend:vote>0?"UP":"DOWN"}]));
   const ema={"1m":{available:true,direction:side},"2m":{available:true,direction:side}};
   const context={farTrendAgainst:false};
   const permitted=assessTrendConflict(side,r,trends,ema,p,context,{ranges:{"60m":{available:true,position:.5}}});
   assert.equal(permitted.frequencyReady,true);
   assert.equal(permitted.ready,true);
   const notConfirmed=assessTrendConflict(side,r,trends,
      {"1m":{available:true,direction:opposite},"2m":{available:true,direction:opposite}},
      p,context,{ranges:{"60m":{available:true,position:.5}}});
   assert.equal(notConfirmed.frequencyReady,false);
   const bothLongAgainst={...trends,"15m":{available:true,trend:opposite},
      "30m":{available:true,trend:opposite}};
   const longVeto=assessTrendConflict(side,r,bothLongAgainst,ema,p,context,
      {ranges:{"60m":{available:true,position:.5}}});
   assert.equal(longVeto.frequencyReady,true);
   const farRisk=assessTrendConflict(side,r,bothLongAgainst,ema,p,
      {farTrendAgainst:true},{ranges:{"60m":{available:true,position:.5}}});
   assert.equal(farRisk.ready,false);
 }
});

test("V33: only verified short spot or scored timeframes yield a fallback direction; both sides",()=>{
 for(const side of ["UP","DOWN"]){
   const d=side==="UP"?1:-1;
   const evidence={spotPriceAction:{threeMinuteBps:d*3,oneMinuteBps:d*.5},
     timeframes:{"1m":{available:true,trend:side},"2m":{available:true,trend:side},
       "5m":{available:true,trend:side==="UP"?"DOWN":"UP"}},
     trendScore:-d*.25,liveIndexChangeBps:0};
   const r=chooseFrequencyPriorityDirection({direction:null,evidence});
   assert.equal(r.side,side);
   assert.equal(r.basis,"CLOSED_SPOT_3M");
   assert.equal(r.agreeingTimeframes,2);
   assert.equal(chooseFrequencyPriorityDirection({direction:side,evidence}),null);
   assert.equal(chooseFrequencyPriorityDirection({direction:null,
      evidence:{...evidence,liveIndexChangeBps:-d*5}}),null);
   assert.equal(chooseFrequencyPriorityDirection({direction:null,
      evidence:{...evidence,spotPriceAction:{threeMinuteBps:0,oneMinuteBps:0},
        trendScore:0}}),null);
   assert.equal(chooseFrequencyPriorityDirection({direction:null,
      evidence:{...evidence,timeframes:{}}}),null);
 }
});
