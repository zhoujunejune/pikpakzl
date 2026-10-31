// EVENT10 source-aware public market enrichment. Never calls Binance order/trading APIs.
// Endpoints are read-only public USDⓈ-M futures; HTTP 451 is a genuine unavailability, not bypassed.
const BASE="https://fapi.binance.com";
const num=(v)=>Number(v);
const oknum=(v)=>Number.isFinite(Number(v));
const round=(v,n=5)=>Number(v.toFixed(n));
const capped=(v,n)=>String(v||"").slice(0,n);
const source="BINANCE_FAPI_USDM_PUBLIC_NOT_EVENT_CONTRACT_SETTLEMENT_INDEX";

export function tenMinuteWindow(feed,now){
 const raw=feed?.candles?.["1m"];
 const data=Array.isArray(raw)?raw:(raw?.rows||raw?.items||raw?.candles||[]);
 if(!Array.isArray(data))throw Error("NO_1M_CANDLES_FOR_10M");
 const bars=data.filter(x=>{
   const t=num(x.startMs??x.openTime);
   return x.closed===true&&Number.isSafeInteger(t)&&t>0&&t+60000<=now&&
     ["open","high","low","close","volume"].every(k=>oknum(x[k])&&num(x[k])>=0)&&num(x.close)>0;
 }).map(x=>({t:num(x.startMs??x.openTime),o:num(x.open),h:num(x.high),
   l:num(x.low),c:num(x.close),v:num(x.volume)}))
 .sort((a,b)=>a.t-b.t);
 const last=bars.slice(-10);
 if(last.length!==10)throw Error("INSUFFICIENT_ROLLING_10M_CANDLES");
 for(let i=1;i<10;i++)if(last[i].t-last[i-1].t!==60000)
   throw Error("GAPPED_ROLLING_10M_CANDLES");
 if(now-(last.at(-1).t+60000)>95000)throw Error("ROLLING_10M_CANDLES_STALE");
 const volume=last.reduce((a,x)=>a+x.v,0);
 const prev=bars.slice(-20,-10);
 const prevVolume=prev.length===10?prev.reduce((a,x)=>a+x.v,0):null;
 return {
   from:last[0].t,until:last.at(-1).t+60000,
   open:last[0].o,close:last.at(-1).c,
   high:round(Math.max(...last.map(x=>x.h)),2),
   low:round(Math.min(...last.map(x=>x.l)),2),
   movePct:round((last.at(-1).c/last[0].o-1)*100,5),
   amplitudePct:round((Math.max(...last.map(x=>x.h))/Math.min(...last.map(x=>x.l))-1)*100,5),
   volume:round(volume,3),
   vsPrevious10mVolumeRatio:prevVolume>0?round(volume/prevVolume,3):null,
   closed1mBars:10,source:"EXISTING_READONLY_BTC_1M_CLOSED_CANDLES"
 };
}
const ema=(series,period)=>{
 let y=series.slice(0,period).reduce((a,b)=>a+b,0)/period;
 const alpha=2/(period+1);
 for(const x of series.slice(period))y+=alpha*(x-y);
 return y;
};
function fifteenMinuteKlines(values,now){
 if(!Array.isArray(values))throw Error("15M_BAD_SHAPE");
 const a=values.filter(k=>Array.isArray(k)&&k.length>=7&&
    Number.isSafeInteger(k[0])&&Number.isSafeInteger(k[6])&&k[6]<now &&
    ["1","2","3","4","5"].every(i=>oknum(k[Number(i)])))
  .map(k=>({at:k[0],close:num(k[4]),high:num(k[2]),low:num(k[3]),volume:num(k[5])}))
  .sort((a,b)=>a.at-b.at).slice(-45);
 if(a.length<36)throw Error("15M_TOO_FEW_CLOSED_KLINES");
 if(now-a.at(-1).at>1900000)throw Error("15M_CANDLE_DATA_STALE");
 for(let i=1;i<a.length;i++)if(a[i].at-a[i-1].at!==900000)
   throw Error("15M_NONCONTIGUOUS_KLINES");
 const c=a.map(x=>x.close);
 const gain=c.slice(-15).reduce((v,p,i,x)=>i? v+Math.max(p-x[i-1],0):v,0);
 const loss=c.slice(-15).reduce((v,p,i,x)=>i? v+Math.max(x[i-1]-p,0):v,0);
 const rsi=loss?100-100/(1+gain/loss):(gain>0?100:50);
 const diffs=[];
 for(let i=25;i<c.length;i++)diffs.push(ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
 const m=diffs.at(-1),signal=ema(diffs,9);
 return {
   candles:a.length,latestClosedAt:a.at(-1).at+900000-1,
   close:a.at(-1).close,ema9:round(ema(c,9),2),
   ema21:round(ema(c,21),2),rsi14:round(rsi,2),
   macd:{line:round(m,4),signal:round(signal,4),histogram:round(m-signal,4)},
   moveLast45mPct:round((c.at(-1)/c.at(-4)-1)*100,5),
   highLast2h:round(Math.max(...a.slice(-8).map(x=>x.high)),2),
   lowLast2h:round(Math.min(...a.slice(-8).map(x=>x.low)),2),
   source:"BINANCE_USDM_PERPETUAL_15M_CLOSED_KLINES"
 };
}
function depth(d,now){
 const at=num(d.T||d.E);
 if(!Number.isSafeInteger(at)||at>now+2000||now-at>12000)throw Error("DEPTH_SNAPSHOT_STALE");
 if(!Array.isArray(d.bids)||!Array.isArray(d.asks)||d.bids.length<10||d.asks.length<10)
   throw Error("INSUFFICIENT_ORDERBOOK_LEVELS");
 const parse=v=>v.slice(0,20).map(([p,q])=>[num(p),num(q)]).filter(([p,q])=>p>0&&q>=0&&Number.isFinite(p)&&Number.isFinite(q));
 const b=parse(d.bids),a=parse(d.asks);
 if(b.length<10||a.length<10||b[0][0]>=a[0][0])throw Error("BAD_ORDERBOOK");
 const bn=b.reduce((t,[p,q])=>t+p*q,0),an=a.reduce((t,[p,q])=>t+p*q,0);
 if(bn+an===0)throw Error("ZERO_ORDERBOOK");
 return {observedAt:at,bestBid:b[0][0],bestAsk:a[0][0],
   spreadBps:round(10000*(a[0][0]-b[0][0])/((a[0][0]+b[0][0])/2),3),
   bidTop20NotionalUsd:round(bn,2),askTop20NotionalUsd:round(an,2),
   imbalanceTop20:round((bn-an)/(bn+an),4),
   sampledLevelsPerSide:20,
   caveat:"Order book is a point-in-time snapshot; orders can be cancelled or hidden."
 };
}
function aggressiveTrades(rows,now){
 if(!Array.isArray(rows))throw Error("TRADES_BAD_SHAPE");
 const filtered=rows.filter(x=>Number.isSafeInteger(x.T)&&now-x.T>=-1000&&now-x.T<=120000&&
    oknum(x.p)&&oknum(x.q)&&num(x.p)>0&&num(x.q)>0&&typeof x.m==="boolean");
 if(filtered.length<3)throw Error("NO_RECENT_AGGREGATE_TRADES");
 let buys=0,sells=0,largeBuy=0,largeSell=0,big=0;
 for(const x of filtered){
   const amount=num(x.p)*num(x.q);
   if(x.m)sells+=amount;else buys+=amount;
   if(amount>=100000){
     big++;
     if(x.m)largeSell+=amount;else largeBuy+=amount;
   }
 }
 const total=buys+sells;
 const ordered=filtered.slice().sort((a,b)=>a.T-b.T);
 const first=ordered[0],last=ordered.at(-1);
 const tradeSpanMs=last.T-first.T;
 const verifiedPriceResponse=ordered.length>=20&&tradeSpanMs>=20000&&tradeSpanMs<=120000;
 const priceMovePct=verifiedPriceResponse?
   round((num(last.p)/num(first.p)-1)*100,5):null;
 return {sampledTradeGroups:filtered.length,windowSeconds:120,
   tradeSpanMs,verifiedPriceResponse,
   futuresFirstTradePrice:verifiedPriceResponse?num(first.p):null,
   futuresLastTradePrice:verifiedPriceResponse?num(last.p):null,
   futuresPriceMovePct:priceMovePct,
   priceResponseSource:"BINANCE_USDM_BTCUSDT_AGGTRADES_SAME_SAMPLE",
   earliestTradeAt:Math.min(...filtered.map(x=>x.T)),
   latestTradeAt:Math.max(...filtered.map(x=>x.T)),
   takerBuyNotionalUsd:round(buys,2),takerSellNotionalUsd:round(sells,2),
   deltaNotionalUsd:round(buys-sells,2),
   takerBuyFraction:total?round(buys/total,4):null,
   largeTradeThresholdUsd:100000,
   observedLargeTradeGroups:big,
   largeBuyNotionalUsd:round(largeBuy,2),
   largeSellNotionalUsd:round(largeSell,2),
   caveat:"Limited last 1000 aggregate trade groups, not full 120-second tape; buyerMaker true means aggressive sell."
 };
}
function premium(d,now){
 const at=num(d.time),index=num(d.indexPrice),mark=num(d.markPrice);
 if(!Number.isSafeInteger(at)||at>now+2000||now-at>15000||
   !Number.isFinite(index)||index<=0||!Number.isFinite(mark)||mark<=0)throw Error("INDEX_STALE");
 return {observedAt:at,indexPrice:index,markPrice:mark,
   markVsIndexBps:round(10000*(mark/index-1),3),
   lastFundingRate:oknum(d.lastFundingRate)?num(d.lastFundingRate):null,
   nextFundingAt:Number.isSafeInteger(d.nextFundingTime)?d.nextFundingTime:null,
   caveat:"USDM futures index is not confirmed identical to the Binance Event Contract settlement index."};
}
function oi(d,now){
 const at=num(d.time),amount=num(d.openInterest);
 if(!Number.isSafeInteger(at)||at>now+2000||now-at>30000||
    !Number.isFinite(amount)||amount<=0)throw Error("OPEN_INTEREST_STALE");
 return {observedAt:at,openInterestBtc:amount};
}
function oiHistory(d,now){
 if(!Array.isArray(d)||d.length<2)throw Error("OI_HISTORY_MISSING");
 const a=d.filter(x=>Number.isSafeInteger(x.timestamp)&&x.timestamp<=now&&
    now-x.timestamp<=1200000&&oknum(x.sumOpenInterest)&&num(x.sumOpenInterest)>0)
 .sort((x,y)=>x.timestamp-y.timestamp);
 if(a.length<2||a.at(-1).timestamp-a.at(-2).timestamp>360000)
   throw Error("OI_HISTORY_STALE");
 const first=num(a.at(-2).sumOpenInterest),last=num(a.at(-1).sumOpenInterest);
 return {observedAt:a.at(-1).timestamp,change5mPct:round((last/first-1)*100,5),
   caveat:"Two five-minute bins of Binance USD-M contract OI; separate from latest live OI."};
}
// EVENT10 V5 requests ONLY two core REST data families.
// The independent 600-second WebSocket tape remains available.
const sections=[
 {name:"fifteenMinute",route:"/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=45",parse:fifteenMinuteKlines},
 {name:"aggressiveFlow",route:"/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000",parse:aggressiveTrades}
];
export const ENRICHMENT_NAMES=Object.freeze(sections.map(x=>x.name));
export async function collectPublicFeatures({fetcher=fetch,now=Date.now,timeoutMs=2800}={}){
 const sampledAt=now();
 const sources=await Promise.all(sections.map(async x=>{
   try{
     const start=now();
     const r=await fetcher(BASE+x.route,{headers:{Accept:"application/json"},
       signal:AbortSignal.timeout(timeoutMs)});
     if(!r.ok)throw Error("HTTP_"+r.status);
     const body=await r.json();
     if(now()-start>timeoutMs+300)throw Error("SLOW_RESPONSE");
     return {name:x.name,ok:true,receivedAt:now(),value:x.parse(body,now())};
   }catch(e){
     const text=capped(e?.message||e,80);
     const issue=/HTTP_451/.test(text)?"REGION_RESTRICTED_451":
       /HTTP_418/.test(text)?"IP_BLOCK_418":
       /Abort|timeout/i.test(text)?"TIMEOUT":
       /HTTP_[0-9]+/.test(text)?text:
       /STAL|MISSING|FEW|BAD|NONCONTIG|INSUFF|NO_RECENT|ZERO_|GAPPED/.test(text)?text:
       "DATA_UNAVAILABLE";
     return {name:x.name,ok:false,error:issue};
   }
 }));
 const features={},availability={};
 for(const x of sources){
   availability[x.name]=x.ok?{available:true,receivedAt:x.receivedAt}:
     {available:false,error:x.error};
   if(x.ok)features[x.name]=x.value;
 }
 return {source,requestedAt:sampledAt,completedAt:now(),
   available:sources.filter(x=>x.ok).length,total:sources.length,
   features,availability,eventsContractIndexOfficial:false,
   caveats:[
     "EVENT10 V5 calls only 15m candles and USD-M recent aggregates; 600s tape comes from the independent read-only WebSocket collector.",
     "Futures prices are not identical to public reference or official Event Contract settlement prices.",
     "Missing or restricted core data is not invented; unrelated indicators are not requested."
   ]};
}
