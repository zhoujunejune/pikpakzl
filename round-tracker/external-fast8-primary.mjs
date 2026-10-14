// The sole active external BTC 5m FAST8 production candidate.
// Its current V9 scoring is an untrained direct regimeScore sign classifier.
// The source regimeScore itself is an upstream historical-market composite,
// not a pretrained third-party model or a verified 65% edge.
import { EXTERNAL_RESEARCH_VERSION } from './external-btc5m-fast8-shadow.mjs';

export const SINGLE_EXTERNAL_PRIMARY_ID = 'FLOW_BOOK_PROXY_V1';
export const SINGLE_EXTERNAL_PRIMARY_SOURCE = 'ZL_FAST8_65_PRIMARY';
export const SINGLE_EXTERNAL_PRIMARY_VERSION =
  EXTERNAL_RESEARCH_VERSION + ':' + SINGLE_EXTERNAL_PRIMARY_ID;

export function selectExternalFast8Production(stats,latest,expectedRound,readiness) {
  if (!readiness?.eligible) return {eligible:false,
    reason:readiness?.reason || 'FAST8_WORKER_PENDING'};
  const locked = latest?.signal;
  const research = locked?.externalResearch;
  const prediction = research?.predictions?.[SINGLE_EXTERNAL_PRIMARY_ID];
  if (locked?.roundStartMs !== expectedRound ||
      research?.version !== EXTERNAL_RESEARCH_VERSION ||
      research?.predictedHorizonMs !== 300000 ||
      (prediction?.direction !== 'UP' && prediction?.direction !== 'DOWN'))
    return {eligible:false,reason:'EXTERNAL_PRIMARY_CURRENT_ROUND_MISSING'};
  if (locked?.decisionComputedAtMs > expectedRound + 8000 ||
      locked?.decisionComputedAtMs < expectedRound ||
      locked?.publishedAtMs > expectedRound + 8000)
    return {eligible:false,reason:'EXTERNAL_PRIMARY_NOT_FROZEN_WITHIN_8S'};
  const degraded = research.fullQuality !== true || prediction.fallback === true ||
    prediction.evidence !== 'FROZEN_REGIME_INPUT' ||
    (research.dataQuality || []).length > 0;
  return {
    eligible:true,reason:null,source:SINGLE_EXTERNAL_PRIMARY_SOURCE,
    model:SINGLE_EXTERNAL_PRIMARY_ID,modelVersion:SINGLE_EXTERNAL_PRIMARY_VERSION,
    direction:prediction.direction,
    generatedAt:readiness.preview?.persistedAtMs,
    fallbackUsed:degraded,
    fallbackReason:prediction.fallback
      ? 'EXTERNAL_PRIMARY_NO_INFORMATION_FALLBACK'
      : degraded ? 'EXTERNAL_PRIMARY_DEGRADED_OR_PRE_ROUND_INPUT' : null,
    qualityStatus:degraded ? 'EXTERNAL_PRIMARY_UNVERIFIED_INPUT'
      : 'EXTERNAL_PRIMARY_FROZEN_INPUT',
    // Strength is NOT a calibrated probability. Do not place it in score/confidence.
    strength:prediction.strength ?? null,
    issues:research.dataQuality || [],
    evidence:prediction.evidence || null,
    trainingStatus:stats?.training?.status || null,
    presentFeatures:locked.presentFeatures ?? null,
  };
}
