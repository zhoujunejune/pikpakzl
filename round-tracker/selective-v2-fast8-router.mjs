// SELECTIVE_V2_FAST8_PREWARM_V1: direction-only routing of historical Selective V2
// and Edge Rescue filters. The base direction is a NEW causal pre-round proxy.
// Not comparable with the original 20-22s strategy's measured accuracy.
export const POLICY_VERSION='SELECTIVE_V2_FAST8_PREWARM_V1';
export const LOCK_DEADLINE_MS=8000;
export const FALLBACK_COMMIT_MS=7800;
export const PRIMARY_SOURCE='SELECTIVE_V2_FAST8_PRIMARY';
export const RESCUE_SOURCE='EDGE_RESCUE_FAST8_PRIMARY';
export const UNVERIFIED_SOURCE='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';
export const INPUT_VERSION='SELECTIVE_V2_FAST8_PRIOR_REAL_MARKET_V1';
const finite=(v)=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v));
const signed=(x)=>x>0?'UP':'DOWN';
function derive(facts){
  if(!facts||typeof facts!=='object')return null;
  // Use only values observed from the current or previous market round.
  // Never fill absent data with zero, choose clock parity, or borrow a
  // quote belonging to the previous prediction-market contract.
  for(const [name,min] of [['currentScore',0.05],
    ['normalizedMomentum15s',0.02],['currentTrendScore',0.05],
    ['normalizedMomentum30s',0.02],['normalizedMomentum60s',0.02],
    ['regimeScore',0.05]]) {
    if(!finite(facts[name]))continue;
    const v=Number(facts[name]);
    if(Math.abs(v)>=min)return {direction:signed(v),baseFeature:name,baseValue:v};
  }
  return null;
}
export function routeSelectiveV2Fast8({round,now=Date.now(),facts,quality,edge,
  previousRoundFeatureCount=0,currentRoundFeatureCount=0,
  sourceRound=null,previousInputVersion=null}={}){
  if(!Number.isSafeInteger(round)||!Number.isFinite(now)||now<round||now>=round+300000) {
    return {status:'DATA_UNAVAILABLE',reason:'ROUND_NOT_ACTIVE',executionEligible:false};
  }
  const elapsedMs=now-round;
  if(elapsedMs>=LOCK_DEADLINE_MS)
    return {round,elapsedMs,status:'DATA_UNAVAILABLE',
      reason:'EIGHT_SECOND_DEADLINE_EXPIRED',executionEligible:false};
  const base=derive(facts);
  const common={
    round,elapsedMs,model:POLICY_VERSION,inputVersion:INPUT_VERSION,
    previousInputVersion,sourceRound,previousRoundFeatureCount,
    currentRoundFeatureCount,executionEligible:false,
  };
  if(!base) return { ...common,
    status:elapsedMs>=FALLBACK_COMMIT_MS?'DATA_UNAVAILABLE':'PENDING',
    reason:'NO_REAL_DIRECTION_FEATURE',signal:null};
  const hasCurrentScore=finite(facts.currentScore);
  const hasNewContractQuote=finite(facts.predictionMarketUpMid)&&
    Number(facts.predictionMarketUpMid)>=0&&Number(facts.predictionMarketUpMid)<=1&&
    currentRoundFeatureCount>0;
  const absorptionKnown=typeof facts.absorptionRisk==='boolean';
  const qualityInputs=hasCurrentScore&&hasNewContractQuote&&absorptionKnown;
  const q=qualityInputs&&typeof quality==='function'
    ? quality(base.direction,facts,elapsedMs,round):null;
  const originalScore=finite(facts.liveScore)?Number(facts.liveScore):null;
  const rescueInputs=qualityInputs&&originalScore!==null;
  const e=!q?.pass && rescueInputs && typeof edge==='function'
    ? edge(base.direction,facts,elapsedMs,originalScore):null;
  const evidence={baseFeature:base.baseFeature,baseValue:base.baseValue,
    hasNewContractQuote,hasCurrentScore,absorptionKnown,
    selectivePass:q?.pass===true,selectiveReasons:q?.reasons||null,
    edgePass:e?.pass===true,edgeReasons:e?.reasons||null};
  if(elapsedMs<LOCK_DEADLINE_MS&&q?.pass===true)
    return {...common,status:'LOCKED',direction:base.direction,
      source:PRIMARY_SOURCE,executionEligible:true,
      score:originalScore,confidence:null,evidence,quality:q};
  if(elapsedMs<LOCK_DEADLINE_MS&&e?.pass===true)
    return {...common,status:'LOCKED',direction:base.direction,
      source:RESCUE_SOURCE,executionEligible:true,
      score:originalScore,confidence:null,evidence,edge:e};
  if(elapsedMs<FALLBACK_COMMIT_MS)
    return {...common,status:'PENDING',signal:null,reason:'AWAITING_QUALIFIED_DIRECTION',evidence};
  // User-authorized: every real-market UP/DOWN direction is order-eligible.
  // Preserve the weak-signal label; never invent confidence or a market value.
  return {...common,status:'LOCKED',direction:base.direction,
    source:UNVERIFIED_SOURCE,executionEligible:true,
    fallbackUsed:true,fallbackReason:'UNVERIFIED_REAL_MARKET_DIRECTION',
    score:null,confidence:null,evidence};
}
