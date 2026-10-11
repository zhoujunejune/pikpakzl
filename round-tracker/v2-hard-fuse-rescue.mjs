// Isolated production rescue for Selective V2 quality-pass signals blocked by
// its own direction-local hard fuse. No historical/forward sample entry gate;
// quality and an independent direction check are mandatory per live round.
export const SOURCE = 'SELECTIVE_V2_HARD_FUSE_RESCUE_PRIMARY';
export const VERSION = 'SELECTIVE_V2_HARD_FUSE_RESCUE_V1';

export function evaluateV2HardFuseRescue(row, now = Date.now()) {
  if (!row || !['UP','DOWN'].includes(row.prediction) ||
      row.actual || row.settledAt ||
      !Number.isFinite(Number(row.roundStartMs)) ||
      now < Number(row.roundStartMs) ||
      now >= Number(row.roundStartMs) + 300000) return null;
  if (row.v2HardFuseRescue?.version === VERSION) return row.v2HardFuseRescue;

  const direction = row.prediction;
  const f = row.predictionFacts || {};
  const sign = direction === 'UP' ? 1 : -1;
  const upMid = Number(f.predictionMarketUpMid);
  const current = Number(f.currentScore);
  const trend = Number(f.currentTrendScore);
  const score = Number(row.predictionScore);
  const delay = Number(row.predictionDelayMs);
  const regime = String(f.regimeDirection || '').toUpperCase();
  const agreement = Number(f.regimeAgreement);
  const support = Number.isFinite(upMid) ? sign * (upMid - 0.5) : null;
  const reasons = [];
  if (!Number.isFinite(support) || support < 0.08)
    reasons.push('PM_DIRECTION_SUPPORT_BELOW_0_08');
  if (!Number.isFinite(current) || sign * current < 0.65)
    reasons.push('CURRENT_DIRECTION_NOT_CONFIRMED');
  if (!Number.isFinite(trend) || sign * trend < 0.45)
    reasons.push('TREND_DIRECTION_NOT_CONFIRMED');
  if (!Number.isFinite(score) || Math.abs(score) < 0.45)
    reasons.push('BASE_SCORE_TOO_WEAK');
  if (!Number.isFinite(delay) || delay < 0 || delay > 20000)
    reasons.push('LOCK_DELAY_OUT_OF_RANGE');
  if (f.absorptionRisk === true) reasons.push('ABSORPTION_RISK');
  if (Number.isFinite(agreement) && agreement >= 0.67 &&
      regime === (direction === 'UP' ? 'DOWN' : 'UP'))
    reasons.push('STRONG_REGIME_CONFLICT');

  return {
    version: VERSION,
    trigger: 'SELECTIVE_V2_QUALITY_PASS_DIRECTION_HARD_FUSE',
    frozenAt: now,
    direction, decision: reasons.length ? 'WAIT' : direction,
    pass: reasons.length === 0, reasons,
    evidence: {
      support: Number.isFinite(support) ? support : null,
      current: Number.isFinite(current) ? current : null,
      trend: Number.isFinite(trend) ? trend : null,
      score: Number.isFinite(score) ? score : null,
      delay: Number.isFinite(delay) ? delay : null,
      regime, agreement: Number.isFinite(agreement) ? agreement : null,
      absorptionRisk: f.absorptionRisk === true,
    },
  };
}

export function summarizeV2HardFuseRescue(rounds) {
  const eligible = [...rounds].filter(row =>
    ['UP','DOWN'].includes(row?.v2HardFuseRescue?.decision) &&
    ['UP','DOWN'].includes(row?.actual) &&
    row.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
    Number.isFinite(Number(row.v2HardFuseRescue.frozenAt)) &&
    Number(row.v2HardFuseRescue.frozenAt) >= Number(row.roundStartMs) &&
    Number(row.v2HardFuseRescue.frozenAt) < Number(row.roundStartMs) + 300000 &&
    Number.isFinite(Number(row.settledAt)) &&
    Number(row.v2HardFuseRescue.frozenAt) < Number(row.settledAt)
  ).sort((a,b) => a.roundStartMs - b.roundStartMs);
  const stats = rows => {
    const hits = rows.filter(row => row.v2HardFuseRescue.decision === row.actual).length;
    return {samples: rows.length, hits, misses: rows.length-hits,
      accuracy: rows.length ? hits/rows.length : null};
  };
  const latest = rows => rows.length ? {
    roundStartMs:Number(rows[rows.length-1].roundStartMs),
    miss:rows[rows.length-1].v2HardFuseRescue.decision !== rows[rows.length-1].actual,
  } : null;
  const byDirection = direction => {
    const all = eligible.filter(row => row.v2HardFuseRescue.decision === direction);
    const recent6=stats(all.slice(-6));
    let missStreak=0;
    for (let i=all.length-1;i>=0 && all[i].v2HardFuseRescue.decision!==all[i].actual;i--)
      missStreak++;
    return {...stats(all),recent6,missStreak,
      fused:(recent6.samples>=5 && recent6.accuracy<0.70) || missStreak>=3,
      latestEligible:latest(all)};
  };
  const recent10=stats(eligible.slice(-10));
  return {
    version:VERSION,
    eligibleStrictForward:stats(eligible),recent10,
    up:byDirection('UP'),down:byDirection('DOWN'),
    fuse:{
      globalFused:recent10.samples>=5 && recent10.accuracy<0.70,
      latestEligible:latest(eligible),
    },
  };
}
