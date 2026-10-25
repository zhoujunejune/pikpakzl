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
 assert.equal(d.indicators.last1mCandleAt,NOW-120000);
 assert.equal(d.indicators.last5mCandleAt,NOW-600000);
 assert.ok(d.priceStructure.lastClosedCandleAt<=NOW);
 assert.equal(d.priceStructure.source,"SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES");
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
   const outbound=JSON.parse(opts.body);
   assert.deepEqual(outbound.thinking,{type:"enabled"});
   assert.equal(outbound.reasoning_effort,"high");
   assert.equal(outbound.response_format.type,"json_object");
   return json({choices:[{message:{
    content:api===1?'{"direction":"WAIT","reason":"unclear"}':'{"direction":"UP","confidence":0.52,"reason":"momentum and trend"}',
    reasoning_content:api===1?"":"推理后选UP"
   }}],usage:{completion_tokens_details:{reasoning_tokens:117}}});
  }});
 await engine.tick();assert.equal(market,0);assert.equal(api,0);
 const started=await engine.start(id);
 assert.equal(started.openPrice,101000);
 assert.equal(started.expiresAt-started.openedAt,600000);
 assert.equal(started.realOrderPlaced,false);
 await flush();await flush();
 assert.equal(api,2);
 assert.equal(engine.status().lastSession.direction,"UP");
 assert.equal(engine.status().thinkingMode,"enabled");
 assert.equal(engine.status().reasoningEffort,"high");
 assert.equal(engine.status().lastReasoningObserved,true);
 assert.equal(engine.status().lastReasoningTokenCount,117);
 assert.equal(engine.status().lastSession.thinkingRequested,true);
 assert.equal(engine.status().lastSession.reasoningObserved,true);
 assert.equal(engine.status().lastSession.reasoningTokenCount,117);
 assert.equal(JSON.stringify(engine.status()).includes("推理后选UP"),false);
 assert.equal(engine.status().lastSession.featureBundleVersion,"EVENT10_PRICE_STRUCTURE_SOURCES_V6");
 assert.equal(engine.status().lastSession.enrichment.available,0);
 assert.equal(engine.status().lastSession.featureAvailability.fifteenMinute.error,"REGION_RESTRICTED_451");
 assert.equal(engine.status().lastSession.featureAvailability.continuousAggTrade.available,false);
 assert.equal(engine.status().lastSession.rollingTenMinutes.closed1mBars,10);
 assert.ok(engine.status().lastSession.rollingTenMinutes.until<=engine.status().lastSession.openedAt);
 assert.ok(engine.status().lastSession.priceStructure.lastClosedCandleAt<=engine.status().lastSession.openedAt);
 assert.equal(engine.status().lastSession.decisionReviewVersion,"EVENT10_AI_PRICE_STRUCTURE_V6_20261024");
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
  assert.equal((await fetch(host+"/api/localize-latest",{method:"POST"})).status,403);
  const created=await fetch(host+"/api/start",{method:"POST",headers:{
    Origin:"https://47-237-188-69.sslip.io",
    "X-Event10-Action":"manual-open","X-Event10-Request-ID":"browser-unique-click-0001"}});
  assert.equal(created.status,202);
  assert.equal((await created.json()).session.realOrderPlaced,false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test("as-of continuous BTC trade window is accepted even if LIVE collector has later trades",async()=>{
 let now=NOW,observedAsOf=null,promptInput=null;
 const f=stateFile();
 const engine=createEngine({clock:()=>now,env:{DEEPSEEK_API_KEY:"TEST_ONLY",EVENT10_STATE_FILE:f},
  fetcher:async(url,opts)=>{
   if(url.startsWith("https://fapi.binance.com/"))return {ok:false,status:451};
   if(url.includes("shadow-market-data"))return json(fixture(now,now-1000));
   if(url.includes("127.0.0.1:13021/api/features")){
    observedAsOf=Number(new URL(url).searchParams.get("asof"));
    return json({ok:true,source:"BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET",
      asOf:observedAsOf,lastReceivedAt:now-200,
      missingAggregateIds:0,gapCount:0,reconnectCount:0,
      windows:{
        "60s":{complete:true,to:observedAsOf-250,lastStreamReceiveAgeMs:250,
          observedGroups:2000,takerBuyNotionalUsd:300000,takerSellNotionalUsd:200000},
        "300s":{complete:false,to:observedAsOf-250,lastStreamReceiveAgeMs:250,
          issues:["INSUFFICIENT_CONTINUOUS_UPTIME"]},
        "600s":{complete:false,to:observedAsOf-250,lastStreamReceiveAgeMs:250,
          issues:["INSUFFICIENT_CONTINUOUS_UPTIME"]}
      }});
   }
   promptInput=JSON.parse(opts.body);
   return json({choices:[{message:{content:'{"direction":"UP","confidence":0.51,"reason":"sample"}'}}]});
  }});
 const session=await engine.start("asof-collector-test-001");
 assert.equal(observedAsOf,NOW-1000);
 assert.deepEqual(session.featureAvailability.continuousAggTrade.windows,["60s"]);
 assert.equal(session.continuousTradeFlow.windows["60s"].observedGroups,2000);
 assert.equal(session.continuousTradeFlow.windows["300s"],undefined);
 await flush();await flush();
 assert.equal(engine.status().lastSession.direction,"UP");
 assert.deepEqual(promptInput.thinking,{type:"enabled"});
 assert.equal(promptInput.reasoning_effort,"high");
 assert.equal(engine.status().lastReasoningObserved,false);
 assert.ok(promptInput.messages[1].content.includes("compactEvidence"));
 const frozenPayload=JSON.parse(promptInput.messages[1].content);
 assert.equal(frozenPayload.compactEvidence.version,"EVENT10_AI_PRICE_STRUCTURE_V6_20261024");
 assert.ok(promptInput.messages[0].content.includes("UP/DOWN"));
 assert.ok(promptInput.messages[0].content.includes("不返回 WAIT"));
 assert.ok(promptInput.messages[0].content.includes("不同市场的绝对价格不能互相相减"));
 assert.ok(promptInput.messages[0].content.includes("超卖不必然UP"));
 assert.equal(frozenPayload.compactEvidence.limitations.referencePriceNotComparableInAbsoluteTermsToFutures,true);
 assert.ok(promptInput.messages[0].content.includes("简体中文"));
 assert.equal(JSON.parse(promptInput.messages[1].content).explanationLanguage,"简体中文");
 assert.equal(Object.keys(frozenPayload).join(","),"purpose,version,outputLanguage,explanationLanguage,referencePrice,capturedAt,expiresAt,compactEvidence");
 assert.equal(frozenPayload.compactEvidence.continuousFlow10m,null); // only 60s is complete
 assert.ok(frozenPayload.compactEvidence.priceStructure);
 assert.equal(frozenPayload.compactEvidence.priceStructure.lastThreeClosedBarsTrend!=="",true);
 assert.equal("enrichedBinancePublicData" in frozenPayload,false);
 assert.equal("continuousAggTradeFlow" in frozenPayload,false);
 assert.equal("rollingLastTenClosedMinutes" in frozenPayload,false);
 assert.equal(frozenPayload.referencePrice,101000);
 assert.equal("proxyHit" in frozenPayload,false);
});
