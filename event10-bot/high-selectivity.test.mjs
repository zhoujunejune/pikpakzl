import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,parseBinanceIndexQuote} from "./contrarian-signal.mjs";
import {createEngine,HORIZON_MS,AUTO_SLOT_MS} from "./manual-engine.mjs";
const T=Date.parse("2026-11-01T06:00:02Z");
const json=x=>({ok:true,status:200,json:async()=>x});
function feed(now=T,closes=[1000,1001,1002,1003]){
 const start=Math.floor(now/60000)*60000;
 const bars=Array.from({length:40},(_,i)=>{
  const p=i>=36?closes[i-36]:1000;
  return {startMs:start-(40-i)*60000,open:p,close:p,high:p+1,low:p-1,volume:100,closed:true};
 });
 return {ok:true,readOnly:true,symbol:"BTCUSDT",
  latest:{lastPrice:bars.at(-1).close,eventMs:now-300,marketFeedConnected:true},
  candles:{"1m":bars}};
}
function evaluate(closes,at=T){
 return evaluatePureSignal({feed:feed(at,closes),reference:{observedAt:at},
  indexSnapshot:{price:100120,observedAt:at-250}});
}
test("four-sheet Excel mandatory rule: reverse 3m movement and flat<0.05% forced UP",()=>{
 assert.equal(RULE_VERSION,"EVENT10_FORCED_CONTRARIAN_12M_V1_20261101");
 assert.equal(AUTO_SLOT_MS,720000);
 assert.equal(HORIZON_MS,600000);
 assert.equal(evaluate([1000,1001,1002,1003]).direction,"DOWN");
 assert.equal(evaluate([1003,1002,1001,1000]).direction,"UP");
 assert.equal(evaluate([1000,1000,1000,1000]).direction,"UP");
 assert.equal(evaluate([1000,1000.1,1000.2,1000.4]).evidence.threeMinuteRule,"FLAT_FORCE_UP");
 assert.equal(evaluate([1000,1000.1,1000.4,1001]).evidence.threeMinuteRule,
  "THREE_MIN_UP_REVERSE_DOWN");
 const r=evaluate([1000,1001,1002,1003]);
 assert.equal(r.evidence.optionalVolumeFilterEnabled,false);
 assert.equal(r.evidence.optionalRsiFilterEnabled,false);
 assert.equal(r.evidence.optionalBreakoutFilterEnabled,false);
 assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
 assert.equal(r.confidence,null);
});
test("bad 1m candles and stale index never fabricate direction",()=>{
 assert.throws(()=>evaluatePureSignal({feed:feed(),reference:{observedAt:T},
  indexSnapshot:{price:100120,observedAt:T-8000}}),/REALTIME_BINANCE_INDEX_REQUIRED/);
 const bad=feed();bad.candles["1m"].at(-2).closed=false;
 assert.throws(()=>evaluatePureSignal({feed:bad,reference:{observedAt:T},
  indexSnapshot:{price:100120,observedAt:T-250}}),
  /THREE_MINUTE_CLOSED_PRICES_REQUIRED/);
 assert.throws(()=>parseBinanceIndexQuote({symbol:"ETHUSDT",indexPrice:"100",time:T},T));
});
test("auto signal per 12m slot, T+600 index proxy, separate V4 ledger, no orders",async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"event10-contra-"));
 let now=Math.floor(T/AUTO_SLOT_MS)*AUTO_SLOT_MS+2000,price=100120;
 const fetcher=async url=>{
  if(url.includes("shadow-market-data"))return json(feed(now,[1000,1001,1002,1003]));
  if(url.includes("premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(price),time:now-100});
  throw Error("UNEXPECTED_URL "+url);
 };
 const engine=createEngine({clock:()=>now,fetcher,
  env:{EVENT10_STATE_FILE:path.join(tmp,"sessions.json")}});
 const initial=await engine.start("manual-contra-a12345");
 assert.equal(initial.direction,"DOWN");
 assert.equal(initial.openPrice,price);
 assert.equal(initial.expiresAt,now+HORIZON_MS);
 assert.equal(initial.realOrderPlaced,false);
 assert.equal(engine.signals().records[0].momentumRule,"THREE_MIN_UP_REVERSE_DOWN");
 assert.equal(engine.status().providerModel,"PURE_SIGNAL_FORCED_CONTRARIAN_12M_V1");
 now+=600100;price=100110;
 await engine.tick();
 assert.equal(engine.signals().stats.proxySettled,1);
 assert.equal(engine.signals().records[0].proxyHit,true);
 now=Math.floor(now/AUTO_SLOT_MS+1)*AUTO_SLOT_MS+2000;
 await engine.tick();
 for(let i=0;i<30&&!engine.signals().records.some(r=>r.trigger==="AUTO");i++)
  await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(engine.signals().records.filter(r=>r.trigger==="AUTO").length,1);
 await engine.tick();
 assert.equal(engine.signals().records.filter(r=>r.trigger==="AUTO").length,1);
 assert.equal(engine.signals().version,RULE_VERSION);
 assert.equal(engine.status().autoTradingEnabled,false);
 const oldFile=path.join(tmp,"old-sessions.json");
 fs.writeFileSync(oldFile,JSON.stringify([{id:"old-session-123456",openedAt:now-900000,
  expiresAt:now-300000,decisionReviewVersion:"EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101",
  direction:"UP",openPrice:123,closePrice:124,proxyHit:true,status:"PREDICTED"}]));
 const oldEngine=createEngine({clock:()=>now,fetcher,env:{EVENT10_STATE_FILE:oldFile}});
 assert.equal(oldEngine.signals().stats.total,0);
});
