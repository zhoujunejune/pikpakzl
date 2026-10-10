import { V3_NO_BASE_15S_VERSION } from './v3-no-base-15s-audit.mjs';
import { FORWARD_GATED_15S_IDS, candidateProductionSource } from './unified-15s-candidate-router.mjs';

// Option B: an experimental fallback, not a validated model.
// It operates ONLY after the two early live routes and the 22-second
// Selective V2/Tier-1 routes have declined to lock the round.
export const LOW_PRIORITY_BACKUP_VERSION = 'UNVERIFIED_15S_LAST_RESORT_V1';
export const LOW_PRIORITY_BACKUP_MIN_MS = 25000;
export const LOW_PRIORITY_BACKUP_MAX_MS = 35000;
const priority = Object.freeze([
  'CURRENT_04_TREND_055_PM05',
  'CURRENT_03_TREND_045_PM08',
  'PM_TREND_045_CURRENT_03',
  'PM_FLOW15_CURRENT_03',
  'PM_REGIME35_SUPPORT08',
  'BLENDED_04_PM_AGREE',
  'ABS_PM_CURRENT15',
  'ABS_PM_REGIME35',
  'PM_LEAN_03',
]);
const valid = d => d === 'UP' || d === 'DOWN';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const ABS = new Set(['ABS_PM_CURRENT15','ABS_PM_REGIME35']);

export function selectLastResort15sBackups(row, now = Date.now()) {
  const reject = reason => ({candidates:[],reason});
  if (!row || !finite(now) || !finite(row.roundStartMs) ||
      now-row.roundStartMs < LOW_PRIORITY_BACKUP_MIN_MS ||
      now-row.roundStartMs > LOW_PRIORITY_BACKUP_MAX_MS ||
      row.roundStartMs % 300000 !== 0 ||
      valid(row.productionPrediction) || valid(row.actual) ||
      row.settledAt || row.productionSettledAt)
    return reject('NOT_ELIGIBLE_LIVE_WAIT_WINDOW');
  const f = row.v3NoBase15sShadow;
  if (!f || f.version !== V3_NO_BASE_15S_VERSION ||
      f.round !== row.roundStartMs ||
      f.baseAbsentAtObservation !== true || f.inputFrozenBeforeSettlement !== true ||
      !finite(f.observedAt) || !finite(f.observedDelayMs) ||
      f.observedAt-row.roundStartMs < 15000 ||
      f.observedAt-row.roundStartMs > 17000 ||
      f.observedDelayMs !== f.observedAt-row.roundStartMs ||
      f.observedAt > now ||
      (finite(row.predictedAt) && row.predictedAt <= f.observedAt))
    return reject('MISSING_15S_IMMUTABLE_PRESETTLEMENT_EVIDENCE');
  const q = f.facts;
  const failures=q?.gateFailures;
  const clean = q?.dataFresh===true && Array.isArray(failures) && failures.length===0;
  const absorptionOnly=q?.dataFresh===false && q?.absorptionRiskAtFreeze===true &&
    Array.isArray(failures) && failures.length===1 && failures[0]==='ABSORPTION_RISK';
  if ((!clean && !absorptionOnly) || q?.bookMappingReliable!==true ||
      q?.bookRoundAligned!==true || !q.sourceMarketTopicId ||
      !finite(q.predictionBookAgeMs) || q.predictionBookAgeMs<0 ||
      q.predictionBookAgeMs>5000 || !finite(q.upMid) || q.upMid<0 || q.upMid>1)
    return reject('INVALID_FROZEN_MARKET_DATA');
  const base=valid(row.prediction)?row.prediction:null;
  const candidates=[];
  for (const id of priority) {
    if (!FORWARD_GATED_15S_IDS.includes(id) || ABS.has(id)!==absorptionOnly) continue;
    const c=f.candidates?.[id];
    if (!c || !valid(c.decision) || c.qualified!==true ||
        !Array.isArray(c.reasons) || c.reasons.length!==0 ||
        (base && base!==c.decision)) continue;
    const signedPm=c.decision==='UP' ? q.upMid-0.5 : 0.5-q.upMid;
    if (signedPm<0.03) continue;
    candidates.push({
      id,source:candidateProductionSource(id),
      direction:c.decision,observedAt:f.observedAt,
      score:finite(q.currentScore)?q.currentScore:null,
      topicId:q.sourceMarketTopicId,absorptionOnly,
      evidenceStatus:'UNVERIFIED_LOW_PRIORITY_OPTION_B',
    });
  }
  return {candidates,reason:candidates.length?null:'NO_LAST_RESORT_CANDIDATE'};
}
