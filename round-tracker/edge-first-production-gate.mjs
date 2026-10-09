// Evaluate supplementary Selective V2 signals only from previously locked, settled rounds.
// Never use a live round or a recomputed/retroactive prediction to qualify production.
export const CORE_MIN_ACCURACY = 0.75;
export const CORE_MIN_SAMPLES = 60;
export const CORE_RECENT20_MIN = 20;
export const CORE_DIRECTION_MIN = 10;

export function evaluateCoreSupplementGate(rounds, direction, currentRound, opts = {}) {
  const minSamples = opts.minSamples ?? CORE_MIN_SAMPLES;
  const floor = opts.floor ?? CORE_MIN_ACCURACY;
  const currentStart = Number(currentRound);
  const valid = Array.from(rounds || []).filter(r => {
    const start = Number(r?.roundStartMs);
    const locked = Number(r?.predictedAt);
    const end = Number(r?.roundEndMs ?? (start + 300000));
    return Number.isFinite(start) && start < currentStart &&
      Number.isFinite(locked) && locked >= start && locked < end &&
      r?.lockQualitySelectiveV2?.version === 'LOCK_QUALITY_SELECTIVE_V2' &&
      r.lockQualitySelectiveV2.pass === true &&
      (r.prediction === 'UP' || r.prediction === 'DOWN') &&
      (r.actual === 'UP' || r.actual === 'DOWN');
  }).sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const summarize = arr => {
    const n = arr.length;
    const hits = arr.filter(r => r.prediction === r.actual).length;
    return { samples:n, hits, misses:n-hits, accuracy:n ? Number((hits/n).toFixed(4)) : null };
  };
  const last60 = valid.slice(-minSamples);
  const recent20 = valid.slice(-20);
  const recent10 = valid.slice(-10);
  const byDirection = valid.filter(r => r.prediction === direction).slice(-CORE_DIRECTION_MIN);
  const directionStats = summarize(byDirection);
  let missStreak = 0;
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const r = valid[i];
    if (r.prediction !== direction) continue;
    if (r.prediction === r.actual) break;
    missStreak += 1;
  }
  const last60Stats = summarize(last60);
  const recent20Stats = summarize(recent20);
  const recent10Stats = summarize(recent10);
  const reasons = [];
  if (direction !== 'UP' && direction !== 'DOWN') reasons.push('NO_BASE_DIRECTION');
  if (last60Stats.samples < minSamples) reasons.push('NEED_60_FROZEN_CORE_SAMPLES');
  if (last60Stats.accuracy === null || last60Stats.accuracy < floor) reasons.push('CORE_LAST60_BELOW_75');
  if (recent20Stats.samples < CORE_RECENT20_MIN ||
      recent20Stats.accuracy === null || recent20Stats.accuracy < floor) reasons.push('CORE_RECENT20_BELOW_75');
  if (recent10Stats.samples < 10 ||
      recent10Stats.accuracy === null || recent10Stats.accuracy < floor) reasons.push('CORE_RECENT10_BELOW_75');
  if (directionStats.samples < CORE_DIRECTION_MIN ||
      directionStats.accuracy === null || directionStats.accuracy < floor) reasons.push('CORE_DIRECTION_LAST10_BELOW_75');
  if (missStreak > 2) reasons.push('CORE_DIRECTION_MISS_STREAK');
  return {
    allowed:reasons.length === 0,
    reasons, minAccuracy:floor, minSamples,
    last60:last60Stats, recent20:recent20Stats, recent10:recent10Stats,
    direction:directionStats, missStreak, observedFrozenSamples:valid.length,
  };
}
