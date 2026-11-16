import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {RULE_VERSION,verifiedThreeMinuteCloses,evaluatePureSignal} from "./pure-signal.mjs";
import {createEngine,scoreProxy} from "./manual-engine.mjs";

const T=Date.parse("2026-11-01T00:00:02Z");
const quote=(at=T,p=1000)=>({price:p,observedAt:at-100,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"});
const feed=(closes=[1000,1000,1000,1000],at=T,options={})=>{
 const minute=Math.floor(at/60000)*60000;
 const candles=closes.map((close,i)=>({
   startMs:minute-(closes.length-i)*60000,closed:true,
   open:close,high:close,low:close,close,volume:1
 }));
 if(options.gap)candles[1].startMs+=60000;
 if(options.future)candles[3].startMs=minute;
 return {ok:true,readOnly:true,symbol:"BTCUSDT",latest:{marketFeedConnected:true},
   candles:{"1m":candles}};
};
const direction=(close,at=T)=>evaluatePureSignal({feed:feed([1000,1000,1000,close],at),
   reference:{observedAt:at},indexSnapshot:quote(at)});
test("AT-01 three-minute rise +0.2% -> Lower with exact event tag",()=>{
 const r=direction(1002);
 assert.equal(r.direction,"DOWN");
 assert.equal(r.eventTag,"THREE_MIN_UP_REVERSE_DOWN");
 assert.ok(Math.abs(r.change3mPct-.2)<1e-9);
});
test("AT-02 three-minute fall about -0.2% -> Higher",()=>{
 const at=T;
 const r=evaluatePureSignal({feed:feed([1002,1002,1002,1000],at),
   reference:{observedAt:at},indexSnapshot:quote(at)});
 assert.equal(r.direction,"UP");
 assert.equal(r.eventTag,"THREE_MIN_DOWN_REVERSE_UP");
});
test("AT-03, AT-04 flat 0.04% and 0% both force Higher",()=>{
 for(const c of [1000.4,1000]){
  const r=direction(c);
  assert.equal(r.direction,"UP");assert.equal(r.eventTag,"FLAT_FORCE_UP");
 }
});
test("AT-05 boundary exactly +0.05% reverses DOWN, not FLAT",()=>{
 assert.equal(direction(1000.5).direction,"DOWN");
 assert.equal(direction(1000.5).eventTag,"THREE_MIN_UP_REVERSE_DOWN");
 assert.equal(direction(999.5).direction,"UP");
 assert.equal(direction(999.5).eventTag,"THREE_MIN_DOWN_REVERSE_UP");
});
test("AT-06 missing, stale, non-contiguous and future candles fail closed",()=>{
 const base={reference:{observedAt:T},indexSnapshot:quote()};
 for(const invalid of [feed([1000,1000,1000]),feed([1000,1000,1000,1002],T,{gap:true}),
   feed([1000,1000,1000,1002],T,{future:true}),
   feed([1000,1000,1000,1002],T-180000)]){
  assert.throws(()=>evaluatePureSignal({...base,feed:invalid}));
 }
 assert.equal(verifiedThreeMinuteCloses(feed([1000,1000,1000,1002]),T).length,4);
});
test("no optional EMA/RSI/depth/volume gate affects a valid mechanical direction",()=>{
 const r=direction(1002);
 assert.deepEqual(r.optionalFilters,{volumeSpike:false,rsiReverse:false,breakoutReverse:false});
 assert.equal(r.evidence.closedBars,4);
 assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
});
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),"zl-event10-contrarian-"));
function fixture({initial=T,closes=[1000,1000,1000,1002],old=[]}={}){
 const dir=tmp(),stateFile=path.join(dir,"manual-sessions-v2.json");
 fs.writeFileSync(stateFile,JSON.stringify(old));
 let now=initial,openedPrice=1000;
 const fetcher=async url=>{
   if(url.includes("shadow-market-data"))return {
     ok:true,status:200,json:async()=>feed(closes,now)};
   if(url.includes("premiumIndex"))return {
     ok:true,status:200,json:async()=>({symbol:"BTCUSDT",indexPrice:openedPrice,time:now-100})};
   throw Error("UNEXPECTED_URL "+url);
 };
 const config={env:{EVENT10_STATE_FILE:stateFile},clock:()=>now,fetcher};
 const e=createEngine(config);
 return {e,config,stateFile,setNow:v=>{now=v},setPrice:v=>{openedPrice=v}};
}
const micro=()=>new Promise(resolve=>setImmediate(resolve));
test("AT-07 automatic 12-minute slot is unique including across restart",async()=>{
 const f=fixture();await f.e.tick();await micro();await micro();
 const a=f.e.signals(100,0);
 assert.equal(a.total,1);assert.equal(a.records[0].id,"auto-12m-"+(Math.floor(T/720000)*720000));
 assert.equal(a.records[0].trigger,"AUTO");
 f.setNow(T+3000);await f.e.tick();await micro();
 assert.equal(f.e.signals(100,0).total,1);
 const reboot=createEngine(f.config);
 f.setNow(T+5000);await reboot.tick();await micro();
 assert.equal(reboot.signals(100,0).total,1);
 assert.equal(reboot.status().autoIntervalMs,720000);
});
test("AT-08 manual requestId is idempotent and manual can coexist with pending auto",async()=>{
 const f=fixture();
 const a=await f.e.start("manual-contrarian-00001");
 const a2=await f.e.start("manual-contrarian-00001");
 const b=await f.e.start("manual-contrarian-00002");
 assert.equal(a.id,a2.id);assert.notEqual(a.id,b.id);
 assert.equal(f.e.signals(25,0).total,2);
 assert.ok(f.e.signals(25,0).records.every(x=>x.trigger==="MANUAL"));
});
test("AT-09 settled 600s later from same index proxy, durable after restart",async()=>{
 const f=fixture();
 const a=await f.e.start("manual-contrarian-settle");
 assert.equal(a.expiresAt-a.openedAt,600000);
 assert.equal(a.direction,"DOWN");assert.equal(a.openPrice,1000);
 f.setPrice(1005);f.setNow(a.expiresAt+1000);
 await f.e.tick();
 const item=f.e.signals(10,0).records[0];
 assert.equal(item.closePrice,1005);
 assert.equal(item.proxyOutcome,"UP");assert.equal(item.proxyHit,false);
 assert.equal(item.closeObservedAt,a.expiresAt+900);
 assert.equal(item.expirySampleLagMs,900);
 assert.equal(f.e.signals(10,0).stats.proxySettled,1);
 assert.equal(createEngine(f.config).signals(10,0).records[0].closePrice,1005);
});
test("AT-10 equal prices FLAT excluded and unverified expiry excluded",async()=>{
 assert.deepEqual(scoreProxy(1000,1000,"UP"),{
   proxyOutcome:"FLAT",proxyHit:null,returnPct:0});
 const f=fixture();const a=await f.e.start("manual-contrarian-expiry");
 f.setNow(a.expiresAt+16000);await f.e.tick();
 assert.equal(f.e.signals(10,0).records[0].settlementStatus,"UNVERIFIABLE_PRICE_NEAR_EXPIRY");
 assert.equal(f.e.signals(10,0).stats.proxySettled,0);
});
test("AT-11 old version remains persisted but is not in new V1 count",()=>{
 const legacy={id:"legacy-00000001",openedAt:T-700000,expiresAt:T-100000,
   direction:"UP",status:"PREDICTED",decisionReviewVersion:"EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101",
   openPrice:1000,closePrice:null,proxyHit:null,proxyOutcome:null};
 const f=fixture({old:[legacy]});
 assert.equal(f.e.signals(25,0).total,0);
 assert.equal(f.e.signals(25,0).stats.proxyAccuracyPct,null);
 assert.equal(f.e.status().decisionReviewVersion,RULE_VERSION);
 assert.equal(f.e.history().length,1);
});
test("AT-12 3 wins/7 losses/2 pending yields 30% and 10 confirmed",()=>{
 const dir=tmp(),stateFile=path.join(dir,"state.json");
 const records=Array.from({length:12},(_,i)=>({
  id:"test-sample-"+String(i).padStart(4,"0"),openedAt:T-i*60000,
  expiresAt:T-i*60000+600000,direction:"UP",status:"PREDICTED",
  decisionReviewVersion:RULE_VERSION,openPrice:1000,
  closePrice:i<10?1000+(i<3?1:-1):null,
  closeObservedAt:i<10?T-i*60000+600000:null,
  proxyHit:i<10?i<3:null,proxyOutcome:i<10?(i<3?"UP":"DOWN"):null,
  settlementStatus:i<10?"INDEX_SIGNAL_TPLUS10_PROXY_ONLY":null
 }));
 fs.writeFileSync(stateFile,JSON.stringify(records));
 const e=createEngine({env:{EVENT10_STATE_FILE:stateFile},clock:()=>T});
 assert.equal(e.signals(25,0).total,12);
 assert.equal(e.signals(25,0).stats.proxySettled,10);
 assert.equal(e.signals(25,0).stats.proxyAccuracyPct,30);
});
test("AT-13 125 historical V1 signals paginate without truncation",()=>{
 const dir=tmp(),stateFile=path.join(dir,"state.json");
 const rows=Array.from({length:125},(_,i)=>({
   id:"paged-signal-"+i,openedAt:T-i*30000,expiresAt:T-i*30000+600000,
   direction:"UP",decisionReviewVersion:RULE_VERSION,status:"PREDICTED",openPrice:1000}));
 fs.writeFileSync(stateFile,JSON.stringify(rows));
 const engine=createEngine({env:{EVENT10_STATE_FILE:stateFile},clock:()=>T});
 const ids=[];for(let i=0;i<125;i+=25)ids.push(...engine.signals(25,i).records.map(x=>x.id));
 assert.equal(ids.length,125);assert.equal(new Set(ids).size,125);
 assert.equal(engine.signals(25,125).records.length,0);
});
