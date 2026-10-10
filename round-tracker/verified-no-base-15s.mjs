import { V3_NO_BASE_15S_VERSION, V3_NO_BASE_15S_FORWARD_TARGET } from './v3-no-base-15s-audit.mjs';

// The V3 engine can abstain while a separate, prospectively frozen 15s candidate
// passes its own independently measurable forward trial. Never manufacture an
// order direction from a WAIT or from a post-settlement re-evaluation.
export const VERIFIED_NO_BASE_SOURCE = 'SELECTIVE_V2_VERIFIED_NO_BASE_15S_PRIMARY';

const validDirection = v => v === 'UP' || v === 'DOWN';
const finite = v => typeof v === 'number' && Number.isFinite(v);
const safeRatio = v => finite(v) && v >= 0 && v <= 1;

export function selectVerifiedNoBase15s(row, status, now = Date.now()) {
  const reject = reason => ({ allowed: false, reason, candidate: null });
  if (!row || !finite(now) || !finite(row.roundStartMs)) return reject('INVALID_ROUND');
  const start = row.roundStartMs;
  if (validDirection(row.prediction) || validDirection(row.productionPrediction))
    return reject('ALREADY_HAS_DIRECTION');
  // The shadow snapshot is frozen exactly at 15s. Reject missing/out-of-window,
  // backdated, stale, cross-round or already-settled inputs.
  const snapshot = row.v3NoBase15sShadow;
  if (!snapshot || snapshot.version !== V3_NO_BASE_15S_VERSION ||
      snapshot.baseAbsentAtObservation !== true || snapshot.inputFrozenBeforeSettlement !== true ||
      snapshot.round !== start || !finite(snapshot.observedAt) ||
      snapshot.observedAt - start < 15000 || snapshot.observedAt - start > 17000 ||
      snapshot.observedAt > now || now - start > 20000 || now >= start + 300000 ||
      row.actual === 'UP' || row.actual === 'DOWN' || row.settledAt)
    return reject('NO_ELIGIBLE_PRESETTLEMENT_15S_FREEZE');
  const fact=snapshot.facts;
  const failures=fact?.gateFailures;
  const cleanInput=fact?.dataFresh === true &&
    Array.isArray(failures) && failures.length===0;
  // Only the two dedicated prospective counterfactual pilots may present
  // EXACTLY an absorption warning. Never waive stale data, an invalid topic,
  // broken depth, stream stall, or any other feed-quality failure.
  const absorptionOnly=fact?.dataFresh === false &&
    fact?.absorptionRiskAtFreeze === true &&
    Array.isArray(failures) && failures.length===1 &&
    failures[0]==='ABSORPTION_RISK';
  if ((!cleanInput && !absorptionOnly) ||
      fact?.bookMappingReliable !== true || fact?.bookRoundAligned !== true ||
      !finite(fact?.upMid) || fact.upMid<0 || fact.upMid>1)
    return reject('FROZEN_INPUT_QUALITY_NOT_PROVEN');
  if (!status || status.version !== V3_NO_BASE_15S_VERSION ||
      status.scope !== 'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S' ||
      !Array.isArray(status.candidates) || !finite(status.observedNoBaseSettledRounds))
    return reject('MISSING_STRICT_FORWARD_PROOF');
  // The current snapshot cannot be included in the settled forward denominator.
  if (status.observedNoBaseSettledRounds < V3_NO_BASE_15S_FORWARD_TARGET)
    return reject('INSUFFICIENT_FORWARD_HISTORY');
  const approved = status.candidates.filter(c =>
    c?.status === 'ELIGIBLE_FOR_INDEPENDENT_REVIEW' &&
    c.strictForwardSamples >= V3_NO_BASE_15S_FORWARD_TARGET &&
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
    const absorptionPilot=proof.candidateId==='ABS_PM_CURRENT15' ||
      proof.candidateId==='ABS_PM_REGIME35';
    // A new risk-classified model cannot be substituted for an ordinary
    // clean model (or vice versa) even if the outcome stats look attractive.
    if (absorptionOnly !== absorptionPilot) continue;
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
      absorptionOnlyProspectivePilot:absorptionOnly,
    }};
  }
  return reject(approved.length ? 'QUALIFIED_MODEL_NOT_VALID_FOR_THIS_ROUND' : 'NO_75_PERCENT_FORWARD_QUALIFIED_MODEL');
}
