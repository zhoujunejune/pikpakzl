// Single external-inspired BTC 5m order-flow production feature, evaluated on
// the immutable worker snapshot at ~T+2s. It is NOT the original author's
// pretrained strategy, and does not have established >50% forward accuracy.
// V5 removes direct OFI and 60s aggressive-flow weights. Upstream
// composite scores can still contain these signals indirectly.
// Two previously experimental proxy strategies have been retired from current
// calculations; their historical journal records remain auditable.
export const EXTERNAL_RESEARCH_VERSION = 'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V5_NO_DIRECT_OFI_FLOW60';
export const EXTERNAL_RESEARCH_IDS = Object.freeze(['FLOW_BOOK_PROXY_V1']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x,min=-1,max=1) => Math.min(max,Math.max(min,x));
const normalized = (f,k,scale=1) => finite(f?.[k])?clamp(f[k]/scale):null;
const side = (score,prior) => score>0?'UP':score<0?'DOWN':prior==='DOWN'?'DOWN':'UP';

export function externalResearchDirections(facts={},{
  baselineDirection='UP',snapshotAvailable=false,
  dataQuality=[],sourceAt=null,roundStartMs=null,preparation=null
}={}) {
  const items = [
    [normalized(facts,'tradePressure15s'),0.17],
    [normalized(facts,'microScore'),0.09],
    [normalized(facts,'currentScore'),0.10],
    [normalized(facts,'currentTrendScore'),0.08],
    [normalized(facts,'regimeScore'),0.05],
    [normalized(facts,'normalizedMomentum60s'),0.05],
    [finite(facts.predictionMarketUpMid)
      ?clamp((facts.predictionMarketUpMid-0.5)*2):null,0.03],
  ];
  const eligible=items.filter(([value])=>value!==null);
  const weight=eligible.reduce((sum,[,w])=>sum+w,0);
  const score=weight
    ?eligible.reduce((sum,[value,w])=>sum+value*w,0)/weight:0;
  const issues=Array.isArray(dataQuality)?[...dataQuality]:['UNKNOWN_DATA_QUALITY'];
  const reusedPreRound=Number.isFinite(roundStartMs) &&
    Number.isFinite(sourceAt) && sourceAt < roundStartMs;
  if(reusedPreRound&&!issues.includes('PRE_ROUND_SNAPSHOT_REUSED'))
    issues.push('PRE_ROUND_SNAPSHOT_REUSED');
  const quality=snapshotAvailable===true&&Number.isFinite(sourceAt)&&
    !reusedPreRound&&eligible.length>=4&&!issues.some(x=>
      x==='NO_FRESH_SNAPSHOT'||x==='DEPTH_MISSING_OR_STALE'||
      x==='TRADES_MISSING_OR_STALE'||x==='PM_MISSING_OR_UNALIGNED'||
      x==='CROSS_ROUND_FRESH_SPOT_BRIDGE');
  // The prior-minute preview is causal BTC SPOT context, not a previous
  // prediction-contract price. Combine it with the first fresh ~2s of this
  // round only when enough distinct pre-round samples really existed.
  // The untrained 70/30 blend is a fixed exploratory rule, NOT a
  // calibrated probability or demonstrated improvement.
  const prepared=preparation?.ready===true &&
    preparation.nextRoundStartMs===roundStartMs &&
    preparation.predictionMarketContractIncluded===false &&
    Number.isFinite(preparation.previewScore);
  const preWeight=prepared?(snapshotAvailable&&eligible.length>=4?0.30:1):0;
  const finalScore=preWeight===1?preparation.previewScore:
    preWeight>0 ? (1-preWeight)*score+preWeight*preparation.previewScore : score;
  const fallback=(!snapshotAvailable||eligible.length<4)&&!prepared||finalScore===0;
  const prepOnly=preWeight===1;
  const prediction={
    direction:side(finalScore,baselineDirection),
    // This is a bounded absolute score, NOT a probability/win-rate.
    strength:(!fallback&&(eligible.length>=4||prepared))?
      Number(Math.abs(finalScore).toFixed(6)):null,
    evidence:fallback?'BASELINE_OR_NO_INFO_FALLBACK':
      prepOnly?'PREPARED_60S_CONTEXT_ONLY':
      quality?'FROZEN_MICROSTRUCTURE_INPUT':'DEGRADED_MICROSTRUCTURE_INPUT',
    featureCount:eligible.length,fallback,
    preparationUsed:prepared,preparationOnly:prepOnly,
    preparedDirection:prepared?preparation.directionPreview:null,
    preparedSampleCount:prepared?preparation.sampleCount:0,
    preWeight,
  };
  return {
    version:EXTERNAL_RESEARCH_VERSION,
    productionEffect:'RESEARCH_EVIDENCE_ONLY',
    executionEligible:false,autoPromotion:false,
    predictedHorizonMs:300000,nominalDeadlineMs:8000,
    sourceAt:Number.isFinite(sourceAt)?sourceAt:null,
    reusedPreRound,fullQuality:quality,
    regime:'ORDER_FLOW_ONLY_PREP60',dataQuality:issues,
    preparation:preparation?{
      version:preparation.version,ready:preparation.ready,
      sampleCount:preparation.sampleCount,spanMs:preparation.spanMs,
      lastAgeMs:preparation.lastAgeMs,
      firstSourceAt:preparation.firstSourceAt,
      lastSourceAt:preparation.lastSourceAt,
      directionPreview:preparation.directionPreview,
      dataType:preparation.dataType,
      predictionMarketContractIncluded:false
    }:null,
    predictions:{FLOW_BOOK_PROXY_V1:prediction}
  };
}
