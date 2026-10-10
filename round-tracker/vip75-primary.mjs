// Pure routing guard for the user-pinned independent primary model.
// Decisions come only from the immutable, pre-settlement shadow snapshot.
export const VIP75_PRIMARY_NAME = 'zl_new_vip75';
export const VIP75_PRIMARY_SOURCE = 'ZL_NEW_VIP75_PRIMARY';
export const VIP75_BACKUP_DELAY_MS = 24000;
const WAIT = (reason) => ({ready:false,reason});
export function selectVip75Primary(row, now=Date.now()) {
  const start = Number(row?.roundStartMs);
  if (!row || !Number.isFinite(start) || !Number.isFinite(now) ||
      now < start || now >= start + 300000) return WAIT('VIP75_ROUND_UNAVAILABLE');
  if (row.settledAt != null) return WAIT('VIP75_ROUND_ALREADY_SETTLED');
  const f = row.independentDirectionShadow;
  if (!f) return WAIT('VIP75_AWAITING_FROZEN_PREDICTION');
  if (f.modelName !== VIP75_PRIMARY_NAME ||
      typeof f.modelVersion !== 'string' ||
      !f.modelVersion.startsWith('INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3_') ||
      f.roundStartMs !== row.roundStartMs ||
      (f.direction !== 'UP' && f.direction !== 'DOWN'))
    return WAIT('VIP75_FROZEN_IDENTITY_INVALID');
  const observed = Number(f.observedAt);
  const trained = Number(f.trainedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(trained) ||
      observed < start + 10000 || observed > start + 22000 ||
      trained >= observed || observed > now ||
      observed !== Number(row.shadowObservedAt) ||
      !row.shadowFacts || typeof row.shadowFacts !== 'object')
    return WAIT('VIP75_FROZEN_SNAPSHOT_INVALID');
  if (typeof f.probability !== 'number' ||
      !Number.isFinite(f.probability) ||
      f.probability < 0 || f.probability > 1)
    return WAIT('VIP75_PROBABILITY_INVALID');
  // probability is P(UP); confidence is P(predicted direction), not a 75% claim.
  const upProbability = f.probability;
  const confidence = f.direction === 'UP' ? upProbability : 1 - upProbability;
  return {
    ready:true,
    direction:f.direction,
    generatedAt:observed,
    modelVersion:f.modelVersion,
    score:Number((upProbability * 2 - 1).toFixed(6)),
    confidence:Number(confidence.toFixed(6)),
    upProbability,
  };
}
export function shouldUseVip75Backup(row, now=Date.now()) {
  const start=Number(row?.roundStartMs);
  return Boolean(row) && Number.isFinite(start) && Number.isFinite(now) &&
    now >= start + VIP75_BACKUP_DELAY_MS && now < start + 300000 &&
    row.settledAt == null;
}
