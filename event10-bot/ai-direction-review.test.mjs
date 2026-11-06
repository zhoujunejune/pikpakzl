import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {reviewAiDirection,feedbackExamples} from "./ai-direction-review.mjs";
import {checkedKlines,collectIndependentSpotCandles} from "./readonly-candles.mjs";
import {createEngine} from "./manual-engine.mjs";
import {RULE_VERSION} from "./pure-signal.mjs";
const AT=Date.parse("2026-11-06T12:00:00Z");
const examples=[
 {openedAt:AT-3600000,closeObservedAt:AT-3000000,direction:"UP",proxyOutcome:"DOWN",
  proxyHit:false,change3mPct:0.1,rsi14:62,volumeRatio:2},
 {openedAt:AT-2400000,closeObservedAt:AT-1800000,direction:"DOWN",proxyOutcome:"DOWN",
  proxyHit:true,change3mPct:-0.05,rsi14:47},
 {openedAt:AT-900000,closeObservedAt:AT+200,direction:"UP",proxyOutcome:"UP",
  proxyHit:true}];
const evidence={ema1Fast:101,ema1Slow:100,ema5Fast:103,ema5Slow:102,change3mPct:0.1,rsi14:61};
function candles(at,interval){
 const ms=interval==="1m"?60000:300000,n=interval==="1m"?65:43;
 let v=1000;const start=Math.floor(at/ms)*ms;
 return Array.from({length:n},(_,i)=>{
  const inc=(interval==="1m"?[0.7,-0.7,0.7,-0.4]:[2,-0.5,2.2,-0.3])[i%4];
  const next=v+inc,open=v;v=next;
  return [start-(n-i)*ms,String(open),String(Math.max(open,next)+.1),
   String(Math.min(open,next)-.1),String(next),String(i===n-1?140:100),
   start-(n-i)*ms+ms-1];
 });
}
test("feedback excludes unknown, unresolved and future outcomes",()=>{
 const list=feedbackExamples(examples,AT,18);
 assert.equal(list.length,2);
 assert.equal(list.filter(x=>!x.correct).length,1);
 assert.equal(list[0].correct,true);
});
test("AI is a direction-only reviewer and never vetoes eligible rule signal",async()=>{
 const calls=[];
 const fetcher=async (url,args)=>{
  calls.push({url,body:JSON.parse(args.body)});
  return {ok:true,json:async()=>({choices:[{
   finish_reason:"stop",
   message:{
    content:JSON.stringify({direction:"DOWN",confidence:0.62,
     reason:"过去相似动量结构容易冲高回落",upCase:"一分及五分EMA仍向上，趋势有惯性",
     downCase:"RSI偏高且前次相似信号发生回落",
     decisiveEvidence:"对照已结算的冲高回落案例更偏下跌",
     risk:"历史案例不多，强上涨可能再次延续"}),
    reasoning_content:"mock high reasoning tokens"
   }
  }]})};
 };
 const r=await reviewAiDirection({rule:"UP",evidence,records:examples,at:AT,
  fetcher,env:{EVENT10_AI_API_KEY:"fake-test-key"},timeoutMs:1000});
 assert.equal(r.status,"AI_REVIEWED");assert.equal(r.direction,"DOWN");
 assert.equal(r.lessonsCount,2);
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.response_format.type,"json_object");
 assert.equal(calls[0].body.model,"deepseek-flash");
 assert.equal(calls[0].body.reasoning_effort,"high");
 assert.equal(calls[0].body.thinking.type,"enabled");
 assert.equal(calls[0].body.max_tokens,8192);
 assert.equal(r.analysisCompleted,true);
 assert.equal(r.reasoningObserved,true);
 assert.equal(r.attempts,1);
 assert.match(JSON.stringify(calls[0].body.messages),/历史/);
 assert.ok(!JSON.stringify(calls[0].body.messages).includes("fake-test-key"));
});
test("AI API errors and missing key retain the original direction",async()=>{
 const failure=await reviewAiDirection({rule:"UP",evidence,records:examples,at:AT,
  fetcher:async()=>{throw Error("API_DOWN")},
  env:{EVENT10_AI_API_KEY:"fake-test-key"}});
 assert.equal(failure.direction,"UP");assert.equal(failure.status,"AI_INCOMPLETE_FALLBACK");
 assert.equal(failure.analysisCompleted,false);assert.equal(failure.attempts,2);
 const noKey=await reviewAiDirection({rule:"DOWN",evidence,at:AT,
  env:{}});
 assert.equal(noKey.direction,"DOWN");assert.equal(noKey.status,"NO_KEY_OR_DISABLED");
});
test("independent public Binance closed candles are verified, not synthetic",async()=>{
 const values=await collectIndependentSpotCandles({now:()=>AT,fetcher:async url=>{
  const interval=url.includes("interval=1m")?"1m":"5m";
  return {ok:true,json:async()=>candles(AT,interval)};
 }});
 assert.equal(values.ok,true);assert.equal(values.readOnly,true);
 assert.equal(values.marketSource,"BINANCE_SPOT_PUBLIC_REST");
 assert.equal(values.candles["1m"].length,60);
 assert.equal(values.candles["5m"].length,40);
 const malformed=candles(AT,"1m");malformed.at(-1)[6]+=60000;
 assert.throws(()=>checkedKlines(malformed,"1m",AT),/BINANCE_CANDLE_INVALID/);
});
test("real engine still accepts unchanged V16 frequency after 13003 fails, AI selects direction",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-v17-ai-"));
 const file=path.join(dir,"session.json");
 let now=AT+1000;
 let aiAvailable=true;
 const fetcher=async url=>{
  if(url.includes("shadow-market-data"))throw Error("ECONNREFUSED");
  if(url.includes("premiumIndex"))return {ok:true,json:async()=>({
   symbol:"BTCUSDT",indexPrice:"70000",time:now-100})};
  if(url.includes("api/v3/klines")){
   const interval=url.includes("interval=1m")?"1m":"5m";
   return {ok:true,json:async()=>candles(now,interval)};
  }
  if(url.includes("chat/completions")){
   if(!aiAvailable)throw Error("AI_OFFLINE");
   return {ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{
    content:JSON.stringify({direction:"DOWN",confidence:0.6,
      reason:"短周期动量仍上升但历史相似信号常回落",
      upCase:"原先EMA与成交量同向显示一定上行潜力",
      downCase:"历史相似失误表明短期动量出现过度拉升",
      decisiveEvidence:"当前RSI与动量组合类似以往上涨误判",
      risk:"行情如果突破近期高点则下跌判断可能出错"}),
    reasoning_content:"mock simulated high thinking"}}]})};
  }
  throw Error("UNKNOWN_TEST_ENDPOINT");
 };
 const engine=createEngine({env:{EVENT10_STATE_FILE:file,DEEPSEEK_API_KEY:"fake"},
  fetcher,clock:()=>now});
 const first=await engine.start("event10-ai-test-0001");
 assert.equal(first.direction,"DOWN");assert.equal(first.aiReview.status,"AI_REVIEWED");
 assert.equal(first.ruleChecks.evidence.originalEligibleDirection,"UP");
 assert.equal(engine.signals().records[0].aiDirection,"DOWN");
 assert.equal(engine.status().modelCalls,1);assert.equal(engine.status().aiReviewConfigured,true);
 assert.equal(engine.signals().version,RULE_VERSION);
 now+=60000;
 const blocked=await engine.start("event10-ai-test-0002");
 assert.equal(blocked.direction,null);assert.equal(engine.status().modelCalls,1);
 now+=600000;aiAvailable=false;
 const second=await engine.start("event10-ai-test-0003");
 assert.equal(second.direction,"UP");assert.equal(second.aiReview.status,"AI_INCOMPLETE_FALLBACK");
 assert.equal(second.aiReview.analysisCompleted,false);
 assert.equal(engine.signals().total,2);assert.equal(engine.status().modelCalls,2);
 assert.equal(engine.status().minSignalGapMs,600000);
});

test("unfinished or unreasoned model output is never labelled AI complete",async()=>{
 let attempts=0;
 const r=await reviewAiDirection({rule:"UP",evidence,at:AT,
  env:{DEEPSEEK_API_KEY:"fake"},timeoutMs:2500,fetcher:async()=>{
   attempts++;
   return {ok:true,json:async()=>({choices:[{finish_reason:"length",message:{
    content:JSON.stringify({direction:"UP",confidence:0.9,reason:"没有完整分析"})
   }}]})};
  }});
 assert.equal(attempts,2);
 assert.equal(r.status,"AI_INCOMPLETE_FALLBACK");
 assert.equal(r.analysisCompleted,false);
 assert.equal(r.direction,"UP");
 assert.match(r.error,/AI_NOT_FINISHED/);
});
