// V7 second-stage filter used for signal-only EVENT10 production. No order APIs.
// Historical safetyGate is an audit tool only; no cold-start deadlock.
export const REVIEW_VERSION="EVENT10_REVERSAL_GUARD_V7_20261103";
export const SAMPLE_BREAKEVEN=5/9; // illustrative 4 USDT gain vs 5 USDT loss
const finite=n=>typeof n==="number"&&Number.isFinite(n);
const abstain=(s,tag,reason)=>({strategyVersion:REVIEW_VERSION,sourceVersion:s?.strategyVersion??null,
  signal:"NO_SIGNAL",direction:null,quality:"NO_SIGNAL",reason,eventTag:tag,realOrderPlaced:false});
export function reviewCandidate(s,context){
  if(!["UP","DOWN"].includes(s?.direction)||s?.quality!=="FILTERED_RESEARCH")
    return abstain(s,"BASELINE_WAIT","基础六项条件尚未满足");
  const e=s.evidence||{},c=context||{};
  if(!finite(s.snapshotAt)||s.snapshotAt!==c.decisionAt||
      ![e.rsi14,e.volumeRatio,e.change3mPct,c.rangePosition20m,
         c.net15mPct,c.oppositeWickRatio].every(finite))
    return abstain(s,"INVALID_FROZEN_CONTEXT","缺少同一时刻有效的多周期数据");
  // Strong prior momentum is not proof of the next 600s. Prefer WAIT around exhaustion.
  if((s.direction==="DOWN"&&e.rsi14<38)||(s.direction==="UP"&&e.rsi14>62))
    return abstain(s,"RSI_EXHAUSTION","RSI进入易反转区，拒绝在末端追空或追多");
  if(e.volumeRatio>1.8||Math.abs(e.change3mPct)>0.12)
    return abstain(s,"IMPULSE_EXHAUSTION","异常放量或短时涨跌过猛，防止追单");
  if(c.oppositeWickRatio>=0.35)
    return abstain(s,"REJECTION_WICK","出现反向拒绝影线，可能发生反转");
  if(c.rangePosition20m<0||c.rangePosition20m>1||
     (s.direction==="DOWN"&&c.rangePosition20m<0.25)||
     (s.direction==="UP"&&c.rangePosition20m>0.75))
    return abstain(s,"RANGE_EDGE","价格接近过去20分钟区间极端，反转风险高");
  if((s.direction==="DOWN"&&c.net15mPct>=-0.05)||
     (s.direction==="UP"&&c.net15mPct<=0.05))
    return abstain(s,"NO_LONGER_TREND","15分钟背景走势不支持持续趋势");
  return {strategyVersion:REVIEW_VERSION,sourceVersion:s.strategyVersion,
     direction:s.direction,signal:s.direction,quality:"RESEARCH_CANDIDATE",
     reason:"通过反转风险评估，但尚无经验证交易优势",eventTag:"V7_RESEARCH_CANDIDATE",
     realOrderPlaced:false};
}
export function safetyGate(history,{minSettled=8,breakEven=SAMPLE_BREAKEVEN}={}){
  if(!Array.isArray(history))return {allow:false,reason:"HISTORY_UNAVAILABLE"};
  const rows=history.filter(x=>["UP","DOWN"].includes(x?.direction)&&
    typeof x.proxyHit==="boolean").slice(0,10);
  const n=rows.length,won=rows.filter(x=>x.proxyHit===true).length;
  if(n<minSettled)return {allow:false,reason:"INSUFFICIENT_SAMPLES",n,won};
  const rate=won/n;
  return {allow:rate>breakEven,reason:rate>breakEven?
    "RATE_ABOVE_COST_THRESHOLD_NOT_VALIDATED":"RECENT_RESULTS_BELOW_COST_THRESHOLD",n,won,rate,breakEven};
}
export function reviewedResearchSignal(s,context,history){
  const g=safetyGate(history);
  if(!g.allow)return abstain(s,"RESEARCH_SAFETY_STOP",
    "最新已结算历史不满足研究阶段的盈亏平衡门槛，停止给出方向");
  return reviewCandidate(s,context);
}
