// V22 EVENT10: six-timeframe trend + live BTC index evidence; no orders or LLM.
// 2m and 10m are time-aligned aggregates of verified closed 1m spot candles.
import {parseBinanceIndexQuote,collectRuleFeatures as getIndexQuote} from "./pure-signal-v19.mjs";
import {analyzeMultiTimeframes} from "./multi-timeframe-trend.mjs";
export const RULE_VERSION="EVENT10_MULTI_TF_SUPERTREND_V22_20261112";
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
    eventTag:direction?"V22_MULTITF_"+direction:"V22_NO_DIRECTION",
    reason:direction?summary+"；多空综合评分="+analysis.trendScore+
      "，输出"+(direction==="UP"?"看涨":"看跌")+"；600秒后独立核验。":
      summary+"；分数完全持平，无法确定方向。",
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
   "V22每12秒检查最新BTC指数报价与1/2/5/10/15/30分钟K线；滚动10分钟最多3条。",
   "Supertrend(10,3)、EMA、MACD、RSI、量能参与多空加权，不以任意单项指标硬性拦截。",
   "2/10分钟K线只由闭合的1分钟真实K线按对齐时间聚合；缺失的高周期明确标记，不补造。",
   "加权分数不等于经过验证的胜率；高频信号可能相关且连续失误。",
   "纯信号研究，无自动下单；公开指数代理非事件合约实际开仓价或结算。"]};
}
