import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,AUTO_SLOT_MS} from "./pure-signal.mjs";
import {createEngine,scoreProxy,MIN_SIGNAL_GAP_MS} from "./manual-engine.mjs";
const START=Date.parse("2026-11-02T00:00:00Z");
function feed(at=START,side=1,flat=false){
 const candles={};
 for(const [k,n,step] of [["1m",65,60000],["5m",40,300000]]){
  let price=1000;const start=Math.floor(at/step)*step;const a=[];
  for(let i=0;i<n;i++){
   const inc=flat?0:side*(k==="1m"?[0.7,-0.7,0.7,-0.4][i%4]:[2,-0.5,2.2,-0.3][i%4]);
   const next=price+inc;
   a.push({startMs:start-(n-i)*step,closed:true,open:price,close:next,
    high:Math.max(price,next)+0.1,low:Math.min(price,next)-0.1,volume:i===n-1?140:100});
   price=next;
  }
  if(k==="1m"&&!flat){a.at(-9).high+=12;a.at(-10).low-=12;}
  candles[k]=a;
 }
 return {ok:true,readOnly:true,symbol:"BTCUSDT",latest:{marketFeedConnected:true},candles};
}
const evaluate=(at,trigger="AUTO",f=feed(at))=>evaluatePureSignal({
 feed:f,reference:{observedAt:at},indexSnapshot:{price:70000,observedAt:at-100},trigger});
test("V17 strict retains six core gates without the old wide secondary veto",()=>{
 const at=START+60000;
 const bullish=feed(at,1);
 const last=bullish.candles["1m"].at(-1);
 last.high+=20; // baseline six trend gates still pass, V7 would veto
 const out=evaluate(at,"AUTO",bullish);
 assert.equal(out.direction,"UP");
 assert.equal(out.strategyVersion,RULE_VERSION);
});
test("V17 long RSI threshold stays below 63 and down requires 15m persistence",()=>{
 const at=START+60000;
 const up=feed(at,1);
 const q=up.candles["1m"].at(-1);
 q.close+=0.7;q.high=Math.max(q.high,q.close+0.1);
 const long=evaluate(at,"MANUAL",up);
 assert.notEqual(long.direction,"DOWN");
 if(long.eventTag==="V9_UP_RSI_EXHAUSTION")assert.equal(long.direction,null);
 const down=evaluate(at,"AUTO",feed(at,-1));
 assert.equal(down.direction,"DOWN");
 assert.equal(down.downChecks.persistence15m,true);
 assert.ok(Number.isFinite(down.evidence.change15mPct));
});
test("no forced directions at 00/20/40: flat markets always abstain",()=>{
 assert.equal(RULE_VERSION,"EVENT10_AI_REQUIRED_LEARNING_V18_20261106");assert.equal(AUTO_SLOT_MS,60000);
 for(const m of [0,20,40]){
   const r=evaluate(START+m*60000,"AUTO",feed(START+m*60000,1,true));
   assert.equal(r.direction,null);assert.equal(r.quality,"NO_SIGNAL");
   assert.equal(r.confidence,null);assert.match(r.reason,/动量|不一致/);
 }
});
test("aligned moderate trends may signal on any minute or manually",()=>{
 for(const m of [0,1,5,20,40]){
   const r=evaluate(START+m*60000);
   assert.equal(r.direction,"UP");assert.equal(r.quality,"STRICT_RESEARCH");
 }
 assert.equal(evaluate(START+3*60000,"MANUAL").direction,"UP");
});
test("V17 preserves V15 eligibility but aligns final direction with 5m EMA",()=>{
 const at=START+60000;
 const bullish=feed(at,1);
 const r=evaluate(at,"AUTO",bullish);
 assert.equal(r.direction,"UP");
 assert.equal(r.quality,"STRICT_RESEARCH");
 const mismatch=feed(at,1);
 mismatch.candles["5m"]=feed(at,-1).candles["5m"];
 const standard=evaluate(at,"AUTO",mismatch);
 assert.equal(standard.direction,"DOWN");
 assert.equal(standard.quality,"STANDARD_RESEARCH");
 assert.equal(standard.evidence.originalEligibleDirection,"UP");
 assert.equal(standard.evidence.ema5Direction,"DOWN");
 assert.equal(standard.evidence.directionCorrected,true);
 assert.equal(standard.conditions.trend5m,false);
});
test("V17 never gives a direction if trend is weak, flat or unverified",()=>{
 const at=START+60000;
 assert.equal(evaluate(at,"AUTO",feed(at,1,true)).direction,null);
 const huge=feed(at,1);const q=huge.candles["1m"].at(-1);
 q.close+=40;q.high=q.close+0.1;
 assert.equal(evaluate(at,"AUTO",huge).direction,null);
});
test("V17 does not invent signals when original conditions fail",()=>{
 const at=START+60000;
 const f=feed(at,1);f.candles["1m"].at(-1).volume=5;
 assert.equal(evaluate(at,"AUTO",f).direction,null);
});
test("real production-size 62 closed 1m candles work, insufficient 59 still fail closed",()=>{
 const at=START+60000;
 const enough=feed(at,1);
 enough.candles["1m"]=enough.candles["1m"].slice(-62);
 const accepted=evaluate(at,"AUTO",enough);
 assert.notEqual(accepted.status,"DATA_ERROR");
 assert.equal(accepted.evidence.closedBars1m,60);
 const missing=feed(at,1);
 missing.candles["1m"]=missing.candles["1m"].slice(-59);
 assert.throws(()=>evaluate(at,"AUTO",missing),/INSUFFICIENT_1m_CLOSED_CANDLES/);
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
test("V17 ten-minute cooldown applies across restart and manual/auto",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-paced-"));
 const file=path.join(dir,"sessions.json");
 let now=START+1000,price=70000;
 const fetcher=async url=>url.includes("shadow-market-data")?{ok:true,json:async()=>feed(now)}:
  url.includes("premiumIndex")?{ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:String(price),time:now-100})}:
  Promise.reject(Error("UNEXPECTED_URL"));
 const opts={env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher};
 const engine=createEngine(opts);
 const first=await engine.start("manual-first-0001");
 assert.equal(first.direction,"UP");
 now=START+60000+1000;
 const blocked=await engine.start("auto-1m-next-0002");
 assert.equal(blocked.direction,null);
 assert.equal(blocked.eventTag,"V17_MIN_SIGNAL_GAP");
 assert.equal(engine.signals().total,1);
 const rebooted=createEngine(opts);
 now=START+540000+1000;
 const still=await rebooted.start("manual-next-0003");
 assert.equal(still.direction,null);
 assert.equal(rebooted.signals().total,1);
 now=START+660000+1000;
 const next=await rebooted.start("manual-next-0004");
 assert.equal(next.direction,"UP");
 assert.equal(next.expiresAt-next.openedAt,600000);
 assert.equal(rebooted.signals().total,2);
 assert.equal(rebooted.status().minSignalGapMs,MIN_SIGNAL_GAP_MS);
 assert.equal(MIN_SIGNAL_GAP_MS,600000);
});
test("V17 does not suppress otherwise valid directions after two recent misses",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-pause-"));
 const file=path.join(dir,"sessions.json");
 let now=START+60000;
 const misses=[23,12].map((age,i)=>({
  id:"past-miss-"+i,decisionReviewVersion:RULE_VERSION,strategyVersion:RULE_VERSION,
  openedAt:now-age*60000,expiresAt:now-(age-10)*60000,
  closeObservedAt:now-(age-10)*60000+1000,
  direction:"DOWN",status:"COMPLETE",proxyHit:false,proxyOutcome:"UP",openPrice:70000,
  closePrice:70001,settlementStatus:"INDEX_SIGNAL_TPLUS10_PROXY_ONLY"
 }));
 fs.writeFileSync(file,JSON.stringify(misses));
 const fetcher=async url=>url.includes("shadow-market-data")?{ok:true,json:async()=>feed(now)}:
  url.includes("premiumIndex")?{ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:"70000",time:now-100})}:
  Promise.reject(Error("UNEXPECTED_URL"));
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher});
 const available=await engine.start("manual-retry-pause-0001");
 assert.equal(available.direction,"UP");
 assert.equal(engine.signals().total,3); // Two settled misses remain in the immutable audit ledger.
});
test("transient stale 1m data recovers and clears current error without erasing audit",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-fresh-"));
 const file=path.join(dir,"state.json");
 let now=START+1000,stale=true;
 const fetcher=async url=>url.includes("shadow-market-data")?{
   ok:true,json:async()=>feed(stale?now-60000:now)
 }:url.includes("premiumIndex")?{
   ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:"70000",time:now-100})
 }:Promise.reject(Error("UNEXPECTED_URL"));
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher});
 const bad=await engine.start("test-stale-scan-0001");
 assert.equal(bad.status,"DATA_ERROR");
 assert.match(engine.status().lastError,/STALE_1m/);
 assert.equal(engine.status().lastSuccessfulScanAt,null);
 const rememberedAt=engine.status().lastDataErrorAt;
 now=START+16000;stale=false;
 const good=await engine.start("test-recovered-scan-0002");
 assert.equal(good.direction,"UP");
 assert.equal(engine.status().lastError,null);
 assert.equal(engine.status().lastSuccessfulScanAt,now);
 assert.equal(engine.status().lastDataErrorAt,rememberedAt);
 assert.match(engine.status().lastDataError,/STALE_1m/);
 assert.ok(Number.isFinite(good.ruleChecks.evidence.lastClosed1mAt));
});
test("missing data and stale index abstain instead of inventing a direction",()=>{
 const at=START;
 assert.throws(()=>evaluate(at,"AUTO",{...feed(at),candles:{"1m":feed(at).candles["1m"]}}),/MISSING_5m_CANDLES/);
 assert.throws(()=>evaluatePureSignal({feed:feed(at),reference:{observedAt:at},
  indexSnapshot:{price:70000,observedAt:at-9000},trigger:"AUTO"}),/REALTIME_BINANCE_INDEX_REQUIRED/);
});
test("V10 retries stale completed candles later in the same minute",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-retry-"));
 const file=path.join(dir,"state.json");
 let now=START+1000;
 const fetcher=async url=>url.includes("shadow-market-data")?{
   ok:true,json:async()=>feed(now-START<25000?now-60000:now)
 }:url.includes("premiumIndex")?{
   ok:true,json:async()=>({symbol:"BTCUSDT",indexPrice:"70000",time:now-100})
 }:Promise.reject(Error("UNEXPECTED_URL"));
 const engine=createEngine({env:{EVENT10_STATE_FILE:file},clock:()=>now,fetcher});
 const flush=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
 await engine.tick();await flush();
 assert.equal(engine.signals().total,0);
 now=START+16000;await engine.tick();await flush();
 assert.equal(engine.signals().total,0);
 now=START+31000;await engine.tick();await flush();
 assert.equal(engine.signals().total,1);
 assert.equal(engine.status().lastSession.direction,"UP");
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
 assert.equal(signal.strategyVersion,RULE_VERSION);assert.equal(signal.signalQuality,"STRICT_RESEARCH");
 assert.equal(signal.expiresAt-signal.openedAt,600000);assert.equal(signal.realOrderPlaced,false);
 assert.equal(engine.status().autoTradingEnabled,false);assert.equal(engine.status().autoIntervalMs,60000);
 assert.equal(engine.status().minSignalGapMs,600000);
 assert.equal(engine.signals().stats.byTier.STRICT_RESEARCH.total,1);
 assert.equal(engine.signals().stats.byTier.STANDARD_RESEARCH.total,0);
 assert.equal(engine.status().scanDiagnostics.lastHour.strictSignals,1);
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


test("V17 initial view starts at zero despite V11 legacy ledger and session entries",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-v12-isolated-"));
 const file=path.join(dir,"state.json"),ledger=path.join(dir,"rule-signals-v1.ndjson");
 const oldVersion="EVENT10_TIERED_V11_20261105";
 const oldRows=Array.from({length:6},(_,i)=>({
  id:"previous-v11-"+i,openedAt:START-3600000+i*1000,expiresAt:START-3000000+i*1000,
  strategyVersion:oldVersion,decisionReviewVersion:oldVersion,
  direction:i%2?"UP":"DOWN",status:"COMPLETE",openPrice:70000,proxyHit:i%2===0
 }));
 fs.writeFileSync(file,JSON.stringify(oldRows));
 fs.writeFileSync(ledger,oldRows.map(s=>JSON.stringify({kind:"SIGNAL",signal:{...s,strategyVersion:oldVersion}})).join("\n")+"\n");
 const engine=createEngine({env:{EVENT10_STATE_FILE:file,EVENT10_SIGNAL_LOG_FILE:ledger},clock:()=>START});
 assert.equal(engine.signals().version,RULE_VERSION);
 assert.equal(engine.signals().total,0);
 assert.equal(engine.signals().stats.proxySettled,0);
 assert.equal(engine.history().length,0);
 assert.equal(engine.status().lastSession,null);
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).length,6);
 const stored=fs.readFileSync(ledger,"utf8");
 assert.match(stored,/previous-v11-0/); // historical audit preserved, not shown
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
