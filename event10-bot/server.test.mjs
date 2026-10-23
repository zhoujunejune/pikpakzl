import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createEngine,marketFeatures,parseDecision,roundId,serve} from "./server.mjs";

const base=roundId(Date.parse("2026-10-24T00:00:00Z"));
const now=base+20_000;
const sampleFeed=(at=now)=>({
  ok:true,readOnly:true,symbol:"BTCUSDT",
  latest:{eventMs:at,lastPrice:101000,marketFeedConnected:true},
  candles:{
    "1m":Array.from({length:50},(_,i)=>({
      startMs:base-(50-i)*60_000,open:100000+i,high:100100+i,
      low:99900+i,close:100000+i,volume:100+i,closed:true
    })),
    "5m":Array.from({length:50},(_,i)=>({
      startMs:base-(50-i)*300_000,open:100000+i,high:100100+i,
      low:99900+i,close:100000+i,volume:100+i,closed:true
    }))
  }
});
const response = (value)=>({ok:true,status:200,json:async()=>value});
const stateFile=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-")),"records.json");

test("10-minute analysis rounds are deterministic and separate from 5-minute cycles",()=>{
  assert.equal(roundId(base+599999),base);
  assert.equal(roundId(base+600000),base+600000);
});
test("public read-only data must be fresh, valid and not official event index",()=>{
  const f=marketFeatures(sampleFeed(),now);
  assert.equal(f.symbol,"BTCUSDT");
  assert.equal(f.eventContractIndexPrice,null);
  assert.equal(f.eventContractPayout,null);
  assert.ok(Number.isFinite(f.rsi1m14));
  assert.throws(()=>marketFeatures({...sampleFeed(),readOnly:false},now),/INVALID_READONLY/);
  assert.throws(()=>marketFeatures(sampleFeed(now-30000),now),/STALE/);
});
test("DeepSeek response strictly validates direction and does not manufacture a win probability",()=>{
  assert.equal(parseDecision('{"direction":"UP","confidence":0.7}').direction,"UP");
  assert.equal(parseDecision('{"direction":"WAIT","confidence":0.2}').direction,"WAIT");
  assert.throws(()=>parseDecision('{"direction":"BUY"}'),/DIRECTION/);
});
test("no model credential means no model calls and never real orders",async()=>{
  let calls=0;
  const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:stateFile()},
    fetcher:async()=>{calls++;return response({});}});
  await engine.tick();
  assert.equal(calls,0);
  assert.equal(engine.status().autoTradingEnabled,false);
  assert.equal(engine.status().executionAvailable,false);
  assert.equal(engine.status().configured,false);
});
test("successful analysis creates one persisted ten-minute signal and never submits order",async()=>{
  let marketCalls=0,modelCalls=0;
  const f=stateFile();
  const engine=createEngine({
    clock:()=>now,
    env:{EVENT10_STATE_FILE:f,DEEPSEEK_API_KEY:"TEST_PLACEHOLDER_NOT_REAL",EVENT10_DEEPSEEK_MODEL:"deepseek-flash"},
    fetcher:async(url,opts)=>{
      if(url.includes("shadow-market-data")){marketCalls++;assert.equal(opts.method,undefined);return response(sampleFeed());}
      modelCalls++;assert.equal(opts.method,"POST");assert.ok(url.includes("deepseek.com"));
      return response({choices:[{message:{content:'{"direction":"DOWN","confidence":0.61,"reason":"weak short-term momentum"}'}}]});
    }
  });
  await engine.tick();await engine.tick();
  const status=engine.status();
  assert.equal(modelCalls,1);
  assert.equal(marketCalls,1);
  assert.equal(status.currentSignal.direction,"DOWN");
  assert.equal(status.currentSignal.orderPlaced,false);
  assert.equal(status.autoTradingEnabled,false);
  assert.equal(status.officialEventContractResultsAvailable,false);
  assert.equal(JSON.parse(fs.readFileSync(f,"utf8")).length,1);
  assert.equal(engine.history().length,1);
});
test("WAIT cannot fabricate a signal or order",async()=>{
  const engine=createEngine({clock:()=>now,
    env:{DEEPSEEK_API_KEY:"PLACEHOLDER",EVENT10_STATE_FILE:stateFile()},
    fetcher:async(url)=>url.includes("shadow-market-data")?response(sampleFeed()):
      response({choices:[{message:{content:'{"direction":"WAIT","confidence":0.0,"reason":"uncertain"}'}}]})});
  await engine.tick();
  assert.equal(engine.history().length,0);
  assert.equal(engine.status().currentSignal,null);
  assert.match(engine.status().error,/MODEL_WAIT/);
});
test("HTTP interface is GET-only, bound to loopback, no trade API",async()=>{
  const engine=createEngine({clock:()=>now,env:{EVENT10_STATE_FILE:stateFile()}});
  const server=serve(engine,{port:0});
  await new Promise(resolve=>server.once("listening",resolve));
  try{
    const url="http://127.0.0.1:"+server.address().port;
    const page=await fetch(url+"/");
    assert.equal(page.status,200);
    assert.match(await page.text(),/真实自动下单不可用/);
    const status=await (await fetch(url+"/api/status")).json();
    assert.equal(status.autoTradingEnabled,false);
    assert.equal((await fetch(url+"/api/place-order",{method:"POST"})).status,405);
    assert.equal((await fetch(url+"/fapi/v1/order")).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
