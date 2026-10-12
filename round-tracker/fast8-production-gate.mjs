// Single-source, reversible production gate for the independent ZL_FAST8_65 worker.
// In exclusive mode all legacy source locks are suspended. The shadow observer
// continues producing UP/DOWN for every round, but order-grade locks require
// prospective validation and a trained (non-baseline) decision.
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
  const proof = stats.validation;
  if (proof?.passed !== true ||
      proof.expectedRounds < 1000 || proof.onTimeRounds < 1000 ||
      proof.labeledPredictions < 1000 ||
      !Number.isFinite(proof.endToEndAccuracy) ||
      proof.endToEndAccuracy < 0.65 ||
      stats.training?.validTrainingSamples < 300)
    return reject('FAST8_FORWARD_65_GATE_NOT_MET');
  if (!stats.modelVersion || stats.modelVersion.includes('baseline') ||
      s.modelVersion !== stats.modelVersion || !Number.isFinite(s.pUpRaw) ||
      s.fallbackLevel !== 'NONE' || s.presentFeatures < 5 ||
      !Array.isArray(s.dataQuality) || s.dataQuality.length !== 0)
    return reject('FAST8_TRAINED_CLEAN_MODEL_REQUIRED');
  return { eligible:true, reason:null, preview };
}
