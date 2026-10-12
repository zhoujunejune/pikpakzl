// The complete policy is fixed before prospective collection starts. No abstention.
export const VERSION = 'ZL_FAST8_65';
export const POLICY = 'FAST8_FULL_COVERAGE_LOGISTIC_V1';
export const ROUND_MS = 300000;
export const CUTOFF_MS = 6500;
export const LOCK_MS = 7000;
export const DEADLINE_MS = 8000;
export const MIN_TRAINING = 300;
export const FEATURES = [
  ['currentScore', 1], ['currentTrendScore', 1], ['microScore', 1],
  ['regimeScore', 1], ['liveScore', 1], ['distanceFromOpenBps', 10],
  ['normalizedMomentum5s', 1], ['normalizedMomentum15s', 1],
  ['normalizedMomentum60s', 1], ['normalizedMomentum180s', 1],
  ['normalizedMomentum300s', 1], ['tradePressure15s', 1],
  ['tradePressure60s', 1], ['ofiNormalized5s', 1],
  ['rangePosition180', 1], ['predictionMarketUpMid', 1], ['spreadBps', 5],
];
export const finite = n => typeof n === 'number' && Number.isFinite(n);
export const isDirection = d => d === 'UP' || d === 'DOWN';
export const sigmoid = n => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, n))));

export function featureVector(features = {}) {
  const values = [], missing = [];
  for (const [key, scale] of FEATURES) {
    const present = finite(features[key]);
    let value = present ? features[key] : 0;
    if (present && (key === 'predictionMarketUpMid' || key === 'rangePosition180')) value = (value - 0.5) * 2;
    values.push(Math.max(-5, Math.min(5, value / scale)));
    missing.push(present ? 0 : 1);
  }
  // Fixed transformations: no future normalization statistics or fitted imputers.
  return [...values, ...missing, values[0] * values[3], values[2] * values[3]];
}

export function probability(weights, x) {
  if (!Array.isArray(weights) || weights.length !== x.length + 1 || !weights.every(finite)) return null;
  const score = weights[0] + x.reduce((sum, value, i) => sum + value * weights[i + 1], 0);
  return finite(score) ? sigmoid(score) : null;
}

function fit(samples) {
  const weights = new Array(samples[0].x.length + 1).fill(0);
  for (let epoch = 0; epoch < 160; epoch++) {
    const gradient = new Array(weights.length).fill(0);
    for (const { x, y } of samples) {
      const error = probability(weights, x) - y;
      gradient[0] += error;
      for (let j = 0; j < x.length; j++) gradient[j + 1] += error * x[j];
    }
    for (let j = 0; j < weights.length; j++) {
      weights[j] -= 0.06 * (gradient[j] / samples.length + (j ? 0.02 * weights[j] : 0));
    }
  }
  return weights;
}

export function trainFast8(samples) {
  if (samples.length < MIN_TRAINING || samples.some(s => !Array.isArray(s.x) ||
      s.x.length !== FEATURES.length * 2 + 2 || !s.x.every(finite) || ![0, 1].includes(s.y))) {
    throw new Error('INVALID_TRAINING_ROWS');
  }
  const ordered = [...samples].sort((a, b) => a.roundStartMs - b.roundStartMs);
  const split = Math.floor(ordered.length * 0.8);
  const validation = ordered.slice(split);
  // Labels for a training row must have existed before the first holdout decision.
  const train = ordered.slice(0, split).filter(s => s.labelReceivedAt < validation[0].decisionAt);
  if (train.length < 100) throw new Error('INSUFFICIENT_TEMPORAL_TRAINING');
  const candidate = fit(train);
  let hits = 0, baselineHits = 0, brier = 0;
  for (const s of validation) {
    const p = probability(candidate, s.x);
    hits += Number(Number(p >= 0.5) === s.y);
    baselineHits += Number(s.baseline === (s.y ? 'UP' : 'DOWN'));
    brier += (p - s.y) ** 2;
  }
  const holdout = { samples: validation.length, hits, accuracy: hits / validation.length,
    baselineHits, baselineAccuracy: baselineHits / validation.length,
    brier: brier / validation.length, coverage: 1, evidence: 'TEMPORAL_HOLDOUT_NOT_FORWARD' };
  return { accepted: hits >= baselineHits && holdout.brier < 0.26,
    weights: fit(ordered), trainingSamples: ordered.length, holdout,
    trainingThroughRound: ordered.at(-1).roundStartMs,
    trainingLabelsReceivedThrough: Math.max(...ordered.map(s => s.labelReceivedAt)) };
}
