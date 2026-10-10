import { V3_NO_BASE_15S_VERSION } from './v3-no-base-15s-audit.mjs';

export const CURRENT03_PM_AGREE_SOURCE = 'CURRENT_03_PM_AGREE_15S_PRIMARY';
export const CURRENT03_PM_AGREE_MODEL = 'CURRENT_03_PM_AGREE';
export const CURRENT03_PM_AGREE_START_MS = Date.parse('2026-10-10T15:00:00.000Z');
const MIN_OBSERVED_MS = 15000;
const MAX_OBSERVED_MS = 17000;
const MAX_LIVE_MS = 20000;
const ROUND_MS = 300000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDirection = d => d === 'UP' || d === 'DOWN';

// Explicit user-directed opt-in: take ONLY CURRENT_03_PM_AGREE from an
// immutable, genuine 15-second, pre-settlement no-base capture. No other
// pilot is permitted to lock production. NOT an accuracy-qualified strategy.
export function selectCurrent03PmAgree15s(row, now = Date.now()) {
  const reject = reason => ({allowed:false, reason, candidate:null});
  if (!row || !finite(now) || !finite(row.roundStartMs))
    return reject('INVALID_ROUND');
  const start = row.roundStartMs;
  if (start < CURRENT03_PM_AGREE_START_MS || start % ROUND_MS !== 0)
    return reject('BEFORE_OPT_IN_OR_INVALID_ROUND');
  const elapsed = now - start;
  if (elapsed < MIN_OBSERVED_MS || elapsed > MAX_LIVE_MS || elapsed >= ROUND_MS)
    return reject('OUTSIDE_15S_LIVE_LOCK_WINDOW');
  if (validDirection(row.prediction) || finite(row.predictedAt) ||
      validDirection(row.productionPrediction) || validDirection(row.actual) ||
      row.settledAt || row.productionSettledAt)
    return reject('BASE_ALREADY_LOCKED_OR_ROUND_SETTLED');
  const frozen = row.v3NoBase15sShadow;
  if (!frozen || frozen.version !== V3_NO_BASE_15S_VERSION ||
      frozen.baseAbsentAtObservation !== true ||
      frozen.inputFrozenBeforeSettlement !== true || frozen.round !== start ||
      !finite(frozen.observedAt) ||
      frozen.observedAt - start < MIN_OBSERVED_MS ||
      frozen.observedAt - start > MAX_OBSERVED_MS ||
      frozen.observedAt > now ||
      !finite(frozen.observedDelayMs) ||
      frozen.observedDelayMs !== frozen.observedAt - start)
    return reject('MISSING_OR_INVALID_PRESETTLEMENT_15S_FREEZE');
  const f = frozen.facts;
  if (!f || f.dataFresh !== true ||
      !Array.isArray(f.gateFailures) || f.gateFailures.length !== 0 ||
      f.bookMappingReliable !== true || f.bookRoundAligned !== true ||
      !f.sourceMarketTopicId || f.absorptionRiskAtFreeze === true ||
      !finite(f.upMid) || f.upMid < 0 || f.upMid > 1 ||
      !finite(f.predictionBookAgeMs) || f.predictionBookAgeMs < 0 || f.predictionBookAgeMs > 5000 ||
      !finite(f.currentScore))
    return reject('FROZEN_MARKET_DATA_QUALITY_FAILED');
  const pmDirection = f.upMid >= 0.53 ? 'UP' : f.upMid <= 0.47 ? 'DOWN' : null;
  if (!pmDirection || (pmDirection === 'UP' ? f.currentScore : -f.currentScore) < 0.30)
    return reject('CURRENT_03_PM_NOT_AGREED');
  const c = frozen.candidates?.[CURRENT03_PM_AGREE_MODEL];
  if (!c || c.decision !== pmDirection || c.qualified !== true ||
      !Array.isArray(c.reasons) || c.reasons.length !== 0)
    return reject('FROZEN_CURRENT03_CANDIDATE_NOT_QUALIFIED');
  return {
    allowed:true, reason:null,
    candidate:{
      direction:pmDirection,
      round:start,
      observedAt:frozen.observedAt,
      currentScore:f.currentScore,
      predictionMarketUpMid:f.upMid,
      sourceMarketTopicId:f.sourceMarketTopicId,
      inputFrozenBeforeSettlement:true,
      accuracyQualification:'USER_OPT_IN_UNVALIDATED_15S_CANDIDATE',
    },
  };
}

// Production-only circuit stats use independent official settlement of
// actually locked 15s signals; shadow HITs are not counted as live outcomes.
export function current03PmAgreeProductionFuseSummary(rounds, productionSource = CURRENT03_PM_AGREE_SOURCE) {
  const settled = Array.from(rounds?.values?.() || []).filter(r =>
    r?.productionSource === productionSource &&
    (r.productionPrediction === 'UP' || r.productionPrediction === 'DOWN') &&
    (r.productionResult === 'HIT' || r.productionResult === 'MISS') &&
    r.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
    r.officialDirection === r.productionActual &&
    (r.productionActual === 'UP' || r.productionActual === 'DOWN') &&
    String(r.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC')
  ).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const summarise = entries => {
    const hits = entries.filter(r => r.productionResult === 'HIT').length;
    return {samples:entries.length,hits,misses:entries.length-hits,
      accuracy:entries.length ? Number((hits/entries.length).toFixed(4)) : null};
  };
  const side = direction => {
    const entries = settled.filter(r=>r.productionPrediction===direction);
    const recent = entries.slice(-6);
    let missesInRow = 0;
    for (let i=entries.length-1;i>=0 && entries[i].productionResult==='MISS';i--) missesInRow++;
    const stats = summarise(recent);
    return {
      ...summarise(entries),recent6:stats,missStreak:missesInRow,
      fused:(stats.samples>=5 && stats.accuracy<0.70) || missesInRow>=3,
    };
  };
  const recent = summarise(settled.slice(-10));
  return {
    fuse:{globalFused:recent.samples>=5 && recent.accuracy<0.70},
    recent10:recent,
    up:side('UP'),down:side('DOWN'),
    production:summarise(settled),
  };
}
