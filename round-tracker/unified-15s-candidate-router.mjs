import {
  V3_NO_BASE_15S_CONFIGS,
  V3_NO_BASE_15S_VERSION,
  V3_NO_BASE_15S_FORWARD_TARGET,
} from './v3-no-base-15s-audit.mjs';

// All ten candidates observe strictly prospective official outcomes.
// Only strategies with live strict-forward qualification may lock at 15-20s,
// before Selective V2's 22s cutoff; a qualified 25-35s backup remains after V2.
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
  if (id === 'PM_CURRENT25_SUPPORT08') return 'PM_CURRENT25_SUPPORT08_15S_PRIMARY';
  if (id === 'CURRENT_03_PM_AGREE') return 'CURRENT_03_PM_AGREE_15S_PRIMARY';
  if (!FORWARD_GATED_15S_IDS.includes(id)) return null;
  // Preserve independent settled histories and existing timed fuses.
  return 'LOW_PRIORITY_15S_' + id + '_PRIMARY';
}

export function wilsonLower95(hits,n) {
  if (!Number.isInteger(hits)||!Number.isInteger(n)||n<=0||hits<0||hits>n)return null;
  const p=hits/n,z2=1.96**2;
  return (p+z2/(2*n)-1.96*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/(1+z2/n);
}

// A shadow label (including ELIGIBLE_FOR_INDEPENDENT_REVIEW) alone never
// authorizes production; recheck all historical thresholds here.
export function forward15sProofPass(x) {
  return x?.status === 'ELIGIBLE_FOR_INDEPENDENT_REVIEW' &&
    Number.isInteger(x.strictForwardSamples) && x.strictForwardSamples >= 100 &&
    Number.isInteger(x.hits) && Number.isInteger(x.misses) &&
    x.hits+x.misses === x.strictForwardSamples &&
    (wilsonLower95(x.hits,x.strictForwardSamples) ?? 0) >= 0.70 &&
    ratio(x.forwardAccuracy) && x.forwardAccuracy >= 0.75 &&
    x.recent30?.samples >= 30 && ratio(x.recent30.accuracy) && x.recent30.accuracy >= 0.75 &&
    x.recent20?.samples >= 20 && ratio(x.recent20.accuracy) && x.recent20.accuracy >= 0.75 &&
    x.recent10?.samples >= 10 && ratio(x.recent10.accuracy) && x.recent10.accuracy >= 0.70 &&
    x.up?.samples >= 10 && x.down?.samples >= 10 &&
    ratio(x.up.accuracy) && x.up.accuracy >= 0.70 &&
    ratio(x.down.accuracy) && x.down.accuracy >= 0.70 &&
    x.upRecent6?.samples >= 6 && ratio(x.upRecent6.accuracy) && x.upRecent6.accuracy >= 0.70 &&
    x.downRecent6?.samples >= 6 && ratio(x.downRecent6.accuracy) && x.downRecent6.accuracy >= 0.70 &&
    Number.isInteger(x.currentMissStreak) && x.currentMissStreak <= 2;
}

export function selectForwardGated15sCandidates(row, stats, now = Date.now(), phase = 'late') {
  const reject = reason => ({candidates:[], reason});
  const elapsed = now - (row?.roundStartMs ?? NaN);
  const windowOk = phase === 'early' ? elapsed >= 15000 && elapsed <= 20000 :
    phase === 'late' ? elapsed >= 25000 && elapsed <= 35000 : false;
  if (!row || !finite(now) || !finite(row.roundStartMs) ||
      row.roundStartMs % 300000 !== 0 || !windowOk ||
      isDirection(row.productionPrediction) || isDirection(row.actual) ||
      row.settledAt || row.productionSettledAt)
    return reject('OUTSIDE_QUALIFIED_15S_LOCK_WINDOW');
  const f = row.v3NoBase15sShadow;
  if (!f || f.version !== V3_NO_BASE_15S_VERSION ||
      f.baseAbsentAtObservation !== true || f.inputFrozenBeforeSettlement !== true ||
      f.round !== row.roundStartMs || !finite(f.observedAt) ||
      f.observedAt-row.roundStartMs < 15000 ||
      f.observedAt-row.roundStartMs > 17000 || f.observedAt > now ||
      !finite(f.observedDelayMs) || f.observedDelayMs !== f.observedAt-row.roundStartMs ||
      (finite(row.predictedAt) && row.predictedAt <= f.observedAt))
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
    if (!ALL_15S_IDS.includes(x.candidateId) || !forward15sProofPass(x) ||
        ABSORPTION.has(x.candidateId) !== absorptionOnly) continue;
    const snapshot = f.candidates?.[x.candidateId];
    const direction = snapshot?.decision;
    if (!isDirection(direction) || snapshot.qualified !== true ||
        !Array.isArray(snapshot.reasons) || snapshot.reasons.length !== 0 ||
        (isDirection(row.prediction) && row.prediction !== direction))
      continue;
    const pmSupport = direction === 'UP' ? q.upMid-0.5 : 0.5-q.upMid;
    if (pmSupport < 0.03) continue;
    const lower=wilsonLower95(x.hits,x.strictForwardSamples);
    const mid=direction==='UP'?q.upMid:1-q.upMid;
    // Midpoint is only a price PROXY, never a verified executable ask/fill or P&L.
    if (lower===null || lower-(mid+0.03)<0.02)continue;
    approved.push({
      id:x.candidateId, direction, observedAt:f.observedAt,
      score:finite(q.currentScore) ? q.currentScore : null,
      pmUpMid:q.upMid, topicId:q.sourceMarketTopicId,
      source:candidateProductionSource(x.candidateId),
      proof:{strictForwardSamples:x.strictForwardSamples,
        forwardAccuracy:x.forwardAccuracy,recent30Accuracy:x.recent30.accuracy,
        lower95:lower,estimatedPriceMid:mid,estimatedNetEdge:lower-mid-0.03,
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
