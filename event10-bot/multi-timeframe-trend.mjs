// EVENT10 V22 read-only multi-timeframe trend evidence. No orders or model calls.
// Binance spot CLOSED candles; 2m/10m are strictly aligned aggregates of 1m.
const MS={ "1m":60000,"2m":120000,"5m":300000,"10m":600000,"15m":900000,"30m":1800000 };
const WEIGHTS={"1m":1.0,"2m":1.25,"5m":1.75,"10m":2.0,"15m":1.65,"30m":1.2};
const round=(x,n=5)=>Number(x.toFixed(n));
const sign=n=>n>0?1:n<0?-1:0;
const direction=n=>n>0?"UP":n<0?"DOWN":null;
const finite=Number.isFinite;
export function verifiedBars(feed,interval,at){
 const ms=MS[interval],block=feed?.candles?.[interval];
 const data=Array.isArray(block)?block:(block?.rows||block?.items||block?.candles||[]);
 if(!ms||!Array.isArray(data))return {bars:[],error:"MISSING_"+interval};
 const bars=data.filter(x=>{
   const t=Number(x?.startMs??x?.openTime);
   const o=Number(x?.open),h=Number(x?.high),l=Number(x?.low),c=Number(x?.close),v=Number(x?.volume);
   return x?.closed===true&&Number.isSafeInteger(t)&&t>0&&t+ms<=at&&
     [o,h,l,c,v].every(finite)&&Math.min(o,h,l,c)>0&&v>=0&&h>=Math.max(o,c)&&l<=Math.min(o,c);
 }).map(x=>({t:Number(x.startMs??x.openTime),o:Number(x.open),h:Number(x.high),
    l:Number(x.low),c:Number(x.close),v:Number(x.volume)})).sort((a,b)=>a.t-b.t);
 if(bars.length<15)return {bars:[],error:"INSUFFICIENT_"+interval};
 // The last 15 candles and the most recent completed boundary must be verifiable.
 const recent=bars.slice(-15);
 for(let i=1;i<recent.length;i++)if(recent[i].t-recent[i-1].t!==ms)
   return {bars:[],error:"GAPPED_"+interval};
 if(bars.at(-1).t+ms<Math.floor(at/ms)*ms)
   return {bars:[],error:"STALE_"+interval};
 return {bars,error:null};
}
export function aggregateBars(one,minutes){
 const ms=minutes*60000,groups=new Map();
 for(const c of one){
   const key=Math.floor(c.t/ms)*ms;
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(c);
 }
 return [...groups].sort((a,b)=>a[0]-b[0]).flatMap(([t,group])=>{
   if(group.length!==minutes||group[0].t!==t||
      group.some((c,i)=>c.t!==t+i*60000))return [];
   return [{t,o:group[0].o,h:Math.max(...group.map(c=>c.h)),
     l:Math.min(...group.map(c=>c.l)),c:group.at(-1).c,
     v:group.reduce((sum,c)=>sum+c.v,0)}];
 });
}
function emaSeries(v,n){
 if(v.length<n)return [];
 let avg=v.slice(0,n).reduce((a,b)=>a+b,0)/n;
 const out=Array(n-1).fill(null);out.push(avg);
 for(const p of v.slice(n)){avg+=(p-avg)*2/(n+1);out.push(avg);}
 return out;
}
function rsi(v,n=14){
 if(v.length<n+1)return null;
 let gain=0,loss=0;
 for(let i=v.length-n;i<v.length;i++){const d=v[i]-v[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
 return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
function macdHistogram(v){
 const f=emaSeries(v,12),s=emaSeries(v,26);
 if(!f.length||!s.length)return null;
 const m=v.flatMap((_,i)=>i>=25?[f[i]-s[i]]:[]);
 const signal=emaSeries(m,9);
 return signal.length?m.at(-1)-signal.at(-1):null;
}
export function supertrend(bars,period=10,multiplier=3){
 if(bars.length<period+1)return null;
 const trs=bars.map((b,i)=>i===0?b.h-b.l:
   Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)));
 let atr=trs.slice(0,period).reduce((a,b)=>a+b,0)/period;
 let upper=null,lower=null,side=0;
 for(let i=period-1;i<bars.length;i++){
   if(i>=period)atr=(atr*(period-1)+trs[i])/period;
   const b=bars[i],mid=(b.h+b.l)/2;
   const basicUpper=mid+multiplier*atr,basicLower=mid-multiplier*atr;
   if(upper===null){
     upper=basicUpper;lower=basicLower;side=b.c>=mid?1:-1;continue;
   }
   const previous=bars[i-1];
   const nextUpper=basicUpper<upper||previous.c>upper?basicUpper:upper;
   const nextLower=basicLower>lower||previous.c<lower?basicLower:lower;
   side=side===1?(b.c<nextLower?-1:1):(b.c>nextUpper?1:-1);
   upper=nextUpper;lower=nextLower;
 }
 return {direction:direction(side),atr:round(atr,3),
   line:round(side===1?lower:upper,3),period,multiplier};
}
export function summarizeTimeframe(bars,label){
 if(bars.length<20)return {interval:label,available:false,reason:"NOT_ENOUGH_BARS",bars:bars.length};
 const close=bars.map(b=>b.c);
 const fast=label==="10m"?9:20,slow=label==="10m"?20:50;
 const emaFast=emaSeries(close,fast),emaSlow=emaSeries(close,slow);
 const a=emaFast.at(-1),b=emaSlow.at(-1)||null;
 const st=supertrend(bars);
 const hist=macdHistogram(close);
 const rs=rsi(close);
 const prevSlope=emaFast.length>=3?emaFast.at(-3):null;
 const vol20=bars.slice(-21,-1).reduce((s,x)=>s+x.v,0)/20;
 const volumeRatio=vol20>0?bars.at(-1).v/vol20:null;
 let score=0;
 if(st?.direction)score+=st.direction==="UP"?2:-2;
 if(b!==null)score+=1.35*sign(a-b);
 if(prevSlope!==null)score+=0.45*sign(a-prevSlope);
 if(hist!==null)score+=0.65*sign(hist);
 if(rs!==null)score+=0.35*sign(rs-50);
 score+=0.5*sign(close.at(-1)-a);
 // Volume reinforces an actual candle, never fabricates a vote on its own.
 if(volumeRatio!==null&&volumeRatio>=1.25)score+=0.25*sign(bars.at(-1).c-bars.at(-1).o);
 return {interval:label,available:true,bars:bars.length,
   trend:direction(score),vote:round(score,3),
   supertrend:st,emaFastPeriod:fast,emaSlowPeriod:slow,
   emaFast:round(a,3),emaSlow:b===null?null:round(b,3),
   macdHistogram:hist===null?null:round(hist,5),
   rsi14:rs===null?null:round(rs,2),
   volumeRatio:volumeRatio===null?null:round(volumeRatio,3),
   lastClosedAt:bars.at(-1).t,close:close.at(-1)};
}
export function analyzeMultiTimeframes({feed,at,indexPrice,previousIndexSnapshot,indexAt}){
 if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=="BTCUSDT"||
    feed?.latest?.marketFeedConnected===false)throw Error("UNVERIFIED_BTCUSDT_FEED");
 const one=verifiedBars(feed,"1m",at);
 if(one.error)throw Error("REQUIRED_1m_"+one.error);
 const five=verifiedBars(feed,"5m",at),fifteen=verifiedBars(feed,"15m",at),
   thirty=verifiedBars(feed,"30m",at);
 const mapping={"1m":one.bars,"2m":aggregateBars(one.bars,2),
   "5m":five.bars,"10m":aggregateBars(one.bars,10),
   "15m":fifteen.bars,"30m":thirty.bars};
 const timeframes={};let weighted=0,weightTotal=0;
 for(const tf of Object.keys(mapping)){
   // Do not score a stale or incomplete source, even if old rows look plausible.
   const failure=tf==="5m"?five.error:tf==="15m"?fifteen.error:tf==="30m"?thirty.error:null;
   const value=failure?{interval:tf,available:false,reason:failure,bars:0}:
      summarizeTimeframe(mapping[tf],tf);
   timeframes[tf]=value;
   if(value.available){weighted+=WEIGHTS[tf]*value.vote;weightTotal+=WEIGHTS[tf];}
 }
 if(!weightTotal)throw Error("NO_VERIFIED_MULTITIMEFRAME_HISTORY");
 const prev=Number(previousIndexSnapshot?.price),prevAt=Number(previousIndexSnapshot?.observedAt);
 const validPrev=finite(prev)&&prev>0&&Number.isSafeInteger(prevAt)&&prevAt<indexAt&&
   indexAt-prevAt<=30000;
 const liveDelta=validPrev?indexPrice-prev:0;
 const oneClose=one.bars.at(-1).c,priorClose=one.bars.at(-2).c;
 const shortDirection=sign(liveDelta)||(sign(indexPrice-oneClose))||sign(oneClose-priorClose);
 // Current index price matters, but short-term noise cannot erase all larger trends.
 const liveContribution=1.8*shortDirection;
 const finalScore=weighted+liveContribution;
 const finalDirection=direction(finalScore)||direction(shortDirection);
 return {direction:finalDirection,trendScore:round(finalScore,3),
   weightedTimeframeScore:round(weighted,3),
   currentPriceDirection:direction(shortDirection),
   liveIndexDelta:validPrev?round(liveDelta,5):null,
   currentIndexPrice:indexPrice,indexAt,
   timeframes,timeframeCoverage:Object.values(timeframes).filter(t=>t.available).length,
   timeframeCount:6,aggregationSource:"CLOSED_BINANCE_SPOT_1M_ALIGNED_2M_10M",
   confidenceCalibrated:false};
}
