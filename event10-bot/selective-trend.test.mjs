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
test("V12 strict retains six core gates without the old wide secondary veto",()=>{
 const at=START+60000;
 const bullish=feed(at,1);
 const last=bullish.candles["1m"].at(-1);
 last.high+=20; // baseline six trend gates still pass, V7 would veto
 const out=evaluate(at,"AUTO",bullish);
 assert.equal(out.direction,"UP");
 assert.equal(out.strategyVersion,RULE_VERSION);
});
test("V12 long RSI threshold stays below 63 and down requires 15m persistence",()=>{
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
 assert.equal(RULE_VERSION,"EVENT10_DUAL_EMA_FREQUENCY_V12_20261105");assert.equal(AUTO_SLOT_MS,60000);
 for(const m of [0,20,40]){
   const r=evaluate(START+m*60000,"AUTO",feed(START+m*60000,1,true));
   assert.equal(r.direction,null);assert.equal(r.quality,"NO_SIGNAL");
   assert.equal(r.confidence,null);assert.match(r.reason,/强制/);
 }
});
test("aligned moderate trends may signal on any minute or manually",()=>{
 for(const m of [0,1,5,20,40]){
   const r=evaluate(START+m*60000);
   assert.equal(r.direction,"UP");assert.equal(r.quality,"STRICT_RESEARCH");
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
test("V12 moderate tier increases coverage only with aligned 1m/5m trend",()=>{
 const at=START+60000;
 const moderate=feed(at,1);moderate.candles["1m"].at(-1).volume=75;
 const r=evaluate(at,"AUTO",moderate);
 assert.equal(r.direction,"UP");
 assert.equal(r.quality,"STANDARD_RESEARCH");
 assert.equal(r.conditions.volume,true);
 assert.equal(r.upChecks.volume,false);
 const mismatch=feed(at,1);mismatch.candles["1m"].at(-1).volume=75;
 mismatch.candles["5m"]=feed(at,-1).candles["5m"];
 assert.equal(evaluate(at,"AUTO",mismatch).direction,null);
});
test("V12 research-backed dual-EMA momentum fallback retains trend agreement and bounded volume",()=>{
 const at=START+60000;
 const moderate=feed(at,1);
 moderate.candles["1m"].at(-1).volume=55; // 0.55x: strict fails, momentum tier accepts
 const good=evaluate(at,"AUTO",moderate);
 assert.equal(good.direction,"UP");
 assert.equal(good.quality,"STANDARD_RESEARCH");
 assert.equal(good.upChecks.volume,false);
 assert.equal(good.standardUpChecks.volume,true);
 assert.equal(good.standardUpChecks.trend5m,true);
 assert.equal(good.standardUpChecks.trend1m,true);
 const stale=feed(at,1);stale.candles["1m"].at(-1).volume=20;
 assert.equal(evaluate(at,"AUTO",stale).direction,null);
 const conflict=feed(at,1);conflict.candles["1m"].at(-1).volume=55;
 conflict.candles["5m"]=feed(at,-1).candles["5m"];
 assert.equal(evaluate(at,"AUTO",conflict).direction,null);
});
test("V12 falling-candle rebound wick rejects an otherwise valid DOWN",()=>{
 const at=START+60000;
 const falling=feed(at,-1),last=falling.candles["1m"].at(-1);
 const base=evaluate(at,"AUTO",falling);
 assert.equal(base.direction,"DOWN");
 last.low=last.close-10;
 const result=evaluate(at,"AUTO",falling);
 assert.equal(result.direction,null);
 assert.equal(result.downChecks.bounceGuard,false);
 assert.equal(result.eventTag,"V12_DOWN_REBOUND_RISK");
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
test("V12 2m gap permits independent overlapping 10m observations across restart",async()=>{
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
 assert.match(blocked.reason,/2分钟/);
 assert.equal(engine.signals().total,1);
 engine=createEngine(opts);
 now=START+90000+1000;
 const manual=await engine.start("manually-triggered-001");
 assert.equal(manual.status,"NO_SIGNAL");
 assert.equal(engine.signals().total,1);
 now=START+MIN_SIGNAL_GAP_MS+1000;
 const overlap=await engine.start(id());
 assert.equal(overlap.direction,"UP");
 assert.equal(overlap.expiresAt-overlap.openedAt,600000);
 assert.equal(overlap.openedAt-first.openedAt,MIN_SIGNAL_GAP_MS);
 assert.equal(engine.status().activeSignalCount,2);
 assert.equal(engine.status().minSignalGapMs,MIN_SIGNAL_GAP_MS);
 assert.equal(engine.signals().total,2);
 now=first.expiresAt+1000;
 const next=await engine.start(id());
 assert.equal(next.direction,"UP");
 assert.equal(engine.signals().total,3);
});
test("V12 retains V9 NO_SIGNAL protection for risky momentum",()=>{
 const at=START+60000;
 const f=feed(at,-1),last=f.candles["1m"].at(-1);
 last.close-=3;last.low=Math.min(last.low,last.close-0.1);
 const r=evaluate(at,"AUTO",f);
 assert.notEqual(r.direction,"UP");
 assert.equal(r.confidence,null);
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
 assert.equal(engine.status().minSignalGapMs,120000);
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


test("V12 initial view starts at zero despite V11 legacy ledger and session entries",()=>{
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
