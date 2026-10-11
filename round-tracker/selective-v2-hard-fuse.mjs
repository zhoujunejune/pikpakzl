// Isolated, fail-closed Selective V2 live gate. Paper evaluation cannot authorize an order.
export const SELECTIVE_V2_FUSE_VERSION = 'SELECTIVE_V2_HARD_FUSE_V1';
const directionOk = x => x === 'UP' || x === 'DOWN';
const strictOfficial = row =>
  directionOk(row?.actual) &&
  row?.officialDirection === row.actual &&
  String(row?.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC') &&
  row?.officialSettlementAudit?.sourceEndpoint === '/sapi/v1/w3w/wallet/prediction/market/detail';
const stat = rows => {
  const samples = rows.length;
  const hits = rows.filter(x => x.hit).length;
  return {samples, hits, misses:samples-hits, accuracy:samples?Number((hits/samples).toFixed(4)):null};
};
const tail = (rows, n) => rows.slice(-n);
const missStreak = rows => {
  let misses = 0;
  for (let i=rows.length-1; i>=0 && !rows[i].hit; i--) misses++;
  return misses;
};

// Only immutable, pre-settlement, real-production decisions count as live evidence.
// Shadow evidence must be frozen within its own round, before official settlement.
export function selectiveV2HardFuseSummary(rounds, direction, {
  paused = true,
  shadowStartMs = Date.parse('2026-10-11T12:55:00Z'),
  excludeRound = null,
} = {}) {
  const all = Array.from(rounds || []).filter(x => x && Number(x.roundStartMs) !== Number(excludeRound));
  const live = all
    .filter(x => x.productionSource === 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY' &&
      directionOk(x.productionPrediction) &&
      (x.productionResult === 'HIT' || x.productionResult === 'MISS') &&
      strictOfficial(x) &&
      Number(x.productionLockedAt || x.productionGeneratedAt || 0) < x.roundStartMs + 300000)
    .sort((a,b)=>a.roundStartMs-b.roundStartMs)
    .map(x=>({direction:x.productionPrediction,hit:x.productionResult==='HIT',round:x.roundStartMs}));
  const filtered = live.filter(x=>x.direction===direction);
  const global10 = stat(tail(live, 10));
  const direction10 = stat(tail(filtered,10));
  const consecutiveMisses = missStreak(filtered);
  const globallyDegraded = global10.samples===10 && global10.accuracy < 0.60;
  const directionDegraded = direction10.samples===10 && direction10.accuracy < 0.60;
  const streakTripped = consecutiveMisses >= 3;

  const shadow = all.filter(x => {
    const proof = x.selectiveV2HardFuseShadow;
    return directionOk(proof?.direction) && proof.direction === direction &&
      Number(x.roundStartMs)>=shadowStartMs &&
      Number(proof.frozenAt)>=Number(x.roundStartMs) &&
      Number(proof.frozenAt)<Number(x.roundStartMs)+300000 &&
      Number(proof.frozenAt)<Number(x.officialSettlementAudit?.observedAt ? Date.parse(x.officialSettlementAudit.observedAt) : 0) &&
      strictOfficial(x);
  }).sort((a,b)=>a.roundStartMs-b.roundStartMs)
    .map(x=>({hit:x.selectiveV2HardFuseShadow.direction===x.actual,round:x.roundStartMs}));
  const recovery20 = stat(tail(shadow,20));
  const recovery10 = stat(tail(shadow,10));
  const recoveryReady = recovery20.samples===20 && recovery20.accuracy>=0.75 &&
    recovery10.accuracy>=0.70 && missStreak(shadow)<3;
  const reasons = [];
  if (paused) reasons.push('MANUAL_SELECTIVE_V2_LIVE_PAUSE');
  if (globallyDegraded) reasons.push('GLOBAL_LAST10_BELOW_60');
  if (directionDegraded) reasons.push('DIRECTION_LAST10_BELOW_60');
  if (streakTripped) reasons.push('DIRECTION_MISS_STREAK_3');
  if (!recoveryReady) reasons.push('SHADOW_RECOVERY_NOT_VERIFIED');
  return {
    version:SELECTIVE_V2_FUSE_VERSION, direction, blocked:Boolean(paused || !recoveryReady || globallyDegraded || directionDegraded || streakTripped),
    reasons, production:{global10,direction10,consecutiveMisses}, shadow:{startMs:shadowStartMs,samples:shadow.length,recovery20,recovery10,recoveryReady},
    policy:'LIVE_PAUSE_AND_DIRECTION_FUSE_REQUIRE_NEW_STRICT_OFFICIAL_SHADOW_PROOF',
  };
}
