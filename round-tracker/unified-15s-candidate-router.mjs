import {
  V3_NO_BASE_15S_CONFIGS,
  V3_NO_BASE_15S_VERSION,
  V3_NO_BASE_15S_FORWARD_TARGET,
} from './v3-no-base-15s-audit.mjs';

// All eleven candidates have one registered policy and their own audit lane.
// Two are already user-opted-in for live use. The remaining nine require
// independent official-settlement strict-forward qualification before they
// can acquire a production lock. No shadow result is a production HIT.
export const LIVE_OPT_IN_15S_IDS = Object.freeze([
  'PM_CURRENT25_SUPPORT08', 'CURRENT_03_PM_AGREE',
]);
export const FORWARD_GATED_15S_IDS = Object.freeze(
  V3_NO_BASE_15S_CONFIGS.map(x => x.id).filter(x => !LIVE_OPT_IN_15S_IDS.includes(x)),
);
export const ALL_15S_IDS = Object.freeze(V3_NO_BASE_15S_CONFIGS.map(x => x.id));
const isDirection = x => x === 'UP' || x === 'DOWN';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const ratio = x => finite(x) && x >= 0 && x <= 1;
const ABSORPTION = new Set(['ABS_PM_CURRENT15', 'ABS_PM_REGIME35']);

export function candidateProductionSource(id) {
  if (!FORWARD_GATED_15S_IDS.includes(id)) return null;
  return 'VERIFIED_V3_NO_BASE_15S_' + id + '_PRIMARY';
}

// A shadow label (including ELIGIBLE_FOR_INDEPENDENT_REVIEW) alone never
// authorizes production; recheck all historical thresholds here.
export function forward15sProofPass(x) {
  return x?.status === 'ELIGIBLE_FOR_INDEPENDENT_REVIEW' &&
    x.strictForwardSamples >= V3_NO_BASE_15S_FORWARD_TARGET &&
    ratio(x.forwardAccuracy) && x.forwardAccuracy >= 0.75 &&
    x.recent20?.samples >= 20 && ratio(x.recent20.accuracy) && x.recent20.accuracy >= 0.75 &&
    x.recent10?.samples >= 10 && ratio(x.recent10.accuracy) && x.recent10.accuracy >= 0.70 &&
    x.up?.samples >= 10 && x.down?.samples >= 10 &&
    ratio(x.up.accuracy) && x.up.accuracy >= 0.70 &&
    ratio(x.down.accuracy) && x.down.accuracy >= 0.70 &&
    x.upRecent6?.samples >= 6 && ratio(x.upRecent6.accuracy) && x.upRecent6.accuracy >= 0.70 &&
    x.downRecent6?.samples >= 6 && ratio(x.downRecent6.accuracy) && x.downRecent6.accuracy >= 0.70 &&
    Number.isInteger(x.maxConsecutiveMisses) && x.maxConsecutiveMisses <= 2;
}

export function selectForwardGated15sCandidates(row, stats, now = Date.now()) {
  const reject = reason => ({candidates:[], reason});
  if (!row || !finite(now) || !finite(row.roundStartMs) ||
      row.roundStartMs % 300000 !== 0 ||
      now-row.roundStartMs < 15000 || now-row.roundStartMs > 20000 ||
      isDirection(row.prediction) || finite(row.predictedAt) ||
      isDirection(row.productionPrediction) || isDirection(row.actual) ||
      row.settledAt || row.productionSettledAt)
    return reject('INVALID_LIVE_15S_NO_BASE_WINDOW');
  const f = row.v3NoBase15sShadow;
  if (!f || f.version !== V3_NO_BASE_15S_VERSION ||
      f.baseAbsentAtObservation !== true || f.inputFrozenBeforeSettlement !== true ||
      f.round !== row.roundStartMs || !finite(f.observedAt) ||
      f.observedAt-row.roundStartMs < 15000 ||
      f.observedAt-row.roundStartMs > 17000 || f.observedAt > now ||
      !finite(f.observedDelayMs) || f.observedDelayMs !== f.observedAt-row.roundStartMs)
    return reject('NO_VALID_15S_PROSPECTIVE_FREEZE');
  const q = f.facts;
  const failures = q?.gateFailures;
  const clean = q?.dataFresh === true && Array.isArray(failures) && failures.length === 0;
  const absorptionOnly = q?.dataFresh === false && q.absorptionRiskAtFreeze === true &&
    Array.isArray(failures) && failures.length === 1 && failures[0] === 'ABSORPTION_RISK';
  if ((!clean && !absorptionOnly) || q.bookMappingReliable !== true ||
      q.bookRoundAligned !== true || !q.sourceMarketTopicId ||
      !finite(q.predictionBookAgeMs) || q.predictionBookAgeMs < 0 || q.predictionBookAgeMs > 5000 ||
      !finite(q.upMid) || q.upMid < 0 || q.upMid > 1)
    return reject('INVALID_FROZEN_PM_DATA');
  if (!stats || stats.version !== V3_NO_BASE_15S_VERSION ||
      stats.scope !== 'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S' ||
      !Array.isArray(stats.candidates) ||
      stats.observedNoBaseSettledRounds < V3_NO_BASE_15S_FORWARD_TARGET)
    return reject('INSUFFICIENT_STRICT_FORWARD_EVIDENCE');
  const approved = [];
  for (const x of stats.candidates) {
    if (!FORWARD_GATED_15S_IDS.includes(x.candidateId) || !forward15sProofPass(x) ||
        ABSORPTION.has(x.candidateId) !== absorptionOnly) continue;
    const snapshot = f.candidates?.[x.candidateId];
    const direction = snapshot?.decision;
    if (!isDirection(direction) || snapshot.qualified !== true ||
        !Array.isArray(snapshot.reasons) || snapshot.reasons.length !== 0)
      continue;
    const pmSupport = direction === 'UP' ? q.upMid-0.5 : 0.5-q.upMid;
    if (pmSupport < 0.03) continue;
    approved.push({
      id:x.candidateId, direction, observedAt:f.observedAt,
      score:finite(q.currentScore) ? q.currentScore : null,
      pmUpMid:q.upMid, topicId:q.sourceMarketTopicId,
      source:candidateProductionSource(x.candidateId),
      proof:{strictForwardSamples:x.strictForwardSamples,
        forwardAccuracy:x.forwardAccuracy,recent20Accuracy:x.recent20.accuracy,
        upAccuracy:x.up.accuracy,downAccuracy:x.down.accuracy},
    });
  }
  // Quality-qualified candidates win over speculative opt-in routes. Prefer
  // higher independently observed forward accuracy, then a stable ID.
  approved.sort((a,b) =>
    b.proof.forwardAccuracy-a.proof.forwardAccuracy ||
    b.proof.strictForwardSamples-a.proof.strictForwardSamples ||
    a.id.localeCompare(b.id)
  );
  return {candidates:approved,reason:approved.length ? null : 'NO_FORWARD_QUALIFIED_MODEL'};
}
