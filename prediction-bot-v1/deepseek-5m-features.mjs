// Read-only, causal BTC market feature extraction from the actual Alibaba
// /api/shadow-market-data schema. Never use future candles or look-ahead labels.
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fix=(x,n=5)=>finite(x)?Number(x.toFixed(n)):null;
const safeDiv=(a,b)=>finite(a)&&finite(b)&&b!==0?a/b:null;
function candles(section,now){
 const src=Array.isArray(section)?section:
   Array.isArray(section?.rows)?section.rows:
   Array.isArray(section?.items)?section.items:
   Array.isArray(section?.candles)?section.candles:[];
 return src.filter(x=>{
  const t=Number(x?.startMs??x?.openTime??0);
  return Number.isSafeInteger(t)&&t>0&&t<=now&&
  ['open','high','low','close','volume'].every(k=>finite(Number(x[k]))&&Number(x[k])>=0)&&
  Number(x.high)>=Number(x.low);
 }).slice(-150).map(x=>({
  t:Number(x.startMs??x.openTime),
  o:Number(x.open),h:Number(x.high),l:Number(x.low),
  c:Number(x.close),v:Number(x.volume),closed:x.closed===true
 }));
}
const ema=(a,n)=>{
 if(a.length<n)return null;
 const factor=2/(n+1);
 let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n;
 for(const x of a.slice(n))e=e+(x-e)*factor;
 return e;
};
function emaSeries(a,n){
 const out=Array(a.length).fill(null);
 if(a.length<n)return out;
 let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n;out[n-1]=e;
 const f=2/(n+1);
 for(let i=n;i<a.length;i++){e=e+(a[i]-e)*f;out[i]=e;}
 return out;
}
function rsi(c,n=14){
 if(c.length<n+1)return null;
 let up=0,down=0;
 for(let i=1;i<=n;i++){const d=c[i]-c[i-1];up+=Math.max(d,0);down+=Math.max(-d,0);}
 up/=n;down/=n;
 for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];up=(up*(n-1)+Math.max(d,0))/n;down=(down*(n-1)+Math.max(-d,0))/n;}
 return down===0?(up===0?50:100):100-100/(1+up/down);
}
function macd(c){
 const fast=emaSeries(c,12),slow=emaSeries(c,26);
 const diffs=fast.map((v,i)=>finite(v)&&finite(slow[i])?v-slow[i]:null);
 const valid=diffs.filter(finite);
 if(valid.length<9)return null;
 const signal=ema(valid,9),line=valid.at(-1);
 return {macd:fix(line,6),signal:fix(signal,6),hist:fix(line-signal,6)};
}
function atr(rows,n=14){
 if(rows.length<n+1)return null;
 const tr=[];
 for(let i=1;i<rows.length;i++){
  const a=rows[i],prev=rows[i-1];
  tr.push(Math.max(a.h-a.l,Math.abs(a.h-prev.c),Math.abs(a.l-prev.c)));
 }
 return tr.slice(-n).reduce((x,y)=>x+y,0)/n;
}
function interval(rows,now){
 // Only fully closed OHLCV candles enter calculated momentum and indicators.
 // A partial candle can be shown separately but cannot contaminate closed bars.
 const full=rows.filter(x=>x.closed);
 const closes=full.map(x=>x.c);
 const last=full.at(-1),prev=full.at(-2);
 if(!last)return {closedCount:0,ready:false};
 const volumes=full.slice(-21,-1).map(x=>x.v);
 const baseline=volumes.length>=5?volumes.reduce((a,b)=>a+b,0)/volumes.length:null;
 const last20=full.slice(-20);
 const max20=Math.max(...last20.map(x=>x.h)),min20=Math.min(...last20.map(x=>x.l));
 const avg=last20.reduce((a,b)=>a+b.c,0)/last20.length;
 const ma20=full.length>=20?full.slice(-20).reduce((a,b)=>a+b.c,0)/20:null;
 const variance=full.length>=20?full.slice(-20).reduce((a,b)=>a+(b.c-ma20)**2,0)/20:null;
 const returns=closes.slice(-21).slice(1).map((v,i,a)=>Math.log(v/closes.at(-(a.length-i+1))));
 return {
  closedCount:full.length,ready:full.length>=35,
  rsi14:fix(rsi(closes),2),macd:macd(closes),
  ema9:fix(ema(closes,9),2),ema21:fix(ema(closes,21),2),
  sma20:fix(ma20,2),atr14:fix(atr(full),2),
  atrPct:fix(safeDiv(atr(full),last.c)*100,4),
  bollingerPctB:variance&&Math.sqrt(variance)>0?
    fix((last.c-(ma20-2*Math.sqrt(variance)))/(4*Math.sqrt(variance)),3):null,
  lastClosed:{startMs:last.t,close:last.c,volume:last.v},
  high20:fix(max20,2),low20:fix(min20,2),
  rangePosition20:max20>min20?fix((last.c-min20)/(max20-min20),3):null,
  momentum1Pct:prev?fix((last.c/prev.c-1)*100,4):null,
  momentum5Pct:closes.length>=6?fix((last.c/closes.at(-6)-1)*100,4):null,
  volumeRelative:finite(baseline)&&baseline>0?fix(last.v/baseline,3):null,
  realizedVolPct:returns.length>=10?fix(Math.sqrt(returns.reduce((a,b)=>a+b*b,0)/returns.length)*100,4):null,
  trendStrengthPct:finite(avg)&&avg>0?fix((last.c/avg-1)*100,4):null
 };
}
export function extractFeatures(data,now=Date.now()){
 if(data?.ok!==true||data?.readOnly!==true||data?.symbol!=='BTCUSDT')throw Error('UNTRUSTED_BTC_FEED');
 const q=data.latest||{},t=Number(q.eventMs),last=Number(q.lastPrice),opened=Number(q.roundOpenPrice);
 if(!Number.isSafeInteger(t)||now-t>18000||now-t< -1000||
    !(last>0)||!(opened>0)||q.marketFeedConnected===false)
  throw Error('BTC_FEED_INVALID_OR_STALE');
 const r=Math.floor(now/300000)*300000;
 if(Number(q.roundStartMs)!==r)throw Error('BTC_ROUND_MISMATCH');
 const m1=candles(data.candles?.['1m'],now),m5=candles(data.candles?.['5m'],now);
 const one=interval(m1,now),five=interval(m5,now);
 // Current unfinished candles shown only as partial context.
 const partial1=m1.filter(x=>!x.closed).at(-1);
 const partial5=m5.filter(x=>!x.closed).at(-1);
 const position=now-r;
 return {
  round:r,observedAt:t,elapsedSec:Math.floor(position/1000),remainingSec:Math.floor((300000-position)/1000),
  lastPrice:last,roundOpenPrice:opened,fromOpenPct:fix((last/opened-1)*100,5),
  oneMinute:one,fiveMinute:five,
  current1mPartial:partial1?{o:partial1.o,h:partial1.h,l:partial1.l,c:partial1.c,v:partial1.v}:null,
  current5mPartial:partial5?{o:partial5.o,h:partial5.h,l:partial5.l,c:partial5.c,v:partial5.v}:null,
  dataQuality:{oneMinuteBars:one.closedCount,fiveMinuteBars:five.closedCount,
    indicatorsReady:one.ready&&five.ready,marketAgeMs:now-t}
 };
}
