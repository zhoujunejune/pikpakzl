import { V3_NO_BASE_20S_VERSION, V3_NO_BASE_20S_FORWARD_TARGET } from './v3-no-base-20s-audit.mjs';

// The V3 engine can abstain while a separate, prospectively frozen 20s candidate
// passes its own independently measurable forward trial. Never manufacture an
// order direction from a WAIT or from a post-settlement re-evaluation.
export const VERIFIED_NO_BASE_SOURCE = 'SELECTIVE_V2_VERIFIED_NO_BASE_20S_PRIMARY';

const validDirection = v => v === 'UP' || v === 'DOWN';
const finite = v => typeof v === 'number' && Number.isFinite(v);
const safeRatio = v => finite(v) && v >= 0 && v <= 1;

export function selectVerifiedNoBase20s(row, status, now = Date.now()) {
  const reject = reason => ({ allowed: false, reason, candidate: null });
  if (!row || !finite(now) || !finite(row.roundStartMs)) return reject('INVALID_ROUND');
  const start = row.roundStartMs;
  if (validDirection(row.prediction) || validDirection(row.productionPrediction))
    return reject('ALREADY_HAS_DIRECTION');
  // The shadow snapshot is frozen exactly at 20s. Reject missing/out-of-window,
  // backdated, stale, cross-round or already-settled inputs.
  const snapshot = row.v3NoBase20sShadow;
  if (!snapshot || snapshot.version !== V3_NO_BASE_20S_VERSION ||
      snapshot.baseAbsentAtObservation !== true || snapshot.inputFrozenBeforeSettlement !== true ||
      snapshot.round !== start || !finite(snapshot.observedAt) ||
      snapshot.observedAt - start < 20000 || snapshot.observedAt - start > 22000 ||
      snapshot.observedAt > now || now - start > 25000 || now >= start + 300000 ||
      row.actual === 'UP' || row.actual === 'DOWN' || row.settledAt)
    return reject('NO_ELIGIBLE_PRESETTLEMENT_20S_FREEZE');
  if (snapshot.facts?.dataFresh !== true || snapshot.facts?.bookMappingReliable !== true ||
      snapshot.facts?.bookRoundAligned !== true ||
      !Array.isArray(snapshot.facts?.gateFailures) || snapshot.facts.gateFailures.length ||
      !finite(snapshot.facts?.upMid) || snapshot.facts.upMid < 0 ||
      snapshot.facts.upMid > 1)
    return reject('FROZEN_INPUT_QUALITY_NOT_PROVEN');
  if (!status || status.version !== V3_NO_BASE_20S_VERSION ||
      status.scope !== 'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_20S' ||
      !Array.isArray(status.candidates) || !finite(status.observedNoBaseSettledRounds))
    return reject('MISSING_STRICT_FORWARD_PROOF');
  // The current snapshot cannot be included in the settled forward denominator.
  if (status.observedNoBaseSettledRounds < V3_NO_BASE_20S_FORWARD_TARGET)
    return reject('INSUFFICIENT_FORWARD_HISTORY');
  const approved = status.candidates.filter(c =>
    c?.status === 'ELIGIBLE_FOR_INDEPENDENT_REVIEW' &&
    c.strictForwardSamples >= V3_NO_BASE_20S_FORWARD_TARGET &&
    safeRatio(c.forwardAccuracy) && c.forwardAccuracy >= 0.75 &&
    c.recent20?.samples >= 20 && safeRatio(c.recent20?.accuracy) && c.recent20.accuracy >= 0.75 &&
    c.recent10?.samples >= 10 && safeRatio(c.recent10?.accuracy) && c.recent10.accuracy >= 0.70 &&
    c.up?.samples >= 10 && c.down?.samples >= 10 &&
    safeRatio(c.up?.accuracy) && safeRatio(c.down?.accuracy) &&
    c.up.accuracy >= 0.70 && c.down.accuracy >= 0.70 &&
    c.upRecent6?.samples >= 6 && c.downRecent6?.samples >= 6 &&
    safeRatio(c.upRecent6?.accuracy) && safeRatio(c.downRecent6?.accuracy) &&
    c.upRecent6.accuracy >= 0.70 && c.downRecent6.accuracy >= 0.70 &&
    Number.isInteger(c.maxConsecutiveMisses) && c.maxConsecutiveMisses <= 2
  ).sort((a,b)=>b.forwardAccuracy-a.forwardAccuracy || b.strictForwardSamples-a.strictForwardSamples);
  for (const proof of approved) {
    const c = snapshot.candidates?.[proof.candidateId];
    const direction = c?.decision;
    if (!validDirection(direction) || c.qualified !== true ||
        !Array.isArray(c.reasons) || c.reasons.length) continue;
    // A supported, mapped market side is required even for otherwise qualified candidates.
    const support = direction === 'UP' ? snapshot.facts.upMid-0.5 : 0.5-snapshot.facts.upMid;
    if (support < 0.03) continue;
    return { allowed:true, reason:null, candidate:{
      direction, candidateId:proof.candidateId, observedAt:snapshot.observedAt,
      round:start, score:finite(snapshot.facts.currentScore)?snapshot.facts.currentScore:null,
      predictionMarketUpMid:snapshot.facts.upMid,
      strictForwardSamples:proof.strictForwardSamples,
      strictForwardAccuracy:proof.forwardAccuracy,
      recent20Accuracy:proof.recent20.accuracy,
      verifiedScope:status.scope,
    }};
  }
  return reject(approved.length ? 'QUALIFIED_MODEL_NOT_VALID_FOR_THIS_ROUND' : 'NO_75_PERCENT_FORWARD_QUALIFIED_MODEL');
}
