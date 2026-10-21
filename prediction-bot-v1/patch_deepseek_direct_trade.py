#!/usr/bin/env python3
"""Replace bespoke mathematical buy/no-buy veto with authenticated DeepSeek's decision.

Applies after patch_deepseek_quote_cognition.py and patch_trade_quote_preview.py.
The order-control program validates model provenance and order mechanics only.
"""
from pathlib import Path
import sys
assert len(sys.argv)==4
model_dir,wrapper_path,new_wrapper=map(Path,sys.argv[1:])
core=model_dir/'deepseek-adaptive15-core.mjs'
runner=model_dir/'deepseek-adaptive15-runner.mjs'
adapter=model_dir/'deepseek-adaptive15-production-adapter.mjs'
def once(s,old,new,tag):
 n=s.count(old)
 if n!=1:raise ValueError('%s: expected once, found %s'%(tag,n))
 return s.replace(old,new,1)

s=core.read_text()
s=once(s,"This is an advisory analysis only; a separate fresh-quote mathematical trade-value gate always decides whether a real order may be submitted.",
 "You (DeepSeek) are solely responsible for the economic TRADE or NO_TRADE choice. Technical order validation only verifies data provenance, order integrity, and quote freshness; no separate statistical rule may override your economic judgment.",
 "AI_FINAL_ECONOMIC_AUTHORITY")
s=once(s,
 "Output tradeOpinion TRADE, NO_TRADE, or UNAVAILABLE and tradeReason.",
 "Output tradeOpinion TRADE, NO_TRADE, or UNAVAILABLE and tradeReason. Return TRADE only when authenticated same-round UP/DOWN quote exists, you select UP or DOWN, and after considering actual price, costs, uncertainty, and official prior outcomes you affirm the trade is worthwhile; return NO_TRADE when you decide the trade is unattractive, and UNAVAILABLE when real quote evidence is absent. If the quote is unavailable but time remains, set continueAnalysis=true to wait for a new genuine quote.",
 "AI_REASONING_POLICY")
core.write_text(s)

s=runner.read_text()
s=once(s,
 "const wantsMore=!latestCurrent||latestCurrent.continueAnalysis||latestCurrent.direction==='WAIT';",
 "const wantsMore=!latestCurrent||latestCurrent.continueAnalysis||latestCurrent.direction==='WAIT'||latestCurrent.tradeOpinion==='UNAVAILABLE';",
 "AI_CONTINUE_WHILE_QUOTE_PENDING")
s=once(s,
 """const readyToLock=latestCurrent&&latestCurrent.direction!=='WAIT'&&
       (!latestCurrent.continueAnalysis||(exhausted&&!inFlight));""",
 """const readyToLock=latestCurrent&&latestCurrent.direction!=='WAIT'&&
       latestCurrent.tradeOpinion!=='UNAVAILABLE'&&
       (!latestCurrent.continueAnalysis||(exhausted&&!inFlight));""",
 "AI_LOCK_TRADE_OPINION")
runner.write_text(s)

# Preserve existing production learning and settlement modules unchanged.
assert 'export function createAdaptive15ProductionProvider' in adapter.read_text()

s=wrapper_path.read_text()
start=s.find("  // DeepSeek-only real AUTO_CONFIRM order-value decision.")
end=s.find("  if (EV_FILTER_ENABLED) {",start)
if start<0 or end<0 or s.count("  // DeepSeek-only real AUTO_CONFIRM order-value decision.")!=1:
 raise ValueError('MISSING_PRODUCTION_MATH_VETO')
if "decideLiveTradeValue({" not in s[start:end] or "conservativeNetEdge" not in s[start:end]:
 raise ValueError('UNKNOWN_LEGACY_MATH_GATE')
direct="""  // DeepSeek alone makes the economic decision to TRADE or NO_TRADE.
  // This layer only authenticates the model's decision and validates order
  // mechanics (round, direction, signed quote, freshness, duplication).
  if (p.signalModelChoice===SELECTIVE8_MODEL) {
    let aiDecision=null;
    let reason='AI_DECISION_UNAVAILABLE';
    let verified=false;
    try {
      const response=await fetch('http://127.0.0.1:13029/api/status',
        {headers:{Accept:'application/json'},signal:AbortSignal.timeout(1100)});
      if(!response.ok)throw Error('MODEL_STATUS_HTTP_'+response.status);
      const data=await response.json(),signal=data?.signal,op=signal?.latest?.aiTradeOpinion;
      const detail=String(signal?.latest?.aiTradeReason||'').slice(0,160);
      if(data?.model!=='DEEPSEEK_5M_V1'||signal?.model!=='DEEPSEEK_5M_V1'||
        signal?.round!==p.round||signal?.latest?.round!==p.round||
        signal?.latest?.status!=='LOCKED'||signal?.latest?.direction!==p.productionSignal||
        signal?.latest?.direction!==p.signal||
        !Number.isSafeInteger(signal.latest.lockedAt)||
        signal.latest.lockedAt<p.round||signal.latest.lockedAt>=p.round+25000||
        !Number.isSafeInteger(signal.latest.aiQuoteObservedAt)||
        signal.latest.aiQuoteObservedAt<p.round||
        signal.latest.aiQuoteObservedAt>signal.latest.lockedAt||
        !Number.isFinite(signal.latest.aiQuoteUpChance)||
        !Number.isFinite(signal.latest.aiQuoteDownChance)||
        signal.latest.aiQuoteUpChance<=0||signal.latest.aiQuoteUpChance>=1||
        signal.latest.aiQuoteDownChance<=0||signal.latest.aiQuoteDownChance>=1)
        throw Error('MODEL_OR_QUOTE_EVIDENCE_UNVERIFIED');
      if(!['TRADE','NO_TRADE'].includes(op))throw Error('AI_TRADE_OPINION_INVALID');
      if(!detail.trim())throw Error('AI_EXPLANATION_MISSING');
      aiDecision=op;reason=detail;verified=true;
    }catch(err){reason=String(err?.message||err).slice(0,110)}
    p.tradeValueDecision=aiDecision||'UNAVAILABLE';
    p.tradeValueReason=reason;
    p.aiDecisionVerified=verified;
    console.log(JSON.stringify({event:'deepseek_direct_trade_choice',
      round:p.round,productionDirection:p.productionSignal,
      orderDirection:p.signal,decision:p.tradeValueDecision,
      reason,verified,quoteChance:Number(quote.chance),
      actualBinanceQuoteAvailable:true}));
    if(!verified||aiDecision!=='TRADE'){
      p.state=verified?'AI_NO_TRADE':'AI_UNAVAILABLE';
      p.blockReason=verified?'DEEPSEEK_CHOSE_NO_TRADE':'AI_DECISION_NOT_VERIFIABLE';
      p.error=verified?'DeepSeek主动决定NO_TRADE：'+reason:
        '未取得可核验的DeepSeek实时交易授权：'+reason;
      return {status:409,body:{ok:false,decision:verified?'NO_TRADE':'UNAVAILABLE',
        reason:p.blockReason,error:p.error}};
    }
  }

"""
s=s[:start]+direct+s[end:]
# Fully remove the obsolete inactive legacy EV filter, not just turn its switch off.
st=s.find("  if (EV_FILTER_ENABLED) {")
en=s.find("  if (remainingMs !== null && remainingMs < 1200) {",st)
if st<0 or en<0 or s.count("  if (EV_FILTER_ENABLED) {")!=1:raise ValueError('UNKNOWN_LEGACY_EV_BLOCK')
s=s[:st]+s[en:]
s=once(s,
 "const EV_FILTER_ENABLED = false; // EV 仅保留计算/展示，不再作为实盘下单拦截条件",
 "// Economic TRADE / NO_TRADE decisions are now solely made by DeepSeek.",
 "REMOVE_EV_SWITCH")
for old in ["const EV_FILTER_REQUIRE_CALIBRATED = !/^(0|false|no|off)$/i.test(String(process.env.PREDICTION_EV_REQUIRE_CALIBRATED || 'true'));",
            "const EV_MIN_EDGE = Math.max(0, Math.min(0.50, Number(process.env.PREDICTION_EV_MIN_EDGE || 0.04)));"]:
 s=once(s,old,"",'REMOVE_UNUSED_LEGACY_EV')
s=once(s,
 """source = "import {decideLiveTradeValue} from './live-trade-value-policy.mjs';\\n" + source;""",
 "",
 "REMOVE_STATISTICAL_GATE_IMPORT")
s=once(s,
 "       }else if(currentPending.state==='EV_FILTERED'){",
 """       }else if(currentPending.state==='AI_NO_TRADE'||currentPending.state==='AI_UNAVAILABLE'){""",
 "FRONTEND_SHOW_AI_DECISION")
s=once(s,
 "         if(currentPending.blockReason==='INSUFFICIENT_EDGE'){",
 "         if(currentPending.state==='AI_NO_TRADE'){",
 "FRONTEND_NO_TRADE_LABEL")
s=once(s,
 "           text('pendingTitle','已跳过本轮：当前赔率优势不足');",
 "           text('pendingTitle','DeepSeek 决定不下单');",
 "FRONTEND_TITLE")
s=once(s,
 """           var mp=Number(currentPending.modelProbability),qc=Number(currentPending.quoteChance),ed=Number(currentPending.edge),me=Number(currentPending.minEdge);
           text('pendingMeta','模型概率 '+(isFinite(mp)?(mp*100).toFixed(2)+'%':'-')+' · 市场报价 '+(isFinite(qc)?(qc*100).toFixed(2)+'%':'-')+' · Edge '+(isFinite(ed)?(ed*100).toFixed(2)+'%':'-')+' · 最低要求 '+(isFinite(me)?'+'+(me*100).toFixed(2)+'%':'-')+'。未向 Binance 提交订单。');""",
 """           text('pendingMeta',(currentPending.tradeValueReason||'AI未发现值得交易的机会')+'。未向 Binance 提交订单。');""",
 "FRONTEND_REASON")
s=once(s,
 """         }else if(currentPending.blockReason==='MODEL_NOT_CALIBRATED'){
           text('pendingTitle','已跳过本轮：模型尚未完成概率校准');
           text('pendingMeta','当前校准样本 '+(currentPending.calibrationSamples==null?'-':currentPending.calibrationSamples)+'，本轮未向 Binance 提交订单。');
         }else{""",
 """         }else{""",
 "REMOVE_UNUSED_FRONTEND_STATISTICAL_LABEL")
s=once(s,
 "           text('pendingTitle','已跳过本轮：风控未通过');",
 "           text('pendingTitle','DeepSeek 交易决策暂不可核验');",
 "FRONTEND_UNVERIFIED")
assert 'decideLiveTradeValue' not in s and "if (EV_FILTER_ENABLED)" not in s
assert "deepseek_live_trade_value" not in s
assert s.count("deepseek_direct_trade_choice")==1
assert s.count("trade/get-quote")<3  # unchanged existing signed quote call
new_wrapper.write_text(s)
print('DIRECT_DEEPSEEK_ONLY_REAL_TRADE_DECISION_PATCH_READY=true')
