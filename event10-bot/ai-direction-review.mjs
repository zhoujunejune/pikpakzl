// Bounded DeepSeek directional review for already-qualified EVENT10 signals.
// Reviews cannot create, suppress, delay a later slot, or place orders.
// Feedback = past verified losses/wins + recurring evidence patterns; NOT training model weights.
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
 const selected=source.sort((a,b)=>b.openedAt-a.openedAt).slice(0,Math.min(60,limit));
 return selected.map(x=>({
  ageMin:Math.round((asOf-x.openedAt)/60000),
  pastDirection:x.direction,actual10mDirection:x.proxyOutcome,
  correct:x.proxyHit,change3mPct:Number.isFinite(x.change3mPct)?rounded(x.change3mPct,5):null,
  volumeRatio:Number.isFinite(x.volumeRatio)?rounded(x.volumeRatio,3):null,
  rsi14:Number.isFinite(x.rsi14)?rounded(x.rsi14,2):null,
  quality:x.signalQuality||null
 }));
}
// Builds an auditable, rolling lesson summary from prior *settled* outcomes.
export function buildLearningProfile(records,asOf){
 const valid=feedbackExamples(records,asOf,60);
 const wins=valid.filter(x=>x.correct);
 const losses=valid.filter(x=>!x.correct);
 const summary=rows=>({
  samples:rows.length,
  up:rows.filter(x=>x.pastDirection==="UP").length,
  down:rows.filter(x=>x.pastDirection==="DOWN").length,
  highRsi:rows.filter(x=>Number.isFinite(x.rsi14)&&x.rsi14>=60).length,
  lowRsi:rows.filter(x=>Number.isFinite(x.rsi14)&&x.rsi14<=40).length,
  highVolume:rows.filter(x=>Number.isFinite(x.volumeRatio)&&x.volumeRatio>=1.5).length,
  largeMomentum:rows.filter(x=>Number.isFinite(x.change3mPct)&&Math.abs(x.change3mPct)>=0.12).length
 });
 const lossCases=losses.slice(0,12).map(({ageMin,pastDirection,actual10mDirection,
   change3mPct,volumeRatio,rsi14,quality})=>({
    ageMin,predicted:pastDirection,observed:actual10mDirection,
    change3mPct,volumeRatio,rsi14,quality
   }));
 return {settledSamples:valid.length,winCount:wins.length,lossCount:losses.length,
  observedProxyAccuracyPct:valid.length?rounded(100*wins.length/valid.length,2):null,
  lossPatterns:summary(losses),winPatterns:summary(wins),recentLossCases:lossCases,
  caveat:"这些只是历史已结算的描述性统计，不能证明因果、不能预测下一轮，样本可能很少。"};
}
// Do not call a terse JSON response "deep analysis". Require comparison of
// both directions, decisive evidence, risk, a proper finish, and a usable answer.
// DeepSeek V4-Pro thinking mode is explicitly HIGH (not 'none').
export const AI_REVIEW_EFFORT="high";
export const AI_REVIEW_MAX_TOKENS=8192;
export const AI_REVIEW_ATTEMPTS=2;
const minText=(v,n=8)=>typeof v==="string"&&v.trim().length>=n;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function reviewPrompt({rule,evidence,lessons,profile,at}){
 const compact={
  asOf:at,ruleDirection:rule,
  ema1Fast:evidence.ema1Fast,ema1Slow:evidence.ema1Slow,
  ema5Fast:evidence.ema5Fast,ema5Slow:evidence.ema5Slow,
  change1mPct:evidence.change1mPct,change3mPct:evidence.change3mPct,
  change15mPct:evidence.change15mPct,volumeRatio:evidence.volumeRatio,
  rsi14:evidence.rsi14,rsiRise3:evidence.rsiRise3,
  bullishLast3:evidence.bullishLast3,bearishLast3:evidence.bearishLast3,
  downBounceRisk:evidence.downBounceRisk,
  recentSettledExamples:lessons,
  rollingLearningProfile:profile
 };
 return [
  {role:"system",content:"你是BTC十分钟公开指数代理方向的严谨研究复核助手。按历史已结算案例作经验复盘，但历史错误本身不能证明未来走势，严禁为迎合历史强行反向。必须分别评估上涨、下跌依据，明确从已结算失败中发现哪些失误特征与本次类似、哪些教训不适用、可能失效的条件以及反向风险，然后选出相对更可能的方向UP或DOWN。不能决定是否发信号，不能利用决策时间后的数据，不能承诺盈利，也不能把历史经验检索称为模型训练。仅返回合法JSON对象，必须含direction、confidence、reason、upCase、downCase、decisiveEvidence、risk，每项中文解释充分且具体（每段至少8个字），confidence为0至1之间的有限数字。解释应引用真实给定指标，不得虚构盘口、清算或事件合约官方结算。"},
  {role:"user",content:"请完整复核未来600秒的方向。规则模型基线及已结算历史经验如下（仅决策时刻前数据）：\n"+JSON.stringify(compact)}
 ];
}
function parseCompleteReview(body){
 const choice=body?.choices?.[0];
 if(choice?.finish_reason!=="stop")throw Error("AI_NOT_FINISHED_"+clampText(choice?.finish_reason||"UNKNOWN",28));
 const message=choice?.message?.content;
 if(typeof message!=="string"||message.length>7000)throw Error("AI_CONTENT_INVALID");
 let data;try{data=JSON.parse(message);}catch{throw Error("AI_JSON_INVALID");}
 if(!validDirection(data?.direction))throw Error("AI_DIRECTION_INVALID");
 if(!["reason","upCase","downCase","decisiveEvidence","risk"].every(k=>minText(data[k],8)))
  throw Error("AI_ANALYSIS_INCOMPLETE");
 const confidence=data.confidence;
 if(typeof confidence!=="number"||!Number.isFinite(confidence)||confidence<0||confidence>1)
  throw Error("AI_CONFIDENCE_INVALID");
 const tokens=body?.usage?.completion_tokens_details?.reasoning_tokens;
 const reasoningObserved=(Number.isFinite(tokens)&&tokens>0)||
  (typeof choice?.message?.reasoning_content==="string"&&choice.message.reasoning_content.length>0);
 if(!reasoningObserved)throw Error("AI_THINKING_NOT_VERIFIED");
 return {direction:data.direction,confidence:rounded(confidence,3),
  reason:clampText(data.reason,160),upCase:clampText(data.upCase,160),
  downCase:clampText(data.downCase,160),
  decisiveEvidence:clampText(data.decisiveEvidence,160),
  risk:clampText(data.risk,160),reasoningObserved,
  reasoningTokenCount:Number.isFinite(tokens)?tokens:null};
}
export async function reviewAiDirection({rule,evidence,records=[],at,fetcher=fetch,
  env=process.env,timeoutMs=40000}={}){
 if(!validDirection(rule))throw Error("AI_REVIEW_RULE_DIRECTION_REQUIRED");
 const key=env.EVENT10_AI_API_KEY||env.DEEPSEEK_API_KEY;
 const model=env.EVENT10_AI_MODEL||"deepseek-flash";
 const lessons=feedbackExamples(records,at,18);
 const profile=buildLearningProfile(records,at);
 const basic={direction:rule,baseDirection:rule,model,lessonsCount:lessons.length,
  learningSamples:profile.settledSamples,learningLosses:profile.lossCount,
  reasoningEffort:AI_REVIEW_EFFORT,analysisCompleted:false,attempts:0};
 if(!key||env.EVENT10_AI_ENABLED==="0"||env.EVENT10_AI_ENABLED==="false")
  return {...basic,status:"NO_KEY_OR_DISABLED",latencyMs:0,confidence:null,
   reason:"AI未运行，规则方向应急输出；不得视为AI分析完成。"};
 const started=Date.now();
 // Real DeepSeek-V4-Pro high-thinking smoke completed after 25.23 seconds.
 // First call gets up to 40s; one retry gets up to 20s so the total
 // remains bounded near 60s without treating a 25s analysis as a failure.
 let lastError="UNKNOWN";
 for(let attempt=1;attempt<=AI_REVIEW_ATTEMPTS;attempt++){
  try{
   const perAttemptMs=attempt===1?Math.max(2500,Math.min(40000,timeoutMs)):
     Math.max(2500,Math.min(20000,timeoutMs));
   const response=await fetcher("https://api.deepseek.com/chat/completions",{
    method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
    signal:AbortSignal.timeout(perAttemptMs),
    body:JSON.stringify({model,messages:reviewPrompt({rule,evidence,lessons,profile,at}),
     reasoning_effort:AI_REVIEW_EFFORT,thinking:{type:"enabled"},
     response_format:{type:"json_object"},max_tokens:AI_REVIEW_MAX_TOKENS})
   });
   if(!response.ok)throw Error("AI_HTTP_"+response.status);
   const validated=parseCompleteReview(await response.json());
   return {...basic,...validated,status:"AI_REVIEWED",analysisCompleted:true,
    attempts:attempt,latencyMs:Date.now()-started,completedAt:Date.now()};
  }catch(error){
   lastError=clampText(error?.name==="TimeoutError"?"TIMEOUT":error?.message,70);
   if(attempt<AI_REVIEW_ATTEMPTS)await wait(350);
  }
 }
 return {...basic,status:"AI_INCOMPLETE_FALLBACK",attempts:AI_REVIEW_ATTEMPTS,
  latencyMs:Date.now()-started,confidence:null,
  reason:"AI没有按要求完成全部分析；以下仅为规则应急方向，不是AI判断。",
  error:lastError};
}
