// Dynamic five-minute entry research. Read-only; never routed to order execution.
// Labels must arrive from the Binance Prediction official settlement ledger.
export const MODEL='DYNAMIC_ENTRY_5M_SHADOW_V1';
export const ROUND_MS=300000;
export const TARGET_ACCURACY=0.75;
export const RETRAIN_EVERY_SETTLED=5;
export const MIN_TRAINING_ROWS=60;
export const FEATURE_NAMES=Object.freeze(['rsi14','momentum1','momentum3','roundMove','timeRemaining']);
const clip=(n,a=-1,b=1)=>Math.max(a,Math.min(b,n));
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const sigmoid=z=>1/(1+Math.exp(-clip(z,-25,25)));
const valid=d=>d==='UP'||d==='DOWN';
export const roundStart=ms=>Math.floor(ms/ROUND_MS)*ROUND_MS;
export function rsi14(closes){
 if(!Array.isArray(closes)||closes.length<15)return null;
 const x=closes.slice(-15);let gain=0,loss=0;
 for(let i=1;i<x.length;i++){const delta=x[i]-x[i-1];gain+=Math.max(0,delta);loss+=Math.max(0,-delta);}
 return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
// Never use candles from a future round or observations timestamped after the decision.
// Every computed vector has an exact market snapshot observation time.
export function extractFeatures(snapshot,now){
 if(snapshot?.readOnly!==true||!finite(snapshot.generatedAtMs)||
    snapshot.generatedAtMs>now+300||now-snapshot.generatedAtMs>6500)return null;
 const latest=snapshot.latest||{};
 const eventMs=latest.eventMs??snapshot.generatedAtMs;
 const price=Number(latest.lastPrice);
 if(!finite(price)||price<=0||!finite(eventMs)||eventMs>now+300||now-eventMs>10000)return null;
 const raw=snapshot.candles?.['1m']?.rows;
 if(!Array.isArray(raw))return null;
 const candles=raw.filter(x=>finite(x?.startMs)&&x.startMs<=now &&
   finite(Number(x.close))&&Number(x.close)>0&&x.startMs%60000===0)
   .sort((a,b)=>a.startMs-b.startMs);
 if(candles.length<16||now-candles.at(-1).startMs>120000)return null;
 // Use fully completed earlier minutes, plus a fresh contemporaneous trade print.
 // This also allows an entry at T+1s before the first current-minute candle exists.
 const minute=Math.floor(now/60000)*60000;
 const past=candles.filter(x=>x.startMs<minute);
 if(past.length<15)return null;
 const closes=past.map(x=>Number(x.close));
 const rsi=rsi14(closes.slice(-14).concat(price));
 if(!finite(rsi))return null;
 const round=roundStart(now);
 // Prefer the source collector's round-open print when it is round-aligned.
 const roundOpen=latest.roundStartMs===round?Number(latest.roundOpenPrice):null;
 const first=candles.find(x=>x.startMs===round);
 const open=finite(roundOpen)&&roundOpen>0?roundOpen:Number(first?.open);
 if(!finite(open)||open<=0)return null;
 const bps=(a,b)=>clip((a-b)/b*10000/35);
 const m1=bps(price,closes.at(-1));
 const m3=bps(price,closes.at(-3));
 const roundMove=bps(price,open);
 const remaining=clip((ROUND_MS-(now-round))/ROUND_MS*2-1);
 return {
  round,at:now,price,marketAt:eventMs,
  values:[clip((rsi-50)/35),m1,m3,roundMove,remaining],
  rsi:Number(rsi.toFixed(2)),elapsedMs:now-round,
 };
}
function dot(w,x){let z=w[0];for(let i=0;i<x.length;i++)z+=w[i+1]*x[i];return z;}
export function decide(features,model=null){
 if(!features||!Array.isArray(features.values)||features.values.length!==FEATURE_NAMES.length||
    features.values.some(x=>!finite(x)))return null;
 const x=features.values;
 // Pre-training baseline is NOT a calibrated 75% probability.
 const raw=model?.weights?.length===x.length+1?
   dot(model.weights,x):
   0.45*x[0]+0.7*x[1]+0.55*x[2]+0.8*x[3]+0.10*x[4];
 const strength=model?.weights?Math.abs(sigmoid(raw)-0.5)*2:
   Math.abs(Math.tanh(raw/1.4));
 const threshold=model?.weights?0.55:0.72;
 const direction=raw>=0?'UP':'DOWN';
 const eligible=strength>=threshold &&
   Math.sign(x[1])===Math.sign(raw) &&
   Math.sign(x[3])===Math.sign(raw);
 return {direction,score:Number(raw.toFixed(5)),strength:Number(strength.toFixed(5)),
   threshold,eligible,modelVersion:model?.version||'HEURISTIC_V1',
   strengthCalibrated:false};
}
const score=(rows)=>{const validRows=rows.filter(x=>valid(x.actual)&&valid(x.direction));
 const hits=validRows.filter(x=>x.direction===x.actual).length;
 return {samples:validRows.length,hits,misses:validRows.length-hits,
  accuracy:validRows.length?hits/validRows.length:null};
};
export function wilsonLower(hits,n,z=1.96){
 if(n<=0)return null;const p=hits/n,den=1+z*z/n;
 return (p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/den;
}
export function aggregate(rows){
 const settled=rows.filter(x=>x.entry&&valid(x.actual))
   .map(x=>({direction:x.entry.direction,actual:x.actual,round:x.round}))
   .sort((a,b)=>a.round-b.round);
 const overall=score(settled);
 const up=score(settled.filter(x=>x.direction==='UP'));
 const down=score(settled.filter(x=>x.direction==='DOWN'));
 const eligible=rows.filter(x=>x.probe&&valid(x.actual));
 const pending=rows.filter(x=>x.entry&&!valid(x.actual)).length;
 const lower=wilsonLower(overall.hits,overall.samples);
 return {
  observedRounds:rows.length,entryRounds:rows.filter(x=>x.entry).length,
  noEntryRounds:rows.filter(x=>!x.entry&&x.round+ROUND_MS<=Date.now()).length,
  pending,officialLabeledProbes:eligible.length,
  overall,up,down,recent20:score(settled.slice(-20)),
  recent100:score(settled.slice(-100)),
  wilsonLower95:lower,
  target:TARGET_ACCURACY,
  qualified:overall.samples>=200&&lower!==null&&lower>TARGET_ACCURACY,
 };
}
// Chronological holdout and training only on features frozen BEFORE official resolution.
export function fitOnOfficialProbes(rows,previous=null){
 const labeled=rows.filter(x=>x.probe&&valid(x.actual)&&
   finite(x.settledAt)&&x.settledAt>=x.round+ROUND_MS &&
   Array.isArray(x.probe.values)&&x.probe.values.length===FEATURE_NAMES.length)
  .sort((a,b)=>a.round-b.round);
 if(labeled.length<MIN_TRAINING_ROWS)return {status:'COLLECTING',samples:labeled.length,
   required:MIN_TRAINING_ROWS,model:previous,holdout:null};
 const holdoutN=Math.max(20,Math.floor(labeled.length*0.25));
 const train=labeled.slice(0,-holdoutN),holdout=labeled.slice(-holdoutN);
 let w=Array(FEATURE_NAMES.length+1).fill(0);
 for(let epoch=0;epoch<180;epoch++){
  const g=Array(w.length).fill(0);
  for(const row of train){
   const x=row.probe.values,y=row.actual==='UP'?1:0;
   const error=sigmoid(dot(w,x))-y;
   g[0]+=error;
   for(let j=0;j<x.length;j++)g[j+1]+=error*x[j];
  }
  const step=0.24/Math.sqrt(epoch/80+1);
  w[0]-=step*g[0]/train.length;
  for(let j=1;j<w.length;j++)w[j]-=step*(g[j]/train.length+0.06*w[j]);
 }
 const checks=holdout.map(r=>({direction:dot(w,r.probe.values)>=0?'UP':'DOWN',actual:r.actual}));
 const validation=score(checks);
 const proposed={weights:w,version:'DYN5_FROZEN_'+labeled.length+'_'+holdout.at(-1).round,
  trainedOn:train.length,holdout:validation,trainingEndRound:train.at(-1).round};
 // Model quality is reported, not assumed: a lower-accuracy holdout stays shadow.
 return {status:validation.accuracy>TARGET_ACCURACY?'VALIDATED_CANDIDATE':'BELOW_TARGET',
  samples:labeled.length,required:MIN_TRAINING_ROWS,holdout:validation,model:proposed};
}
