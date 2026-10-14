// Fail closed when frozen VIP75 lacks a complete causal observation.
// A clock tick, round parity or an old contract's random direction can never
// substitute for a genuine trained prediction. This policy does not modify
// the frozen model, its weights, the 8s deadline or the order mapping.
export const VIP75_DATA_GAP_POLICY_VERSION = 'VIP75_STRICT_EVIDENCE_8S_V1';
export const VIP75_DATA_GAP_DIAGNOSTIC_MS = 7000;
export const VIP75_DATA_GAP_DEADLINE_MS = 8000;

export function vip75DataGapResponse({round,now,artifactReady=false,probe=null,
    source,modelVersion,productionPolicy}={}) {
  if(!Number.isSafeInteger(round) || !Number.isFinite(now) || now<round) {
    throw new Error('INVALID_VIP75_ROUND_OR_TIME');
  }
  const expired=now>=round+VIP75_DATA_GAP_DEADLINE_MS;
  const missing=Array.isArray(probe?.missingRequired)?
    probe.missingRequired.filter(key=>typeof key==='string'):[];
  const reason=!artifactReady?'VIP75_FROZEN_MODEL_UNAVAILABLE':
    missing.length?'VIP75_REQUIRED_MARKET_FEATURES_MISSING':
      'VIP75_NO_VALID_CAUSAL_SNAPSHOT';
  // A missing-data round is NOT an UP/DOWN prediction and MUST NOT be
  // pushed into a live order or counted as a trained model miss/hit.
  return {
    round, status:expired?'DATA_UNAVAILABLE':'PENDING', signal:null,
    input:{round},generatedAt:null,source,model:'zl_new_vip75',
    modelVersion,productionPolicy,
    fallbackUsed:false,fallbackReason:null,
    pendingReason:expired?null:reason,
    dataGapReason:reason,deadlineMs:VIP75_DATA_GAP_DEADLINE_MS,
    contingencyAtMs:VIP75_DATA_GAP_DIAGNOSTIC_MS,
    tradingAllowed:false,otherProductionSourcesPaused:true,
    fast8Quality:{
      status:expired?'VIP75_DATA_UNAVAILABLE_NO_TRADE':'VIP75_AWAITING_REAL_INPUT',
      issues:[reason],
      missingFeatures:missing,
      previousRoundFeatureCount:Number(probe?.previousRoundFeatureCount||0),
      currentRoundFeatureCount:Number(probe?.currentRoundFeatureCount||0),
      inputVersion:probe?.inputVersion??null,
      dataGapPolicyVersion:VIP75_DATA_GAP_POLICY_VERSION,
      trainedPrediction:false,
    },
  };
}
