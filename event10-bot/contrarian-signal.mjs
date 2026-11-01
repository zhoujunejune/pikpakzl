// Excel: 事件合约_强制反动量低胜率高频策略.xlsx. Research-only BTC signals.
// Mandatory: every 12 minutes reverse the change in last 3 closed 1m closes;
// |3m change|<0.05% forces UP. Volume/RSI/breakout filters optional and OFF.
export const RULE_VERSION="EVENT10_FORCED_CONTRARIAN_12M_V1_20261101";
const positive=v=>typeof v==="number"&&Number.isFinite(v)&&v>0;
export function parseBinanceIndexQuote(raw,receivedAt){
 const price=Number(raw?.indexPrice),at=Number(raw?.time);
 if(raw?.symbol!=="BTCUSDT"||!positive(price)||!Number.isSafeInteger(at)||
    at>receivedAt+1000||receivedAt-at>5000)throw Error("INDEX_QUOTE_STALE_OR_INVALID");
 return {price,observedAt:at,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"};
}
function fourClosed(feed,at){
 const block=feed?.candles?.["1m"];
 const rows=Array.isArray(block)?block:(block?.rows||block?.items||block?.candles);
 if(!Array.isArray(rows))throw Error("MISSING_1M_CANDLES");
 const bars=rows.filter(r=>{
  const t=Number(r?.startMs??r?.openTime),o=Number(r?.open),c=Number(r?.close),
    h=Number(r?.high),l=Number(r?.low);
  return r?.closed===true&&Number.isSafeInteger(t)&&t>0&&t+60000<=at&&
    positive(o)&&positive(c)&&positive(h)&&positive(l)&&h>=Math.max(o,c)&&l<=Math.min(o,c);
 }).map(r=>({t:Number(r.startMs??r.openTime),c:Number(r.close)}))
  .sort((a,b)=>a.t-b.t).slice(-4);
 if(bars.length!==4||bars.some((b,i)=>i>0&&b.t-bars[i-1].t!==60000))
  throw Error("THREE_MINUTE_CLOSED_PRICES_REQUIRED");
 if(at-(bars[3].t+60000)>70000)throw Error("STALE_1m_CANDLES");
 return bars;
}
export function evaluatePureSignal({feed,reference,indexSnapshot=null}={}){
 const at=reference?.observedAt;
 if(!Number.isSafeInteger(at)||!indexSnapshot||!positive(indexSnapshot.price)||
    !Number.isSafeInteger(indexSnapshot.observedAt)||
    indexSnapshot.observedAt>at||at-indexSnapshot.observedAt>5000)
  throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
 if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=="BTCUSDT"||
    feed?.latest?.marketFeedConnected===false)
  throw Error("UNVERIFIED_BTCUSDT_SPOT_FEED");
 const spot=Number(feed?.latest?.lastPrice),spotAt=Number(feed?.latest?.eventMs);
 if(!positive(spot)||!Number.isSafeInteger(spotAt)||spotAt>at||at-spotAt>6000)
  throw Error("STALE_BTCUSDT_SPOT_REFERENCE");
 const bars=fourClosed(feed,at),before=bars[0].c,after=bars[3].c;
 const movementPct=(after/before-1)*100,flat=Math.abs(movementPct)<0.05;
 const direction=flat?"UP":movementPct>0?"DOWN":"UP";
 const momentumRule=flat?"FLAT_FORCE_UP":
  movementPct>0?"THREE_MIN_UP_REVERSE_DOWN":"THREE_MIN_DOWN_REVERSE_UP";
 const reason=(direction==="UP"?"看涨 Higher":"看跌 Lower")+
  "：反动量研究策略；最近3分钟已收盘价格由 "+before.toFixed(5)+" 至 "+
  after.toFixed(5)+"，涨跌 "+(movementPct>0?"+":"")+movementPct.toFixed(5)+"%。"+
  (flat?"绝对波动低于0.05%，按表格强制看涨。":"按表格对三分钟动量取反。")+
  "锁定币安USD-M指数参考价，600秒后代理核验；不执行真实交易。";
 return {strategyVersion:RULE_VERSION,direction,signal:direction,status:"PREDICTED",
  reason,confidence:null,snapshotAt:at,cycleStartAt:Math.floor(at/720000)*720000,
  conditions:{threeMinuteClosesVerified:true,contrarianRuleApplied:true},
  upChecks:null,downChecks:null,
  referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
  evidence:{liveIndexPrice:indexSnapshot.price,spotPrice:spot,
   previous3MinuteClose:before,currentClosed1mPrice:after,
   threeMinuteChangePct:movementPct,threeMinuteRule:momentumRule,
   flatThresholdPct:0.05,lastClosed1mAt:bars[3].t,
   optionalVolumeFilterEnabled:false,optionalRsiFilterEnabled:false,
   optionalBreakoutFilterEnabled:false,
   referenceSource:"BINANCE_USDM_REALTIME_INDEX_TPLUS600_PROXY",
   candleSource:"VERIFIED_CLOSED_BTCUSDT_SPOT_1M",
   referenceIsActualEventContractStrike:false,researchOnly:true,noRealOrders:true}};
}
export async function collectRuleFeatures({fetcher=fetch,now=Date.now,timeoutMs=3000}={}){
 const availability={},features={};
 try{
  const r=await fetcher("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
   {headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw Error("HTTP_"+r.status);
  const receivedAt=now(),quote=parseBinanceIndexQuote(await r.json(),receivedAt);
  features.indexQuote={...quote,receivedAt};
  availability.indexQuote={available:true,receivedAt};
 }catch(e){availability.indexQuote={available:false,error:String(e?.message||e).slice(0,115)};}
 return {source:"BINANCE_USDM_INDEX_AND_VERIFIED_SPOT_1M_CLOSES",
  available:Object.keys(features).length,total:1,features,availability,
  caveats:["每12分钟强制反动量研究信号：净涨做跌、净跌做涨、波动小于0.05%做涨。",
   "成交量、RSI与突破均属表格可选过滤，本版未启用。",
   "10%~20%胜率仅为表格目标，不代表可保证的实际胜率。",
   "指数参考价不等于官方事件合约Strike和实际结算；没有任何真实下单。"]};
}
