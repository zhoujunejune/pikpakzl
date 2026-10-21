#!/usr/bin/env python3
"""Add current round genuine Binance quote context to existing 25s DeepSeek analysis."""
from pathlib import Path
import sys
assert len(sys.argv)==3
src,dst=map(Path,sys.argv[1:])
dst.mkdir(parents=True,exist_ok=True)
def one(s,a,b,label):
 n=s.count(a)
 if n!=1:raise RuntimeError(label+': found '+str(n))
 return s.replace(a,b,1)

p='deepseek-adaptive15-core.mjs'
s=(src/p).read_text()
s=one(s,'export function analysisRequest(w,pass,now,features,feedback={}){',
 'export function analysisRequest(w,pass,now,features,feedback={},tradeContext=null){','CORE_SIGNATURE')
s=one(s,' const confidence=Number(j.confidence);',
 """  const tradeOpinion=['TRADE','NO_TRADE','UNAVAILABLE'].includes(j?.tradeOpinion)?j.tradeOpinion:'UNAVAILABLE';
  const tradeReason=String(j?.tradeReason||'').slice(0,160);
  const confidence=Number(j.confidence);""",'CORE_JSON_DECODE')
s=one(s,"   reason:String(j.reason||'').slice(0,250),",
 "    reason:String(j.reason||'').slice(0,250),tradeOpinion,tradeReason,",'CORE_JSON_FIELDS')
s=one(s,
 "    'Confidence is SUBJECTIVE, not a calibrated win probability; a directional prediction is NOT an instruction to trade or proof of positive expected value.'",
 """     'Confidence is SUBJECTIVE, not a calibrated win probability; a directional prediction is NOT an instruction to trade or proof of positive expected value.',
     'During the current round, verifiedBinanceExecutableQuotes may contain genuine LIVE UP/DOWN BUY quotes from Binance. If quotes are absent, pending or expired, set tradeOpinion UNAVAILABLE and NEVER fabricate an executable price.',
     'In addition to UP/DOWN, explain whether the trade is worthwhile at the observed quote after costs, considering older OFFICIALLY settled evidence. Historical hit rates and subjective confidence are not calibrated future probabilities.',
     'Output tradeOpinion TRADE, NO_TRADE, or UNAVAILABLE and tradeReason. This is an advisory analysis only; a separate fresh-quote mathematical trade-value gate always decides whether a real order may be submitted.'""",
 'CORE_PROMPT_TRADING')
s=one(s,
 '    verifiedHistoricalExperience:feedbackSafe,',
 """     verifiedHistoricalExperience:feedbackSafe,
     verifiedBinanceExecutableQuotes:pass==='current'&&tradeContext?.ok===true?tradeContext:null,""",
 'CORE_ADD_LIVE_QUOTES')
s=one(s,
 '    requireDirectionalForecast:false,',
 '     requireDirectionalForecast:false,','CORE_KEEP_DIRECTION')
s=one(s,
 '''    'Return compact JSON {"direction":"UP","confidence":0.51,"continueAnalysis":false,"reason":"actual evidence","risk":"uncertainty or basis gap","reasonToWait":""}. Choose continueAnalysis=true only if more fresh market observations could improve the decision before the deadline.',''',
 '''     'Return compact JSON {"direction":"UP","confidence":0.51,"continueAnalysis":false,"reason":"actual evidence","risk":"uncertainty or basis gap","reasonToWait":"","tradeOpinion":"UNAVAILABLE","tradeReason":"current quote unavailable"}. Choose continueAnalysis=true only if more fresh market observations could improve the decision before the deadline.',''',
 'CORE_MODEL_FORMAT')
s=one(s,'   reason:chosen.reason,earlySamples:early.length,priorSamples:prior.length}};',
 '''    reason:chosen.reason,aiTradeOpinion:chosen.tradeOpinion||'UNAVAILABLE',
    aiTradeReason:chosen.tradeReason||'',
    aiQuoteObservedAt:chosen.tradeQuoteEvidence?.generatedAt??null,
    aiQuoteUpChance:chosen.tradeQuoteEvidence?.UP?.chance??null,
    aiQuoteDownChance:chosen.tradeQuoteEvidence?.DOWN?.chance??null,
    earlySamples:early.length,priorSamples:prior.length}};''','CORE_RESULT_EXPLANATION')
(dst/p).write_text(s)

p='deepseek-adaptive15-runner.mjs'
s=(src/p).read_text()
s=one(s,' onLocked=null,onWait=null,getHistoricalFeedback=null',
 '  onLocked=null,onWait=null,getHistoricalFeedback=null,getLiveQuoteContext=null',
 'RUNNER_QUOTE_CALLBACK')
s=one(s,
 '''   payload=analysisRequest(w,pass,now,features,feedback);
   // Prompt evidence offered, not demonstrated comprehension or predictive lift.''',
 '''    // Quotes for the new round are never fabricated from a previous round.
    // Local endpoint responds while preview acquisition continues in background.
    let verifiedQuotes=null;
    if(pass==='current'&&typeof getLiveQuoteContext==='function'){
      try{verifiedQuotes=await getLiveQuoteContext(w.round,clock())}catch{}
    }
    payload=analysisRequest(w,pass,now,features,feedback,verifiedQuotes);
    w.lastQuoteContext=verifiedQuotes;
    // Prompt evidence offered, not demonstrated comprehension or predictive lift.''',
 'RUNNER_PROMPT_QUOTES')
s=one(s,'    historyOffered:feedback?.usable===true,',
 '''     historyOffered:feedback?.usable===true,
     verifiedLiveQuoteOffered:verifiedQuotes?.ok===true,''',
 'RUNNER_AUDIT_QUOTE')
s=one(s,'   registerAnalysis(w,result);w.lastModelError=null;lastError=null;',
 '''   result.tradeQuoteEvidence=w.lastQuoteContext?.ok===true?w.lastQuoteContext:null;
   if(!result.tradeQuoteEvidence)result.tradeOpinion='UNAVAILABLE';
   registerAnalysis(w,result);w.lastModelError=null;lastError=null;''',
 'RUNNER_VALIDATED_REASON')
(dst/p).write_text(s)

p='deepseek-adaptive15-production-adapter.mjs'
s=(src/p).read_text()
s=one(s,
 "    reason:String(candidate.latest.reason||'DEEPSEEK_TWO_PASS_ADAPTIVE15_EXPERIENCE').slice(0,180),",
 """     reason:String(candidate.latest.reason||'DEEPSEEK_TWO_PASS_ADAPTIVE15_EXPERIENCE').slice(0,180),
     aiTradeOpinion:candidate.latest.aiTradeOpinion||'UNAVAILABLE',
     aiTradeReason:String(candidate.latest.aiTradeReason||'').slice(0,160),
     aiQuoteObservedAt:candidate.latest.aiQuoteObservedAt??null,
     aiQuoteUpChance:candidate.latest.aiQuoteUpChance??null,
     aiQuoteDownChance:candidate.latest.aiQuoteDownChance??null,""",
 'ADAPTER_SIGNAL_AI_REASON')
s=one(s,'  onWait:term=>storeWait(term),',
 """   // Genuine current-round Binance BUY quote previews, NEVER an order. The
   // callback has a strict 650ms budget and cannot delay the 25s limit.
   getLiveQuoteContext:async(round,at)=>{
     if(at<round||at>=round+25000)return null;
     try{
       const resp=await fetcher('http://127.0.0.1:13001/api/ai-quote-context?round='+round,{
         headers:{Accept:'application/json'},signal:AbortSignal.timeout(650)});
       if(!resp.ok)return null;
       const q=await resp.json(),now=clock();
       if(q?.ok!==true||q.round!==round||!Number.isSafeInteger(q.generatedAt)||
          q.generatedAt>now+250||now-q.generatedAt>2800)return null;
       for(const direction of ['UP','DOWN']){
         const x=q[direction],price=x?.chance;
         if(typeof price!=='number'||!Number.isFinite(price)||price<=0||price>=1||
            !Number.isSafeInteger(x?.at)||now-x.at>2800||x.at>now+250||
            (x.expireAt&&x.expireAt<=now+1500))return null;
       }
       return {ok:true,source:'SIGNED_BINANCE_PREDICTION_CURRENT_ROUND_BUY_QUOTE_PREVIEW',
         round,generatedAt:q.generatedAt,UP:q.UP,DOWN:q.DOWN,
         assumedCostBuffer:0.02,minRequiredEdge:0.015,
         quoteOnly:true,executeOnlyWithRefreshedQuote:true};
     }catch{return null}
   },
   onWait:term=>storeWait(term),""",'ADAPTER_CURRENT_ROUND_QUOTE_CB')
(dst/p).write_text(s)
print('DEEPSEEK_REAL_QUOTE_COGNITION_PATCH_READY=true')
