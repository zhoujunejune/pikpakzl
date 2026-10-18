// EDGE_5M_V1: forward-only evidence-driven five-minute probability model.
// No order submission, no synthetic features, no spot-candle proxy settlement.
export const EDGE_MODEL='EDGE_5M_V1';
export const INPUT_VERSION='EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1';
export const FEATURE_NAMES=Object.freeze(['spot_perp_lead','book_imbalance','aggressive_flow','basis_change','short_volatility']);
export const MIN_TRAINING_ROUNDS=5000; // statistical validation target, not a signal gate
export const MIN_FIT_ROUNDS=300; // begin provisional weight fitting before validation
export const ROUND_MS=300000;
const good=n=>typeof n==='number'&&Number.isFinite(n);
const clamp=(v,lo=-4,hi=4)=>Math.max(lo,Math.min(hi,v));
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30)));
const valid=d=>d==='UP'||d==='DOWN';
export const roundAt=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
export function extractFeatures(observation,trail=[],now=Date.now()){
  const p=Number(observation?.spotPrice),f=Number(observation?.perpPrice);
  const s=Number(observation?.spotAt),ft=Number(observation?.perpAt);
  if(!good(p)||p<=0||!good(f)||f<=0||!good(s)||!good(ft)||
     s>now+300||ft>now+300||now-s>3500||now-ft>3500)return null;
  const bids=observation?.bids,asks=observation?.asks;
  if(!Array.isArray(bids)||!Array.isArray(asks)||bids.length<5||asks.length<5)return null;
  const total=levels=>levels.slice(0,5).reduce((sum,x)=>sum+Number(x?.[1]||0),0);
  const buy=total(bids),sell=total(asks);
  if(!good(buy)||!good(sell)||buy<=0||sell<=0)return null;
  const trades=observation?.trades;
  if(!Array.isArray(trades))return null;
  let aggressBuy=0,aggressSell=0,validRecent=0;
  for(const t of trades){
    const tm=Number(t?.T),qty=Number(t?.q);
    if(!good(tm)||!good(qty)||qty<=0||tm>now+300||now-tm>4000)continue;
    validRecent++;
    if(t.m===true)aggressSell+=qty;else if(t.m===false)aggressBuy+=qty;
  }
  if(validRecent<3||aggressBuy+aggressSell<=0)return null;
  const prev=trail.filter(x=>good(x.at)&&now-x.at>=1500&&now-x.at<=12000&&
    good(x.spotPrice)&&good(x.perpPrice)&&x.spotPrice>0&&x.perpPrice>0);
  if(prev.length<3)return null;
  const oldest=prev[0];
  const spotReturn=(p-oldest.spotPrice)/oldest.spotPrice;
  const perpReturn=(f-oldest.perpPrice)/oldest.perpPrice;
  const lead=clamp((perpReturn-spotReturn)*10000/12);
  const imbalance=clamp((buy-sell)/(buy+sell)*2);
  const flow=clamp((aggressBuy-aggressSell)/(aggressBuy+aggressSell)*2);
  const b0=(oldest.perpPrice-oldest.spotPrice)/oldest.spotPrice;
  const b1=(f-p)/p;
  const basis=clamp((b1-b0)*10000/8);
  const observations=prev.map(x=>x.spotPrice).concat(p);
  const returns=observations.slice(1).map((x,i)=>Math.log(x/observations[i]));
  const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
  const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length);
  const volFeature=clamp(vol*10000/8,0,4);
  const values=[lead,imbalance,flow,basis,volFeature];
  if(values.some(x=>!good(x)))return null;
  return {round:roundAt(now),at:now,marketAt:Math.min(s,ft),values,
    dataSource:'BINANCE_PUBLIC_SPOT_PERP_DEPTH_AGGTRADES',inputVersion:INPUT_VERSION};
}
function logit(w,x){let sum=w[0];for(let i=0;i<x.length;i++)sum+=w[i+1]*x[i];return sum;}
export function scoreDirection(features,model){
  const x=features?.values;
  if(!Array.isArray(x)||x.length!==FEATURE_NAMES.length||x.some(v=>!good(v)))return null;
  // Prior to calibration this is a DIRECTIONAL PROBE ONLY, not a win probability.
  const raw=model?.weights?.length===x.length+1?logit(model.weights,x):
    0.20*x[0]+0.25*x[1]+0.25*x[2]+0.18*x[3]-0.02*x[4];
  const calibrated=!!model?.calibrationReady;
  const p=calibrated?sigmoid(model.calibration[0]+model.calibration[1]*raw):null;
  const direction=(calibrated?p>=0.5:raw>=0)?'UP':'DOWN';
  return {direction,score:raw,modelProbability:calibrated?(direction==='UP'?p:1-p):null,
    calibrationReady:calibrated,executionEligible:true}; // complete real inputs suffice for a direction; model quality is reported separately
}
export function trainOnOfficial(rows){
  const labeled=rows.filter(r=>valid(r.actual)&&r.probe?.inputVersion===INPUT_VERSION&&
    r.probe.values?.length===FEATURE_NAMES.length&&r.probe.values.every(good)&&
    good(r.probe.at)&&r.probe.at<r.round+8000&&good(r.settledAt)&&r.settledAt>=r.round+ROUND_MS)
    .sort((a,b)=>a.round-b.round);
  if(labeled.length<MIN_FIT_ROUNDS)return {status:'COLLECTING',samples:labeled.length,
    required:MIN_TRAINING_ROUNDS,fitRequired:MIN_FIT_ROUNDS,calibrationReady:false,model:null};
  const N=labeled.length,train=labeled.slice(0,Math.floor(N*.7)),
    calibration=labeled.slice(Math.floor(N*.7),Math.floor(N*.85)),
    test=labeled.slice(Math.floor(N*.85));
  let weights=Array(FEATURE_NAMES.length+1).fill(0);
  for(let epoch=0;epoch<130;epoch++){
    const g=weights.map(()=>0);
    for(const r of train){const err=sigmoid(logit(weights,r.probe.values))-(r.actual==='UP'?1:0);
      g[0]+=err;for(let j=0;j<FEATURE_NAMES.length;j++)g[j+1]+=err*r.probe.values[j];}
    const lr=.22/Math.sqrt(1+epoch/55);
    weights=weights.map((v,j)=>v-lr*(g[j]/train.length+(j===0?0:.06*v)));
  }
  // Platt calibration on a chronologically later and disjoint block.
  let a=0,b=1;
  for(let epoch=0;epoch<160;epoch++){
    let ga=0,gb=0;
    for(const r of calibration){const z=logit(weights,r.probe.values);
      const err=sigmoid(a+b*z)-(r.actual==='UP'?1:0);ga+=err;gb+=err*z;}
    a-=.10*ga/calibration.length;
    b-=.10*(gb/calibration.length+.015*(b-1));
  }
  const evaluated=test.map(r=>({p:sigmoid(a+b*logit(weights,r.probe.values)),y:r.actual==='UP'?1:0}));
  const brier=evaluated.reduce((s,r)=>s+(r.p-r.y)**2,0)/evaluated.length;
  const prior=train.filter(r=>r.actual==='UP').length/train.length;
  const base=prior*(1-prior);
  let ece=0;
  for(let bucket=0;bucket<10;bucket++){
    const subs=evaluated.filter(r=>Math.min(9,Math.floor(r.p*10))===bucket);
    if(!subs.length)continue;
    const avg=subs.reduce((s,r)=>s+r.p,0)/subs.length;
    const actual=subs.reduce((s,r)=>s+r.y,0)/subs.length;
    ece+=subs.length/evaluated.length*Math.abs(avg-actual);
  }
  const calibrationReady=N>=MIN_TRAINING_ROUNDS&&ece<=.08&&brier<base;
  return {status:N<MIN_TRAINING_ROUNDS?'PROVISIONAL_TRAINED':calibrationReady?'VALIDATED':'CALIBRATION_REJECTED',
    samples:N,required:MIN_TRAINING_ROUNDS,fitRequired:MIN_FIT_ROUNDS,
    calibrationReady,holdoutSamples:test.length,brier,ece,baselineBrier:base,
    model:{weights,calibration:[a,b],calibrationReady,trainedAt:Date.now(),
      version:'EDGE5_OFFICIAL_'+N+'_'+labeled.at(-1).round}};
}
export function summarize(rows){
  const settled=rows.filter(r=>r.probe&&valid(r.actual)&&valid(r.direction));
  const group=items=>{const samples=items.length,hits=items.filter(x=>x.direction===x.actual).length;
    return {samples,hits,misses:samples-hits,accuracy:samples?hits/samples:null};};
  return {observedRounds:rows.length,locked:rows.filter(r=>r.probe).length,
    pending:rows.filter(r=>r.probe&&!valid(r.actual)).length,
    overall:group(settled),up:group(settled.filter(r=>r.direction==='UP')),
    down:group(settled.filter(r=>r.direction==='DOWN'))};
}
