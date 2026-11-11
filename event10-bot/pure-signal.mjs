// V20: signal-only entry-quality research. Never places an order; never uses future candles.
// Reuses unchanged V19 candidate gates. A one-minute/5-minute disagreement is not auto-flipped.
import {evaluatePureSignal as evaluateV19, collectRuleFeatures as collectV19Features,
  verifiedClosedCandles,parseBinanceIndexQuote} from "./pure-signal-v19.mjs";
export const RULE_VERSION="EVENT10_ENTRY_POSITION_V20_20261111";
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
export const AUTO_SLOT_MS=60000;
export {verifiedClosedCandles,parseBinanceIndexQuote};
const round=(n,p=4)=>Number(n.toFixed(p));
const eligible=(x)=>Number.isFinite(x)&&x>0;
export function evaluatePureSignal(args={}){
  const base=evaluateV19(args),at=args.reference?.observedAt;
  const rawDirection=base.evidence?.originalEligibleDirection||base.direction;
  const metrics={entryModel:"V20_ENTRY_POSITION_SPOT_PROXY",candidateDirection:rawDirection,
    ema5Direction:base.evidence?.ema5Direction,positionSource:"LIVE_SPOT_TICK_AND_VERIFIED_CLOSED_SPOT_1M",
    indexLockSource:"BINANCE_USDM_INDEX_QUOTE",entryReady:false,waitForEntryImprovement:true};
  const reject=(tag,why)=>({...base,strategyVersion:RULE_VERSION,direction:null,signal:"NO_SIGNAL",
    status:"NO_SIGNAL",quality:"NO_SIGNAL",eventTag:tag,reason:why,conditions:null,
    evidence:{...base.evidence,...metrics}});
  if(!base.direction||!rawDirection)return reject("V20_NO_V19_CANDIDATE","V19趋势/动量未形成有效候选，本次不发布。");
  if(rawDirection!==metrics.ema5Direction)return reject("V20_TREND_CONFLICT",
    "1分钟候选方向与5分钟EMA不同；V20不强制反转方向，等待一致。");
  const one=verifiedClosedCandles(args.feed,"1m",at,60);
  const tick=Number(args.feed?.latest?.lastPrice),tickAt=Number(args.feed?.latest?.eventMs);
  if(!eligible(tick)||!Number.isSafeInteger(tickAt)||tickAt>at+1000||
      at-tickAt>6000)return reject("V20_LIVE_SPOT_TICK_UNAVAILABLE",
    "缺少六秒内的现货实时成交价，无法判断实际入场点位。");
  const last20=one.slice(-20),high=Math.max(...last20.map(c=>c.h));
  const low=Math.min(...last20.map(c=>c.l)),width=high-low;
  if(!eligible(width))return reject("V20_FLAT_PRICE_RANGE","近20分钟无可核验价格区间。");
  const position=(tick-low)/width,rangePct=width/tick*100;
  const momentum=Math.abs(base.change3mPct),volume=base.evidence?.volumeRatio;
  Object.assign(metrics,{positionPct:round(position*100,2),range20mPct:round(rangePct,4),
    range20mHigh:round(high,4),range20mLow:round(low,4),spotAt:tickAt,
    spotPrice:tick,signalIndexPrice:args.indexSnapshot?.price,
    momentum3mAbsPct:round(momentum,5),volumeRatio:volume,
    positionIsSpotProxyNotOfficialEventStrike:true});
  const fail=(tag,why)=>reject(tag,why);
  if(rangePct<0.08||rangePct>1.5)return fail("V20_RANGE_UNSUITABLE",
    "近20分钟区间波幅过小或过大，本轮不发布。");
  if(position<0||position>1)return fail("V20_BREAKOUT_SEPARATE_RESEARCH",
    "当前价已突破近20分钟区间；突破行情需单独研究，不追价。");
  if(momentum<0.05||momentum>0.22)return fail("V20_MOMENTUM_UNSUITABLE",
    "最近3分钟趋势过弱或过热，本轮不发布。");
  if(!Number.isFinite(volume)||volume<0.8||volume>3.0)return fail("V20_VOLUME_UNSUITABLE",
    "量能证据不足或异常，本轮不发布。");
  if(rawDirection==="UP"&&(position<0.30||position>0.75))
    return fail("V20_UP_ENTRY_POSITION","看涨锁定点位不在预设的30%—75%区间。");
  if(rawDirection==="DOWN"&&(position<0.25||position>0.70))
    return fail("V20_DOWN_ENTRY_POSITION","看跌锁定点位不在预设的25%—70%区间。");
  metrics.entryReady=true;
  return {...base,strategyVersion:RULE_VERSION,direction:rawDirection,signal:rawDirection,
    status:"PREDICTED",quality:base.quality,eventTag:"V20_ENTRY_CANDIDATE_"+rawDirection,
    reason:"V20：趋势一致、动量及量能达标、入场区间合理；仍需观察候选点位再锁定指数价。",
    evidence:{...base.evidence,...metrics}};
}
export async function collectRuleFeatures(args={}){
  const data=await collectV19Features(args);
  return {...data,caveats:[
    "V20保留V19候选规则，增加实时现货位置与动量过滤及入场改善观察；仅输出研究信号。",
    "现货位置只是指数入场点位的代理；模拟指数锁定价并非官方事件合约开仓价。",
    "未作样本外验证，胜率改善未证实；无AI，无自动下单。"]};
}
