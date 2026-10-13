// Single-source, reversible production gate for the independent ZL_FAST8_65 worker.
// In exclusive mode legacy source locks are paused. A timely, verified-current-round
// FAST8 UP/DOWN can enter the live router even before prospective 65% validation.
// Observed accuracy and training status remain telemetry, NOT a claim of readiness.
export const FAST8_SOURCE = 'ZL_FAST8_65_PRIMARY';
export const FAST8_MODEL = 'ZL_FAST8_65';
export const FAST8_MODE = 'FAST8_ONLY';
export const LEGACY_MODE = 'LEGACY';
export const FAST8_DEADLINE_MS = 8000;

export function fast8ProductionReadiness(stats, latest, expectedRound, now = Date.now()) {
  const decision = latest?.signal || null;
  const preview = decision?.roundStartMs === expectedRound &&
    (decision?.direction === 'UP' || decision?.direction === 'DOWN')
    ? {
      round: expectedRound,
      direction: decision.direction,
      modelVersion: decision.modelVersion || null,
      fallbackLevel: decision.fallbackLevel || null,
      persistedAtMs: decision.persistedAtMs ?? null,
      serverAvailableAtMs: decision.serverAvailableAtMs ?? null,
    } : null;
  const reject = reason => ({eligible:false, reason, preview});
  if (!stats?.ok || stats?.health?.journalReady !== true ||
      !Number.isFinite(stats?.statusAgeMs) || stats.statusAgeMs > 60000)
    return reject('FAST8_WORKER_OR_JOURNAL_NOT_READY');
  if (!preview) return reject('FAST8_CURRENT_ROUND_DIRECTION_PENDING');
  const s = decision;
  if (s.modelFamily !== FAST8_MODEL || stats.modelFamily !== FAST8_MODEL ||
      s.policyVersion !== stats.policyVersion)
    return reject('FAST8_POLICY_MISMATCH');
  // Missing market data is an explicit fallback produced by the FAST8 worker.
  // It has no market-event timestamp; do not invent one or label it validated.
  const issues = Array.isArray(s.dataQuality) ? [...s.dataQuality] : ['DATA_QUALITY_UNKNOWN'];
  const missingSnapshot = s.maxEventTimeMs == null &&
    issues.includes('NO_FRESH_SNAPSHOT') && s.presentFeatures === 0;
  const eventTimeValid = missingSnapshot ||
    (Number.isFinite(s.maxEventTimeMs) &&
      s.maxEventTimeMs >= expectedRound &&
      s.maxEventTimeMs <= expectedRound + 1500);
  if (!Number.isFinite(s.persistedAtMs) ||
      !Number.isFinite(s.serverAvailableAtMs) ||
      !Number.isFinite(s.decisionComputedAtMs) ||
      !eventTimeValid ||
      s.persistedAtMs < expectedRound ||
      s.decisionComputedAtMs < expectedRound ||
      s.serverAvailableAtMs < s.persistedAtMs ||
      s.serverAvailableAtMs > expectedRound + FAST8_DEADLINE_MS ||
      now < s.serverAvailableAtMs ||
      s.decisionComputedAtMs > expectedRound + FAST8_DEADLINE_MS)
    return reject('FAST8_SIGNAL_LATE_OR_UNVERIFIED');
  // Never suppress an immutable, timely FAST8 direction for accuracy,
  // model-registration or feature-quality gates. Surface those as diagnostics.
  // Missing/stale features and no-information fallbacks are NOT verified edges.
  if (s.modelVersion && stats.modelVersion && s.modelVersion !== stats.modelVersion)
    issues.push('MODEL_VERSION_CHANGED_AFTER_DECISION');
  if (!Number.isFinite(s.presentFeatures) || s.presentFeatures < 5)
    issues.push('LOW_FEATURE_COVERAGE');
  const fallbackUsed = s.fallbackLevel !== 'NONE' || issues.length > 0;
  return { eligible:true, reason:null,
    preview:{...preview, fallbackLevel:s.fallbackLevel || null,
      dataQuality:issues, presentFeatures:s.presentFeatures ?? 0,
      fallbackUsed, qualityStatus: fallbackUsed ? 'UNVERIFIED_DIRECTION_FALLBACK' : 'FEATURES_AVAILABLE' } };
}
