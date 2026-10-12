import { current03PmAgreeProductionFuseSummary } from './current03-pm-agree-production.mjs';

// Applied ONLY to PM_FLOW15_CURRENT_03 and PM_CURRENT25_SUPPORT08.
// The independent production ledger must contain official, round-aligned outcomes;
// shadow HIT/MISS labels and other production sources never affect this fuse.
export function firstLayer15sProductionFuseSummary(rounds, productionSource) {
  const baseline = current03PmAgreeProductionFuseSummary(rounds, productionSource);
  const official = Array.from(rounds?.values?.() || []).filter(row =>
    row?.productionSource === productionSource &&
    ['UP', 'DOWN'].includes(row.productionPrediction) &&
    ['HIT', 'MISS'].includes(row.productionResult) &&
    row.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
    row.officialDirection === row.productionActual &&
    ['UP', 'DOWN'].includes(row.productionActual) &&
    String(row.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC')
  ).sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  const streak = entries => {
    let n=0;
    for (let i=entries.length-1;i>=0 && entries[i].productionResult === 'MISS';i--) n++;
    return n;
  };
  const latest = entries => {
    const row = entries.at(-1);
    return row ? {roundStartMs:row.roundStartMs,miss:row.productionResult==='MISS'} : null;
  };
  const globalMissStreak = streak(official);
  const direction = side => {
    const rows = official.filter(row => row.productionPrediction === side);
    const original = baseline[side.toLowerCase()];
    return {
      ...original,
      fused:(original.recent6.samples >= 5 && original.recent6.accuracy < 0.70) ||
        streak(rows) >= 2,
      latestEligible:latest(rows),
    };
  };
  return {
    ...baseline,
    fuse:{
      ...baseline.fuse,
      // Wait for 10 independent production results before applying rolling 70%.
      // Two consecutive official misses trigger an immediate whole-strategy fuse.
      globalFused:(baseline.recent10.samples >= 10 && baseline.recent10.accuracy < 0.70) ||
        globalMissStreak >= 2,
      latestEligible:latest(official),
    },
    productionMissStreak:globalMissStreak,
    up:direction('UP'),
    down:direction('DOWN'),
  };
}
