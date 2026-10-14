// Single external-inspired BTC 5m order-flow production feature, evaluated on
// the immutable worker snapshot at ~T+2s. It is NOT the original author's
// pretrained strategy, and does not have established >50% forward accuracy.
// V9 production scores ONLY CURRENT-round regimeScore. Prediction-market
// prices and other raw features never participate in final direction scoring.
// Earlier PREP60/blending remains retired. Upstream regimeScore is a
// composite of historic spot market trends, not a guaranteed 5m predictor.
// Two previously experimental proxy strategies have been retired from current
// calculations; their historical journal records remain auditable.
export const EXTERNAL_RESEARCH_VERSION = 'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V9_REGIME_ONLY';
export const EXTERNAL_RESEARCH_IDS = Object.freeze(['FLOW_BOOK_PROXY_V1']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x,min=-1,max=1) => Math.min(max,Math.max(min,x));
const normalized = (f,k,scale=1) => finite(f?.[k])?clamp(f[k]/scale):null;
// A binary direction is still required even when regimeScore is missing/0;
// use the round clock only, NOT momentum, another market feature or old labels.
const noInfoSide = roundStartMs => Number.isFinite(roundStartMs) &&
  Math.floor(roundStartMs/300000)%2===1?'DOWN':'UP';
const side = (score,roundStartMs) => score>0?'UP':score<0?'DOWN':noInfoSide(roundStartMs);

export function externalResearchDirections(facts={},{
  snapshotAvailable=false,
  dataQuality=[],sourceAt=null,roundStartMs=null
}={}) {
  // Previous-round observations must not enter a CURRENT-round prediction.
  const reusedPreRound=Number.isFinite(roundStartMs) &&
    Number.isFinite(sourceAt) && sourceAt < roundStartMs;
  // A single direct score input, unaffected by PM midprice, momentum,
  // order flow, other spot composites or supplied legacy fallbackDirection.
  const regimeScore=snapshotAvailable&&!reusedPreRound
    ?normalized(facts,'regimeScore'):null;
  const eligible=regimeScore===null?0:1;
  const score=regimeScore??0;
  // Unused feature freshness does not degrade regime-only quality.
  const unrelated=new Set(['PM_MISSING_OR_UNALIGNED','DEPTH_MISSING_OR_STALE',
    'TRADES_MISSING_OR_STALE','CURRENT_ROUND_OPEN_NOT_YET_ALIGNED']);
  const issues=(Array.isArray(dataQuality)?dataQuality:['UNKNOWN_DATA_QUALITY'])
    .filter(issue=>!unrelated.has(issue));
  if(reusedPreRound&&!issues.includes('PRE_ROUND_SNAPSHOT_REUSED'))
    issues.push('PRE_ROUND_SNAPSHOT_REUSED');
  const quality=snapshotAvailable===true&&Number.isFinite(sourceAt)&&
    !reusedPreRound&&eligible===1&&!issues.some(x=>
      x==='NO_FRESH_SNAPSHOT'||x==='CROSS_ROUND_FRESH_SPOT_BRIDGE');
  // Only current-round data contributes to the score. When it is absent or
  // balanced at zero, retain the separately labeled no-information fallback.
  const fallback=eligible===0||score===0;
  const prediction={
    direction:side(score,roundStartMs),
    // This is a bounded absolute score, NOT a probability/win-rate.
    strength:!fallback?Number(Math.abs(score).toFixed(6)):null,
    evidence:fallback?'BASELINE_OR_NO_INFO_FALLBACK':
      quality?'FROZEN_REGIME_INPUT':'DEGRADED_REGIME_INPUT',
    featureCount:eligible,fallback,
    // Schema-compatible explicit zeroes for retired prewarm fields.
    preparationUsed:false,preparationOnly:false,
    preparedDirection:null,preparedSampleCount:0,preWeight:0,
  };
  return {
    version:EXTERNAL_RESEARCH_VERSION,
    productionEffect:'RESEARCH_EVIDENCE_ONLY',
    executionEligible:false,autoPromotion:false,
    predictedHorizonMs:300000,nominalDeadlineMs:8000,
    sourceAt:Number.isFinite(sourceAt)?sourceAt:null,
    reusedPreRound,fullQuality:quality,
    regime:'REGIME_ONLY_CURRENT_ROUND',dataQuality:issues,
    preparation:null,
    predictions:{FLOW_BOOK_PROXY_V1:prediction}
  };
}
