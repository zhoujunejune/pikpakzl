import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {once} from "node:events";
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"event10-alert-watch-"));
process.env.EVENT10_ALERT_RECEIPTS_FILE=path.join(temp,"receipts.ndjson");
const {serve}=await import("./server.mjs?event10alerttest=1");

function fakeEngine(){
 const state={records:[{id:"auto-1m-1794000000000",direction:"UP",
   openedAt:1794000000000,expiresAt:1794000600000,
   strategyVersion:"EVENT10_PURE_RULE_V19_20261107"}]};
 const engine={
  status:()=>({ok:true,decisionReviewVersion:"EVENT10_PURE_RULE_V19_20261107",
    aiMandatory:false,modelCalls:0,autoTradingEnabled:false,active:null,lastSession:null}),
  history:()=>[],
  signals:(limit=25,offset=0)=>({ok:true,version:"EVENT10_PURE_RULE_V19_20261107",
    records:state.records.slice(offset,offset+limit),total:state.records.length}),
  start:async()=>{throw Error("SHOULD_NOT_TRADE")},probe:async()=>({ok:true})
 };
 return {engine,state};
}
test("authenticated-perimeter long polling is bounded, advances on new signal and never trades",async()=>{
 const {engine,state}=fakeEngine();
 const server=serve(engine,{port:0});
 try{
  await once(server,"listening");
  const url="http://127.0.0.1:"+server.address().port;
  let response=await fetch(url+"/api/watch");
  assert.equal(response.status,200);
  assert.equal((await response.json()).records[0].direction,"UP");
  const cursor=state.records[0].id;
  const begin=Date.now();
  const waiting=fetch(url+"/api/watch?after="+cursor);
  await new Promise(resolve=>setTimeout(resolve,140));
  assert.ok(Date.now()-begin>=100);
  state.records.unshift({...state.records[0],id:"auto-1m-1794000600000",direction:"DOWN"});
  response=await waiting;
  assert.equal(response.status,200);
  const msg=await response.json();
  assert.equal(msg.records[0].direction,"DOWN");
  assert.equal(msg.watchTimeout,false);
  assert.ok(Date.now()-begin<8000);
  response=await fetch(url+"/api/watch?after=not_valid!");
  assert.equal(response.status,400);
  response=await fetch(url+"/api/trade",{method:"POST"});
  assert.equal(response.status,405);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test("only known active-version IDs can write bounded anonymous native receipt states",async()=>{
 const {engine,state}=fakeEngine();
 const server=serve(engine,{port:0});
 try{
  await once(server,"listening");
  const url="http://127.0.0.1:"+server.address().port;
  const clientId="8c2a65e1-6bd2-4d23-b4bd-62e3077040a1";
  const send=(obj,origin)=>fetch(url+"/api/alert-receipt",{method:"POST",headers:{
    "Content-Type":"application/json",...(origin?{"Origin":origin}:{})},
    body:JSON.stringify(obj)});
  let response=await send({clientId,signalId:state.records[0].id,
    state:"NOTIFICATION_POSTED_ALARM_STARTED"});
  assert.equal(response.status,200);
  assert.equal((await response.json()).accepted,true);
  response=await send({clientId,signalId:state.records[0].id,
    state:"CANNOT_COMMIT_ORDER"});
  assert.equal(response.status,400);
  response=await send({clientId,signalId:"manual-unknown-signal-0001",
    state:"NOTIFICATION_POSTED_ALARM_STARTED"});
  assert.equal(response.status,404);
  response=await send({clientId,signalId:state.records[0].id,
    state:"NOTIFICATION_POSTED_ALARM_STARTED"},"https://evil.example.com");
  assert.equal(response.status,403);
  response=await fetch(url+"/api/alert-health");
  assert.equal(response.status,200);
  const health=await response.json();
  assert.equal(health.summary.posted,1);
  assert.equal(health.summary.audible,1);
  assert.equal(health.source,"ANONYMOUS_ANDROID_ACKS_NOT_OS_DELIVERY");
  assert.equal(fs.readFileSync(process.env.EVENT10_ALERT_RECEIPTS_FILE,"utf8").trim().split("\n").length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});