// Single external-inspired BTC 5m order-flow production feature, evaluated on
// the immutable worker snapshot at ~T+2s. It is NOT the original author's
// pretrained strategy, and does not have established >50% forward accuracy.
// V8 scores ONLY CURRENT-round regimeScore and the aligned Prediction Market UP mid.
// Previous-round 60s preparation, blending and old-snapshot fallback are removed.
// Upstream regimeScore may itself depend on historical market observations.
// Two previously experimental proxy strategies have been retired from current
// calculations; their historical journal records remain auditable.
export const EXTERNAL_RESEARCH_VERSION = 'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V8_CURRENT_ONLY_REGIME_PM';
export const EXTERNAL_RESEARCH_IDS = Object.freeze(['FLOW_BOOK_PROXY_V1']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x,min=-1,max=1) => Math.min(max,Math.max(min,x));
const normalized = (f,k,scale=1) => finite(f?.[k])?clamp(f[k]/scale):null;
const side = (score,prior) => score>0?'UP':score<0?'DOWN':prior==='DOWN'?'DOWN':'UP';

export function externalResearchDirections(facts={},{
  baselineDirection='UP',snapshotAvailable=false,
  dataQuality=[],sourceAt=null,roundStartMs=null
}={}) {
  // Previous-round observations must not enter a CURRENT-round prediction.
  const reusedPreRound=Number.isFinite(roundStartMs) &&
    Number.isFinite(sourceAt) && sourceAt < roundStartMs;
  const items = [
    [reusedPreRound?null:normalized(facts,'regimeScore'),0.05],
    [!reusedPreRound&&finite(facts.predictionMarketUpMid)
      ?clamp((facts.predictionMarketUpMid-0.5)*2):null,0.03],
  ];
  const eligible=items.filter(([value])=>value!==null);
  const weight=eligible.reduce((sum,[,w])=>sum+w,0);
  const score=weight
    ?eligible.reduce((sum,[value,w])=>sum+value*w,0)/weight:0;
  const issues=Array.isArray(dataQuality)?[...dataQuality]:['UNKNOWN_DATA_QUALITY'];
  if(reusedPreRound&&!issues.includes('PRE_ROUND_SNAPSHOT_REUSED'))
    issues.push('PRE_ROUND_SNAPSHOT_REUSED');
  const quality=snapshotAvailable===true&&Number.isFinite(sourceAt)&&
    !reusedPreRound&&eligible.length===2&&!issues.some(x=>
      x==='NO_FRESH_SNAPSHOT'||x==='DEPTH_MISSING_OR_STALE'||
      x==='TRADES_MISSING_OR_STALE'||x==='PM_MISSING_OR_UNALIGNED'||
      x==='CROSS_ROUND_FRESH_SPOT_BRIDGE');
  // Only current-round data contributes to the score. When it is absent or
  // balanced at zero, retain the separately labeled no-information fallback.
  const fallback=!snapshotAvailable||eligible.length===0||score===0;
  const prediction={
    direction:side(score,baselineDirection),
    // This is a bounded absolute score, NOT a probability/win-rate.
    strength:!fallback?Number(Math.abs(score).toFixed(6)):null,
    evidence:fallback?'BASELINE_OR_NO_INFO_FALLBACK':
      quality?'FROZEN_MICROSTRUCTURE_INPUT':'DEGRADED_MICROSTRUCTURE_INPUT',
    featureCount:eligible.length,fallback,
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
    regime:'REGIME_PM_ONLY_CURRENT_ROUND',dataQuality:issues,
    preparation:null,
    predictions:{FLOW_BOOK_PROXY_V1:prediction}
  };
}
