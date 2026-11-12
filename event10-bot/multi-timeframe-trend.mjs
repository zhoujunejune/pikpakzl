// EVENT10 V22 read-only multi-timeframe trend evidence. No orders or model calls.
// Binance spot CLOSED candles; 2m/10m are strictly aligned aggregates of 1m.
const MS={ "1m":60000,"2m":120000,"5m":300000,"10m":600000,"15m":900000,"30m":1800000 };
// V23: weights sum to one; the 10-minute outcome needs fresh 1/2/5m evidence.
// 15m and 30m are background context rather than six repeated vetoes.
export const TEN_MINUTE_WEIGHTS=Object.freeze({"1m":0.22,"2m":0.27,"5m":0.28,"10m":0.13,"15m":0.07,"30m":0.03});
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
// V23 direction arbitration: normalize correlated indicator votes and explicitly
// distinguish emerging reversals from already-established long-term trends.
// This is NOT a trained probabilistic classifier; its score is never a win rate.
export function selectTenMinuteDirection(timeframes,liveBps=null){
 let weighted=0,observedWeight=0;
 const norm={},sides={};
 for(const [tf,weight] of Object.entries(TEN_MINUTE_WEIGHTS)){
   const v=timeframes?.[tf];
   if(!v?.available||!finite(v.vote))continue;
   const normalized=Math.max(-1,Math.min(1,v.vote/5.2));
   norm[tf]=round(normalized,4);
   sides[tf]=sign(normalized);
   weighted+=weight*normalized;observedWeight+=weight;
 }
 if(!observedWeight)throw Error("NO_VERIFIED_MULTITIMEFRAME_HISTORY");
 const baseline=weighted/observedWeight;
 // 12-second index changes below 0.8bp are normal noise, not an independent trend.
 const liveDirection=finite(liveBps)&&Math.abs(liveBps)>=0.8?sign(liveBps):0;
 const combined=0.82*baseline+0.18*liveDirection;
 const candidate=sign(combined),one=sides["1m"]||0,two=sides["2m"]||0,
   five=sides["5m"]||0;
 let reason="V23_NORMALIZED_TREND";
 // A 1m + 2m reversal with a confirming index tick is not six independent
 // votes for the older direction. Wait for new evidence before publishing.
 if(one!==0&&one===two&&one!==five&&liveDirection!==-one)
   reason="V23_EARLY_REVERSAL_UNCONFIRMED";
 else if(candidate!==0&&one!==0&&two===one&&candidate!==one&&
    liveDirection===one)
   reason="V23_SHORT_TERM_REVERSAL_CONFLICT";
 else if(candidate!==0&&liveDirection===-candidate&&
    finite(liveBps)&&Math.abs(liveBps)>=4)
   reason="V23_STRONG_LIVE_PRICE_CONFLICT";
 else if(Math.abs(combined)<0.20)
   reason="V23_SCORE_TOO_WEAK";
 const accepted=reason==="V23_NORMALIZED_TREND";
 return {direction:accepted?direction(candidate):null,decisionReason:reason,
   trendScore:round(combined,4),weightedTimeframeScore:round(baseline,4),
   currentPriceDirection:direction(liveDirection),
   liveIndexChangeBps:finite(liveBps)?round(liveBps,4):null,
   normalizedVotes:norm,shortTermDirection:direction(sign((norm["1m"]||0)+(norm["2m"]||0))),
   longContextDirection:direction(sign((norm["15m"]||0)+(norm["30m"]||0))),
   timeframeWeightCoverage:round(observedWeight,4),
   noCalibratedConfidence:true};
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
 const timeframes={};
 for(const tf of Object.keys(mapping)){
   const failure=tf==="5m"?five.error:tf==="15m"?fifteen.error:tf==="30m"?thirty.error:null;
   timeframes[tf]=failure?{interval:tf,available:false,reason:failure,bars:0}:
     summarizeTimeframe(mapping[tf],tf);
 }
 const prev=Number(previousIndexSnapshot?.price),prevAt=Number(previousIndexSnapshot?.observedAt);
 const validPrev=finite(prev)&&prev>0&&Number.isSafeInteger(prevAt)&&prevAt<indexAt&&
   indexAt-prevAt<=30000;
 const liveDelta=validPrev?indexPrice-prev:null;
 const liveBps=validPrev?(indexPrice/prev-1)*10000:null;
 const result=selectTenMinuteDirection(timeframes,liveBps);
 return {...result,liveIndexDelta:validPrev?round(liveDelta,5):null,
   currentIndexPrice:indexPrice,indexAt,timeframes,
   timeframeCoverage:Object.values(timeframes).filter(t=>t.available).length,
   timeframeCount:6,aggregationSource:"CLOSED_BINANCE_SPOT_1M_ALIGNED_2M_10M",
   confidenceCalibrated:false};
}
