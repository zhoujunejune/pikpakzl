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
  if (!Number.isFinite(s.persistedAtMs) ||
      !Number.isFinite(s.serverAvailableAtMs) ||
      !Number.isFinite(s.decisionComputedAtMs) ||
      !Number.isFinite(s.maxEventTimeMs) ||
      s.maxEventTimeMs > expectedRound + 1500 ||
      s.persistedAtMs < expectedRound ||
      s.serverAvailableAtMs < s.persistedAtMs ||
      s.serverAvailableAtMs > expectedRound + FAST8_DEADLINE_MS ||
      now < s.serverAvailableAtMs ||
      now > expectedRound + FAST8_DEADLINE_MS ||
      s.decisionComputedAtMs > expectedRound + FAST8_DEADLINE_MS)
    return reject('FAST8_SIGNAL_LATE_OR_UNVERIFIED');
  // Explicit production opt-in: performance evidence does not suppress a timely
  // observed signal. Keep policy/timing/source and feature-integrity checks.
  if (!stats.modelVersion || s.modelVersion !== stats.modelVersion ||
      s.presentFeatures < 5 || !Array.isArray(s.dataQuality) ||
      s.dataQuality.length !== 0)
    return reject('FAST8_MODEL_OR_FEATURES_NOT_READY');
  return { eligible:true, reason:null, preview };
}
