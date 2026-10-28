import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {createEngine,serve} from "./server.mjs";

const RULE="EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029";
const NOW=Date.parse("2026-10-29T08:14:00Z");
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),"event10-ledger-"));
function record(i,{settled=false}={}){
 const openedAt=NOW-(i+1)*600000;
 return {
   id:"historical-rule-"+String(i).padStart(5,"0"),
   openedAt,expiresAt:openedAt+600000,
   direction:i%2?"DOWN":"UP",status:"PREDICTED",decisionReviewVersion:RULE,
   signalCycleStartMs:openedAt-openedAt%600000,
   openPrice:100000+i,
   ruleChecks:{conditions:{trend5m:true,momentum1m:true,volume:true,orderflow:true,rsi:true},
     evidence:{volumeRatio:1.45,rsi14:54}},
   closePrice:settled?100012+i:null,closeObservedAt:settled?openedAt+600000:null,
   proxyHit:settled?(i%2===0):null,proxyOutcome:settled?"UP":null,
   settlementStatus:settled?"PUBLIC_MARKET_PROXY_ONLY":null,
   realOrderPlaced:false
 };
}
test("all 540 existing V1 signals migrate into append-only ledger; older pages survive restarts",()=>{
 const dir=temp(),stateFile=path.join(dir,"manual-sessions-v2.json"),ledger=path.join(dir,"rule-signals-v1.ndjson");
 const old=Array.from({length:540},(_,i)=>record(i,{settled:true}));
 old.push({...record(999),id:"invalid-no-signal",direction:null,status:"NO_SIGNAL"});
 fs.writeFileSync(stateFile,JSON.stringify(old));
 const config={clock:()=>NOW,env:{EVENT10_STATE_FILE:stateFile}};
 const e=createEngine(config);
 assert.equal(e.history(999).length,200); // compatibility API is bounded
 assert.equal(e.status().strategyStats.total,540);
 assert.equal(e.signals(25,0).total,540);
 assert.equal(e.signals(25,500).records.length,25);
 assert.equal(e.signals(25,525).records.length,15);
 assert.equal(e.signals(25,550).records.length,0);
 assert.equal(e.signals(25,0).stats.proxySettled,540);
 assert.equal(e.signals(25,0).stats.proxyHits,270);
 assert.ok(e.signals(25,0).records.every(x=>x.fiveOfFive&&x.direction));
 assert.equal(fs.readFileSync(ledger,"utf8").trim().split("\n").length,540);
 const restarted=createEngine(config);
 assert.equal(restarted.signals(50,525).records.length,15);
 assert.equal(fs.readFileSync(ledger,"utf8").trim().split("\n").length,540);
 assert.equal(restarted.status().autoTradingEnabled,false);
 assert.equal(restarted.status().executionAvailable,false);
});
test("10-minute later public-market proxy settlement is appended and survives restart",async()=>{
 const dir=temp(),stateFile=path.join(dir,"manual-sessions-v2.json"),ledger=path.join(dir,"rule-signals-v1.ndjson");
 const current={...record(0),id:"pending-ten-minute-123",
  openedAt:NOW-600000,expiresAt:NOW,
  openPrice:100000,proxyHit:null,proxyOutcome:null,
  settlementStatus:null,closePrice:null,closeObservedAt:null};
 fs.writeFileSync(stateFile,JSON.stringify([current]));
 const clock=()=>NOW+1000;
 const config={clock,env:{EVENT10_STATE_FILE:stateFile},
   fetcher:async (url)=>{
    assert.ok(url.includes("shadow-market-data"));
    return {ok:true,status:200,json:async()=>({ok:true,readOnly:true,symbol:"BTCUSDT",
      latest:{lastPrice:100050,eventMs:NOW+700,marketFeedConnected:true}})};
   }};
 const e=createEngine(config);
 assert.equal(e.signals(5,0).stats.proxySettled,0);
 await e.tick();
 assert.equal(e.signals(5,0).records[0].proxyHit,true);
 assert.equal(e.signals(5,0).records[0].closePrice,100050);
 assert.equal(e.signals(5,0).stats.proxySettled,1);
 assert.equal(e.signals(5,0).stats.proxyHits,1);
 const journal=fs.readFileSync(ledger,"utf8");
 assert.equal(journal.trim().split("\n").length,2);
 assert.match(journal,/"kind":"SETTLEMENT"/);
 const restarted=createEngine(config);
 assert.equal(restarted.signals(5,0).stats.proxySettled,1);
 assert.equal(restarted.signals(5,0).records[0].proxyHit,true);
});
test("read-only /api/signals paginates all records and rejects invalid inputs",async()=>{
 const dir=temp(),stateFile=path.join(dir,"manual-sessions-v2.json");
 fs.writeFileSync(stateFile,JSON.stringify([record(0,{settled:true}),record(1,{settled:false})]));
 const engine=createEngine({env:{EVENT10_STATE_FILE:stateFile},clock:()=>NOW});
 const server=serve(engine,{port:0});
 await new Promise(resolve=>server.once("listening",resolve));
 const address="http://127.0.0.1:"+server.address().port;
 try{
  const res=await fetch(address+"/api/signals?limit=1&offset=1");
  assert.equal(res.status,200);
  const result=await res.json();
  assert.equal(result.total,2);
  assert.equal(result.records.length,1);
  assert.equal(result.offset,1);
  assert.equal(result.stats.total,2);
  assert.equal(result.autoTradingEnabled,false);
  assert.equal((await fetch(address+"/api/signals?offset=wrong")).status,400);
  assert.equal((await fetch(address+"/api/signals?limit=0")).status,400);
  assert.equal((await fetch(address+"/api/order",{method:"POST"})).status,405);
 }finally{server.close();}
});
