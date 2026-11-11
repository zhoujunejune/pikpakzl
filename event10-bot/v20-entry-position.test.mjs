import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {evaluatePureSignal,RULE_VERSION} from "./pure-signal.mjs";
import {evaluatePureSignal as evaluateV19} from "./pure-signal-v19.mjs";
import {createEngine} from "./manual-engine.mjs";
const START=Date.parse("2026-11-11T06:00:01.000Z");
function candles(now,side=1){
 const c={};
 for(const [key,n,step] of [["1m",65,60000],["5m",40,300000]]){
  const start=Math.floor(now/step)*step,rows=[];let price=1000;
  for(let i=0;i<n;i++){
   const inc=side*(key==="1m"?[.7,-.7,.7,-.4][i%4]:[2,-.5,2.2,-.3][i%4]);
   const next=price+inc;
   rows.push({startMs:start-(n-i)*step,closed:true,open:price,close:next,
    high:Math.max(price,next)+.1,low:Math.min(price,next)-.1,volume:i===n-1?140:100});
   price=next;
  }
  if(key==="1m"){rows.at(-9).high+=12;rows.at(-10).low-=12;}
  c[key]=rows;
 }
 return c;
}
function feed(now=START,side=1){
 const rows=candles(now,side);
 return {ok:true,readOnly:true,symbol:"BTCUSDT",latest:{
  eventMs:now-100,lastPrice:rows["1m"].at(-1).close,marketFeedConnected:true
 },candles:rows};
}
const args=(f,now=START,idx=70000)=>({feed:f,reference:{observedAt:now},
 indexSnapshot:{price:idx,observedAt:now-100},trigger:"AUTO"});
test("V20 retains V19 candidate but records a fresh spot proxy point and index entry",()=>{
 const f=feed(),original=evaluateV19(args(f)),v20=evaluatePureSignal(args(f));
 assert.equal(original.direction,"UP");
 assert.equal(RULE_VERSION,"EVENT10_ENTRY_POSITION_V20_20261111");
 assert.equal(v20.direction,"UP");
 assert.equal(v20.evidence.candidateDirection,"UP");
 assert.equal(v20.evidence.ema5Direction,"UP");
 assert.equal(v20.evidence.entryReady,true);
 assert.ok(v20.evidence.positionPct>=30&&v20.evidence.positionPct<=75);
 assert.equal(v20.evidence.signalIndexPrice,70000);
 assert.equal(v20.evidence.positionIsSpotProxyNotOfficialEventStrike,true);
});
test("V20 rejects a high entry and does not falsely claim an official index position",()=>{
 const f=feed(),hi=Math.max(...f.candles["1m"].slice(-20).map(x=>x.high));
 f.latest.lastPrice=hi+1;
 const r=evaluatePureSignal(args(f));
 assert.equal(r.direction,null);
 assert.equal(r.eventTag,"V20_BREAKOUT_SEPARATE_RESEARCH");
});
test("V20 refuses original 1m candidate when 5m trend disagrees, no forced sign",()=>{
 const f=feed();
 f.candles["5m"]=candles(START,-1)["5m"];
 const original=evaluateV19(args(f)),v20=evaluatePureSignal(args(f));
 assert.equal(original.evidence.originalEligibleDirection,"UP");
 assert.equal(original.direction,"DOWN");
 assert.equal(v20.direction,null);
 assert.equal(v20.eventTag,"V20_TREND_CONFLICT");
});
test("V20 never accepts stale spot tick for a point-position signal",()=>{
 const f=feed();f.latest.eventMs=START-9000;
 const out=evaluatePureSignal(args(f));
 assert.equal(out.direction,null);assert.equal(out.eventTag,"V20_LIVE_SPOT_TICK_UNAVAILABLE");
});
test("V20 observes 15-60 seconds, locks price only after improvement, never trades",async()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"v20-entry-")),"sessions.json");
 let now=START,idx=70000,calls=0;
 const fetcher=async url=>{
  calls++;
  if(url.includes("shadow-market-data"))return {ok:true,json:async()=>feed(now)};
  if(url.includes("premiumIndex"))return {ok:true,json:async()=>({
   symbol:"BTCUSDT",indexPrice:String(idx),time:now-100})};
  throw Error("UNEXPECTED_EXTERNAL_CALL "+url);
 };
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher});
 const first=await engine.start("manual-v20-first-0001");
 assert.equal(first.direction,null);assert.equal(first.eventTag,"V20_ENTRY_OBSERVING");
 assert.equal(engine.signals().total,0);
 now+=16000;idx=69995;
 const second=await engine.start("manual-v20-second-0002");
 assert.equal(second.direction,"UP");
 assert.equal(second.openPrice,69995);
 assert.equal(second.expiresAt-second.openedAt,600000);
 assert.ok(second.ruleChecks.evidence.entryObservation.improvementBps>=.5);
 assert.equal(second.realOrderPlaced,false);
 assert.equal(engine.status().decisionReviewVersion,RULE_VERSION);
 assert.equal(engine.status().autoTradingEnabled,false);
 assert.equal(engine.status().modelCalls,0);
 assert.equal(engine.signals().total,1);
 assert.equal(engine.signals().version,RULE_VERSION);
 assert.equal(engine.signals().records[0].strategyVersion,RULE_VERSION);
 now+=16000;idx=69990;
 const duplicate=await engine.start("manual-v20-cooldown-0003");
 assert.equal(duplicate.direction,null);
 assert.equal(duplicate.eventTag,"V17_MIN_SIGNAL_GAP");
 assert.equal(engine.signals().total,1);
 assert.ok(calls>=4);
});
test("V20 fails closed when entry price never improves",async()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"v20-wait-")),"sessions.json");
 let now=START;
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>now,
  fetcher:async url=>url.includes("shadow-market-data")?{ok:true,json:async()=>feed(now)}:
   url.includes("premiumIndex")?{ok:true,json:async()=>({symbol:"BTCUSDT",
    indexPrice:"70000",time:now-100})}:Promise.reject(Error("NO_EXTERNAL"))});
 const first=await engine.start("manual-v20-wait-0001");
 assert.equal(first.eventTag,"V20_ENTRY_OBSERVING");
 now+=16000;
 const second=await engine.start("manual-v20-wait-0002");
 assert.equal(second.eventTag,"V20_ENTRY_WAIT");
 assert.equal(engine.signals().total,0);
});
