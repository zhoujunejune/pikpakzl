// Standalone shadow predictor. No order APIs, private trading credentials or production imports.
export const NAME = '突破20%即可';
export const VERSION = 'BREAKOUT20_RSI_MACD_RANGE_V1';
export const FEATURE_NAMES = Object.freeze([
  'rsi_1m', 'rsi_5m', 'macd_hist_1m', 'macd_hist_5m',
  'price_position_1m20', 'price_position_5m12',
  'distance_high_1m20', 'distance_low_1m20',
  'distance_high_5m12', 'distance_low_5m12',
]);
const clip = (v,a=-3,b=3)=>Math.max(a,Math.min(b,v));
const num = x => (x === null || x === undefined || x === '' ? NaN : Number(x));
export function parseKline(k) {
  if(!k)return null;
  const isArray=Array.isArray(k);
  const row={
    t:num(isArray?k[0]:k.t), o:num(isArray?k[1]:k.o),
    h:num(isArray?k[2]:k.h), l:num(isArray?k[3]:k.l),
    c:num(isArray?k[4]:k.c), end:num(isArray?k[6]:k.T),
    closed:isArray?Number(k[6])<Date.now():k.x===true,
  };
  if (![row.t,row.o,row.h,row.l,row.c,row.end].every(Number.isFinite) ||
    row.o<=0||row.h<row.l||row.c<=0||row.end<=row.t ||
    row.o>row.h||row.o<row.l||row.c>row.h||row.c<row.l) return null;
  return row;
}
function ema(values,period){
  if(values.length<period)return null;
  let prev=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const out=Array(period-1).fill(null).concat(prev);
  for(let i=period;i<values.length;i++){
    prev=values[i]*(2/(period+1))+prev*(1-2/(period+1));out.push(prev);
  }
  return out;
}
export function rsi(closes,n=14){
  if(closes.length<n+1)return null;
  let up=0,down=0;
  for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];up+=Math.max(0,d);down+=Math.max(0,-d);}
  up/=n;down/=n;
  for(let i=n+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    up=(up*(n-1)+Math.max(0,d))/n;down=(down*(n-1)+Math.max(0,-d))/n;
  }
  return down===0?(up===0?50:100):100-100/(1+up/down);
}
export function macdHistogram(closes){
  if(closes.length<35)return null;
  const a=ema(closes,12), b=ema(closes,26);
  const line=closes.map((_,i)=>a[i]===null||b[i]===null?null:a[i]-b[i]);
  const signal=ema(line.slice(25),9);
  return signal?.at(-1)===null||signal?.at(-1)===undefined?null:line.at(-1)-signal.at(-1);
}
export function features(one,five,price){
  // Fully closed bars only. The live price may come from an unfinished candle
  // observed BEFORE the 8-second decision lock, never after it.
  if(one.length<35||five.length<35||!Number.isFinite(price)||price<=0)return null;
  const r1=rsi(one.map(x=>x.c)),r5=rsi(five.map(x=>x.c));
  const m1=macdHistogram(one.map(x=>x.c)),m5=macdHistogram(five.map(x=>x.c));
  if(![r1,r5,m1,m5].every(Number.isFinite))return null;
  const a=one.slice(-20), b=five.slice(-12);
  const high1=Math.max(...a.map(x=>x.h)), low1=Math.min(...a.map(x=>x.l));
  const high5=Math.max(...b.map(x=>x.h)), low5=Math.min(...b.map(x=>x.l));
  const range1=high1-low1, range5=high5-low5;
  if(range1<=0||range5<=0)return null;
  const vector=[
    (r1-50)/25,(r5-50)/25,
    (m1/price)*1e4/5,(m5/price)*1e4/5,
    ((price-low1)/range1-.5)*2,((price-low5)/range5-.5)*2,
    (price-high1)/range1,(price-low1)/range1,
    (price-high5)/range5,(price-low5)/range5,
  ].map(z=>clip(z));
  return {vector,indicators:{
    rsi1m:r1,rsi5m:r5,macdHist1m:m1,macdHist5m:m5,
    high1m20:high1,low1m20:low1,high5m12:high5,low5m12:low5,
    latestPrice:price,position1m:(price-low1)/range1,position5m:(price-low5)/range5,
  }};
}
const sigmoid=z=>1/(1+Math.exp(-clip(z,-25,25)));
export function probability(weights,x){
  if(!weights||weights.length!==x.length+1)return null;
  return sigmoid(weights[0]+x.reduce((acc,v,i)=>acc+v*weights[i+1],0));
}
export function baseline(x){
  // Clearly labeled, fixed, untrained initialization policy.
  const z=.27*x[0]+.32*x[1]+.27*x[2]+.35*x[3]+.18*x[4]+.25*x[5];
  return sigmoid(z);
}
function fit(rows){
  const weights=Array(FEATURE_NAMES.length+1).fill(0);
  for(let epoch=0;epoch<180;epoch++){
    const grad=Array(weights.length).fill(0),lr=.24/(1+epoch/160);
    for(const r of rows){
      const p=probability(weights,r.x),error=p-r.y;
      grad[0]+=error;
      for(let j=0;j<r.x.length;j++)grad[j+1]+=error*r.x[j];
    }
    for(let j=0;j<weights.length;j++)
      weights[j]-=lr*(grad[j]/rows.length+(j===0?0:.045*weights[j]));
  }
  return weights;
}
export function train(samples,{minimum=100}={}){
  const sorted=samples.filter(r=>Array.isArray(r.x)&&r.x.length===FEATURE_NAMES.length&&
    r.x.every(Number.isFinite)&&(r.y===0||r.y===1)&&Number.isFinite(r.t))
    .sort((a,b)=>a.t-b.t);
  // Duplicated calendar rounds must not be counted twice.
  const unique=sorted.filter((r,i)=>i===0||r.t!==sorted[i-1].t).slice(-600);
  if(unique.length<minimum)return {ok:false,reason:'INSUFFICIENT_SETTLED_ROUNDS',samples:unique.length,minimum};
  const n=Math.max(20,Math.floor(unique.length*.20));
  const training=unique.slice(0,-n-1); // embargo one 5-minute round
  const holdout=unique.slice(-n);
  if(training.length<60)return {ok:false,reason:'INSUFFICIENT_TRAINING_WINDOW',samples:training.length};
  const weights=fit(training);
  const evaluate=predict=>{
    const scored=holdout.map(r=>({p:predict(r.x),y:r.y}));
    return {n:scored.length,
      accuracy:scored.filter(r=>(r.p>=.5?1:0)===r.y).length/scored.length,
      brier:scored.reduce((s,r)=>s+(r.p-r.y)**2,0)/scored.length};
  };
  const candidate=evaluate(x=>probability(weights,x));
  const fixed=evaluate(baseline);
  const adopted=candidate.accuracy>fixed.accuracy+.005&&candidate.brier<=fixed.brier;
  return {ok:true,adopted,weights:adopted?weights:null,candidate,fixed,
    trainingSamples:training.length,holdoutSamples:holdout.length,
    trainingEnd:training.at(-1).t,holdoutStart:holdout[0].t};
}
export function prospectiveStats(rows){
  const locked=rows.filter(r=>r.direction==='UP'||r.direction==='DOWN');
  const settled=locked.filter(r=>r.actual==='UP'||r.actual==='DOWN');
  const tally=items=>({samples:items.length,
    hits:items.filter(r=>r.direction===r.actual).length,
    accuracy:items.length?items.filter(r=>r.direction===r.actual).length/items.length:null});
  return {rounds:rows.length,locked:locked.length,
    dataGaps:rows.filter(r=>r.status==='DATA_GAP').length,
    pending:locked.length-settled.length,overall:tally(settled),
    up:tally(settled.filter(r=>r.direction==='UP')),
    down:tally(settled.filter(r=>r.direction==='DOWN')),
    recent20:tally(settled.slice(-20)),recent100:tally(settled.slice(-100))};
}
