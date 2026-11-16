import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,MAX_SIGNALS_PER_10M,SIGNAL_WINDOW_MS} from "./manual-engine.mjs";
const BASE=Date.parse("2026-11-12T06:00:31Z");
const json=v=>({ok:true,json:async()=>v});
function feed(now){
 const candles={};
 for(const [interval,n,ms] of [["1m",65,60000],["5m",43,300000]]){
  const end=Math.floor(now/ms)*ms,arr=[];
  for(let i=0;i<n;i++){
   const p=70000+(i%5)*0.1;
   arr.push({startMs:end-(n-i)*ms,closed:true,open:p,close:p+0.04,
     high:p+0.5,low:p-0.5,volume:100});
  }
  candles[interval]=arr;
 }
 // This fallback latest price is deliberately stale and incorrect. Signal
 // must use the verified current Binance futures index quote instead.
 return {ok:true,readOnly:true,symbol:"BTCUSDT",marketSource:"BINANCE_SPOT_PUBLIC_REST",
  latest:{lastPrice:69000,eventMs:now-200000,marketFeedConnected:true},candles};
}
function evaluate(now,index,prev){
 return evaluatePureSignal({feed:feed(now),reference:{observedAt:now},
  indexSnapshot:{price:index,observedAt:now-100,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"},
  previousIndexSnapshot:prev});
}
const temp=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"v21-live-index-")),"sessions.json");
test("current live index quote beats stale candle fallback, updates after 12s",()=>{
 assert.equal(RULE_VERSION,"EVENT10_LIVE_INDEX_3_PER_10M_V21_20261112");
 assert.equal(AUTO_SLOT_MS,12000);
 const first=evaluate(BASE,70010);
 assert.equal(first.direction,"UP");
 assert.equal(first.evidence.currentIndexPrice,70010);
 assert.equal(first.evidence.currentPriceUsedForDirection,true);
 assert.equal(first.evidence.waitForEntryImprovement,false);
 const second=evaluate(BASE+12000,69990,{price:70010,observedAt:BASE-100});
 assert.equal(second.direction,"DOWN");
 assert.equal(second.evidence.comparisonSource,"PREVIOUS_FRESH_INDEX_QUOTE");
 assert.ok(second.evidence.liveIndexChangeBps<0);
});
test("no V20 RSI, EMA, volume or price-zone conditions block fresh valid quotes",()=>{
 const up=evaluate(BASE,70030),down=evaluate(BASE,69930);
 assert.equal(up.direction,"UP");
 assert.equal(down.direction,"DOWN");
 assert.deepEqual(up.upChecks,{});
 assert.deepEqual(down.downChecks,{});
});
test("stale or invalid index must not fabricate a price signal",()=>{
 assert.throws(()=>evaluate(BASE,0),/REALTIME_BINANCE_INDEX_REQUIRED/);
 assert.throws(()=>evaluatePureSignal({feed:feed(BASE),reference:{observedAt:BASE},
   indexSnapshot:{price:70000,observedAt:BASE-10000}}),/REALTIME_BINANCE_INDEX_REQUIRED/);
});
test("rolling quota is shared by auto and manual, persists across restart and releases after 600s",async()=>{
 assert.equal(MAX_SIGNALS_PER_10M,3);assert.equal(SIGNAL_WINDOW_MS,600000);
 const file=temp();let now=BASE,idx=70010;
 const fetcher=async url=>{
  if(url.includes("shadow-market-data"))return json(feed(now));
  if(url.includes("premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(idx),time:now-100});
  throw Error("UNEXPECTED_EXTERNAL_"+url);
 };
 const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},fetcher});
 for(let n=0;n<3;n++){
  now=BASE+n*12000;idx=70010+n;
  const signal=await engine.start(["auto-v21-case0001","manual-v21-case02","auto-v21-case0003"][n]);
  assert.ok(signal.direction==="UP"||signal.direction==="DOWN");
  assert.equal(signal.expiresAt-signal.openedAt,600000);
  assert.equal(signal.realOrderPlaced,false);
 }
 assert.equal(engine.signals().total,3);
 assert.equal(engine.status().autoIntervalMs,12000);
 assert.equal(engine.status().maxSignalsPerTenMinutes,3);
 now=BASE+36000;idx=70020;
 const fourth=await engine.start("manual-v21-case04");
 assert.equal(fourth.eventTag,"V21_ROLLING_10M_CAP");
 assert.equal(fourth.direction,null);
 const restored=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},fetcher});
 assert.equal((await restored.start("manual-v21-case05")).eventTag,"V21_ROLLING_10M_CAP");
 now=BASE+600001;idx=70022;
 const fifth=await restored.start("auto-v21-case0006");
 assert.ok(fifth.direction);
 assert.equal(restored.signals().total,4);
 assert.equal(restored.status().modelCalls,0);
 assert.equal(restored.status().autoTradingEnabled,false);
});
test("rolling ten-minute window is not a calendar-aligned slot",async()=>{
 const file=temp();let now=BASE,index=70010;
 const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:file},
  fetcher:async url=>url.includes("shadow-market-data")?json(feed(now)):
    url.includes("premiumIndex")?json({symbol:"BTCUSDT",indexPrice:String(index),time:now-100}):
    Promise.reject(Error("NOT_EXPECTED"))});
 for(let n=0;n<3;n++){
  now=BASE+n*200000;index++;
  assert.ok((await engine.start("manual-v21-spaced-"+n+"-0001")).direction);
 }
 now=BASE+590000;
 assert.equal((await engine.start("manual-v21-spaced-4-0001")).eventTag,"V21_ROLLING_10M_CAP");
 now=BASE+600001;
 assert.ok((await engine.start("manual-v21-spaced-5-0001")).direction);
});
