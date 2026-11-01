// BTC 10-minute event contract research signal: no order execution.
export const RULE_VERSION="EVENT10_FORCED_CONTRARIAN_12M_V1_20261101";
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
export const AUTO_SLOT_MS=720000;
const positive=n=>typeof n==="number"&&Number.isFinite(n)&&n>0;
export function parseBinanceIndexQuote(raw,receivedAt){
  const price=Number(raw?.indexPrice),at=Number(raw?.time);
  if(raw?.symbol!=="BTCUSDT"||!positive(price)||!Number.isSafeInteger(at)||
     at>receivedAt+1000||receivedAt-at>5000)throw Error("INDEX_QUOTE_STALE_OR_INVALID");
  return {price,observedAt:at,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"};
}
export function verifiedThreeMinuteCloses(feed,asOf){
  if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=="BTCUSDT"||
     feed?.latest?.marketFeedConnected===false)throw Error("UNVERIFIED_BTCUSDT_FEED");
  const b=feed?.candles?.["1m"];
  const input=Array.isArray(b)?b:(b?.rows||b?.items||b?.candles);
  if(!Array.isArray(input))throw Error("MISSING_1M_CANDLES");
  const rows=input.filter(x=>{
    const t=Number(x?.startMs??x?.openTime);
    return x?.closed===true&&Number.isSafeInteger(t)&&t>0&&
      t+60000<=asOf&&positive(Number(x?.close));
  }).map(x=>({at:Number(x.startMs??x.openTime),close:Number(x.close)}))
    .sort((a,b)=>a.at-b.at);
  if(rows.length<4)throw Error("INSUFFICIENT_FOUR_CLOSED_1M_CANDLES");
  const four=rows.slice(-4);
  for(let i=1;i<4;i++)if(four[i].at-four[i-1].at!==60000)
    throw Error("NONCONTIGUOUS_1M_CANDLES");
  if(asOf-(four[3].at+60000)>90000)throw Error("STALE_1M_CANDLES");
  return four;
}
export function evaluatePureSignal({feed,reference,indexSnapshot,cycleMs=AUTO_SLOT_MS}={}){
  const at=reference?.observedAt;
  if(!Number.isSafeInteger(at)||!indexSnapshot||!positive(indexSnapshot.price)||
     !Number.isSafeInteger(indexSnapshot.observedAt)||
     indexSnapshot.observedAt>at||at-indexSnapshot.observedAt>5000)
    throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
  const four=verifiedThreeMinuteCloses(feed,at),first=four[0],last=four[3];
  const change3mPct=(last.close/first.close-1)*100;
  const flat=Math.abs(change3mPct)<0.05; // equality is NOT flat
  const direction=flat?"UP":change3mPct>=0.05?"DOWN":"UP";
  const eventTag=flat?"FLAT_FORCE_UP":
    direction==="DOWN"?"THREE_MIN_UP_REVERSE_DOWN":"THREE_MIN_DOWN_REVERSE_UP";
  const reason=flat?"3分钟波动小于0.05%，按机械规则强制Higher。":
    direction==="DOWN"?"3分钟上涨达到0.05%，反向输出Lower。":
      "3分钟下跌达到0.05%，反向输出Higher。";
  return {strategyVersion:RULE_VERSION,direction,signal:direction,status:"PREDICTED",
    eventTag,change3mPct,reason,confidence:null,
    snapshotAt:at,cycleStartAt:Math.floor(at/cycleMs)*cycleMs,
    optionalFilters:{volumeSpike:false,rsiReverse:false,breakoutReverse:false},
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{change3mPct,firstClosed1mAt:first.at,lastClosed1mAt:last.at,
      firstClose:first.close,lastClose:last.close,closedBars:4,
      candleSource:"VERIFIED_CLOSED_BTCUSDT_SPOT_1M",
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
  return {source:"BINANCE_USDM_INDEX_SPOT_CLOSED_1M_PROXY_NOT_OFFICIAL",
    available:features.indexQuote?1:0,total:1,features,availability,
    caveats:["仅BTCUSDT，四根已收盘1分钟K线计算完整3分钟净涨跌；三个可选过滤器默认全部关闭。",
      "数据异常不生成有效方向；本服务是研究信号，绝不执行真实订单。",
      "锁定指数价与600秒到期指数价不是币安事件合约官方Strike或结算。"]};
}
