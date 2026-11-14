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
// V26 EMA9/21 entry diagnostics are computed ONLY from completed Binance spot candles.
// They complement (rather than replace) the V25 multi-horizon and V24 reversal gates.
export function ema921EntrySnapshot(bars,label="1m"){
 if(!Array.isArray(bars)||bars.length<25)return {available:false,interval:label,reason:"INSUFFICIENT_CLOSED_BARS"};
 const closes=bars.map(b=>b.c);
 const fast=emaSeries(closes,9),slow=emaSeries(closes,21);
 const i=closes.length-1,a=fast[i],b=slow[i],pa=fast[i-1],pb=slow[i-1],ppa=fast[i-2];
 if(![a,b,pa,pb,ppa,closes[i]].every(finite)||closes[i]<=0)
   return {available:false,interval:label,reason:"EMA_NOT_READY"};
 const price=closes[i],spread=(a/b-1)*10000,priorSpread=(pa/pb-1)*10000;
 const trend=direction(spread),oldTrend=direction(priorSpread);
 const cross=trend!==oldTrend?trend==="UP"?"GOLDEN":"DEATH":null;
 const slope=(a/pa-1)*10000,priorSlope=(pa/ppa-1)*10000;
 return {available:true,interval:label,source:"VERIFIED_CLOSED_SPOT_EMA_9_21",
   ema9:round(a,3),ema21:round(b,3),
   direction:trend,crossover:cross,
   spreadBps:round(spread,4),spreadChangeBps:round(spread-priorSpread,4),
   widening:Math.abs(spread)>Math.abs(priorSpread),
   ema9SlopeBps:round(slope,4),ema9AccelerationBps:round(slope-priorSlope,4),
   closeDistanceEma9Bps:round((price/a-1)*10000,4),
   lastClosedAt:bars[i].t+(MS[label]||60000)};
}
export function assessEmaEntry(side,snapshots,ctx,priceAction){
 if(side!=="UP"&&side!=="DOWN")return {ready:false,reason:"NO_DIRECTION"};
 const a=snapshots?.["1m"],b=snapshots?.["2m"],c=snapshots?.["5m"];
 if(!a?.available||!b?.available||!c?.available)
   return {ready:true,reason:"V26_EMA_PARTIAL_NO_EXTRA_VETO",entryType:"UNCONFIRMED"};
 const d=side==="UP"?1:-1;
 const p3=priceAction?.threeMinuteBps;
 const against=finite(p3)&&d*p3<=-3;
 const oppose=a.direction!==side&&b.direction!==side &&
   d*a.ema9SlopeBps<0&&d*b.ema9SlopeBps<0;
 const freshOppositeCross=(a.crossover&&(a.crossover===(d===1?"DEATH":"GOLDEN"))) &&
   b.direction!==side;
 const nearEdge=side==="UP"?
   (ctx?.ranges?.["15m"]?.position>=0.86||ctx?.ranges?.["60m"]?.position>=0.92):
   (ctx?.ranges?.["15m"]?.position<=0.14||ctx?.ranges?.["60m"]?.position<=0.08);
 // The ATR-scaled chase limit requires confirmation from 2m EMA and closed
 // 3m price movement. It must not block every strong trend or every new cross.
 const atr=ctx?.atr1mBps||0;
 const extended=d*a.closeDistanceEma9Bps>Math.max(10,2.2*atr) &&
   d*b.closeDistanceEma9Bps>Math.max(8,1.4*atr) &&
   finite(p3)&&d*p3>Math.max(14,2*atr)&&nearEdge;
 const adverse=(oppose||freshOppositeCross)&&against;
 // V27: EMA9/21 separation AND EMA9 acceleration must both weaken before
 // treating an early opposite move as likely exhaustion. The 2m confirmation
 // or a confirmed adverse 3m spot move is independent of the 1m noise.
 const weakeningFast=d*a.spreadChangeBps<=-0.45 &&
   d*a.ema9AccelerationBps<=-0.45;
 const weakening2m=d*b.spreadChangeBps<=-0.3 ||
   d*b.ema9SlopeBps<=-0.5;
 const nearTermAdverse=finite(p3)&&d*p3<=-3;
 const earlyWeakening=weakeningFast&&(weakening2m||nearTermAdverse)&&
   finite(p3)&&d*p3<2;
 // The most recent closed 3m move against the old trend plus a
 // newly opposing EMA slope is sufficient to pause a late 10m chase;
 // do not require BOTH 1m and 2m crossovers to finish first.
 const reboundVsTrend=nearTermAdverse&&
   (d*a.ema9SlopeBps<=-0.35||d*a.spreadChangeBps<=-0.55)&&
   (d*b.ema9SlopeBps<=0||d*b.spreadChangeBps<=0);
 // V29: an adverse CLOSED 3m swing plus shrinking 1m EMA9/21 spread
 // and decelerating EMA9 is a countertrend warning even if 5m closes lag.
 const fastCountermove=finite(p3)&&d*p3<=-8&&
   d*a.spreadChangeBps<=-0.25&&d*a.ema9AccelerationBps<=-0.7;
 const day=ctx?.ranges?.["24h"],hour=ctx?.ranges?.["60m"];
 const two=ctx?.ranges?.["2h"],p5=priceAction?.fiveMinuteBps;
 const dayAtEdge=day?.available===true&&
   (side==="UP"?day.position>=0.88:day.position<=0.12);
 const hPos=hour?.available?(side==="UP"?1-hour.position:hour.position):null;
 const twoPos=two?.available?(side==="UP"?1-two.position:two.position):null;
 const crowded=(finite(hPos)&&hPos<=0.20)||(finite(twoPos)&&twoPos<=0.12);
 const stretched3=finite(p3)&&d*p3>=50;
 const stretched5=finite(p5)&&d*p5>=70;
 const accelAgainst=d*a.ema9AccelerationBps<=-2;
 const dailyEdgeExhaustion=dayAtEdge&&(
   stretched3||
   (crowded&&accelAgainst&&finite(p3)&&d*p3>=10)||
   (finite(hPos)&&hPos<=0.20&&stretched5));
 const ready=!adverse&&!extended&&!earlyWeakening&&!reboundVsTrend&&
   !fastCountermove&&!dailyEdgeExhaustion;
 const crossAligned=a.crossover===(d===1?"GOLDEN":"DEATH") &&
    b.direction===side&&d*b.ema9SlopeBps>0;
 const pullback=d*a.closeDistanceEma9Bps>=-Math.max(2,0.5*atr)&&
   d*a.closeDistanceEma9Bps<=Math.max(6,1.2*atr) &&
   b.direction===side&&d*b.ema9SlopeBps>0 &&
   c.direction===side;
 const entryType=!ready?"WAIT":crossAligned?"CROSSOVER_CONFIRMATION":
   pullback?"EMA_PULLBACK_CONTINUATION":"TREND_CONTINUATION";
 return {ready,reason:adverse?"V26_EMA_AGAINST_ENTRY":
   extended?"V26_EMA_OVEREXTENDED_ENTRY":
   earlyWeakening?"V27_EMA_MOMENTUM_DECAY":
   reboundVsTrend?"V27_EMA_EARLY_COUNTERMOVE":
   fastCountermove?"V29_FAST_COUNTERMOVE_EMA_DECAY":
   dailyEdgeExhaustion?"V29_24H_EXTREME_CHASE":"V29_EMA_ENTRY_OK",
   entryType,opposingShortEmas:oppose,recentOpposingCross:!!freshOppositeCross,
   overextended:!!extended,momentumDecaying:!!earlyWeakening,
   confirmedCountermove:!!(reboundVsTrend||fastCountermove),
   dailyEdgeExhaustion,fastCountermove,
   shortEmaAligned:a.direction===side&&b.direction===side,
   atr1mBps:round(atr,4)};
}
// V23 direction arbitration: normalize correlated indicator votes and explicitly
// distinguish emerging reversals from already-established long-term trends.
// This is NOT a trained probabilistic classifier; its score is never a win rate.
// V25: compare near/medium/far CLOSED SPOT horizons (6m through 24h).
// All ranges and returns stay on the SAME spot market basis as their candles.
// A stale or unavailable OPTIONAL 30m history never fabricates a long view.
export function horizonStructure(bars,period,spotPrice){
 if(!Array.isArray(bars)||bars.length<period||!finite(spotPrice)||spotPrice<=0)
   return {available:false};
 const sample=bars.slice(-period),first=sample[0],last=sample.at(-1);
 const high=Math.max(...sample.map(x=>x.h)),low=Math.min(...sample.map(x=>x.l));
 if(!finite(high)||!finite(low)||high<=low)return {available:false};
 return {available:true,bars:period,high:round(high,3),low:round(low,3),
   position:round(Math.max(0,Math.min(1,(spotPrice-low)/(high-low))),4),
   changeBps:round((last.c/first.o-1)*10000,4),
   toSupportBps:round((spotPrice-low)/spotPrice*10000,3),
   toResistanceBps:round((high-spotPrice)/spotPrice*10000,3),
   lastClosedAt:last.t};
}
export function analyzeEntryHorizons({one,five,thirty}){
 if(!one?.length)return {available:false,reason:"NO_1M_HISTORY"};
 const spot=one.at(-1).c,oneRange=one.slice(-15);
 const trueRanges=oneRange.slice(1).map((b,i)=>Math.max(
   b.h-b.l,Math.abs(b.h-oneRange[i].c),Math.abs(b.l-oneRange[i].c)));
 const atrBps=round(trueRanges.reduce((a,b)=>a+b,0)/Math.max(1,trueRanges.length)/spot*10000,4);
 return {available:true,source:"CLOSED_BINANCE_SPOT_HORIZON_CONTEXT",
   asOf:one.at(-1).t+60000,spotClose:spot,atr1mBps:atrBps,
   ranges:{
     "6m":horizonStructure(one,6,spot),
     "15m":horizonStructure(one,15,spot),
     "60m":horizonStructure(one,60,spot),
     "2h":horizonStructure(five,24,spot),
     "4h":horizonStructure(thirty,8,spot),
     "24h":horizonStructure(thirty,48,spot)
   }};
}
// Only veto an entry when BOTH a recent price extreme AND independent
// short-horizon exhaustion/reversal agree. No blanket bias toward DOWN.
export function assessEntryTiming(side,ctx,priceAction){
 if(side!=="UP"&&side!=="DOWN")return {ready:false,reason:"NO_DIRECTION"};
 if(!ctx?.available)return {ready:false,reason:"MISSING_ENTRY_CONTEXT"};
 const ranges=ctx.ranges||{},hour=ranges["60m"],two=ranges["2h"],
   four=ranges["4h"],day=ranges["24h"];
 const p3=priceAction?.threeMinuteBps,p5=priceAction?.fiveMinuteBps;
 if(!finite(p3))return {ready:false,reason:"MISSING_3M_PRICE_ACTION"};
 const nearSupport=(hour?.available&&hour.position<=0.12)||
   (two?.available&&two.position<=0.08);
 const nearResistance=(hour?.available&&hour.position>=0.88)||
   (two?.available&&two.position>=0.92);
 const extended=Math.max(18,2.5*(ctx.atr1mBps||0));
 const bounce=side==="DOWN"?p3>=3:p3<=-3;
 const exhaustion=side==="DOWN"?p3<=-extended:p3>=extended;
 const edge=side==="DOWN"?nearSupport:nearResistance;
 // Longer 4h/24h bias is context, not an unconditional 10m predictor.
 const farAgainst=!!(four?.available&&day?.available&&
   ((side==="DOWN"&&four.changeBps>12&&day.changeBps>25)||
    (side==="UP"&&four.changeBps< -12&&day.changeBps< -25)));
 const reversalAtEdge=edge&&(bounce||exhaustion);
 // V28: no late 10m chase at BOTH 1h AND 2h extremes when a completed
 // 3m/5m spot swing shows acceleration exhaustion or strong displacement.
 // Only same-market CLOSED SPOT bars contribute to the trigger.
 const hourExtreme=hour?.available&&(side==="UP"?hour.position>=0.93:hour.position<=0.07);
 const twoExtreme=two?.available&&(side==="UP"?two.position>=0.93:two.position<=0.07);
 const d=side==="UP"?1:-1;
 const p3Ahead=d*p3,p5Ahead=finite(p5)?d*p5:null;
 const exhaustedAtDoubleEdge=!!(hourExtreme&&twoExtreme&&finite(p5Ahead)&&
   ((p3Ahead>=Math.max(12,1.15*(ctx.atr1mBps||0))&&p5Ahead>=16)||
     (p5Ahead>=20&&p3Ahead<p5Ahead*0.5)));
 const ready=!reversalAtEdge&&!exhaustedAtDoubleEdge;
 return {ready,
   reason:reversalAtEdge?"V25_ENTRY_EDGE_REVERSAL_OR_EXHAUSTION":
     exhaustedAtDoubleEdge?"V28_DOUBLE_HORIZON_PRICE_EXHAUSTION":"V28_ENTRY_POSITION_OK",
   nearSupport,nearResistance,shortMove3mBps:round(p3,4),
   overextensionBps:round(extended,4),farTrendAgainst:farAgainst,
   exhaustedAtDoubleEdge,longContextCaution:farAgainst,referenceSpotPrice:ctx.spotClose};
}
// V24: compare price movement strictly within CLOSED spot 1m candles.
// Never subtract a USD-M index quote from a spot candle close (different price basis).
export function closedSpotPriceAction(bars){
 if(!Array.isArray(bars)||bars.length<6)return {available:false};
 const last=bars.at(-1).c;
 const returnsBps=n=>round((last/bars.at(-1-n).c-1)*10000,4);
 const recent=bars.slice(-3);
 return {available:true,source:"VERIFIED_CLOSED_SPOT_1M_SAME_BASIS",
   oneMinuteBps:returnsBps(1),threeMinuteBps:returnsBps(3),fiveMinuteBps:returnsBps(5),
   upCloses:recent.filter(x=>x.c>x.o).length,
   downCloses:recent.filter(x=>x.c<x.o).length,
   lastCloseAt:bars.at(-1).t+60000};
}
export function selectTenMinuteDirection(timeframes,liveBps=null,priceAction=null){
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
 const p3=priceAction?.threeMinuteBps,p5=priceAction?.fiveMinuteBps;
 const upCloses=priceAction?.upCloses??0,downCloses=priceAction?.downCloses??0;
 // V30: a completed 3m+5m turn aligned with 10/15/30m need not depend
 // on a 12-second tick being big enough to qualify; forbid opposing live move.
 const closedReversal=one!==0&&one===two&&one!==five&&
   sides["10m"]===one&&sides["15m"]===one&&sides["30m"]===one&&
   liveDirection!==-one&&finite(p3)&&finite(p5)&&
   one*p3>=10&&one*p5>=8&&(one>0?upCloses>=2:downCloses>=2);
 const earlyTurn=one!==0&&one===two&&one!==five&&(
   (one===liveDirection&&finite(p3)&&
      (one>0?p3>=8&&upCloses>=2:p3<=-8&&downCloses>=2))||
   closedReversal);
 // A strong, VERIFIED underlying 5/10/15/30m trend can resume while 1m/2m
 // indicators lag after a countertrend pullback. EMA must also confirm below.
 const trendResumption=one!==0&&one===two&&one!==five&&
   candidate===five&&sides["10m"]===five&&
   sides["15m"]===five&&sides["30m"]===five&&
   liveDirection!==-candidate&&finite(p3)&&finite(p5)&&
   candidate*p3>=6&&candidate*p5>=8&&Math.abs(combined)>=0.15;
 // V31: 10m vote can lag a fresh completed swing while 5/15/30m
 // trends agree. This is the repeated V30 EARLY_REVERSAL_UNCONFIRMED
 // case, where BOTH 1/2m indicators disagree with the primary trend.
 // Require independent 3m AND 5m closed spot evidence; veto strong
 // contrary index ticks and all one-sided (unconfirmed) swings.
 const dominantSide=(five!==0&&five===sides["15m"]&&five===sides["30m"])?five:0;
 const dominantRecovery=dominantSide!==0&&one===two&&one===-dominantSide&&
   sides["10m"]!==dominantSide&&finite(p3)&&finite(p5)&&
   dominantSide*p3>=9&&dominantSide*p5>=12&&
   !(finite(liveBps)&&dominantSide*liveBps<=-3)&&
   (dominantSide>0?downCloses<=1:upCloses<=1);
 // Avoid blindly chasing a six-timeframe trend against a clear 3m+5m reversal.
 const adverseAction=finite(p3)&&finite(p5)&&(
   (candidate<0&&p3>=6&&p5>=10&&upCloses>=2)||
   (candidate>0&&p3<=-6&&p5<=-10&&downCloses>=2));
 let reason="V23_NORMALIZED_TREND",selected=candidate;
 // A 1m + 2m reversal with a confirming index tick is not six independent
 // votes for the older direction. Wait for new evidence before publishing.
 if(earlyTurn){
   reason="V24_CONFIRMED_EARLY_REVERSAL";selected=one;
 }else if(trendResumption){
   reason="V30_TREND_RESUMPTION_SPOT_CONFIRMED";selected=candidate;
 }else if(dominantRecovery){
   reason="V31_DOMINANT_TREND_SPOT_RECOVERY";selected=dominantSide;
 }else if(one!==0&&one===two&&one!==five&&liveDirection!==-one)
   reason="V23_EARLY_REVERSAL_UNCONFIRMED";
 else if(candidate!==0&&one!==0&&two===one&&candidate!==one&&
    liveDirection===one)
   reason="V23_SHORT_TERM_REVERSAL_CONFLICT";
 else if(candidate!==0&&liveDirection===-candidate&&
    finite(liveBps)&&Math.abs(liveBps)>=4)
   reason="V23_STRONG_LIVE_PRICE_CONFLICT";
 else if(adverseAction)
   reason="V24_SPOT_REVERSAL_CONFLICT";
 else if(Math.abs(combined)<0.20)
   reason="V23_SCORE_TOO_WEAK";
 // V32 frequency-first: on a mixed market, use actual CLOSED 3m spot
 // direction if at least two independent short/long trend votes support it.
 // No signal on stale data, flat 3m price or a strong opposing live tick.
 // This raises opportunity count, not predicted hit probability.
 const wasAccepted=["V23_NORMALIZED_TREND","V24_CONFIRMED_EARLY_REVERSAL",
   "V30_TREND_RESUMPTION_SPOT_CONFIRMED","V31_DOMINANT_TREND_SPOT_RECOVERY"].includes(reason);
 // Require meaningful CLOSED spot movement, not a 2bp 3-minute wiggle.
 // Short 1m+2m votes are correlated; one long vote alone must also have a
 // confirming 5m close. Two independent higher-period votes can substitute.
 const spotSide=finite(p3)&&Math.abs(p3)>=3?sign(p3):0;
 const shortSupport=[one,two,five].filter(x=>x===spotSide).length;
 const longSupport=["10m","15m","30m"].filter(tf=>sides[tf]===spotSide).length;
 const spot5Supports=finite(p5)&&spotSide*p5>=3;
 const liveReject=finite(liveBps)&&spotSide*liveBps<=-0.8;
 const confirmedVotes=shortSupport>=2||(shortSupport>=1&&(longSupport>=1||spot5Supports));
 const highFrequency=!wasAccepted&&spotSide!==0&&!liveReject&&
   shortSupport>=1&&confirmedVotes;
 if(highFrequency){reason="V32_FREQUENCY_CLOSED_SPOT";selected=spotSide;}
 const accepted=wasAccepted||highFrequency;
 return {direction:accepted?direction(selected):null,decisionReason:reason,
   trendScore:round(combined,4),weightedTimeframeScore:round(baseline,4),
   currentPriceDirection:direction(liveDirection),
   liveIndexChangeBps:finite(liveBps)?round(liveBps,4):null,
   normalizedVotes:norm,shortTermDirection:direction(sign((norm["1m"]||0)+(norm["2m"]||0))),
   longContextDirection:direction(sign((norm["15m"]||0)+(norm["30m"]||0))),
   timeframeWeightCoverage:round(observedWeight,4),
   trendResumption,dominantRecovery,closedReversal,highFrequency,noCalibratedConfidence:true};
}
// V28: veto weak, internally conflicting continuation signals while keeping
// a clearly confirmed emerging 1m/2m reversal path available in BOTH directions.
// The 30m/5m conflicts only act as vetoes when at least another indicator warns.
export function assessTrendConflict(side,selected,timeframes,emaEntry,priceAction,entryTiming,ctx){
 if(side!=="UP"&&side!=="DOWN")return {ready:false,reason:"NO_DIRECTION"};
 const d=side==="UP"?1:-1;
 const trend=name=>timeframes?.[name]?.available?timeframes[name].trend:null;
 const against=name=>trend(name)!==null&&trend(name)!==side;
 const conflicts=["1m","2m","5m","10m","15m","30m"].filter(against);
 const fiveAgainst=against("5m"),longAgainst=against("30m"),
   shortAgainst=against("1m")||against("2m");
 const emaOpposed=emaEntry?.["1m"]?.available&&emaEntry["1m"].direction!==side;
 const spot3=priceAction?.threeMinuteBps;
 const oppositeSpot=finite(spot3)&&d*spot3<=-2;
 const weak=finite(selected?.trendScore)&&Math.abs(selected.trendScore)<0.48;
 const earlyTurn=selected?.decisionReason==="V24_CONFIRMED_EARLY_REVERSAL";
 // A real early turn must still be demonstrable in spot candles and aligned
 // with the actual 1m and 2m votes, not merely a 12s index-price fluctuation.
 const confirmedTurn=earlyTurn&&trend("1m")===side&&trend("2m")===side&&
   finite(spot3)&&d*spot3>=8;
 const repeatedDisagreement=(fiveAgainst&&(longAgainst||shortAgainst||emaOpposed||weak))||
   (longAgainst&&(shortAgainst||emaOpposed||oppositeSpot))||
   (longAgainst&&against("15m")&&finite(spot3)&&d*spot3<6)||
   (emaOpposed&&(shortAgainst||oppositeSpot||weak));
 // V29: V28's confirmedTurn shortcut wrongly bypassed a VERIFIED adverse
 // 4h/24h trend and 5/10/15/30m disagreement.
 const farAgainst=entryTiming?.farTrendAgainst===true;
 const severeLongConflict=farAgainst&&against("15m")&&against("30m");
 const e1=emaEntry?.["1m"],e2=emaEntry?.["2m"];
 const hour=ctx?.ranges?.["60m"];
 const hPos=hour?.available?(side==="UP"?hour.position:1-hour.position):null;
 const inSafeHour=finite(hPos)&&hPos<=0.85;
 const signedScore=d*(selected?.trendScore??0);
 const requalified=severeLongConflict&&inSafeHour&&
   e1?.available===true&&e2?.available===true&&
   e1.direction===side&&e2.direction===side&&
   finite(spot3)&&d*spot3>=6&&signedScore>=0.15&&
   d*e2.ema9SlopeBps>0&&(
     (confirmedTurn&&d*e1.ema9AccelerationBps>=-1)||
     (!earlyTurn&&trend("5m")===side&&trend("10m")===side&&
       d*e1.ema9AccelerationBps>=0));
 const severeLongUnconfirmed=severeLongConflict&&!requalified;
 // The resumption exception cannot bypass an adverse 4h/24h context,
 // 24h price-exhaustion gate, or repeat/loss-reentry publication guards.
 const resumption=selected?.decisionReason==="V30_TREND_RESUMPTION_SPOT_CONFIRMED"&&
   !severeLongConflict&&
   ["5m","10m","15m","30m"].every(name=>trend(name)===side)&&
   e1?.available===true&&e2?.available===true&&
   finite(priceAction?.threeMinuteBps)&&d*priceAction.threeMinuteBps>=6&&
   finite(priceAction?.fiveMinuteBps)&&d*priceAction.fiveMinuteBps>=8&&
   d*e1.spreadChangeBps>=0.25&&d*e1.ema9AccelerationBps>=0&&
   d*e2.ema9SlopeBps>=-1;
 // V31: require 5/15/30m independent votes plus actual spot momentum
 // and a returning short EMA. Never override an adverse 4h/24h direction,
 // hard entry-timing filters, or duplicate/rolling quotas.
 const dominant=selected?.decisionReason==="V31_DOMINANT_TREND_SPOT_RECOVERY"&&
   farAgainst!==true&&
   ["5m","15m","30m"].every(name=>trend(name)===side)&&
   e1?.available===true&&e2?.available===true&&
   finite(priceAction?.threeMinuteBps)&&d*priceAction.threeMinuteBps>=9&&
   finite(priceAction?.fiveMinuteBps)&&d*priceAction.fiveMinuteBps>=12&&
   d*e1.spreadChangeBps>=0.20&&d*e1.ema9AccelerationBps>=0&&
   d*e2.ema9SlopeBps>=-1;
 // V32 frequency path does not demand full six-period agreement. Allow
 // confirmed 3m spot + an aligned 1/2m or 5m vote and EMA. A 4h/24h
 // countertrend requires BOTH EMA confirmations and avoids hourly extremes.
 const frequencyRequested=selected?.decisionReason==="V32_FREQUENCY_CLOSED_SPOT";
 const alignedShort=trend("1m")===side||trend("2m")===side||trend("5m")===side;
 const emaSupports=e1?.available&&e2?.available&&
   (e1.direction===side||e2.direction===side);
 // V32 frequency-first: allow a confirmed short-lived countertrend direction
 // only with two aligned EMA directions, non-extreme hourly position and
 // 5m spot support. This prioritizes opportunities; it does NOT calibrate hit rate.
 const againstBothLong=against("15m")&&against("30m");
 const hourly=ctx?.ranges?.["60m"];
 const nearEdge=hourly?.available&&
   (side==="UP"?hourly.position>=0.94:hourly.position<=0.06);
 const counterConfirmed=!againstBothLong||(
   e1?.available&&e2?.available&&e1.direction===side&&e2.direction===side&&
   finite(priceAction?.fiveMinuteBps)&&d*priceAction.fiveMinuteBps>=4&&
   !nearEdge);
 // A verified opposing 4h/24h regime remains a safety boundary.
 // Frequency-first relaxes ordinary timeframes, not a proven severe long risk.
 const farRequalified=!severeLongConflict||requalified;
 const frequencyReady=frequencyRequested&&alignedShort&&emaSupports&&
   counterConfirmed&&finite(spot3)&&d*spot3>=3&&farRequalified;
 const ready=frequencyReady||(!severeLongUnconfirmed&&
   (confirmedTurn||resumption||dominant||!repeatedDisagreement));
 return {ready,reason:ready?"V32_TREND_CONTEXT_OK":
   severeLongUnconfirmed?"V29_UNCONFIRMED_4H_24H_COUNTERTREND":
   "V28_CONFLICTED_MULTITIMEFRAME_ENTRY",
   conflicts,confirmedTurn,resumption,dominant,frequencyReady,fiveAgainst,longAgainst,shortAgainst,
   emaOpposed,oppositeSpot,weak,farAgainst,severeLongConflict,
   requalified,severeLongUnconfirmed};
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
 const spotPriceAction=closedSpotPriceAction(one.bars);
 const entryHorizons=analyzeEntryHorizons({one:one.bars,five:five.bars,thirty:thirty.bars});
 const result=selectTenMinuteDirection(timeframes,liveBps,spotPriceAction);
 const entryTiming=assessEntryTiming(result.direction,entryHorizons,spotPriceAction);
 const emaEntry={"1m":ema921EntrySnapshot(one.bars,"1m"),
   "2m":ema921EntrySnapshot(mapping["2m"],"2m"),
   "5m":ema921EntrySnapshot(five.bars,"5m")};
 const emaTiming=assessEmaEntry(result.direction,emaEntry,entryHorizons,spotPriceAction);
 const trendConflict=assessTrendConflict(result.direction,result,timeframes,emaEntry,spotPriceAction,entryTiming,entryHorizons);
 const holdForHorizon=!!result.direction&&!entryTiming.ready;
 const holdForEma=!!result.direction&&!emaTiming.ready;
 const holdForConflict=!!result.direction&&!trendConflict.ready;
 return {...result,direction:(holdForHorizon||holdForEma||holdForConflict)?null:result.direction,
   decisionReason:holdForHorizon?entryTiming.reason:holdForEma?emaTiming.reason:
     holdForConflict?trendConflict.reason:result.decisionReason,
   entryTiming,entryHorizons,emaEntry,emaTiming,trendConflict,spotPriceAction,liveIndexDelta:validPrev?round(liveDelta,5):null,
   currentIndexPrice:indexPrice,indexAt,timeframes,
   timeframeCoverage:Object.values(timeframes).filter(t=>t.available).length,
   timeframeCount:6,aggregationSource:"CLOSED_BINANCE_SPOT_1M_ALIGNED_2M_10M",
   confidenceCalibrated:false};
}
