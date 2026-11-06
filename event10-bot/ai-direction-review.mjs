// Bounded DeepSeek directional review for already-qualified EVENT10 signals.
// Reviews cannot create, suppress, delay a later slot, or place orders.
// Feedback is retrieval of prior settled results: NOT training model weights.
const validDirection=x=>x==="UP"||x==="DOWN";
const clampText=(value,n=150)=>String(value||"").slice(0,n);
const rounded=(n,digits=4)=>Number.isFinite(n)?Number(n.toFixed(digits)):null;
export function feedbackExamples(records,asOf,limit=18){
 if(!Array.isArray(records))return [];
 // No look-ahead: require a verified outcome and sample timestamp strictly before decision.
 const source=records.filter(x=>x&&validDirection(x.direction)&&
   typeof x.proxyHit==="boolean"&&validDirection(x.proxyOutcome)&&
   Number.isFinite(x.openedAt)&&Number.isFinite(x.closeObservedAt)&&
   x.closeObservedAt<asOf&&x.openedAt<asOf-600000);
 const selected=source.sort((a,b)=>b.openedAt-a.openedAt).slice(0,Math.min(30,limit));
 return selected.map(x=>({
  ageMin:Math.round((asOf-x.openedAt)/60000),
  pastDirection:x.direction,actual10mDirection:x.proxyOutcome,
  correct:x.proxyHit,change3mPct:Number.isFinite(x.change3mPct)?rounded(x.change3mPct,5):null,
  volumeRatio:Number.isFinite(x.volumeRatio)?rounded(x.volumeRatio,3):null,
  rsi14:Number.isFinite(x.rsi14)?rounded(x.rsi14,2):null,
  quality:x.signalQuality||null
 }));
}
export function reviewPrompt({rule,evidence,lessons,at}){
 const compact={
  asOf:at,ruleDirection:rule,
  ema1Fast:evidence.ema1Fast,ema1Slow:evidence.ema1Slow,
  ema5Fast:evidence.ema5Fast,ema5Slow:evidence.ema5Slow,
  change1mPct:evidence.change1mPct,change3mPct:evidence.change3mPct,
  change15mPct:evidence.change15mPct,volumeRatio:evidence.volumeRatio,
  rsi14:evidence.rsi14,rsiRise3:evidence.rsiRise3,
  bullishLast3:evidence.bullishLast3,bearishLast3:evidence.bearishLast3,
  downBounceRisk:evidence.downBounceRisk,
  recentSettledExamples:lessons
 };
 return [
  {role:"system",content:"你是BTC十分钟公开指数代理方向研究复核助手。只允许在UP和DOWN二选一；不能决定是否发信号，不得根据历史错误取消下一条有效规则信号。没有足够证据也必须选择相对更可能的方向，不能声称确定盈利。仅考虑截止 asOf 前可知的市场指标和已结算历史例子，绝不使用未来数据。历史错误用于提醒失误场景，不代表修改了模型权重。请输出紧凑JSON对象，字段 direction (UP或DOWN),confidence (0到1),reason (中文不超过100字)。"},
  {role:"user",content:"请以规则模型的方向为基线，结合以下最新行情和过去已经结算的正确及错误案例，复核未来600秒的方向。注意必须输出JSON：\n"+JSON.stringify(compact)}
 ];
}
export async function reviewAiDirection({rule,evidence,records=[],at,fetcher=fetch,
  env=process.env,timeoutMs=2500}={}){
 if(!validDirection(rule))throw Error("AI_REVIEW_RULE_DIRECTION_REQUIRED");
 const key=env.EVENT10_AI_API_KEY||env.DEEPSEEK_API_KEY;
 const model=env.EVENT10_AI_MODEL||"deepseek-v4-pro";
 const lessons=feedbackExamples(records,at,18);
 const basic={direction:rule,baseDirection:rule,model,lessonsCount:lessons.length};
 if(!key||env.EVENT10_AI_ENABLED==="0"||env.EVENT10_AI_ENABLED==="false")
  return {...basic,status:"NO_KEY_OR_DISABLED",latencyMs:0,confidence:null,reason:"规则方向兜底；大模型未启用。"};
 const started=Date.now();
 try{
  const response=await fetcher("https://api.deepseek.com/chat/completions",{
   method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
   signal:AbortSignal.timeout(Math.max(700,Math.min(3500,timeoutMs))),
   body:JSON.stringify({model,messages:reviewPrompt({rule,evidence,lessons,at}),
    temperature:0.1,reasoning_effort:"none",response_format:{type:"json_object"},max_tokens:180})
  });
  if(!response.ok)throw Error("AI_HTTP_"+response.status);
  const body=await response.json();
  const message=body?.choices?.[0]?.message?.content;
  if(typeof message!=="string"||message.length>2500)throw Error("AI_RESPONSE_INVALID");
  let data;try{data=JSON.parse(message);}catch{throw Error("AI_JSON_INVALID");}
  if(!validDirection(data?.direction))throw Error("AI_DIRECTION_INVALID");
  const confidence=Number(data.confidence);
  return {...basic,direction:data.direction,status:"AI_REVIEWED",
   latencyMs:Date.now()-started,
   confidence:Number.isFinite(confidence)&&confidence>=0&&confidence<=1?rounded(confidence,3):null,
   reason:clampText(data.reason,130)};
 }catch(error){
  return {...basic,status:"AI_FALLBACK",latencyMs:Date.now()-started,
   confidence:null,reason:"AI超时或失败，使用规则方向。",
   error:clampText(error?.name==="TimeoutError"?"TIMEOUT":error?.message,70)};
 }
}
