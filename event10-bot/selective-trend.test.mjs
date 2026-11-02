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
   const inc=flat?0:side*(k==="1m"?[1,-0.7,1,-0.4][i%4]:[2,-0.5,2.2,-0.3][i%4]);
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
test("no forced directions at 00/20/40: flat markets always abstain",()=>{
 assert.equal(RULE_VERSION,"EVENT10_FRESH_NONOVERLAP_V6_20261103");assert.equal(AUTO_SLOT_MS,60000);
 for(const m of [0,20,40]){
   const r=evaluate(START+m*60000,"AUTO",feed(START+m*60000,1,true));
   assert.equal(r.direction,null);assert.equal(r.quality,"NO_SIGNAL");
   assert.equal(r.confidence,null);assert.match(r.reason,/不强制/);
 }
});
test("aligned moderate trends may signal on any minute or manually",()=>{
 for(const m of [0,1,5,20,40]){
   const r=evaluate(START+m*60000);
   assert.equal(r.direction,"UP");assert.equal(r.quality,"FILTERED_RESEARCH");
 }
 assert.equal(evaluate(START+3*60000,"MANUAL").direction,"UP");
});
test("EMA conflict, low volume, and 3m pump must suppress signals",()=>{
 const at=START+60000;
 const conflicting=feed(at);conflicting.candles["5m"]=feed(at,-1).candles["5m"];
 assert.equal(evaluate(at,"AUTO",conflicting).direction,null);
 assert.equal(evaluate(at,"AUTO",feed(at,-1)).direction,"DOWN");
 const weakVolume=feed(at);weakVolume.candles["1m"].at(-1).volume=20;
 assert.equal(evaluate(at,"AUTO",weakVolume).direction,null);
 const spike=feed(at),bar=spike.candles["1m"].at(-1);
 bar.close+=60;bar.high=bar.close+0.1;
 assert.equal(evaluate(at,"AUTO",spike).direction,null);
 const lowRsiDown=feed(at,-1),lowLast=lowRsiDown.candles["1m"].at(-1);
 lowLast.close-=80;lowLast.low=lowLast.close-0.1;
 assert.notEqual(evaluate(at,"AUTO",lowRsiDown).direction,"UP");
});
test("one-minute and five-minute closed candles must be current, never replay old bars",()=>{
 const at=START+300000+1000;
 const stale1=feed(at);
 stale1.candles["1m"]=feed(at-60000).candles["1m"];
 assert.throws(()=>evaluate(at,"AUTO",stale1),/STALE_1m_LAST_CLOSED_CANDLE/);
 const stale5=feed(at);
 stale5.candles["5m"]=feed(at-300000).candles["5m"];
 assert.throws(()=>evaluate(at,"AUTO",stale5),/STALE_5m_LAST_CLOSED_CANDLE/);
});
test("abnormally large volume and momentum spikes must not be chased",()=>{
 const at=START+60000;
 for(const side of [1,-1]){
   const highVolume=feed(at,side);
   highVolume.candles["1m"].at(-1).volume=500;
   assert.equal(evaluate(at,"AUTO",highVolume).direction,null);
   const runaway=feed(at,side);
   const bar=runaway.candles["1m"].at(-1);
   bar.close+=side*10;bar.high=Math.max(bar.open,bar.close)+0.1;
   bar.low=Math.min(bar.open,bar.close)-0.1;
   assert.equal(evaluate(at,"AUTO",runaway).direction,null);
 }
});
test("no overlapping 600-second signals, across manual, auto and process restart",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-nonoverlap-"));
 const file=path.join(dir,"sessions.json");
 let now=START+1000,price=70000;
 const fetcher=async url=>url.includes("shadow-market-data")?{ok:true,json:async()=>feed(now)}:
  url.includes("premiumIndex")?{ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:String(price),time:now-100})}:
  Promise.reject(Error("UNEXPECTED_URL"));
 const opts={env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher};
 const id=()=> "auto-1m-"+(Math.floor(now/60000)*60000);
 let engine=createEngine(opts);
 const first=await engine.start(id());
 assert.equal(first.direction,"UP");
 now=START+60000+1000;
 const blocked=await engine.start(id());
 assert.equal(blocked.status,"NO_SIGNAL");
 assert.equal(blocked.quality,"COOLDOWN");
 assert.match(blocked.reason,/重叠/);
 assert.equal(engine.signals().total,1);
 engine=createEngine(opts);
 now=START+120000+1000;
 const manual=await engine.start("manually-triggered-001");
 assert.equal(manual.status,"NO_SIGNAL");
 assert.equal(engine.signals().total,1);
 now=first.expiresAt+1000;
 const next=await engine.start(id());
 assert.equal(next.direction,"UP");
 assert.equal(engine.signals().total,2);
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
 assert.equal(signal.strategyVersion,RULE_VERSION);assert.equal(signal.signalQuality,"FILTERED_RESEARCH");
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
   strategyVersion:"EVENT10_HYBRID_3PH_V4_20261102",decisionReviewVersion:"EVENT10_HYBRID_3PH_V4_20261102",status:"COMPLETE",direction:"DOWN",proxyHit:false};
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

test("explicit reset: 15 previous V4 signals must yield zero visible new-version results",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-reset-"));
 const file=path.join(dir,"sessions.json"),ledger=file.replace("sessions.json","rule-signals-v1.ndjson");
 const oldVersion="EVENT10_HYBRID_3PH_V4_20261102";
 const oldRows=Array.from({length:15},(_,i)=>({
  id:"old-v4-"+i,openedAt:START-3600000+i*1000,expiresAt:START-3000000+i*1000,
  decisionReviewVersion:oldVersion,strategyVersion:oldVersion,
  direction:"UP",status:"PREDICTED",openPrice:70000,proxyHit:i%2===0
 }));
 fs.writeFileSync(file,JSON.stringify(oldRows));
 fs.writeFileSync(ledger,oldRows.map(s=>JSON.stringify({kind:"SIGNAL",signal:{...s,strategyVersion:oldVersion}})).join("\n")+"\n");
 const engine=createEngine({env:{EVENT10_STATE_FILE:file,EVENT10_SIGNAL_LOG_FILE:ledger},clock:()=>START});
 assert.equal(engine.history().length,0);
 assert.equal(engine.signals().total,0);
 assert.equal(engine.signals().stats.proxySettled,0);
 assert.equal(engine.status().lastSession,null);
 assert.equal(engine.status().decisionReviewVersion,RULE_VERSION);
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).length,15);
});
