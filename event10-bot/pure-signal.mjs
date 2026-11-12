// V23 EVENT10: normalized six-timeframe trend + fresh index, with reversal veto; no orders or AI.
// 2m and 10m are time-aligned aggregates of verified closed 1m spot candles.
import {parseBinanceIndexQuote,collectRuleFeatures as getIndexQuote} from "./pure-signal-v19.mjs";
import {analyzeMultiTimeframes} from "./multi-timeframe-trend.mjs";
export const RULE_VERSION="EVENT10_REVERSAL_AWARE_10M_V23_20261113";
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
export const AUTO_SLOT_MS=12_000;
export {parseBinanceIndexQuote};
const round=(x,n=4)=>Number(x.toFixed(n));
export function evaluatePureSignal({feed,reference,indexSnapshot,previousIndexSnapshot,trigger="AUTO"}={}){
 const at=Number(reference?.observedAt),index=Number(indexSnapshot?.price);
 const ts=Number(indexSnapshot?.observedAt);
 if(!Number.isSafeInteger(at)||!Number.isFinite(index)||index<=0||
    !Number.isSafeInteger(ts)||ts>at||at-ts>5000)
   throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
 const analysis=analyzeMultiTimeframes({feed,at,indexPrice:index,
    previousIndexSnapshot,indexAt:ts});
 const direction=analysis.direction;
 const one=analysis.timeframes["1m"],five=analysis.timeframes["5m"];
 const short=analysis.timeframes["2m"],medium=analysis.timeframes["10m"],
   long=analysis.timeframes["15m"],background=analysis.timeframes["30m"];
 const label=v=>v?.trend==="UP"?"多":v?.trend==="DOWN"?"空":"待确认";
 const summary="1/2/5/10/15/30分钟="+[one,short,five,medium,long,background].map(label).join("/")+
    "；Supertrend、EMA、MACD、RSI与量能综合判断，实时指数价="+index.toFixed(2);
 const prev=Number(previousIndexSnapshot?.price);
 const validPrev=Number.isFinite(prev)&&prev>0&&
    Number.isSafeInteger(previousIndexSnapshot?.observedAt)&&
    previousIndexSnapshot.observedAt<ts&&ts-previousIndexSnapshot.observedAt<=30000;
 return {strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",
    quality:direction?"STANDARD_RESEARCH":"NO_SIGNAL",
    eventTag:direction?"V23_10M_"+direction:analysis.decisionReason,
    reason:direction?summary+"；去重后多空评分="+analysis.trendScore+
      "，输出"+(direction==="UP"?"看涨":"看跌")+"；600秒后独立核验。":
      summary+"；"+({V23_EARLY_REVERSAL_UNCONFIRMED:"短周期出现逆向转折，等待进一步确认。",V23_SHORT_TERM_REVERSAL_CONFLICT:"实时走势与短周期方向冲突，暂不追原趋势。",V23_STRONG_LIVE_PRICE_CONFLICT:"当前指数价格逆向波动明显，暂不追原趋势。",V23_SCORE_TOO_WEAK:"多空优势不足，暂不发布。"}[analysis.decisionReason]||"当前未形成可靠方向。"),
    confidence:null,change1mPct:round((index/one.close-1)*100,5),
    change3mPct:round((index/one.close-1)*100,5),
    snapshotAt:at,cycleStartAt:Math.floor(at/AUTO_SLOT_MS)*AUTO_SLOT_MS,
    conditions:null,upChecks:{},downChecks:{},standardUpChecks:{},standardDownChecks:{},
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{trigger,quality:direction?"STANDARD_RESEARCH":"NO_SIGNAL",
      currentIndexPrice:index,currentIndexAt:ts,currentPriceUsedForDirection:true,
      indexAgeMs:at-ts,previousIndexPrice:validPrev?prev:null,
      previousIndexAt:validPrev?previousIndexSnapshot.observedAt:null,
      liveIndexChangeBps:validPrev?round((index/prev-1)*10000,4):null,
      liveIndexDelta:analysis.liveIndexDelta,
      lastClosedSpot1mClose:one.close,lastClosed1mAt:one.lastClosedAt,
      lastClosed5mAt:five.available?five.lastClosedAt:null,
      lastClosedSpot5mClose:five.available?five.close:null,
      comparisonSource:"MULTI_TIMEFRAME_SUPERTREND_EMA_MOMENTUM_PLUS_FRESH_INDEX",
      trendScore:analysis.trendScore,weightedTimeframeScore:analysis.weightedTimeframeScore,
      trendDecisionReason:analysis.decisionReason,normalizedVotes:analysis.normalizedVotes,
      shortTermDirection:analysis.shortTermDirection,longContextDirection:analysis.longContextDirection,
      timeframeWeightCoverage:analysis.timeframeWeightCoverage,
      currentPriceDirection:analysis.currentPriceDirection,
      timeframeCoverage:analysis.timeframeCoverage,timeframeCount:analysis.timeframeCount,
      timeframes:analysis.timeframes,aggregationSource:analysis.aggregationSource,
      confidenceCalibrated:false,
      possibleIndexVsSpotBasis:true,
      referenceSource:indexSnapshot.source||"BINANCE_USDM_BTCUSDT_INDEX_PRICE",
      referenceIsActualEventContractStrike:false,entryReady:true,
      waitForEntryImprovement:false}};
}
export async function collectRuleFeatures(args={}){
 const f=await getIndexQuote(args);
 return {...f,caveats:[
   "V23每12秒检查当前指数价和六周期趋势；滚动10分钟最多3条。",
   "归一化多周期指标，短周期更贴近10分钟预测；实时报价反转时不机械追大周期趋势。",
   "2/10分钟K线只由闭合的1分钟真实K线按对齐时间聚合；缺失的高周期明确标记，不补造。",
   "相同走势不允许12秒内连续复制三次；策略尚未证明比V22有更高的样本外命中率。",
   "纯信号研究，无自动下单；公开指数代理非事件合约实际开仓价或结算。"]};
}
