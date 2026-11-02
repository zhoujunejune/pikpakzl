import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,scoreProxy} from "./manual-engine.mjs";
const START=Date.parse("2026-11-02T00:00:00Z");
function feed(at=START,side=1,flat=false){
 const candles={};
 for(const [k,n,step] of [["1m",65,60000],["5m",40,300000]]){
  let price=1000;const start=Math.floor(at/step)*step;const a=[];
  for(let i=0;i<n;i++){
   const inc=flat?0:side*(k==="1m"?[2,-1.4,2,-0.8][i%4]:[2,-0.5,2.2,-0.3][i%4]);
   const next=price+inc;
   a.push({startMs:start-(n-i)*step,closed:true,open:price,close:next,
    high:Math.max(price,next)+0.1,low:Math.min(price,next)-0.1,volume:i===n-1?140:100});
   price=next;
  }candles[k]=a;
 }
 return {ok:true,readOnly:true,symbol:"BTCUSDT",latest:{marketFeedConnected:true},candles};
}
const evaluate=(at,trigger="AUTO",f=feed(at))=>evaluatePureSignal({
 feed:f,reference:{observedAt:at},indexSnapshot:{price:70000,observedAt:at-100},trigger});
test("three ordinary references at 00/20/40, explicitly not high confidence",()=>{
 assert.equal(RULE_VERSION,"EVENT10_HYBRID_3PH_V4_20261102");assert.equal(AUTO_SLOT_MS,60000);
 for(const m of [0,20,40]){
  const r=evaluate(START+m*60000);
  assert.ok(["UP","DOWN"].includes(r.direction));assert.equal(r.quality,"STANDARD_RESEARCH");
  assert.equal(r.confidence,null);assert.match(r.reason,/不保证命中率/);
 }
});
test("enhanced signals only in extra slot or manual, never blind force",()=>{
 const f=evaluate(START+5*60000);assert.equal(f.quality,"FILTERED_RESEARCH");
 assert.ok(["UP","DOWN"].includes(f.direction));
 assert.equal(evaluate(START+60000).direction,null);
 assert.equal(evaluate(START+3*60000,"MANUAL",feed(START+3*60000,1,true)).direction,null);
});
test("missing data and stale index abstain instead of inventing a direction",()=>{
 const at=START;
 assert.throws(()=>evaluate(at,"AUTO",{...feed(at),candles:{"1m":feed(at).candles["1m"]}}),/MISSING_5m_CANDLES/);
 assert.throws(()=>evaluatePureSignal({feed:feed(at),reference:{observedAt:at},
  indexSnapshot:{price:70000,observedAt:at-9000},trigger:"AUTO"}),/REALTIME_BINANCE_INDEX_REQUIRED/);
});
test("engine saves version, 600-second index result, no order and persistent records",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-hybrid-"));const file=path.join(dir,"state.json");
 let now=START+1000,price=70000;
 const fetcher=async url=>url.includes("shadow-market-data")?{ok:true,json:async()=>feed(now)}:
  url.includes("premiumIndex")?{ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:String(price),time:now-100})}:
  Promise.reject(Error("UNEXPECTED_URL"));
 const opts={env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher};
 const engine=createEngine(opts);await engine.tick();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 const signal=engine.signals().records[0];
 assert.equal(signal.strategyVersion,RULE_VERSION);assert.equal(signal.signalQuality,"STANDARD_RESEARCH");
 assert.equal(signal.expiresAt-signal.openedAt,600000);assert.equal(signal.realOrderPlaced,false);
 assert.equal(engine.status().autoTradingEnabled,false);assert.equal(engine.status().autoIntervalMs,60000);
 now=signal.expiresAt+1000;price=70001;await engine.tick();
 assert.equal(engine.signals().stats.proxySettled,1);
 assert.equal(createEngine(opts).signals().total,1);
});
test("older versions excluded and flat comparison never a win",()=>{
 assert.equal(scoreProxy(100,100,"UP").proxyHit,null);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-hybrid-old-"));const file=path.join(dir,"state.json");
 fs.writeFileSync(file,JSON.stringify([{id:"old",openedAt:START-900000,expiresAt:START-300000,
  decisionReviewVersion:"EVENT10_FREQ_2M_TREND_V3_20261102",status:"PREDICTED",direction:"UP",
  openPrice:100,proxyHit:true}]));
 const x=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>START});
 assert.equal(x.history().length,0);assert.equal(x.status().lastSession,null);
 assert.equal(x.signals().total,0);
});

test("only V4 records are returned to public history and status, even with legacy sessions on disk",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-v4-history-filter-"));
 const file=path.join(dir,"state.json");
 const old={id:"old-2026",openedAt:START-900000,expiresAt:START-300000,
   strategyVersion:"EVENT10_FREQ_2M_TREND_V3_20261102",decisionReviewVersion:"EVENT10_FREQ_2M_TREND_V3_20261102",status:"COMPLETE",direction:"DOWN",proxyHit:false};
 const now={id:"current-v4",openedAt:START-600000,expiresAt:START,
   strategyVersion:RULE_VERSION,decisionReviewVersion:RULE_VERSION,status:"COMPLETE",direction:"UP",openPrice:70000,proxyHit:true};
 fs.writeFileSync(file,JSON.stringify([now,old]));
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>START+60000});
 assert.equal(engine.history().length,1);
 assert.equal(engine.history()[0].id,"current-v4");
 assert.equal(engine.status().lastSession.id,"current-v4");
 assert.equal(engine.signals().total,1);
 assert.equal(engine.signals().stats.proxyHits,1);
 const persisted=JSON.parse(fs.readFileSync(file,"utf8"));
 assert.equal(persisted.length,2); // Old immutable audit data isn't physically destroyed.
});
