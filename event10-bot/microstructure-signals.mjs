// EVENT10 V39: OPTIONAL public USD-M market microstructure evidence.
// All calls are read-only. No orders, no keys, no impact on signal eligibility.
// Values are sampled at or before the candidate's publication timestamp.
const BASE="https://fapi.binance.com";
const finite=Number.isFinite;
const round=(x,d=4)=>Number(x.toFixed(d));
const n=x=>Number(x);
const LIMITS=Object.freeze({orderBook:12000,aggressiveFlow:30000,indexKlines:120000});
export const MICRO_FEATURE_NAMES=Object.freeze(["orderBook","aggressiveFlow","indexKlines"]);
const REQUESTS=Object.freeze({
 orderBook:"/fapi/v1/depth?symbol=BTCUSDT&limit=20",
 aggressiveFlow:"/fapi/v1/aggTrades?symbol=BTCUSDT&limit=500",
 indexKlines:"/fapi/v1/indexPriceKlines?pair=BTCUSDT&interval=1m&limit=8"
});
const point=(t,at,maxAge)=>{
 if(!Number.isSafeInteger(t)||t<=0||t>at||at-t>maxAge)
   throw Error("SOURCE_TIME_INVALID_OR_STALE");
 return t;
};
export function parseMicroOrderBook(value,at){
 if(!value||!Array.isArray(value.bids)||!Array.isArray(value.asks)||
    value.bids.length<10||value.asks.length<10)throw Error("DEPTH_TOO_FEW_LEVELS");
 const t=point(Number(value.T??value.E),at,LIMITS.orderBook);
 const parse=rows=>rows.slice(0,20).map(x=>Array.isArray(x)&&x.length>=2?[n(x[0]),n(x[1])]:[NaN,NaN]);
 const bids=parse(value.bids),asks=parse(value.asks);
 if([...bids,...asks].some(([price,qty])=>!finite(price)||price<=0||!finite(qty)||qty<0))
   throw Error("DEPTH_BAD_LEVEL");
 if(bids[0][0]>=asks[0][0])throw Error("DEPTH_CROSSED");
 for(let i=1;i<bids.length;i++)if(bids[i][0]>bids[i-1][0])throw Error("BIDS_UNSORTED");
 for(let i=1;i<asks.length;i++)if(asks[i][0]<asks[i-1][0])throw Error("ASKS_UNSORTED");
 const b=bids.reduce((s,[p,q])=>s+p*q,0),a=asks.reduce((s,[p,q])=>s+p*q,0);
 if(b+a<=0)throw Error("DEPTH_ZERO");
 const imbalance=(b-a)/(b+a);
 return {observedAt:t,imbalanceTop20:round(imbalance),bidNotionalUsd:round(b,2),
  askNotionalUsd:round(a,2),spreadBps:round((asks[0][0]-bids[0][0])*20000/(asks[0][0]+bids[0][0]),3),
  vote:imbalance>=0.17?"UP":imbalance<=-0.17?"DOWN":null,
  source:"BINANCE_USDM_PUBLIC_DEPTH_SNAPSHOT",caveat:"Spoofing/cancellation can make displayed depth misleading."};
}
export function parseMicroAggTrades(values,at){
 if(!Array.isArray(values))throw Error("AGGTRADES_BAD_SHAPE");
 const rows=values.filter(x=>Number.isSafeInteger(x?.T)&&x.T<=at&&
  at-x.T<=20000&&finite(n(x.p))&&n(x.p)>0&&finite(n(x.q))&&n(x.q)>0&&
  typeof x.m==="boolean").sort((a,b)=>a.T-b.T);
 if(rows.length<25)throw Error("AGGTRADES_TOO_FEW");
 const first=rows[0],last=rows.at(-1);
 point(last.T,at,5000);
 if(last.T-first.T<1500)throw Error("AGGTRADES_TOO_NARROW");
 let buy=0,sell=0;
 for(const x of rows){const usd=n(x.p)*n(x.q);if(x.m)sell+=usd;else buy+=usd;}
 const total=buy+sell, fraction=buy/total;
 if(!finite(fraction)||total<=0)throw Error("AGGTRADES_ZERO");
 return {observedAt:last.T,earliestTradeAt:first.T,samples:rows.length,
  takerBuyNotionalUsd:round(buy,2),takerSellNotionalUsd:round(sell,2),
  takerBuyFraction:round(fraction),takerDeltaUsd:round(buy-sell,2),
  vote:fraction>=0.60?"UP":fraction<=0.40?"DOWN":null,
  source:"BINANCE_USDM_PUBLIC_AGGTRADES",caveat:"Last 500 aggregate trades are not a complete tape."};
}
export function parseMicroIndexKlines(values,at){
 if(!Array.isArray(values))throw Error("INDEX_KLINES_BAD_SHAPE");
 const rows=values.filter(x=>Array.isArray(x)&&x.length>=7&&
  Number.isSafeInteger(x[0])&&Number.isSafeInteger(x[6])&&
  x[6]===x[0]+59999&&x[6]<at&&finite(n(x[4]))&&n(x[4])>0)
  .sort((a,b)=>a[0]-b[0]);
 if(rows.length<4)throw Error("INDEX_KLINES_TOO_FEW_CLOSED");
 const recent=rows.slice(-4);
 for(let i=1;i<recent.length;i++)if(recent[i][0]-recent[i-1][0]!==60000)
  throw Error("INDEX_KLINES_GAP");
 point(recent.at(-1)[6],at,LIMITS.indexKlines);
 const oldClose=n(recent[0][4]),lastClose=n(recent.at(-1)[4]);
 const deltaBps=(lastClose/oldClose-1)*10000;
 return {observedAt:recent.at(-1)[6],threeMinuteBps:round(deltaBps,3),
  vote:deltaBps>=3?"UP":deltaBps<=-3?"DOWN":null,
  source:"BINANCE_USDM_PUBLIC_CLOSED_INDEX_1M_KLINES",
  caveat:"Closed index candles are independent from live index tick; never an official Event Contract strike."};
}
const parsers={orderBook:parseMicroOrderBook,aggressiveFlow:parseMicroAggTrades,indexKlines:parseMicroIndexKlines};
function classify(error){
 const s=String(error?.message||error||"UNKNOWN");
 if(/^HTTP_451/.test(s))return "REGION_RESTRICTED_451";
 if(/^HTTP_418/.test(s))return "IP_BLOCK_418";
 if(/^HTTP_429/.test(s))return "RATE_LIMIT_429";
 if(/Abort|timeout/i.test(s))return "TIMEOUT";
 return s.slice(0,80);
}
export async function collectOptionalMicrostructure({fetcher=fetch,now=Date.now,timeoutMs=950}={}){
 const rows=await Promise.all(MICRO_FEATURE_NAMES.map(async name=>{
  try{
   const r=await fetcher(BASE+REQUESTS[name],{headers:{Accept:"application/json"},
     signal:AbortSignal.timeout(timeoutMs)});
   if(!r.ok)throw Error("HTTP_"+r.status);
   const value=await r.json(),receivedAt=now();
   const parsed=parsers[name](value,receivedAt);
   return {name,feature:{...parsed,receivedAt},availability:{available:true,receivedAt}};
  }catch(e){return {name,feature:null,availability:{available:false,error:classify(e)}};}
 }));
 return {source:"BINANCE_USDM_OPTIONAL_READONLY_MICROSTRUCTURE",
   features:Object.fromEntries(rows.filter(x=>x.feature).map(x=>[x.name,x.feature])),
   availability:Object.fromEntries(rows.map(x=>[x.name,x.availability])),
   available:rows.filter(x=>x.feature).length,total:MICRO_FEATURE_NAMES.length};
}
export function chooseMicrostructureDirection(baseSide,features,decisionAt){
 const initial={side:baseSide,changed:false,reason:"MICROSTRUCTURE_NO_OVERRIDE",
  votes:{},availableSources:0};
 if(!["UP","DOWN"].includes(baseSide)||!Number.isSafeInteger(decisionAt))
   return {...initial,reason:"NO_BASE_DIRECTION"};
 const votes={},fresh={};
 for(const name of MICRO_FEATURE_NAMES){
  const x=features?.[name];
  if(!x||!Number.isSafeInteger(x.receivedAt)||x.receivedAt>decisionAt||
     !Number.isSafeInteger(x.observedAt)||x.observedAt>decisionAt||
     decisionAt-x.observedAt>LIMITS[name])continue;
  fresh[name]=x;
  votes[name]=x.vote==="UP"||x.vote==="DOWN"?x.vote:null;
 }
 const availableSources=Object.keys(fresh).length;
 const flow=votes.aggressiveFlow;
 const supporters=Object.keys(votes).filter(k=>votes[k]===flow);
 // Require fresh trade aggression and at least one corroborating INDEPENDENT source.
 // Neutral, sparse, stale or unavailable data MUST preserve the original direction.
 const confirmed=flow&&supporters.length>=2;
 const side=confirmed?flow:baseSide;
 return {side,changed:side!==baseSide,
  reason:confirmed?(side===baseSide?"MICRO_CONFIRMS_BASE":"MICRO_CORRECTS_DIRECTION"):"MICRO_INSUFFICIENT_CONSENSUS",
  votes,availableSources,corroboratingSources:confirmed?supporters:[],
  tradeBuyFraction:fresh.aggressiveFlow?.takerBuyFraction??null,
  depthImbalance:fresh.orderBook?.imbalanceTop20??null,
  index3mBps:fresh.indexKlines?.threeMinuteBps??null};
}
