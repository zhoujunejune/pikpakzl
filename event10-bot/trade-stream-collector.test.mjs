import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ContinuousTradeCollector,parseTrade,serveCollector,TRADE_STREAM_URL} from "./trade-stream-collector.mjs";

const NOW=Date.parse("2026-10-24T04:00:00Z");
const event=(id,when=NOW,side=false)=>JSON.stringify({
 e:"aggTrade",s:"BTCUSDT",a:id,T:when-250,E:when-60,p:"81000.00",q:"2.000",
 f:id,l:id,m:side,st:1
});
const bare=(clock=()=>NOW)=>new ContinuousTradeCollector({clock,disableDisk:true});
test("Binance 2026 public USD-M futures stream is no trading/private endpoint",()=>{
 assert.equal(TRADE_STREAM_URL,"wss://fstream.binance.com/market/ws/btcusdt@aggTrade");
 assert.doesNotMatch(TRADE_STREAM_URL,/\/private|\/order|apiKey|listenKey/i);
 const x=parseTrade(event(123,NOW,true),NOW);
 assert.equal(x.id,123);
 assert.equal(x.takerSide,"SELL");
 assert.equal(x.notional,162000);
 assert.equal(x.receivedAt-x.eventAt,60);
 assert.throws(()=>parseTrade(JSON.stringify({e:"aggTrade",s:"ETHUSDT"}),NOW),/INVALID/);
});
test("Collector works independently of manual EVENT10 button, persists every accepted group",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-journal-"));
 let now=NOW;
 const c=new ContinuousTradeCollector({clock:()=>now,dir});
 try{
  c.connected=true;c.connectedAt=NOW-610000;
  assert.equal(c.accept(event(100,now,false)),true);
  now+=100;
  assert.equal(c.accept(event(101,now,true)),true);
  assert.equal(c.accept(event(101,now,true)),false);
  await new Promise(resolve=>setTimeout(resolve,50));
  const files=fs.readdirSync(dir).filter(x=>x.endsWith(".ndjson"));
  assert.ok(files.length>=1);
  const saved=files.map(f=>fs.readFileSync(path.join(dir,f),"utf8")).join("");
  assert.match(saved,/"id":100/);
  assert.match(saved,/"id":101/);
  assert.equal(c.total,2);
  assert.equal(c.duplicate,1);
  const feature=c.features();
  assert.equal(feature.windows["60s"].complete,true);
  assert.equal(feature.windows["60s"].observedGroups,2);
  assert.equal(feature.windows["60s"].takerBuyNotionalUsd,162000);
  assert.equal(feature.windows["60s"].takerSellNotionalUsd,162000);
 }finally{c.stop();fs.rmSync(dir,{force:true,recursive:true})}
});
test("Missing aggregate IDs and reconnect break completeness and are never hidden",()=>{
 const c=bare();c.connected=true;c.connectedAt=NOW-620000;
 assert.equal(c.accept(event(7,NOW-3000)),true);
 assert.equal(c.accept(event(10,NOW)),true);
 assert.equal(c.missingAggregateIds,2);
 assert.equal(c.gapCount,1);
 assert.equal(c.features().windows["60s"].complete,false);
 assert.ok(c.features().windows["60s"].issues.includes("COLLECTION_GAP_IN_WINDOW"));
 c.disconnect("TEST_DISCONNECT");
 assert.equal(c.features().windows["60s"].complete,false);
 assert.ok(c.features().windows["60s"].issues.includes("WEBSOCKET_DISCONNECTED"));
});
test("Stale/future events and wrong contract are rejected as unverified",()=>{
 const c=bare();
 assert.equal(c.accept(event(1,NOW-70000),NOW),false);
 assert.equal(c.accept(event(2,NOW+8000),NOW),false);
 assert.equal(c.accept(JSON.stringify({...JSON.parse(event(3)),s:"ETHUSDT"}),NOW),false);
 assert.equal(c.invalid,3);
 assert.equal(c.features().windows["300s"].complete,false);
});
test("Collector local API is GET-only and does not open event contract orders",async()=>{
 const c=bare();const server=serveCollector(c,{port:0});
 await new Promise(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+server.address().port;
 try{
  const res=await fetch(base+"/api/health");
  assert.equal(res.status,200);
  const health=await res.json();
  assert.equal(health.source,"BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET");
  assert.equal(health.connected,false);
  assert.equal((await fetch(base+"/api/features")).status,200);
  assert.equal((await fetch(base+"/api/order",{method:"POST"})).status,405);
 }finally{server.close();c.stop()}
});
