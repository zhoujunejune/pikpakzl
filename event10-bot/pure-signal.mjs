// V21 EVENT10: 12-second live BTC index direction research, no orders or AI.
// No RSI, EMA, volume, range, or wait-for-better-entry veto. Valid live data is mandatory.
import {verifiedClosedCandles,parseBinanceIndexQuote,collectRuleFeatures as getIndexQuote}
 from "./pure-signal-v19.mjs";
export const RULE_VERSION="EVENT10_LIVE_INDEX_3_PER_10M_V21_20261112";
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
export const AUTO_SLOT_MS=12_000;
export {verifiedClosedCandles,parseBinanceIndexQuote};
const round=(x,n=5)=>Number(x.toFixed(n));
export function evaluatePureSignal({feed,reference,indexSnapshot,previousIndexSnapshot,trigger="AUTO"}={}){
 const at=Number(reference?.observedAt),index=Number(indexSnapshot?.price);
 const ts=Number(indexSnapshot?.observedAt);
 if(!Number.isSafeInteger(at)||!Number.isFinite(index)||index<=0||
    !Number.isSafeInteger(ts)||ts>at||at-ts>5000)
   throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
 // These verified historical bars are evidence, never a strategy filter.
 const one=verifiedClosedCandles(feed,"1m",at,3);
 const last=one.at(-1).c,prior=one.at(-2).c,older=one.at(-3).c;
 const prev=Number(previousIndexSnapshot?.price),prevTs=Number(previousIndexSnapshot?.observedAt);
 const validPrev=Number.isFinite(prev)&&prev>0&&Number.isSafeInteger(prevTs)&&
   prevTs<ts&&ts-prevTs<=30_000;
 const liveChange=validPrev?index-prev:null;
 // Prefer two consecutive actual index quotes; fall back to recent closed
 // spot-candle direction if two index quotes are identical or first startup.
 const delta=validPrev&&liveChange!==0?liveChange:index-last;
 const motion=delta!==0?delta:last!==prior?last-prior:prior-older;
 const direction=motion>0?"UP":motion<0?"DOWN":null;
 return {strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
   status:direction?"PREDICTED":"NO_SIGNAL",quality:direction?"STANDARD_RESEARCH":"NO_SIGNAL",
   eventTag:direction?"V21_LIVE_INDEX_"+direction:"V21_PRICE_FLAT",
   reason:direction?"实时指数价 "+index.toFixed(2)+"，价格变化方向为"+(direction==="UP"?"看涨":"看跌")+
     "；每条信号独立对比600秒后指数价格。":"最新价格和最近收盘价都未变化，不能凭空认定方向。",
   confidence:null,change1mPct:round((index/last-1)*100),
   change3mPct:round((index/older-1)*100),
   snapshotAt:at,cycleStartAt:Math.floor(at/AUTO_SLOT_MS)*AUTO_SLOT_MS,
   conditions:null,upChecks:{},downChecks:{},standardUpChecks:{},standardDownChecks:{},
   referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
   evidence:{trigger,quality:direction?"STANDARD_RESEARCH":"NO_SIGNAL",
     currentIndexPrice:index,currentIndexAt:ts,currentPriceUsedForDirection:true,
     indexAgeMs:at-ts,previousIndexPrice:validPrev?prev:null,
     previousIndexAt:validPrev?prevTs:null,
     liveIndexChangeBps:validPrev?round((index/prev-1)*10000,4):null,
     lastClosedSpot1mClose:last,previousClosedSpot1mClose:prior,
     comparisonSource:validPrev&&liveChange!==0?"PREVIOUS_FRESH_INDEX_QUOTE":"CLOSED_SPOT_1M",
     possibleIndexVsSpotBasis:true,referenceSource:indexSnapshot.source||"BINANCE_USDM_BTCUSDT_INDEX_PRICE",
     referenceIsActualEventContractStrike:false,entryReady:true,waitForEntryImprovement:false}};
}
export async function collectRuleFeatures(args={}){
 const f=await getIndexQuote(args);
 return {...f,caveats:[
  "V21每12秒更新新鲜BTC指数价格；任意滚动10分钟内最多发布3条信号。",
  "没有V19/V20趋势、RSI、成交量、点位或等待改善入场价门槛。",
  "真实指数报价无效则不制造信号；同一时段的多条信号高度相关。",
  "仅研究信号，不自动下单；BTC指数代理价并非官方事件合约成交或结算价。"]};
}
