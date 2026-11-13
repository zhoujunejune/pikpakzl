// V28 EVENT10: double-horizon entry exhaustion, conflict risk and durable post-loss reentry checks; no orders or AI.
// 2m and 10m are time-aligned aggregates of verified closed 1m spot candles.
import {parseBinanceIndexQuote,collectRuleFeatures as getIndexQuote} from "./pure-signal-v19.mjs";
import {analyzeMultiTimeframes} from "./multi-timeframe-trend.mjs";
export const RULE_VERSION="EVENT10_CONFLICT_EDGE_REENTRY_V28_20261113";
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
 const priceAction=analysis.spotPriceAction;
 const entry=analysis.entryTiming, horizons=analysis.entryHorizons;
 const emaTiming=analysis.emaTiming, emaEntry=analysis.emaEntry;
 const one=analysis.timeframes["1m"],five=analysis.timeframes["5m"];
 const short=analysis.timeframes["2m"],medium=analysis.timeframes["10m"],
   long=analysis.timeframes["15m"],background=analysis.timeframes["30m"];
 const label=v=>v?.trend==="UP"?"多":v?.trend==="DOWN"?"空":"待确认";
 const summary="1/2/5/10/15/30分钟="+[one,short,five,medium,long,background].map(label).join("/")+
    "；Supertrend、EMA、MACD、RSI与量能综合判断，实时指数价="+index.toFixed(2)+
    "；远近区间位置(1小时/4小时/24小时)="+
    ["60m","4h","24h"].map(k=>horizons.ranges[k]?.available?
      Math.round(horizons.ranges[k].position*100)+"%":"数据不足").join("/");
 const prev=Number(previousIndexSnapshot?.price);
 const validPrev=Number.isFinite(prev)&&prev>0&&
    Number.isSafeInteger(previousIndexSnapshot?.observedAt)&&
    previousIndexSnapshot.observedAt<ts&&ts-previousIndexSnapshot.observedAt<=30000;
 return {strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",
    quality:direction?"STANDARD_RESEARCH":"NO_SIGNAL",
    eventTag:direction?"V28_10M_"+direction:analysis.decisionReason,
    reason:direction?summary+"；已收盘3分钟变化="+(priceAction.threeMinuteBps/100).toFixed(4)+"%；多空评分="+analysis.trendScore+
      "，输出"+(direction==="UP"?"看涨":"看跌")+"；600秒后独立核验。":
      summary+"；"+({V28_CONFLICTED_MULTITIMEFRAME_ENTRY:"多个时间尺度与当前信号方向冲突，短线尚未确认反转；本次不追单。",V28_DOUBLE_HORIZON_PRICE_EXHAUSTION:"价格同时处于1小时和2小时极端区间，短期上涨或下跌出现疲劳迹象，等待新入场。",V27_EMA_MOMENTUM_DECAY:"EMA9斜率加速度下降且EMA9/21间距收窄，短线动量可能衰竭，暂缓同向信号。",V27_EMA_EARLY_COUNTERMOVE:"短期价格逆向变化且EMA动量转弱，暂停追随旧趋势。",V26_EMA_AGAINST_ENTRY:"1分钟与2分钟EMA9/21逆向且斜率与3分钟价格共同确认，当前不追趋势。",V26_EMA_OVEREXTENDED_ENTRY:"价格偏离EMA9且处于区间极值，等待回踩或回弹后再出信号。",V25_ENTRY_EDGE_REVERSAL_OR_EXHAUSTION:"当前价格接近近期区间高低点且伴随短线反转或过度延伸，等更合适的入场位置。",V24_SPOT_REVERSAL_CONFLICT:"已收盘现货3/5分钟价格连续逆向，暂不追原趋势。",V23_EARLY_REVERSAL_UNCONFIRMED:"短周期出现逆向转折，等待进一步确认。",V23_SHORT_TERM_REVERSAL_CONFLICT:"实时走势与短周期方向冲突，暂不追原趋势。",V23_STRONG_LIVE_PRICE_CONFLICT:"当前指数价格逆向波动明显，暂不追原趋势。",V23_SCORE_TOO_WEAK:"多空优势不足，暂不发布。"}[analysis.decisionReason]||"当前未形成可靠方向。"),
    confidence:null,change1mPct:round(priceAction.oneMinuteBps/100,5),
    change3mPct:round(priceAction.threeMinuteBps/100,5),
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
      spotPriceAction:priceAction,
      entryHorizons:horizons,entryTiming:entry,
      emaEntry,emaTiming,trendConflict:analysis.trendConflict,
      trendDecisionReason:analysis.decisionReason,normalizedVotes:analysis.normalizedVotes,
      shortTermDirection:analysis.shortTermDirection,longContextDirection:analysis.longContextDirection,
      timeframeWeightCoverage:analysis.timeframeWeightCoverage,
      currentPriceDirection:analysis.currentPriceDirection,
      timeframeCoverage:analysis.timeframeCoverage,timeframeCount:analysis.timeframeCount,
      timeframes:analysis.timeframes,aggregationSource:analysis.aggregationSource,
      confidenceCalibrated:false,
      possibleIndexVsSpotBasis:true,
      referenceSource:indexSnapshot.source||"BINANCE_USDM_BTCUSDT_INDEX_PRICE",
      referenceIsActualEventContractStrike:false,
      entryReady:entry.ready&&emaTiming.ready&&analysis.trendConflict.ready,
      waitForEntryImprovement:!(entry.ready&&emaTiming.ready&&analysis.trendConflict.ready)}};
}
export async function collectRuleFeatures(args={}){
 const f=await getIndexQuote(args);
 return {...f,caveats:[
   "V28每12秒扫描：短中长周期趋势冲突需再确认，1小时/2小时极值追涨跌需谨慎，保留EMA加速度及6m至24h位置，每10分钟最多3条。",
   "加强5m/30m逆向风险过滤，并保留经闭合K线确认的早期反转；修正上一条同向已结算失败后2分钟K线的持久化字段读取。",
   "2/10分钟K线只由闭合的1分钟真实K线按对齐时间聚合；缺失的高周期明确标记，不补造。",
   "仍只提供看涨/看跌信号，不自动下单；V28是针对历史失误的规则调整，必须用独立的后续样本检验，不能保证盈利。",
   "纯信号研究，无自动下单；公开指数代理非事件合约实际开仓价或结算。"]};
}
