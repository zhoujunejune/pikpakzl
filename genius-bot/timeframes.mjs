// Higher-timeframe summaries for PAPER-ONLY DeepSeek research.
// Input: Binance USD-M futures closed candles. No exchange orders.
export const TIMEFRAMES=Object.freeze({
  '15m':{ms:900000,ttlMs:90000},
  '1h':{ms:3600000,ttlMs:300000},
  '4h':{ms:14400000,ttlMs:900000},
  '1d':{ms:86400000,ttlMs:3600000},
  '1w':{ms:604800000,ttlMs:14400000}
});
const finite=Number.isFinite;
const rnd=(x,n=4)=>Number(x.toFixed(n));
function ema(values,period){
  let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const x of values.slice(period))value+=(x-value)*(2/(period+1));
  return value;
}
function rsi(values,period=14){
  let up=0,down=0;
  const diff=values.slice(-(period+1));
  for(let i=1;i<diff.length;i++){const d=diff[i]-diff[i-1];up+=Math.max(0,d);down+=Math.max(0,-d);}
  return down===0?(up===0?50:100):100-100/(1+up/down);
}
export function summarizeTimeframe(raw,interval,now=Date.now()){
  const cfg=TIMEFRAMES[interval];
  if(!cfg)throw Error('UNSUPPORTED_HIGHER_TIMEFRAME');
  if(!Array.isArray(raw))throw Error('INVALID_HIGHER_KLINES');
  const {ms}=cfg;
  const closed=raw.filter(x=>Array.isArray(x)&&Number.isSafeInteger(x[0])&&x[0]+ms<=now)
    .map(x=>({at:x[0],close:Number(x[4]),high:Number(x[2]),low:Number(x[3]),volume:Number(x[5])}));
  if(closed.length<75)throw Error('INSUFFICIENT_'+interval.toUpperCase()+'_HISTORY');
  const bars=closed.slice(-120);
  for(let i=0;i<bars.length;i++){
    const b=bars[i];
    if(!Number.isSafeInteger(b.at)||b.at<=0||![b.close,b.high,b.low,b.volume].every(finite)||
      b.close<=0||b.high<b.close||b.low>b.close||b.low<=0||b.volume<0||
      i>0&&b.at-bars[i-1].at!==ms)throw Error('INVALID_'+interval.toUpperCase()+'_CANDLES');
  }
  const last=bars.at(-1),ageMs=now-(last.at+ms);
  if(ageMs<0||ageMs>ms+120000)throw Error('STALE_'+interval.toUpperCase()+'_CANDLES');
  const closes=bars.map(b=>b.close),volumes=bars.map(b=>b.volume);
  const e9=ema(closes,9),e21=ema(closes,21),e55=ema(closes,55);
  const h=bars.slice(-20),highest=Math.max(...h.map(x=>x.high)),lowest=Math.min(...h.map(x=>x.low));
  let trueRanges=[];
  for(let i=bars.length-14;i<bars.length;i++){
    const b=bars[i],prev=bars[i-1].close;
    trueRanges.push(Math.max(b.high-b.low,Math.abs(b.high-prev),Math.abs(b.low-prev)));
  }
  const atr=trueRanges.reduce((a,b)=>a+b,0)/14;
  const v20=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const bias=e9>e21&&e21>e55?'UP':e9<e21&&e21<e55?'DOWN':'MIXED';
  return {interval,bias,close:last.close,ema9:rnd(e9,6),ema21:rnd(e21,6),
    ema55:rnd(e55,6),rsi14:rnd(rsi(closes),2),
    atrPct14:rnd(atr/last.close*100,3),
    change20BarsPct:rnd((last.close/closes.at(-21)-1)*100,3),
    change60BarsPct:rnd((last.close/closes.at(-61)-1)*100,3),
    high20:highest,low20:lowest,volumeRatio20:rnd(v20>0?last.volume/v20:0,3),
    lastClosedAt:last.at+ms,ageMs,bars:bars.length};
}
export function higherTimeframesComplete(frames){
  return Boolean(frames&&['15m','1h','4h','1d','1w'].every(k=>frames[k]&&frames[k].interval===k));
}
