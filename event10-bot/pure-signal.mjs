// V16: same V15 eligibility and frequency; correct direction to 5m EMA9/21. No trade API.
export const RULE_VERSION="EVENT10_EMA5_DIRECTION_V16_20261106";
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
  // Quality-and-usability compromise: no forced sign on conflicting 1m / 3m
  // momentum. 1m EMA9/21 is mandatory, 5m trend is informational for STANDARD.
  // The engine (not this pure rule) caps accepted directions at 1 per 10m.
  const change1mPct=(last.c/p1.at(-2)-1)*100;
  const standardUp={
    trend5m:ema5Fast>ema5Slow, // advisory, not a veto
    trend1m:ema1Fast>ema1Slow,
    momentum:change3mPct>=0.020&&change3mPct<=0.22,
    structure:change1mPct>0&&last.c>last.o,
    volume:volumeRatio>=0.40&&volumeRatio<=3.0,
    rsi:rsi14>=32&&rsi14<=70
  };
  const standardDown={
    trend5m:ema5Fast<ema5Slow, // advisory, not a veto
    trend1m:ema1Fast<ema1Slow,
    momentum:change3mPct<=-0.020&&change3mPct>=-0.22,
    structure:change1mPct<0&&last.c<last.o,
    volume:volumeRatio>=0.40&&volumeRatio<=3.0,
    rsi:rsi14>=30&&rsi14<=68,
    bounceGuard:!downBounceRisk
  };
  const standardReady=checks=>Object.entries(checks)
    .filter(([name])=>name!=="trend5m").every(([,ok])=>ok);
  let direction=null,quality="NO_SIGNAL",eventTag="V16_CONFLICT_OR_LOW_MOMENTUM";
  let reason="1分钟、3分钟动量、EMA或量价不一致，本轮无可操作信号。";
  if(highUp!==highDown&&(highUp||highDown)){
    direction=highUp?"UP":"DOWN";quality="STRICT_RESEARCH";
    eventTag=direction==="UP"?"V16_STRICT_HIGHER":"V16_STRICT_LOWER";
    reason="高标准多周期趋势与动量一致；10分钟独立观察。";
  }else {
    const up=standardReady(standardUp),down=standardReady(standardDown);
    if(up!==down&&(up||down)){
      direction=up?"UP":"DOWN";quality="STANDARD_RESEARCH";
      eventTag=direction==="UP"?"V16_STANDARD_HIGHER":"V16_STANDARD_LOWER";
      reason="1分钟与3分钟动量同向，EMA9/21确认，成交量与RSI不过度偏离；10分钟内最多一条新信号。";
    }
  }
  // Evidence from 30 previously settled V15 signal timestamps: 5m EMA
  // direction correction changed 8 directions and improved proxy hits 15->19.
  // This is only historical evidence, NOT a guaranteed live accuracy lift.
  // Never add/remove a qualifying signal: correct the sign only.
  const eligibleDirection=direction;
  const ema5Direction=ema5Fast>ema5Slow?"UP":ema5Fast<ema5Slow?"DOWN":null;
  const directionCorrected=!!(eligibleDirection&&ema5Direction&&eligibleDirection!==ema5Direction);
  if(directionCorrected){
    direction=ema5Direction;
    eventTag=direction==="UP"?"V16_EMA5_CORRECTED_HIGHER":"V16_EMA5_CORRECTED_LOWER";
    reason="方向校正：原V15条件已触发信号，5分钟EMA9/21方向相反，按5分钟趋势改为"+(direction==="UP"?"看涨":"看跌")+"。保留原有触发时间和10分钟限频。";
  }else if(direction){
    eventTag=direction==="UP"?"V16_EMA5_CONFIRMED_HIGHER":"V16_EMA5_CONFIRMED_LOWER";
    reason="方向确认：V15触发条件与5分钟EMA9/21同向；保持原有10分钟节奏。";
  }
  return {strategyVersion:RULE_VERSION,direction,signal:direction||"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",eventTag,reason,quality,confidence:null,
    change3mPct:round(change3mPct),change1mPct:round(change1mPct),change15mPct:round(change15mPct),snapshotAt:at,
    cycleStartAt:Math.floor(at/cycleMs)*cycleMs,
    conditions:eligibleDirection?(quality==="STRICT_RESEARCH"?(eligibleDirection==="UP"?upChecks:downChecks):(eligibleDirection==="UP"?standardUp:standardDown)):null,
    upChecks,downChecks,standardUpChecks:standardUp,standardDownChecks:standardDown,
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{originalEligibleDirection:eligibleDirection,ema5Direction,directionCorrected,change1mPct:round(change1mPct),change3mPct:round(change3mPct),change15mPct:round(change15mPct),volumeRatio:round(volumeRatio,3),rsiRise3,downBounceRisk,lastClosePosition:round(lastClosePosition,3),
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
    caveats:["V16沿用V15的信号触发与10分钟间隔，仅按5分钟EMA趋势修正方向；最多约6条/小时。",
      "数据异常、动量冲突或全平盘不出方向；保留连续失误暂停。5分钟EMA方向校正仍可能误判，不执行真实订单。",
      "锁定指数代理价与10分钟后代理价并非币安事件合约官方开仓Strike或结算。"]};
}
