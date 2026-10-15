// Market Fusion FAST8: causal BTC spot microstructure + current-contract context.
// Versioned, deterministic and deliberately NOT labelled a trained probability.
// Uses real previous-round tail and fresh current observations; missing values
// are omitted instead of zero-filled. The last contract's PM quote is never reused.
export const VERSION='MARKET_FUSION_FAST8_V1';
export const INPUT_VERSION='BTC5M_PREV_TAIL120_CURRENT8_CAUSAL_V1';
export const SOURCE='SELECTIVE_V2_FAST8_PRIMARY'; // Reuse the existing independent UP/DOWN order policy.
export const DEADLINE_MS=8000;
export const LOCK_BY_MS=6500;
const ROUND_MS=300000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const clamp=(x,lo=-1,hi=1)=>Math.min(hi,Math.max(lo,x));

const GROUPS={
  momentum:[['normalizedMomentum15s',0.30,0.23],['normalizedMomentum30s',0.22,0.25],
    ['normalizedMomentum60s',0.22,0.30],['normalizedMomentum180s',0.09,0.40],
    ['normalizedMomentum300s',0.06,0.45],['microScore',0.11,0.55]],
  flow:[['tradePressure15s',0.34,0.65],['ofiNormalized5s',0.32,0.65],
    ['tradePressure60s',0.18,0.75],['ofiNormalized60s',0.16,0.75]],
  trend:[['regimeScore',0.32,0.55],['currentTrendScore',0.27,0.55],
    ['currentScore',0.23,0.55],['liveScore',0.18,0.65]],
};
const GROUP_WEIGHTS={momentum:0.36,flow:0.30,trend:0.24,market:0.10};
function signedGroup(facts,name){
  const entries=GROUPS[name];
  let sum=0,weight=0,count=0,signals=[];
  for(const [field,w,scale] of entries){
    if(!finite(facts?.[field]))continue;
    const n=clamp(facts[field]/scale);
    sum+=n*w;weight+=w;count++;
    signals.push({field,value:facts[field]});
  }
  return count?{score:sum/weight,count,signals}:null;
}
function marketGroup(facts,permitQuote){
  // This indicator is new-contract-specific; previous-round quotations
  // (including a previous topic accidentally retained by a cache) are banned.
  if(!permitQuote || !finite(facts?.predictionMarketUpMid) ||
    facts.predictionMarketUpMid<0 || facts.predictionMarketUpMid>1)return null;
  return {score:clamp((facts.predictionMarketUpMid-0.5)*5),count:1,
    signals:[{field:'predictionMarketUpMid',value:facts.predictionMarketUpMid}]};
}
function snapshotScore(facts,{permitQuote=false}={}){
  const groups={momentum:signedGroup(facts,'momentum'),
    flow:signedGroup(facts,'flow'),trend:signedGroup(facts,'trend'),
    market:marketGroup(facts,permitQuote)};
  let value=0,weight=0,count=0,groupCount=0;
  for(const [key,g] of Object.entries(groups)){
    if(!g)continue;
    const w=GROUP_WEIGHTS[key];
    value+=g.score*w;weight+=w;count+=g.count;groupCount++;
  }
  if(!weight)return null;
  return {score:value/weight,featureCount:count,groupCount,
    groups:Object.fromEntries(Object.entries(groups).filter(([,x])=>x))};
}
function fallbackDirection(prior,current){
  // A real nonzero observed input is a valid sign tie-breaker, never the clock.
  for(const facts of [current,prior]){
    for(const field of ['normalizedMomentum15s','tradePressure15s',
      'ofiNormalized5s','regimeScore','currentTrendScore','normalizedMomentum60s']){
      if(finite(facts?.[field])&&facts[field]!==0)
        return facts[field]>0?'UP':'DOWN';
    }
  }
  return null;
}
export function evaluateMarketFusionFast8({round,now=Date.now(),prior=null,
  currentFacts=null,currentObservedAt=null,currentRoundAligned=false}={}){
  if(!Number.isSafeInteger(round)||round%ROUND_MS!==0||
    !Number.isFinite(now)||now<round||now>=round+ROUND_MS)
    return {status:'DATA_UNAVAILABLE',reason:'INVALID_ROUND',executionEligible:false};
  const elapsedMs=now-round;
  const priorValid=prior?.sourceRound===round-ROUND_MS;
  const previous=priorValid?prior.facts:null;
  const hasFreshCurrent=currentRoundAligned&&finite(currentObservedAt)&&
    currentObservedAt>=round&&currentObservedAt<=now&&
    now-currentObservedAt<=3000&&currentFacts?.dataFresh!==false;
  const recent=hasFreshCurrent?currentFacts:null;
  const p=snapshotScore(previous);
  const q=snapshotScore(recent,{permitQuote:recent?.predictionMarketRoundAligned===true});
  if(!p&&!q)return {round,elapsedMs,status:elapsedMs>=LOCK_BY_MS?'DATA_UNAVAILABLE':'PENDING',
    reason:'NO_OBSERVED_MARKET_FEATURE',executionEligible:false};
  // Prior snapshot is continuous BTC spot information, not the prior contract.
  // A fresh aligned observation receives increased weight when available.
  const pWeight=p&&q?0.45:p?1:0;
  const qWeight=p&&q?0.55:q?1:0;
  const score=(p?.score||0)*pWeight+(q?.score||0)*qWeight;
  const featureCount=(p?.featureCount||0)+(q?.featureCount||0);
  const groupCount=Math.max(p?.groupCount||0,q?.groupCount||0);
  const direction=score>0?'UP':score<0?'DOWN':fallbackDirection(previous,recent);
  const evidence={score:Number(score.toFixed(6)),featureCount,groupCount,
    previousRound:priorValid?prior.sourceRound:null,
    previousFeatureCount:p?.featureCount||0,
    currentFeatureCount:q?.featureCount||0,
    currentAgeMs:recent?now-currentObservedAt:null,
    previousGroups:p?.groups||{},currentGroups:q?.groups||{},
    previousContractQuoteUsed:false,
    currentContractQuoteUsed:Boolean(q?.groups.market),
    probabilityCalibrated:false};
  if(elapsedMs>=DEADLINE_MS)
    return {round,elapsedMs,status:'DATA_UNAVAILABLE',
      reason:'EIGHT_SECOND_DEADLINE_EXPIRED',executionEligible:false,evidence};
  const strongEarly=elapsedMs>=1000&&Math.abs(score)>=0.24&&
    groupCount>=2&&Boolean(recent);
  if(!strongEarly&&elapsedMs<LOCK_BY_MS)
    return {round,elapsedMs,status:'PENDING',reason:'COLLECTING_CAUSAL_MARKET_DATA',
      executionEligible:false,evidence};
  if(!direction)
    return {round,elapsedMs,status:'DATA_UNAVAILABLE',
      reason:'NO_NONZERO_MARKET_DIRECTION',executionEligible:false,evidence};
  const lowEvidence=Math.abs(score)<0.16||groupCount<2||!recent;
  return {round,elapsedMs,status:'LOCKED',source:SOURCE,model:VERSION,
    modelVersion:VERSION,direction,score:evidence.score,
    executionEligible:true,fallbackUsed:lowEvidence,
    fallbackReason:lowEvidence?'LOW_EVIDENCE_REAL_MARKET_DIRECTION':null,
    evidence,inputVersion:INPUT_VERSION};
}
