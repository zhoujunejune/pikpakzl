// BTC ten-minute V11: strict + standard research tiers, separate scorecards, no trade API.
// Feed provides 62 closed 1m candles in production; require 60 contiguous candles, never 65.
// V8 uses the existing six-gate filter without V7 secondary veto.
// Signals require aligned 1m/5m trend, moderate momentum, candle structure, volume AND RSI.
export const RULE_VERSION="EVENT10_TIERED_V11_20261105";
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
  const one=verifiedClosedCandles(feed,"1m",at,60);
  const five=verifiedClosedCandles(feed,"5m",at,40);
  const p1=one.map(x=>x.c),p5=five.map(x=>x.c);
  const last=one.at(-1);
  const ema1Fast=ema(p1,9),ema1Slow=ema(p1,21);
  const ema5Fast=ema(p5,9),ema5Slow=ema(p5,21);
  const prev5Fast=ema(p5.slice(0,-3),9);
  const rsi14=rsi(p1);
  const rsiEarlier=rsi(p1.slice(0,-3));
  const rsiRise3=round(rsi14-rsiEarlier,2);
  const change3mPct=(last.c/p1.at(-4)-1)*100;
  const change15mPct=(last.c/p1.at(-16)-1)*100;
  const volumeBase=one.slice(-21,-1).reduce((sum,x)=>sum+x.v,0)/20;
  const volumeRatio=volumeBase>0?last.v/volumeBase:0;
  const bullish=one.slice(-3).filter(x=>x.c>x.o).length;
  const bearish=one.slice(-3).filter(x=>x.c<x.o).length;
  const lastRange=Math.max(0.000001,last.h-last.l);
  const lastClosePosition=(last.c-last.l)/lastRange;
  const downBounceRisk=(change3mPct<=-0.10&&volumeRatio<1.0)||
    rsiRise3>3.5||(lastClosePosition>0.72&&last.c<last.o);
  // Keep large impulse moves out: chasing a 10m contract after a spike is hazardous.
  const upChecks={
    trend5m:ema5Fast>ema5Slow&&ema5Fast>prev5Fast,
    trend1m:ema1Fast>ema1Slow&&last.c>ema1Fast,
    momentum:change3mPct>=0.030&&change3mPct<=0.18,
    structure:bullish>=2&&last.c>last.o,
    volume:volumeRatio>=0.80&&volumeRatio<=2.50,
    rsi:rsi14>=45&&rsi14<63
  };
  const downChecks={
    trend5m:ema5Fast<ema5Slow&&ema5Fast<prev5Fast,
    trend1m:ema1Fast<ema1Slow&&last.c<ema1Fast,
    momentum:change3mPct<=-0.030&&change3mPct>=-0.18,
    structure:bearish>=2&&last.c<last.o,
    volume:volumeRatio>=0.80&&volumeRatio<=2.50,
    rsi:rsi14>=35&&rsi14<=55,
    persistence15m:change15mPct<=-0.05,
    bounceGuard:!downBounceRisk
  };
  // The STRICT tier keeps V10 gates; DOWN also avoids exhaustion rebounds.
  const confirmed=checks=>Object.values(checks).every(Boolean);
  const highUp=confirmed(upChecks),highDown=confirmed(downChecks);
  // STANDARD only loosens modest momentum/volume thresholds, never the
  // multi-timeframe direction, directional close or rebound safeguards.
  const standardUp={
    ...upChecks,momentum:change3mPct>=0.012&&change3mPct<=0.16,
    volume:volumeRatio>=0.60&&volumeRatio<=2.30,
    rsi:rsi14>=43&&rsi14<66
  };
  const standardDown={
    ...downChecks,momentum:change3mPct<=-0.012&&change3mPct>=-0.16,
    volume:volumeRatio>=0.65&&volumeRatio<=2.30,
    rsi:rsi14>=37&&rsi14<=57,
    persistence15m:change15mPct<=-0.025
  };
  let direction=null,quality="NO_SIGNAL",eventTag="FILTERED_NO_EDGE";
  let reason="多周期趋势、动量、形态、成交量、RSI及反弹风险尚未同时满足；不会强制给方向。";
  if(highUp!==highDown&&(highUp||highDown)){
    direction=highUp?"UP":"DOWN";quality="STRICT_RESEARCH";
    eventTag=direction==="UP"?"V11_STRICT_HIGHER":"V11_STRICT_LOWER";
    reason="高标准研究信号：通过V10趋势、动量、量价、RSI全部检查，看跌额外排除反弹风险。";
  }else{
    const normalUp=confirmed(standardUp),normalDown=confirmed(standardDown);
    if(normalUp!==normalDown&&(normalUp||normalDown)){
      direction=normalUp?"UP":"DOWN";quality="STANDARD_RESEARCH";
      eventTag=direction==="UP"?"V11_STANDARD_HIGHER":"V11_STANDARD_LOWER";
      reason="普通研究信号：适度放宽动量、成交量及RSI门槛，仍要求双周期同向、方向K线和反转防护；与高标准独立统计。";
    }
  }
  if(!direction&&downChecks.trend5m&&downChecks.trend1m&&downBounceRisk){
    eventTag="V11_DOWN_REBOUND_RISK";
    reason="短周期偏空，但出现下跌衰竭、长下影或RSI快速回升，避免追空遇反弹。";
  }
  if(!direction&&rsi14>=63&&upChecks.trend5m&&upChecks.trend1m){
    eventTag="V11_UP_RSI_EXHAUSTION";
    reason="上升趋势中RSI达到63以上，避免高位追涨。";
  }
  return {strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",eventTag,reason,quality,confidence:null,
    change3mPct:round(change3mPct),change15mPct:round(change15mPct),snapshotAt:at,
    cycleStartAt:Math.floor(at/cycleMs)*cycleMs,
    conditions:direction?(quality==="STRICT_RESEARCH"?(direction==="UP"?upChecks:downChecks):(direction==="UP"?standardUp:standardDown)):null,
    upChecks,downChecks,standardUpChecks:standardUp,standardDownChecks:standardDown,
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{change3mPct:round(change3mPct),change15mPct:round(change15mPct),volumeRatio:round(volumeRatio,3),rsiRise3,downBounceRisk,lastClosePosition:round(lastClosePosition,3),
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
    caveats:["V11信号：高标准与普通信号独立分级，每分钟扫描；有效信号至少相隔2分钟，每条独立观察10分钟；不保证命中率。",
      "数据异常不出方向，本服务只产生研究信号，不执行真实订单。",
      "锁定指数代理价与10分钟后代理价并非币安事件合约官方开仓Strike或结算。"]};
}
