// BTC ten-minute V7: live signal-only, no exchange orders or guaranteed accuracy.
import {reviewCandidate} from "./v7-reversal-review.mjs";
// Signals require aligned 1m/5m trend, moderate momentum, candle structure, volume AND RSI.
export const RULE_VERSION="EVENT10_REVERSAL_GUARD_V7_20261103";
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
export const AUTO_SLOT_MS=60000;
const positive=n=>typeof n==="number"&&Number.isFinite(n)&&n>0;
const round=(x,n=5)=>Number(x.toFixed(n));
export function parseBinanceIndexQuote(raw,receivedAt){
  const price=Number(raw?.indexPrice),at=Number(raw?.time);
  if(raw?.symbol!=="BTCUSDT"||!positive(price)||!Number.isSafeInteger(at)||
    at>receivedAt+1000||receivedAt-at>5000)throw Error("INDEX_QUOTE_STALE_OR_INVALID");
  return {price,observedAt:at,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"};
}
export function verifiedClosedCandles(feed,interval,asOf,count){
  if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=="BTCUSDT"||
    feed?.latest?.marketFeedConnected===false)throw Error("UNVERIFIED_BTCUSDT_FEED");
  const block=feed?.candles?.[interval];
  const input=Array.isArray(block)?block:(block?.rows||block?.items||block?.candles);
  if(!Array.isArray(input))throw Error("MISSING_"+interval+"_CANDLES");
  const ms=interval==="1m"?60000:300000;
  const rows=input.filter(v=>{
    const t=Number(v?.startMs??v?.openTime);
    return v?.closed===true&&Number.isSafeInteger(t)&&t>0&&t+ms<=asOf&&
      positive(Number(v?.open))&&positive(Number(v?.close))&&
      positive(Number(v?.high))&&positive(Number(v?.low))&&
      Number.isFinite(Number(v?.volume))&&Number(v.volume)>=0&&
      Number(v.high)>=Math.max(Number(v.open),Number(v.close))&&
      Number(v.low)<=Math.min(Number(v.open),Number(v.close));
  }).map(v=>({at:Number(v.startMs??v.openTime),o:Number(v.open),c:Number(v.close),
    h:Number(v.high),l:Number(v.low),v:Number(v.volume)}))
    .sort((a,b)=>a.at-b.at);
  if(rows.length<count)throw Error("INSUFFICIENT_"+interval+"_CLOSED_CANDLES");
  const out=rows.slice(-count);
  for(let i=1;i<out.length;i++)if(out[i].at-out[i-1].at!==ms)
    throw Error("NONCONTIGUOUS_"+interval+"_CANDLES");
  // Reject the preceding bar once a newer completed interval is expected.
  // Previously, 1m bars lagging 60s and 5m bars lagging 5m still passed.
  const expectedLastClose=Math.floor(asOf/ms)*ms;
  if(out.at(-1).at+ms<expectedLastClose)
    throw Error("STALE_"+interval+"_LAST_CLOSED_CANDLE");
  if(asOf-(out.at(-1).at+ms)>(interval==="1m"?60000:300000))
    throw Error("STALE_"+interval+"_CANDLES");
  return out;
}
function ema(prices,n){
  if(prices.length<n)throw Error("INSUFFICIENT_EMA");
  let x=prices.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const alpha=2/(n+1);
  for(const v of prices.slice(n))x+=alpha*(v-x);
  return x;
}
function rsi(prices,n=14){
  const last=prices.slice(-(n+1));
  if(last.length<n+1)throw Error("INSUFFICIENT_RSI");
  let gains=0,losses=0;
  for(let i=1;i<last.length;i++){
    const d=last[i]-last[i-1];
    gains+=Math.max(0,d);losses+=Math.max(0,-d);
  }
  return losses===0?(gains===0?50:100):100-100/(1+gains/losses);
}
export function evaluatePureSignal({feed,reference,indexSnapshot,cycleMs=AUTO_SLOT_MS,trigger='MANUAL'}={}){
  const at=reference?.observedAt;
  if(!Number.isSafeInteger(at)||!indexSnapshot||!positive(indexSnapshot.price)||
    !Number.isSafeInteger(indexSnapshot.observedAt)||
    indexSnapshot.observedAt>at||at-indexSnapshot.observedAt>5000)
    throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
  const one=verifiedClosedCandles(feed,"1m",at,65);
  const five=verifiedClosedCandles(feed,"5m",at,40);
  const p1=one.map(x=>x.c),p5=five.map(x=>x.c);
  const last=one.at(-1);
  const ema1Fast=ema(p1,9),ema1Slow=ema(p1,21);
  const ema5Fast=ema(p5,9),ema5Slow=ema(p5,21);
  const prev5Fast=ema(p5.slice(0,-3),9);
  const rsi14=rsi(p1);
  const change3mPct=(last.c/p1.at(-4)-1)*100;
  const volumeBase=one.slice(-21,-1).reduce((sum,x)=>sum+x.v,0)/20;
  const volumeRatio=volumeBase>0?last.v/volumeBase:0;
  const bullish=one.slice(-3).filter(x=>x.c>x.o).length;
  const bearish=one.slice(-3).filter(x=>x.c<x.o).length;
  // Keep large impulse moves out: chasing a 10m contract after a spike is hazardous.
  const upChecks={
    trend5m:ema5Fast>ema5Slow&&ema5Fast>prev5Fast,
    trend1m:ema1Fast>ema1Slow&&last.c>ema1Fast,
    momentum:change3mPct>=0.035&&change3mPct<=0.18,
    structure:bullish>=2&&last.c>last.o,
    volume:volumeRatio>=0.90&&volumeRatio<=2.50,
    rsi:rsi14>=45&&rsi14<=70
  };
  const downChecks={
    trend5m:ema5Fast<ema5Slow&&ema5Fast<prev5Fast,
    trend1m:ema1Fast<ema1Slow&&last.c<ema1Fast,
    momentum:change3mPct<=-0.035&&change3mPct>=-0.18,
    structure:bearish>=2&&last.c<last.o,
    volume:volumeRatio>=0.90&&volumeRatio<=2.50,
    rsi:rsi14>=30&&rsi14<=55
  };
  // There are no fixed signal quotas. RSI extremes never trigger reversal by themselves.
  // Avoid high-volume capitulation and momentum spikes; 10m de-dup happens in engine.
  // All six conditions are required; avoid late entries after an extended 3m impulse.
  const core=checks=>checks.trend5m&&checks.trend1m&&checks.momentum;
  const confirmed=checks=>core(checks)&&checks.structure&&checks.volume&&checks.rsi;
  const passUp=confirmed(upChecks),passDown=confirmed(downChecks);
  let direction=null,quality="NO_SIGNAL",eventTag="FILTERED_NO_EDGE";
  let reason="本分钟未通过数据时效、趋势共振、适度动量、K线结构、正常成交量及RSI的全部要求；不强制猜方向。";
  if(passUp!==passDown){
    direction=passUp?"UP":"DOWN";
    quality="FILTERED_RESEARCH";
    eventTag=direction==="UP"?"CONFIRMED_TREND_HIGHER":"CONFIRMED_TREND_LOWER";
    reason="增强过滤方向：已收盘K线新鲜、趋势共振、适度动量、正常成交量、K线结构与RSI确认；仍可能误判。";
  }
  const baseline={strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",eventTag,reason,quality,confidence:null,
    change3mPct:round(change3mPct),snapshotAt:at,
    cycleStartAt:Math.floor(at/cycleMs)*cycleMs,
    conditions:quality==="FILTERED_RESEARCH"?(direction==="UP"?upChecks:downChecks):null,
    upChecks,downChecks,
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{change3mPct:round(change3mPct),volumeRatio:round(volumeRatio,3),
      rsi14:round(rsi14,2),quality,trigger,ordinary:false,highWindow:true,ema1Fast:round(ema1Fast,3),ema1Slow:round(ema1Slow,3),
      ema5Fast:round(ema5Fast,3),ema5Slow:round(ema5Slow,3),
      bullishLast3:bullish,bearishLast3:bearish,
      firstClosed1mAt:one.at(-4).at,lastClosed1mAt:last.at,
      lastClosed5mAt:five.at(-1).at,closedBars1m:one.length,
      closedBars5m:five.length,
      candleSource:"VERIFIED_CLOSED_BTCUSDT_SPOT_1M_5M",
      liveIndexPrice:indexSnapshot.price,
      referenceSource:indexSnapshot.source||"BINANCE_USDM_BTCUSDT_INDEX_PRICE",
      referenceIsActualEventContractStrike:false}};
  if(!baseline.direction)return baseline;
  const range=one.slice(-21),high20=Math.max(...range.map(x=>x.h)),low20=Math.min(...range.map(x=>x.l));
  const oppositeWick=direction==="DOWN"?Math.min(last.o,last.c)-last.l:
    last.h-Math.max(last.o,last.c);
  const context={decisionAt:at,
    rangePosition20m:high20>low20?(last.c-low20)/(high20-low20):NaN,
    net15mPct:(last.c/one.at(-16).c-1)*100,
    oppositeWickRatio:Math.max(0,oppositeWick/Math.max(last.h-last.l,1e-8))};
  const review=reviewCandidate(baseline,context);
  baseline.evidence.reviewContext={rangePosition20m:round(context.rangePosition20m,3),
    net15mPct:round(context.net15mPct,5),oppositeWickRatio:round(context.oppositeWickRatio,3)};
  baseline.evidence.reviewTag=review.eventTag;
  if(!review.direction)return {...baseline,direction:null,signal:"NO_SIGNAL",
    status:"NO_SIGNAL",quality:"NO_SIGNAL",conditions:null,
    reason:review.reason,eventTag:review.eventTag};
  return {...baseline,quality:"FILTERED_RESEARCH",eventTag:"V7_REVERSAL_GUARD_CONFIRMED",
    reason:"趋势与反转风险过滤通过；仅供观察十分钟方向，不保证命中。"};
}
export async function collectRuleFeatures({fetcher=fetch,now=Date.now,timeoutMs=3000}={}){
  const features={},availability={};
  try{
    const r=await fetcher("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
      {headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
    if(!r.ok)throw Error("INDEX_QUOTE_HTTP_"+r.status);
    const receivedAt=now();
    features.indexQuote={...parseBinanceIndexQuote(await r.json(),receivedAt),receivedAt};
    availability.indexQuote={available:true,receivedAt};
  }catch(e){availability.indexQuote={available:false,error:String(e?.message||e).slice(0,110)};}
  return {source:"BINANCE_USDM_INDEX_SPOT_CLOSED_1M_5M_PROXY_NOT_OFFICIAL",
    available:features.indexQuote?1:0,total:1,features,availability,
    caveats:["V7信号：每分钟扫描新鲜已收盘K线，额外过滤RSI衰竭、异常成交量、20分钟区间、反向影线和15分钟背景冲突；不保证频率或胜率。",
      "数据异常不出方向，本服务只产生研究信号，不执行真实订单。",
      "锁定指数代理价与10分钟后代理价并非币安事件合约官方开仓Strike或结算。"]};
}
