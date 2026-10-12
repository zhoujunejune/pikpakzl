// Immutable retirement evidence from Railway's 2026-10-09T05:21:10Z
// strict-forward status snapshots. Each listed candidate was explicitly
// RETIRED_LOW_ACCURACY, active=false, with 20 decisions and accuracy < 65%.
// Keep tombstones in source control so history rotation/redeploy cannot rearm
// a rejected SHADOW-ONLY candidate. No official settlement or audit rows are deleted.
const TOMBSTONES = Object.freeze({
  SELECTIVE_V2_NO_BASE_CONTEST_V2: Object.freeze({
    BALANCED_65_70_PM03: 0.40,
    PM05_65_70: 0.45,
    PM08_65_70: 0.50,
    CURRENT70_70_PM03: 0.40,
    TREND80_65_PM03: 0.50,
    MICRO_65_70_PM03: 0.40,
    MOM30_65_70_PM03: 0.40,
    BOTH_65_70_PM03: 0.40,
  }),
  WAIT_RESCUE_SHADOW_V1: Object.freeze({
    SAFE_R75_T50_PM03: 0.45,
    SAFE_R75_T50_PM05: 0.45,
    SAFE_R75_T60_PM03: 0.45,
    SAFE_R75_T60_PM05: 0.45,
    SAFE_R75_T50_PM03_MICRO: 0.45,
    SAFE_R75_T50_PM03_MOM: 0.45,
    EXP_R60_T60_PM12: 0.45,
    EXP_R60_T70_PM10: 0.40,
  }),
});

export function retiredShadowEvidence(version, candidateId) {
  const group = TOMBSTONES[String(version)] || {};
  if (!Object.prototype.hasOwnProperty.call(group, String(candidateId))) return null;
  return {
    status: 'RETIRED_LOW_ACCURACY',
    active: false,
    historicalStrictForwardSamples: 20,
    historicalStrictForwardAccuracy: group[String(candidateId)],
    source: 'RAILWAY_STATUS_2026-10-09T05:21:10Z',
  };
}

export function hasUnretiredShadowCandidates(version, configs) {
  return Array.isArray(configs) && configs.some(c => c?.id && !retiredShadowEvidence(version, c.id));
}

export function retiredShadowCount(version) {
  return Object.keys(TOMBSTONES[String(version)] || {}).length;
}
