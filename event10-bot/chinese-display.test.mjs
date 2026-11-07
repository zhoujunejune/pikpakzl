import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createChineseDisplay,hasHan,requiresChineseDisplay} from "./chinese-display.mjs";
const temp=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"event10-zh-")),"zh-cache.json");
const old={id:"old-case-001",status:"PREDICTED",direction:"DOWN",
 reason:"Aligned downtrend plus persistent aggressive selling favor more downside.",
 analysisArguments:{
  upCase:"Oversold bounce is possible.",
  downCase:"Selling pressure supports DOWN.",
  decisiveEvidence:"Short and long timeframes agree.",
  uncertainty:"Oversold conditions lower confidence."
 },openPrice:80842,closePrice:80770,proxyHit:true};
const chinese={reason:"多周期下跌趋势与持续主动卖出表明未来价格可能继续下跌。",
 upCase:"超卖可能引发短线反弹。",downCase:"持续卖出压力支持下跌。",
 decisiveEvidence:"短周期和长周期方向一致。",uncertainty:"超卖降低判断把握。"};
test("detect legacy English vs existing Simplified Chinese",()=>{
 assert.equal(requiresChineseDisplay(old),true);
 assert.equal(hasHan("持续卖出压力支持下跌"),true);
 assert.equal(requiresChineseDisplay({...old,reason:chinese.reason,analysisArguments:{
  upCase:chinese.upCase,downCase:chinese.downCase,
  decisiveEvidence:chinese.decisiveEvidence,uncertainty:chinese.uncertainty}}),false);
});
test("legacy translation caches separately, preserves all original prediction/price/settlement and is reused",async()=>{
 const file=temp();
 let calls=0,requestBody;
 const engine=createChineseDisplay({env:{DEEPSEEK_API_KEY:"test-only"},cacheFile:file,
  fetcher:async(url,opts)=>{
   calls++;requestBody=JSON.parse(opts.body);
   assert.equal(opts.method,"POST");
   return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chinese)}}]})};
  }});
 const before=JSON.stringify(old);
 const a=await engine.translate(old);
 assert.equal(a.displayChinese.reason,chinese.reason);
 assert.equal(a.displayChinese.downCase,chinese.downCase);
 assert.equal(calls,1);
 assert.deepEqual(Object.keys(JSON.parse(requestBody.messages[1].content)).sort(),Object.keys(chinese).sort());
 assert.equal(JSON.stringify(old),before);
 const decorated=engine.overlay(old);
 assert.equal(decorated.reason,old.reason);
 assert.equal(decorated.direction,"DOWN");
 assert.equal(decorated.proxyHit,true);
 assert.equal(decorated.displayChinese.reason,chinese.reason);
 const b=await engine.translate(old);
 assert.equal(b.cached,true);
 assert.equal(calls,1);
 const newProcess=createChineseDisplay({env:{},cacheFile:file,fetcher:async()=>{throw Error("UNEXPECTED_API_CALL")}});
 assert.equal(newProcess.overlay(old).displayChinese.reason,chinese.reason);
 assert.equal(fs.existsSync(file),true);
});
test("translation request cannot hallucinate a prediction or accept text with no Chinese",async()=>{
 const engine=createChineseDisplay({env:{DEEPSEEK_API_KEY:"test-only"},cacheFile:temp(),
  fetcher:async()=>({ok:true,json:async()=>({choices:[{message:{content:
   JSON.stringify({...chinese,reason:"Still an English sentence."})}}]})})});
 await assert.rejects(engine.translate(old),/CHINESE_TRANSLATION_MISSING_reason/);
 await assert.rejects(engine.translate({...old,status:"ANALYZING"}),/NO_FINISHED_FORECAST/);
});
