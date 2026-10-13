// Purely causal 60-second pre-round market context. Binance BTC spot flow
// continues across five-minute settlement windows; prediction-market contracts
// do NOT. No PM price, round-open deviation or contract id enters this buffer.
export const NEXT_ROUND_PREP_VERSION='FAST8_PREP60_CAUSAL_V1';
export const PREP_WINDOW_MS=60000;
const ROUND_MS=300000;
const MIN_INTERVAL_MS=500;
const MAX_SAMPLES=120;
const CONTINUOUS_SPOT_KEYS=Object.freeze([
  'ofiNormalized5s','tradePressure15s','tradePressure60s',
  'microScore','regimeScore','normalizedMomentum60s'
]);
const WEIGHTS=Object.freeze({
  ofiNormalized5s:0.27,tradePressure15s:0.17,
  tradePressure60s:0.16,microScore:0.09,
  regimeScore:0.05,normalizedMomentum60s:0.05
});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clamp=x=>Math.max(-1,Math.min(1,x));

function score(features){
  let weighted=0,weightSum=0;
  for(const [key,w] of Object.entries(WEIGHTS)){
    if(!finite(features[key]))continue;
    weighted+=clamp(features[key])*w;weightSum+=w;
  }
  return weightSum>0?weighted/weightSum:null;
}

export function createNextRoundPreparation(){
  const data=new Map();
  function observe({roundStartMs,sourceAt,receivedAt,features,issues=[]}={}){
    if(!finite(roundStartMs)||roundStartMs%ROUND_MS!==0||
      !finite(sourceAt)||!finite(receivedAt)||sourceAt>receivedAt||
      receivedAt-sourceAt>2000)return false;
    const nextRoundStartMs=roundStartMs+ROUND_MS;
    // Only observations actually acquired during the prior round's final minute.
    if(sourceAt<nextRoundStartMs-PREP_WINDOW_MS||sourceAt>=nextRoundStartMs||
      receivedAt>=nextRoundStartMs)return false;
    // Valid upstream spot data can be prepared continuously even while a PM
    // contract for the *next* round does not exist yet.
    const clean=Object.fromEntries(CONTINUOUS_SPOT_KEYS.map(k=>[
      k,finite(features?.[k])?clamp(features[k]):null
    ]));
    const reason=Array.isArray(issues)?issues:[];
    if(reason.includes('DEPTH_MISSING_OR_STALE'))clean.ofiNormalized5s=null;
    if(reason.includes('TRADES_MISSING_OR_STALE')){
      clean.tradePressure15s=null;clean.tradePressure60s=null;
    }
    if(!Object.values(clean).some(finite))return false;
    let samples=data.get(nextRoundStartMs);
    if(!samples){samples=[];data.set(nextRoundStartMs,samples)}
    // A duplicate or reordered HTTP poll must not create fake observations.
    const last=samples.at(-1);
    if(last && (sourceAt<=last.sourceAt||receivedAt<last.receivedAt))return false;
    const entry={sourceAt,receivedAt,features:clean};
    if(last && sourceAt-last.sourceAt<MIN_INTERVAL_MS)samples[samples.length-1]=entry;
    else samples.push(entry);
    if(samples.length>MAX_SAMPLES)samples.shift();
    for(const key of data.keys())if(key<nextRoundStartMs)data.delete(key);
    return true;
  }
  function preparedFor(nextRoundStartMs){
    if(!finite(nextRoundStartMs)||nextRoundStartMs%ROUND_MS!==0)return null;
    const samples=(data.get(nextRoundStartMs)||[]).filter(s=>
      s.sourceAt>=nextRoundStartMs-PREP_WINDOW_MS &&
      s.sourceAt<nextRoundStartMs && s.receivedAt<nextRoundStartMs);
    const first=samples[0],last=samples.at(-1);
    const avgFeatures={};
    const featureSamples={};
    for(const key of CONTINUOUS_SPOT_KEYS){
      const list=samples.map(s=>s.features[key]).filter(finite);
      featureSamples[key]=list.length;
      avgFeatures[key]=list.length?Number((list.reduce((a,b)=>a+b,0)/list.length).toFixed(6)):null;
    }
    const previewScore=score(avgFeatures);
    const spanMs=first&&last?last.sourceAt-first.sourceAt:0;
    const lastAgeMs=last?nextRoundStartMs-last.sourceAt:null;
    const directionPreview=previewScore===null?null:previewScore>0?'UP':previewScore<0?'DOWN':null;
    const ready=samples.length>=12 && spanMs>=20000 &&
      lastAgeMs!==null && lastAgeMs<=5000 &&
      Object.values(featureSamples).filter(n=>n>=8).length>=4 &&
      directionPreview!==null;
    return {
      version:NEXT_ROUND_PREP_VERSION,nextRoundStartMs,
      windowStartMs:nextRoundStartMs-PREP_WINDOW_MS,
      sampleCount:samples.length,spanMs,lastAgeMs,
      firstSourceAt:first?.sourceAt??null,lastSourceAt:last?.sourceAt??null,
      featureSamples,avgFeatures,previewScore, directionPreview, ready,
      dataType:'CONTINUOUS_BTC_SPOT_ONLY',
      predictionMarketContractIncluded:false,
      // Never classify a pre-round candidate as the new round's frozen signal.
      executionEligible:false,productionEffect:'PREP_ONLY_NOT_TRADABLE'
    };
  }
  function status(now){
    const upcoming=Math.floor(now/ROUND_MS)*ROUND_MS+ROUND_MS;
    const prep=preparedFor(upcoming);
    return {...prep,secondsUntilRound:Math.max(0,Math.ceil((upcoming-now)/1000))};
  }
  return {observe,preparedFor,status};
}
