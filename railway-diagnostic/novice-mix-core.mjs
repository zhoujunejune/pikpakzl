// NOVICE_MIX_LOW_V1: research-only, no trade/signal integration.
// All market features are from one immutable pre-deadline snapshot.
export const MODEL='NOVICE_MIX_LOW_V1';
export const FACTORS=['price','kline','technical','previous','gambler','volume','range'];
export const BASE_WEIGHTS=Object.freeze([.28,.20,.18,.14,.10,.06,.04]);
const sign=n=>n>0?1:n<0?-1:0;
const safe=n=>typeof n==='number'&&Number.isFinite(n);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const direction=x=>x>=0?'UP':'DOWN';
function ema(xs,period){
  if(xs.length<period+2)return null;
  const alpha=2/(period+1);
  let value=xs[0];for(let i=1;i<xs.length;i++)value=alpha*xs[i]+(1-alpha)*value;
  return value;
}
function rsi(closes){
  const a=closes.slice(-15);if(a.length<15)return null;
  let u=0,d=0;
  for(let i=1;i<a.length;i++){const delta=a[i]-a[i-1];u+=Math.max(0,delta);d+=Math.max(0,-delta);}
  return d===0?(u===0?50:100):100-100/(1+u/d);
}
export function weighted(factors,weights=BASE_WEIGHTS) {
  let s=0,w=0;
  FACTORS.forEach((name,i)=>{
    const v=factors[name];
    if(safe(v)&&safe(weights[i])&&weights[i]>0){s+=v*weights[i];w+=weights[i];}
  });
  return {score:w?Number((s/w).toFixed(6)):null,available:w};
}
export function predictMarket(snapshot,history=[],weights=BASE_WEIGHTS,clock=Date.now()){
  const round=Math.floor(clock/300000)*300000;
  const one=snapshot?.candles?.['1m']?.rows;
  const five=snapshot?.candles?.['5m']?.rows;
  const latest=snapshot?.latest;
  const fresh=snapshot?.ok===true&&snapshot.readOnly===true&&
    Number.isFinite(snapshot.generatedAtMs)&&snapshot.generatedAtMs<=clock&&clock-snapshot.generatedAtMs<5000&&
    latest&&safe(latest.lastPrice)&&latest.lastPrice>0&&
    safe(latest.eventMs)&&clock-latest.eventMs<12000&&
    Array.isArray(one)&&one.length>=35&&Array.isArray(five)&&five.length>=25;
  if(!fresh){
    const last=history.at(-1)?.direction;
    return {model:MODEL,round,lockedAt:clock,direction:last==='UP'?'UP':last==='DOWN'?'DOWN':'UP',
      status:'NO_DATA_FALLBACK',score:null,factors:{},reason:'MISSING_OR_STALE_READONLY_MARKET_INPUT'};
  }
  // Read ONLY candles known at observation time. These are rolling current candles,
  // not historical final closes obtained after the signal lock.
  const m=one.filter(c=>safe(c.startMs)&&c.startMs<=clock&&safe(c.close)&&safe(c.open));
  const f=five.filter(c=>safe(c.endMs)&&c.endMs<clock&&safe(c.open)&&safe(c.close));
  if(m.length<35||f.length<3)return {model:MODEL,round,lockedAt:clock,direction:history.at(-1)?.direction==='DOWN'?'DOWN':'UP',
    status:'NO_DATA_FALLBACK',score:null,factors:{},reason:'INSUFFICIENT_PRELOCK_CANDLES'};
  const cur=m.at(-1),prev=m.at(-2),p=latest.lastPrice;
  const last3=m.slice(-3),last20=m.slice(-20),lastVolumes=m.slice(-11,-1);
  const closes=m.map(x=>x.close);
  const short=ema(closes.slice(-40),12),long=ema(closes.slice(-40),26);
  const indicatorRsi=rsi(closes);
  const factors={
    price:sign(p-prev.close),
    kline:clamp((sign(p-cur.open)+sign(last3.reduce((v,x)=>v+(x.close-x.open),0)))/2,-1,1),
    technical:sign((indicatorRsi!=null?(indicatorRsi>70?-1:indicatorRsi<30?1:0):0)+(short!=null&&long!=null?sign(short-long):0)),
    previous:history.at(-1)?.direction==='UP'?1:history.at(-1)?.direction==='DOWN'?-1:null,
    gambler:sign(-f.slice(-3).reduce((s,c)=>s+sign(c.close-c.open),0)),
    volume:lastVolumes.length>=8?
      (cur.volume>lastVolumes.reduce((s,c)=>s+c.volume,0)/lastVolumes.length*1.2?sign(p-cur.open):0):null,
    range:(()=>{const hi=Math.max(...last20.map(c=>c.high)),lo=Math.min(...last20.map(c=>c.low));
      return hi>lo?(p>(lo+(hi-lo)*.85)?1:p<(lo+(hi-lo)*.15)?-1:0):0;})()
  };
  const {score,available}=weighted(factors,weights);
  const d=score===null?(history.at(-1)?.direction==='DOWN'?'DOWN':'UP'):direction(score);
  return {model:MODEL,round,lockedAt:clock,direction:d,status:available>=.5?'LOCKED':'PARTIAL_INPUT',
    score,factors,weights:weights.slice(),marketSnapshotAt:snapshot.generatedAtMs,
    marketSource:snapshot.source,reason:null};
}
export function summarize(rows) {
  const sorted=[...rows].sort((a,b)=>a.round-b.round);
  const tally=list=>{const settled=list.filter(x=>x.actual==='UP'||x.actual==='DOWN');
    const hits=settled.filter(x=>x.actual===x.direction).length;
    return {samples:settled.length,hits,accuracy:settled.length?hits/settled.length:null};};
  const valid=sorted.filter(x=>x.status==='LOCKED'||x.status==='PARTIAL_INPUT');
  const settled=valid.filter(x=>x.actual==='UP'||x.actual==='DOWN');
  return {rounds:sorted.length,locked:valid.length,pending:valid.length-settled.length,
    dataGaps:sorted.length-valid.length,
    overall:tally(valid),up:tally(valid.filter(x=>x.direction==='UP')),
    down:tally(valid.filter(x=>x.direction==='DOWN')),recent20:tally(settled.slice(-20)),
    recent100:tally(settled.slice(-100))};
}
export function fitExperimentalWeights(rows,previous=BASE_WEIGHTS){
  const settled=rows.filter(x=>(x.actual==='UP'||x.actual==='DOWN')&&
    (x.status==='LOCKED'||x.status==='PARTIAL_INPUT')&&x.factors&&Object.keys(x.factors).length>=5);
  if(settled.length<80)return {status:'COLLECTING',required:80,samples:settled.length,weights:previous};
  const train=settled.slice(-160,-20),holdout=settled.slice(-20);
  const accuracy=(list,w)=>list.filter(r=>{
    const scored=weighted(r.factors,w).score;
    return scored!==null&&direction(scored)===r.actual;
  }).length/list.length;
  const initial=accuracy(holdout,previous);
  let best=previous,bestTrain=accuracy(train,previous);
  // Deliberately restricted search: no future outcomes, no test-set optimization.
  for(let i=0;i<FACTORS.length;i++)for(const multiplier of [.25,.5,1.5,2]){
    const candidate=previous.map((w,j)=>j===i?w*multiplier:w);
    const sum=candidate.reduce((a,b)=>a+b,0);
    const normalized=candidate.map(w=>w/sum);
    const score=accuracy(train,normalized);
    if(score<bestTrain-.015){best=normalized;bestTrain=score;}
  }
  const holdoutScore=accuracy(holdout,best);
  const adopted=best!==previous&&holdoutScore<=initial-.05;
  return {status:adopted?'ADOPTED':'HOLDOUT_NOT_BETTER',samples:settled.length,
    trainingSamples:train.length,holdoutSamples:holdout.length,
    trainingAccuracy:bestTrain,holdoutAccuracy:holdoutScore,incumbentHoldoutAccuracy:initial,
    weights:adopted?best:previous};
}
