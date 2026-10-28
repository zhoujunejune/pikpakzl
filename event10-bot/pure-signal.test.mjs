import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {evaluatePureSignal,parseTop5Depth,parseAggressiveStreak,
  collectRuleFeatures,RULE_VERSION} from "./pure-signal.mjs";
import {createEngine} from "./manual-engine.mjs";
const NOW=Date.parse("2026-10-29T08:01:00Z"),TICK=NOW-1000;
function candles(ms,side){
 const end=Math.floor(TICK/ms)*ms;
 return Array.from({length:100},(_,i)=>{
  const t=end-(100-i)*ms;
  const step=side==="UP"?1:-1;
  const c=ms===300000?1000+step*i*0.35:
    1000+step*(i*0.085+(i%5===0?-0.5:0));
  const o=i===99?c-step*0.20:c-step*0.06;
  return {startMs:t,open:o,close:c,
    high:Math.max(o,c)+0.4,low:Math.min(o,c)-0.4,
    volume:i===99?150:100,closed:true};
 });
}
function fixture(side="UP"){
 const m=candles(60000,side),f=candles(300000,side);
 return {ok:true,readOnly:true,symbol:"BTCUSDT",
  latest:{eventMs:TICK,lastPrice:m.at(-1).close+(side==="UP"?1:-1),marketFeedConnected:true},
  candles:{"1m":m,"5m":f}};
}
const reference=feed=>({price:feed.latest.lastPrice,observedAt:TICK});
const rawBook=(up=true)=>({
 bids:Array.from({length:5},(_,i)=>[String(990-i),String(up?5:1)]),
 asks:Array.from({length:5},(_,i)=>[String(992+i),String(up?1:5)]),
 T:NOW-2500
});
const book=up=>parseTop5Depth(rawBook(up),NOW-2000);
const score=(feed,b=book(true),trades=null)=>evaluatePureSignal({
 feed,reference:reference(feed),orderBook:b,aggressiveFlow:trades});
test("strict higher gate requires all five, with evidence",()=>{
 const d=score(fixture("UP"));
 assert.equal(d.strategyVersion,RULE_VERSION);
 assert.equal(d.direction,"UP");
 assert.deepEqual(Object.values(d.upChecks),[true,true,true,true,true]);
 assert.equal(d.status,"PREDICTED");
 assert.ok(d.evidence.rsi14>=45&&d.evidence.rsi14<=70);
 assert.equal(d.evidence.volumeRatio,1.5);
 assert.equal(d.firstThreeMinutes,true);
});
test("strict lower is symmetric and never uses buy streak as bearish depth",()=>{
 const d=score(fixture("DOWN"),book(false));
 assert.equal(d.direction,"DOWN");
 assert.deepEqual(Object.values(d.downChecks),[true,true,true,true,true]);
});
test("any one failed condition yields NO_SIGNAL, with no forced direction",()=>{
 const feed=fixture("UP");
 const weak=structuredClone(feed);
 weak.candles["1m"].at(-1).volume=125;
 assert.equal(score(weak).direction,null);
 const badBook=score(feed,book(false));
 assert.equal(badBook.direction,null);
 assert.equal(badBook.upChecks.orderflow,false);
 const noBook=score(feed,null);
 assert.equal(noBook.signal,"NO_SIGNAL");
});
test("a genuine recent streak of three aggressive buys substitutes UP depth only",()=>{
 const trades=[{T:NOW-3200,p:"1000",q:"0.1",m:false,a:1},
  {T:NOW-2900,p:"1001",q:"0.1",m:false,a:2},
  {T:NOW-2700,p:"1002",q:"0.1",m:false,a:3}];
 const streak=parseAggressiveStreak(trades,NOW-2000);
 const signal=score(fixture("UP"),null,streak);
 assert.equal(signal.direction,"UP");
 assert.equal(signal.evidence.aggressiveBuyConfirmed,true);
 const stale=score(fixture("UP"),null,{...streak,lastTradeAt:TICK-5000});
 assert.equal(stale.direction,null);
 assert.equal(score(fixture("DOWN"),null,streak).direction,null);
});
test("no future candle or stale depth may pass; no peeking",()=>{
 const d=fixture("UP");
 d.candles["1m"].at(-1).closed=false;
 assert.throws(()=>score(d),/STALE_1m_CANDLES/);
 assert.equal(score(fixture("UP"),{...book(true),observedAt:TICK+1}).direction,null);
});
test("book parser uses quantity, top FIVE, not top20 notional",()=>{
 assert.equal(book(true).bidTop5QtyBtc,25);
 assert.equal(book(true).askTop5QtyBtc,5);
 assert.throws(()=>parseTop5Depth({bids:[],asks:[]},NOW),/MISSING_TOP5/);
});
test("failed REST availability is transparent and no hidden AI call",async()=>{
 const seen=[];
 const x=await collectRuleFeatures({now:()=>NOW,
  fetcher:async(url)=>{seen.push(url);return {ok:false,status:451}}});
 assert.equal(x.available,0);
 assert.equal(x.total,2);
 assert.deepEqual(Object.values(x.availability).map(y=>y.error),
  ["REGION_RESTRICTED_451","REGION_RESTRICTED_451"]);
 assert.ok(seen.every(x=>x.startsWith("https://fapi.binance.com/")));
 const stateFile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-pure-")),"history.json");
 let now=NOW;
 const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:stateFile},
  fetcher:async(url)=>{
   if(url.startsWith("https://fapi.binance.com/"))return {ok:false,status:451};
   if(url.includes("shadow-market-data"))return {ok:true,status:200,json:async()=>fixture("UP")};
   throw Error("UNEXPECTED_EXTERNAL_CALL");
  }});
 const out=await engine.start("manual-pure-test-0001");
 assert.equal(out.status,"NO_SIGNAL");
 assert.equal(engine.status().stats.total,0);
 assert.equal(engine.status().providerModel,"PURE_RULES_V1");
 assert.equal(engine.status().modelCalls,0);
 assert.equal(engine.status().autoTradingEnabled,false);
 assert.equal(engine.status().executionAvailable,false);
 assert.equal(engine.status().lastCheck.signal,"NO_SIGNAL");
 assert.equal(fs.existsSync(stateFile),false);
});


test("manual click during an automatic first-3m scan shares the result without duplicate capture",async()=>{
 const stateFile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-coalesce-")),"history.json");
 let resume,requests=0,feedCalls=0;
 const gate=new Promise(resolve=>{resume=resolve;});
 const engine=createEngine({clock:()=>NOW,env:{EVENT10_STATE_FILE:stateFile},
  fetcher:async(url)=>{
   if(url.startsWith("https://fapi.binance.com/")){
    requests++;await gate;return {ok:false,status:451};
   }
   if(url.includes("shadow-market-data")){
    feedCalls++;return {ok:true,status:200,json:async()=>fixture("UP")};
   }
   throw Error("UNEXPECTED_EXTERNAL_CALL");
  }});
 await engine.tick(); // starts auto scan in background
 assert.equal(engine.status().busyStart,true);
 const manual=engine.start("manual-concurrent-click-0001");
 assert.equal(engine.status().busyStart,true);
 resume();
 const result=await manual;
 assert.equal(result.status,"NO_SIGNAL");
 assert.equal(result.id,"auto-rule-"+NOW);
 assert.equal(engine.status().busyStart,false);
 assert.equal(engine.status().lastCheck.status,"NO_SIGNAL");
 assert.equal(engine.status().lastError,null);
 assert.equal(requests,2); // ONE pair of depth + trades, not two scans
 assert.equal(feedCalls,1);
 assert.equal(engine.status().stats.total,0);
});
test("manual retry during an existing valid ten-minute signal reuses that session",async()=>{
 const stateFile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-existing-")),"history.json");
 let restCalls=0,feedCalls=0;
 const engine=createEngine({clock:()=>NOW,env:{EVENT10_STATE_FILE:stateFile},
  fetcher:async url=>{
   if(url.includes("/fapi/v1/depth")){
    restCalls++;return {ok:true,status:200,json:async()=>rawBook(true)};
   }
   if(url.includes("/fapi/v1/aggTrades")){
    restCalls++;return {ok:false,status:451};
   }
   if(url.includes("shadow-market-data")){
    feedCalls++;return {ok:true,status:200,json:async()=>fixture("UP")};
   }
   throw Error("UNEXPECTED_EXTERNAL_CALL");
  }});
 const first=await engine.start("manual-first-success-0001");
 assert.equal(first.status,"PREDICTED");
 const second=await engine.start("manual-second-click-0001");
 assert.equal(second.id,first.id);
 assert.equal(engine.status().stats.total,1);
 assert.equal(restCalls,2);
 assert.equal(feedCalls,1);
});
