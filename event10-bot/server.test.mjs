import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createEngine,serve,buildSnapshot,checkedTick,parseDirection,scoreProxy} from "./server.mjs";

const NOW=Date.parse("2026-10-24T02:00:00Z");
const stateFile=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-manual-")),"manual.json");
const fixture=(now=NOW, tick=now-1000, value=101000)=>{
 const make=(ms)=>Array.from({length:100},(_,i)=>{
   const t=Math.floor(now/ms)*ms-(100-i)*ms;
   return {startMs:t,open:100000+i,high:100200+i,low:99900+i,
      close:100000+i,volume:200+i,closed:true};
 });
 return {ok:true,readOnly:true,symbol:"BTCUSDT",
  latest:{eventMs:tick,lastPrice:value,marketFeedConnected:true},
  candles:{"1m":make(60000),"5m":make(300000)}};
};
const json=(body)=>({ok:true,status:200,json:async()=>body});
const id="test-unique-identifier-001";
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test("strict current BTC read-only tick and closed-candle features",()=>{
 const d=buildSnapshot(fixture(),NOW);
 assert.equal(d.price,101000);
 assert.ok(d.indicators.rsi1m14>=0);
 assert.ok(d.indicators.bars1m>=36);
 assert.throws(()=>checkedTick(fixture(NOW,NOW-15000),NOW),/STALE/);
 assert.throws(()=>checkedTick({...fixture(),readOnly:false},NOW),/UNVERIFIED/);
});
test("analyzed final direction is only UP or DOWN, not WAIT",()=>{
 assert.equal(parseDirection('{"direction":"UP","confidence":0.6}').direction,"UP");
 assert.equal(parseDirection('{"direction":"DOWN","confidence":0.6}').direction,"DOWN");
 assert.throws(()=>parseDirection('{"direction":"WAIT"}'),/AI_MUST_OUTPUT/);
 assert.throws(()=>parseDirection('{"direction":"BUY"}'),/AI_MUST_OUTPUT/);
});
test("proxy hit is tracked but separate from official event outcome",()=>{
 assert.deepEqual(scoreProxy(100,105,"UP"),{proxyOutcome:"UP",proxyHit:true,returnPct:5});
 assert.equal(scoreProxy(100,99,"UP").proxyHit,false);
 assert.equal(scoreProxy(100,100,"UP").proxyHit,null);
});
test("no automatic analysis and no events orders",async()=>{
 let calls=0;
 const engine=createEngine({clock:()=>NOW,env:{EVENT10_STATE_FILE:stateFile()},fetcher:async()=>{calls++;return json({});}});
 for(let i=0;i<3;i++)await engine.tick();
 assert.equal(calls,0);
 assert.equal(engine.status().autoSignalEnabled,false);
 assert.equal(engine.status().autoTradingEnabled,false);
 assert.equal(engine.status().executionAvailable,false);
 await assert.rejects(engine.start(id),/NOT_CONFIGURED/);
});
test("manual click freezes a price, retries WAIT, decides UP, and checks outcome after 600 seconds",async()=>{
 let now=NOW,api=0,market=0;
 const file=stateFile();
 const engine=createEngine({clock:()=>now,env:{DEEPSEEK_API_KEY:"TEST_ONLY",EVENT10_STATE_FILE:file},
  fetcher:async(url,opts)=>{
   if(url.startsWith("https://fapi.binance.com/")||url.includes("127.0.0.1:13021"))return {ok:false,status:451};
   if(url.includes("shadow-market-data")){market++;return json(fixture(now,now-1000,now>=NOW+600000?101050:101000));}
   api++;
   assert.equal(opts.method,"POST");
   assert.equal(opts.body.includes("PREDICT_10_MIN_AFTER_MANUAL_CAPTURE"),true);
   return json({choices:[{message:{content:api===1?'{"direction":"WAIT","reason":"unclear"}':'{"direction":"UP","confidence":0.52,"reason":"momentum and trend"}'}}]});
  }});
 await engine.tick();assert.equal(market,0);assert.equal(api,0);
 const started=await engine.start(id);
 assert.equal(started.openPrice,101000);
 assert.equal(started.expiresAt-started.openedAt,600000);
 assert.equal(started.realOrderPlaced,false);
 await flush();await flush();
 assert.equal(api,2);
 assert.equal(engine.status().lastSession.direction,"UP");
 assert.equal(engine.status().lastSession.featureBundleVersion,"EVENT10_PUBLIC_USDM_V2");
 assert.equal(engine.status().lastSession.enrichment.available,0);
 assert.equal(engine.status().lastSession.featureAvailability.orderBook.error,"REGION_RESTRICTED_451");
 assert.equal(engine.status().lastSession.featureAvailability.continuousAggTrade.available,false);
 assert.equal(engine.status().lastSession.rollingTenMinutes.closed1mBars,10);
 assert.equal(engine.status().lastSession.status,"PREDICTED");
 assert.equal((await engine.start(id)).id,id);
 await assert.rejects(engine.start("another-click-id-4444"),/ACTIVE/);
 now=NOW+598000;await engine.tick();
 assert.equal(engine.status().stats.proxySettled,0);
 now=NOW+601000;await engine.tick();
 assert.equal(market,2);
 const last=engine.status().lastSession;
 assert.equal(last.closePrice,101050);
 assert.equal(last.proxyOutcome,"UP");
 assert.equal(last.proxyHit,true);
 assert.equal(last.officialEventHit,null);
 assert.equal(last.settlementStatus,"PUBLIC_MARKET_PROXY_ONLY");
 assert.equal(engine.status().stats.proxyHits,1);
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).length,1);
});
test("model keeps returning WAIT: record failure, do not invent UP/DOWN",async()=>{
 let now=NOW;
 const engine=createEngine({clock:()=>now,env:{DEEPSEEK_API_KEY:"TEST_ONLY",EVENT10_STATE_FILE:stateFile()},
  fetcher:async(url)=>(url.startsWith("https://fapi.binance.com/")||url.includes("127.0.0.1:13021"))?{ok:false,status:451}:
    url.includes("shadow-market-data")?json(fixture(now)):
    json({choices:[{message:{content:'{"direction":"WAIT","reason":"weak"}'}}]})});
 await engine.start("id-for-model-fail-001");await flush();await flush();
 assert.equal(engine.status().lastSession.status,"FAILED");
 assert.equal(engine.status().lastSession.direction,null);
 assert.equal(engine.status().stats.validDirections,0);
});
test("POST manual click is same-origin protected, GET never triggers analysis",async()=>{
 let now=NOW;
 const engine=createEngine({clock:()=>now,env:{DEEPSEEK_API_KEY:"TEST_ONLY",EVENT10_STATE_FILE:stateFile()},
  fetcher:async(url)=>(url.startsWith("https://fapi.binance.com/")||url.includes("127.0.0.1:13021"))?{ok:false,status:451}:
    url.includes("shadow-market-data")?json(fixture(now)):
    json({choices:[{message:{content:'{"direction":"DOWN","confidence":0.4}'}}]})});
 const server=serve(engine,{port:0});
 await new Promise(resolve=>server.once("listening",resolve));
 const host="http://127.0.0.1:"+server.address().port;
 try{
  const page=await fetch(host+"/");
  assert.equal(page.status,200);
  assert.match(await page.text(),/锁定当前参考价/);
  const stat=await(await fetch(host+"/api/status")).json();
  assert.equal(stat.stats.total,0);
  assert.equal((await fetch(host+"/api/start",{method:"POST"})).status,403);
  assert.equal((await fetch(host+"/api/order",{method:"POST"})).status,405);
  const created=await fetch(host+"/api/start",{method:"POST",headers:{
    Origin:"https://47-237-188-69.sslip.io",
    "X-Event10-Action":"manual-open","X-Event10-Request-ID":"browser-unique-click-0001"}});
  assert.equal(created.status,202);
  assert.equal((await created.json()).session.realOrderPlaced,false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
