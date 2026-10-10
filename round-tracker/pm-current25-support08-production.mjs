import { V3_NO_BASE_15S_VERSION } from './v3-no-base-15s-audit.mjs';

export const PM_CURRENT25_SUPPORT08_SOURCE = 'PM_CURRENT25_SUPPORT08_15S_PRIMARY';
export const PM_CURRENT25_SUPPORT08_MODEL = 'PM_CURRENT25_SUPPORT08';
export const PM_CURRENT25_SUPPORT08_START_MS = Date.parse('2026-10-10T15:00:00.000Z');
const ROUND_MS = 300000;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const validDirection = x => x === 'UP' || x === 'DOWN';

// Explicit 15s production opt-in. The pre-settlement frozen candidate is
// required; this is not an independently validated accuracy guarantee.
export function selectPmCurrent25Support0815s(row, now = Date.now()) {
  const reject = reason => ({allowed:false,reason,candidate:null});
  if (!row || !finite(now) || !finite(row.roundStartMs)) return reject('INVALID_ROUND');
  const start = row.roundStartMs;
  if (start < PM_CURRENT25_SUPPORT08_START_MS || start % ROUND_MS !== 0)
    return reject('BEFORE_OPT_IN_OR_INVALID_ROUND');
  if (now-start < 15000 || now-start > 20000 || now-start >= ROUND_MS)
    return reject('OUTSIDE_15S_LOCK_WINDOW');
  if (validDirection(row.prediction) || finite(row.predictedAt) ||
      validDirection(row.productionPrediction) || validDirection(row.actual) ||
      row.settledAt || row.productionSettledAt)
    return reject('ALREADY_HAS_BASE_OR_SETTLEMENT');
  const frozen = row.v3NoBase15sShadow;
  if (!frozen || frozen.version !== V3_NO_BASE_15S_VERSION ||
      frozen.round !== start || frozen.baseAbsentAtObservation !== true ||
      frozen.inputFrozenBeforeSettlement !== true || !finite(frozen.observedAt) ||
      frozen.observedAt-start < 15000 || frozen.observedAt-start > 17000 ||
      frozen.observedAt > now ||
      !finite(frozen.observedDelayMs) ||
      frozen.observedDelayMs !== frozen.observedAt-start)
    return reject('INVALID_15S_PRESETTLEMENT_FREEZE');
  const f = frozen.facts;
  if (!f || f.dataFresh !== true || !Array.isArray(f.gateFailures) ||
      f.gateFailures.length !== 0 || f.bookMappingReliable !== true ||
      f.bookRoundAligned !== true || !f.sourceMarketTopicId ||
      f.absorptionRiskAtFreeze === true ||
      !finite(f.predictionBookAgeMs) ||
      f.predictionBookAgeMs < 0 || f.predictionBookAgeMs > 5000 ||
      !finite(f.upMid) || f.upMid < 0 || f.upMid > 1 ||
      !finite(f.currentScore) || f.currentScore < -1 || f.currentScore > 1)
    return reject('FROZEN_DATA_QUALITY_REJECTED');
  const direction = f.upMid >= 0.58 ? 'UP' : f.upMid <= 0.42 ? 'DOWN' : null;
  if (!direction || (direction === 'UP' ? f.currentScore : -f.currentScore) < 0.25)
    return reject('PM_SUPPORT08_CURRENT25_NOT_ALIGNED');
  const c = frozen.candidates?.[PM_CURRENT25_SUPPORT08_MODEL];
  if (!c || c.decision !== direction || c.qualified !== true ||
      !Array.isArray(c.reasons) || c.reasons.length !== 0)
    return reject('FROZEN_CANDIDATE_NOT_QUALIFIED');
  return {
    allowed:true,reason:null,candidate:{
      round:start,direction,observedAt:frozen.observedAt,
      currentScore:f.currentScore,predictionMarketUpMid:f.upMid,
      sourceMarketTopicId:f.sourceMarketTopicId,
      accuracyQualification:'USER_OPT_IN_UNVALIDATED_15S_CANDIDATE',
    },
  };
}
