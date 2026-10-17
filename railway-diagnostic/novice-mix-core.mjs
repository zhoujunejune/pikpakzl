// RSI-only 8-second predictor; this is the sole feature for BOTH selectable
// signal models in the trade-control adapter. All historical mixed-feature
// weights, MACD, price trend, volume, range and preceding guesses are unused.
export const MODEL='NOVICE_MIX_LOW_V1'; // Retain stable external model identity.
export const INPUT_VERSION='RSI_ONLY_14_V1';
export const RSI_PERIOD=14;
export const FACTORS=Object.freeze(['rsi']);
export const BASE_WEIGHTS=Object.freeze([1]);
const safe=n=>typeof n==='number'&&Number.isFinite(n);
const valid=d=>d==='UP'||d==='DOWN';
const rsiFromCloses=(closes,period=RSI_PERIOD)=>{
  if(closes.length<period+1)return null;
  const a=closes.slice(-(period+1));
  let gain=0,loss=0;
  for(let i=1;i<a.length;i++){
    const change=a[i]-a[i-1];
    gain+=Math.max(0,change);loss+=Math.max(0,-change);
  }
  if(loss===0)return gain===0?50:100;
  const ratio=gain/loss;
  return 100-100/(1+ratio);
};
export function weighted(factors){
  const v=factors?.rsi;
  return {score:safe(v)?Number(((v-50)/50).toFixed(6)):null,
    available:safe(v)?1:0};
}
export function predictMarket(snapshot,history=[],weights=BASE_WEIGHTS,clock=Date.now()){
  const round=Math.floor(clock/300000)*300000;
  const one=snapshot?.candles?.['1m']?.rows;
  // Only 1-minute RSI observations may affect prediction/readiness. A
  // failure of unrelated 5-minute candles or separate spot/volume feeds must
  // not suppress an otherwise fresh RSI-only signal.
  const fresh=snapshot?.readOnly===true&&
    safe(snapshot.generatedAtMs)&&snapshot.generatedAtMs<=clock&&clock-snapshot.generatedAtMs<5000&&
    Array.isArray(one)&&one.length>=RSI_PERIOD+1;
  const fail=(reason)=>({model:MODEL,inputVersion:INPUT_VERSION,round,lockedAt:clock,
    direction:'UP',status:'NO_DATA_FALLBACK',score:null,rsi:null,factors:{},reason});
  if(!fresh)return fail('MISSING_OR_STALE_RSI_CANDLES');
  // Use only 1m prices known by the deadline; do not consume any later candle.
  const candles=one.filter(c=>safe(c.startMs)&&c.startMs<=clock&&
    safe(c.close)&&c.close>0).sort((a,b)=>a.startMs-b.startMs);
  if(candles.length<RSI_PERIOD+1||clock-candles.at(-1).startMs>125000)
    return fail('INSUFFICIENT_PRELOCK_RSI_CANDLES');
  const indicator=rsiFromCloses(candles.map(c=>c.close));
  if(!safe(indicator))return fail('RSI_CALCULATION_UNAVAILABLE');
  const {score}=weighted({rsi:indicator});
  // One technical indicator: momentum regime from the RSI midpoint.
  // RSI 50 is a deterministic neutral tie: UP (never WAIT with valid input).
  const direction=indicator>=50?'UP':'DOWN';
  return {model:MODEL,inputVersion:INPUT_VERSION,round,lockedAt:clock,
    direction,status:'LOCKED',score,rsi:Number(indicator.toFixed(4)),
    factors:{rsi:Number(indicator.toFixed(4))},weights:[1],
    marketSnapshotAt:snapshot.generatedAtMs,marketSource:snapshot.source,reason:null};
}
export function summarize(rows){
 const sorted=[...rows].sort((a,b)=>a.round-b.round);
 const tally=xs=>{const settled=xs.filter(x=>valid(x.actual));
  const hits=settled.filter(x=>x.actual===x.direction).length;
  return {samples:settled.length,hits,accuracy:settled.length?hits/settled.length:null};};
 const eligible=sorted.filter(x=>x.status==='LOCKED'&&x.inputVersion===INPUT_VERSION);
 const settled=eligible.filter(x=>valid(x.actual));
 return {rounds:sorted.length,locked:eligible.length,pending:eligible.length-settled.length,
  dataGaps:sorted.length-eligible.length,overall:tally(eligible),
  up:tally(eligible.filter(x=>x.direction==='UP')),
  down:tally(eligible.filter(x=>x.direction==='DOWN')),
  recent20:tally(settled.slice(-20)),recent100:tally(settled.slice(-100))};
}
export function fitExperimentalWeights(rows){
 // No weight search is meaningful with exactly one predictor; deliberately
 // disable the previous seven-factor optimizer and its low-win-rate target.
 const samples=rows.filter(x=>x.inputVersion===INPUT_VERSION&&x.status==='LOCKED'&&valid(x.actual)).length;
 return {status:'RSI_ONLY_FIXED',required:0,samples,weights:[1],
  inputVersion:INPUT_VERSION,trainingSamples:0,holdoutSamples:0};
}
