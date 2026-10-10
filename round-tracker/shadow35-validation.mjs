// Pure, read-only acceptance checks for one pre-registered frozen experiment.
// Every completed calendar round remains in the denominator, including outages.
const DAY_MS = 86400000;
const FORWARD_DAYS = 30;
const DEADLINE_MS = 35000;
const BOOTSTRAP_RESAMPLES = 1024;
const MIN_DECISIONS = 1000;
const MIN_DIRECTION_DECISIONS = 100;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const direction = value => value === 'UP' || value === 'DOWN';

function wilson(successes, total) {
  if (!total) return { method: 'WILSON_95_TWO_SIDED', lower: null, upper: null, successes, total };
  const z = 1.959963984540054;
  const z2 = z * z;
  const proportion = successes / total;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total) / denominator;
  return { method: 'WILSON_95_TWO_SIDED', lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin), successes, total };
}

function metrics(counts) {
  return { ...counts, misses: counts.labeledDecisions - counts.hits,
    pendingLabels: counts.decidedRounds - counts.labeledDecisions,
    accuracy: counts.labeledDecisions ? counts.hits / counts.labeledDecisions : null,
    coverage: counts.expectedRounds ? counts.decidedRounds / counts.expectedRounds : null };
}

function emptyCounts(expectedRounds = 0) {
  return { expectedRounds, observedRounds: 0, decidedRounds: 0, labeledDecisions: 0, hits: 0 };
}

function addCounts(destination, source) {
  for (const name of Object.keys(emptyCounts())) destination[name] += source[name];
}

function seededRandom(text) {
  let seed = 2166136261;
  for (let index = 0; index < text.length; index++) seed = Math.imul(seed ^ text.charCodeAt(index), 16777619);
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function dailyBootstrap(days, seed) {
  const fullDays = days.filter(day => day.complete);
  const base = { method: 'EXPERIMENTAL_24H_BLOCK_BOOTSTRAP_95_TWO_SIDED',
    resamples: BOOTSTRAP_RESAMPLES, fullDays: fullDays.length, requiredFullDays: FORWARD_DAYS,
    seedBasis: 'MODEL_VERSION_AND_FIXED_EXPERIMENT_WINDOW', accuracy: { lower: null, upper: null },
    coverage: { lower: null, upper: null } };
  if (fullDays.length < FORWARD_DAYS) return { ...base, status: 'INSUFFICIENT_COMPLETE_DAILY_BLOCKS' };
  const random = seededRandom(seed);
  const accuracies = [];
  const coverages = [];
  for (let sample = 0; sample < BOOTSTRAP_RESAMPLES; sample++) {
    const counts = emptyCounts();
    for (let block = 0; block < fullDays.length; block++) {
      addCounts(counts, fullDays[Math.floor(random() * fullDays.length)]);
    }
    // A resample without labels cannot support a positive accuracy lower bound.
    accuracies.push(counts.labeledDecisions ? counts.hits / counts.labeledDecisions : 0);
    coverages.push(counts.expectedRounds ? counts.decidedRounds / counts.expectedRounds : 0);
  }
  accuracies.sort((a, b) => a - b);
  coverages.sort((a, b) => a - b);
  return { ...base, status: 'AVAILABLE',
    accuracy: { lower: quantile(accuracies, 0.025), upper: quantile(accuracies, 0.975) },
    coverage: { lower: quantile(coverages, 0.025), upper: quantile(coverages, 0.975) } };
}

function invalidDecisionReasons(decision, start, model, now) {
  const reasons = [];
  if (!decision || typeof decision !== 'object') return ['DECISION_RECORD_INVALID'];
  if (decision.modelVersion !== model.modelVersion) reasons.push('DECISION_MODEL_VERSION_MISMATCH');
  if (decision.threshold != null && (!finite(decision.threshold) || decision.threshold !== model.threshold)) reasons.push('DECISION_FROZEN_THRESHOLD_MISMATCH');
  if (!direction(decision.direction)) reasons.push('DECISION_DIRECTION_INVALID');
  if (decision.roundStartMs != null && decision.roundStartMs !== start) reasons.push('DECISION_ROUND_MISMATCH');
  if (!finite(decision.observedAt)) reasons.push('DECISION_OBSERVED_AT_MISSING');
  else if (decision.observedAt < start || decision.observedAt > start + DEADLINE_MS || decision.observedAt > now) reasons.push('DECISION_OBSERVATION_OUTSIDE_DEADLINE');
  if (!finite(decision.completedAt)) reasons.push('DECISION_COMPLETED_AT_MISSING');
  else if (decision.completedAt < start || decision.completedAt > start + DEADLINE_MS || decision.completedAt > now) reasons.push('DECISION_COMPLETED_OUTSIDE_DEADLINE');
  if (finite(decision.observedAt) && finite(decision.completedAt) && decision.completedAt < decision.observedAt) reasons.push('DECISION_COMPLETED_BEFORE_OBSERVATION');
  // The runtime freezes the first eligible decision. Acceptance uses the complete
  // decision journal, never a retrospective checkpoint or probability selection.
  return reasons;
}

function invalidSettlementReasons(settlement, start, now, roundMs) {
  if (!settlement) return ['OFFICIAL_LABEL_PENDING'];
  const reasons = [];
  if (!direction(settlement.actual)) reasons.push('SETTLEMENT_DIRECTION_INVALID');
  if (settlement.roundStartMs != null && settlement.roundStartMs !== start) reasons.push('SETTLEMENT_ROUND_MISMATCH');
  if (settlement.actualSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION') reasons.push('SETTLEMENT_NOT_OFFICIAL');
  if (typeof settlement.resolutionEvidence !== 'string' ||
      !settlement.resolutionEvidence.startsWith('OFFICIAL_' + settlement.actual + ':') ||
      !settlement.resolutionEvidence.includes('STRICT_ROUND_ALIGNED_TOPIC')) reasons.push('SETTLEMENT_EVIDENCE_INVALID');
  if (!finite(settlement.settledAt) || settlement.settledAt < start + roundMs || settlement.settledAt > now) reasons.push('SETTLEMENT_TIME_INVALID');
  if (!finite(settlement.recordedAt) || settlement.recordedAt < settlement.settledAt || settlement.recordedAt > now) reasons.push('SETTLEMENT_RECEIPT_TIME_INVALID');
  return reasons;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

export function summarizeShadow35Validation({ model, rows, now, roundMs = 300000,
  lastError = null, targetAccuracy = 0.75, targetCoverage = 0.45 } = {}) {
  const blockers = [];
  const reasonCounts = {};
  const block = reason => { if (!blockers.includes(reason)) blockers.push(reason); };
  const countReason = reason => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; };
  const base = { validationVersion: 'FROZEN_30_DAY_FORWARD_V1',
    productionEffect: 'NONE_SHADOW_ONLY', autoPromotion: false, canRecommendProductionSwitch: false,
    longTermValidated: false,
    noGuarantee: 'Observed performance does not guarantee future accuracy or coverage.',
    deadlineMs: DEADLINE_MS, targets: { accuracy: targetAccuracy, coverage: targetCoverage },
    requirements: { frozenDays: FORWARD_DAYS, minLabeledDecisions: MIN_DECISIONS,
      minLabeledDecisionsPerDirection: MIN_DIRECTION_DECISIONS, rollingWindowDays: 7,
      minDecisionsPerRollingWindow: 100, confidenceLevel: 0.95,
      bootstrapResamples: BOOTSTRAP_RESAMPLES, allDecisionLabelsRequired: true } };
  const notReady = status => ({ ...base, ok: !blockers.some(reason => reason.startsWith('INVALID_')),
    status, blockers, invalidReasons: reasonCounts, ...metrics(emptyCounts()),
    rawDecidedRounds: 0, invalidDecisions: 0, invalidSettlementRecords: 0,
    byDay: [], byDirection: {}, rolling7DayWindows: [], last7Days: null,
    confidenceIntervals: { accuracy: wilson(0, 0), coverage: wilson(0, 0), dailyBlockBootstrap: null },
    elapsedDays: 0, completeExperimentalDays: 0, progress: 0,
    p50DecisionDelayMs: null, p95DecisionDelayMs: null });
  if (!finite(now) || !finite(roundMs) || !Number.isInteger(roundMs) || roundMs <= 0 ||
      DAY_MS % roundMs !== 0 || !finite(targetAccuracy) || targetAccuracy <= 0 || targetAccuracy > 1 ||
      !finite(targetCoverage) || targetCoverage <= 0 || targetCoverage > 1 || !Array.isArray(rows)) {
    block('INVALID_VALIDATION_INPUT');
    return notReady('VALIDATION_INPUT_INVALID');
  }
  if (!model) {
    block('NO_FROZEN_MODEL_REGISTERED');
    return notReady('COLLECTING_TRAINING_DATA');
  }
  if (typeof model.modelVersion !== 'string' || !model.modelVersion ||
      !finite(model.forwardStartMs) || model.forwardStartMs % roundMs !== 0 ||
      !finite(model.frozenUntilMs) || model.frozenUntilMs <= model.forwardStartMs ||
      !finite(model.threshold) || model.threshold < 0.5 || model.threshold > 1) {
    block('INVALID_FROZEN_MODEL_METADATA');
    return notReady('FROZEN_MODEL_METADATA_INVALID');
  }
  const start = model.forwardStartMs;
  const end = start + FORWARD_DAYS * DAY_MS;
  const cutoff = Math.max(start, Math.min(now, end, model.frozenUntilMs));
  const expectedRounds = Math.max(0, Math.floor((cutoff - start) / roundMs));
  const completedThrough = start + expectedRounds * roundMs;
  const freezeDuration = model.frozenUntilMs - start;
  if (freezeDuration < FORWARD_DAYS * DAY_MS) block('FROZEN_WINDOW_SHORTER_THAN_30_DAYS');
  if (now < end || now < model.frozenUntilMs) block('FROZEN_FORWARD_PERIOD_NOT_COMPLETE');
  if ((finite(model.trainedAt) && model.trainedAt > start) ||
      (finite(model.registeredAt) && model.registeredAt > start)) block('MODEL_REGISTERED_AFTER_FORWARD_START');
  if (lastError) {
    block('RUNTIME_ERROR_REQUIRES_REVIEW');
    if (/JOURNAL|MODEL_METADATA/.test(String(lastError))) block('JOURNAL_OR_MODEL_INTEGRITY_ERROR');
  }

  const byDay = Array.from({ length: FORWARD_DAYS }, (_, index) => {
    const dayStartMs = start + index * DAY_MS;
    const dayEndMs = dayStartMs + DAY_MS;
    return { day: index + 1, startMs: dayStartMs, endMs: dayEndMs,
      complete: completedThrough >= dayEndMs,
      ...emptyCounts(Math.max(0, Math.floor((Math.min(completedThrough, dayEndMs) - dayStartMs) / roundMs))) };
  });
  const byDirection = { UP: emptyCounts(), DOWN: emptyCounts() };
  const unique = new Map();
  const duplicates = new Set();
  for (const entry of rows) {
    if (!Array.isArray(entry) || entry.length !== 2 || !finite(entry[0]) ||
        !entry[1] || typeof entry[1] !== 'object') {
      block('INVALID_JOURNAL_ROW'); countReason('INVALID_JOURNAL_ROW'); continue;
    }
    const [roundStart, state] = entry;
    if (roundStart < start || roundStart >= completedThrough) continue;
    if (roundStart % roundMs !== 0) { block('INVALID_JOURNAL_ROW_ALIGNMENT'); countReason('INVALID_JOURNAL_ROW_ALIGNMENT'); continue; }
    if (unique.has(roundStart)) { duplicates.add(roundStart); block('DUPLICATE_JOURNAL_ROUND'); countReason('DUPLICATE_JOURNAL_ROUND'); }
    else unique.set(roundStart, state);
  }
  const overall = emptyCounts(expectedRounds);
  const delays = [];
  let rawDecidedRounds = 0;
  let invalidDecisions = 0;
  let invalidSettlementRecords = 0;
  for (const [roundStart, state] of unique) {
    const day = byDay[Math.floor((roundStart - start) / DAY_MS)];
    overall.observedRounds++;
    day.observedRounds++;
    if (!state.decision) continue;
    if (state.decision.modelVersion === model.modelVersion) rawDecidedRounds++;
    const reasons = invalidDecisionReasons(state.decision, roundStart, model, now);
    if (duplicates.has(roundStart)) reasons.push('DUPLICATE_JOURNAL_ROUND');
    if (reasons.length) {
      invalidDecisions++;
      for (const reason of reasons) countReason(reason);
      block('INVALID_DECISION_RECORDS');
      continue;
    }
    // Counting every valid decision protects against choosing only successful
    // days, directions or checkpoints after the experiment has completed.
    overall.decidedRounds++;
    day.decidedRounds++;
    byDirection[state.decision.direction].decidedRounds++;
    delays.push(state.decision.completedAt - roundStart);
    const labelReasons = invalidSettlementReasons(state.settlement, roundStart, now, roundMs);
    if (labelReasons.length) {
      for (const reason of labelReasons) countReason(reason);
      if (state.settlement) invalidSettlementRecords++;
      continue;
    }
    overall.labeledDecisions++;
    day.labeledDecisions++;
    const directionCounts = byDirection[state.decision.direction];
    directionCounts.labeledDecisions++;
    if (state.decision.direction === state.settlement.actual) {
      overall.hits++; day.hits++; directionCounts.hits++;
    }
  }
  const summary = metrics(overall);
  if (summary.pendingLabels) block('PENDING_OFFICIAL_DECISION_LABELS');
  if (invalidSettlementRecords) block('INVALID_OFFICIAL_SETTLEMENT_RECORDS');
  if (summary.labeledDecisions < MIN_DECISIONS) block('INSUFFICIENT_LABELED_DECISIONS');
  if (summary.accuracy === null || summary.accuracy < targetAccuracy) block('ACCURACY_POINT_TARGET_NOT_MET');
  if (summary.coverage === null || summary.coverage < targetCoverage) block('COVERAGE_POINT_TARGET_NOT_MET');

  const directions = {};
  for (const [name, counts] of Object.entries(byDirection)) {
    const directional = metrics(counts);
    // Directional coverage is its share of the complete calendar denominator.
    directional.coverage = expectedRounds ? counts.decidedRounds / expectedRounds : null;
    directional.expectedRounds = expectedRounds;
    directional.confidenceInterval = wilson(counts.hits, counts.labeledDecisions);
    directions[name] = directional;
    if (counts.labeledDecisions < MIN_DIRECTION_DECISIONS) block('INSUFFICIENT_' + name + '_LABELED_DECISIONS');
    if (directional.accuracy === null || directional.accuracy < targetAccuracy) block(name + '_ACCURACY_POINT_TARGET_NOT_MET');
  }

  const days = byDay.map(day => metrics(day));
  const windows = [];
  for (let endIndex = 6; endIndex < FORWARD_DAYS; endIndex++) {
    const selected = days.slice(endIndex - 6, endIndex + 1);
    const counts = emptyCounts();
    for (const day of selected) addCounts(counts, day);
    const window = metrics(counts);
    const complete = selected.every(day => day.complete);
    const passes = complete && window.decidedRounds >= 100 && window.pendingLabels === 0 &&
      window.accuracy !== null && window.accuracy >= targetAccuracy &&
      window.coverage !== null && window.coverage >= targetCoverage;
    windows.push({ startDay: endIndex - 5, endDay: endIndex + 1,
      startMs: selected[0].startMs, endMs: selected.at(-1).endMs,
      complete, passes, ...window });
    if (complete && !passes) block('ROLLING_7_DAY_STABILITY_NOT_MET');
  }
  if (windows.some(window => !window.complete)) block('ROLLING_7_DAY_VALIDATION_INCOMPLETE');

  const accuracyCI = wilson(summary.hits, summary.labeledDecisions);
  const coverageCI = wilson(summary.decidedRounds, expectedRounds);
  if (accuracyCI.lower === null || accuracyCI.lower < targetAccuracy) block('ACCURACY_WILSON_LOWER_BOUND_NOT_MET');
  if (coverageCI.lower === null || coverageCI.lower < targetCoverage) block('COVERAGE_WILSON_LOWER_BOUND_NOT_MET');
  const bootstrap = dailyBootstrap(days, model.modelVersion + ':' + start + ':' + end);
  if (bootstrap.status !== 'AVAILABLE') block('INSUFFICIENT_COMPLETE_DAILY_BLOCKS');
  else {
    if (bootstrap.accuracy.lower < targetAccuracy) block('ACCURACY_DAILY_BOOTSTRAP_LOWER_BOUND_NOT_MET');
    if (bootstrap.coverage.lower < targetCoverage) block('COVERAGE_DAILY_BOOTSTRAP_LOWER_BOUND_NOT_MET');
  }
  const canRecommendProductionSwitch = blockers.length === 0;
  const freezeEnded = now >= model.frozenUntilMs;
  return { ...base, ok: !blockers.some(reason => /INVALID_JOURNAL|DUPLICATE_JOURNAL|INTEGRITY_ERROR/.test(reason)),
    status: canRecommendProductionSwitch ? 'READY_FOR_PRODUCTION_REVIEW' :
      freezeEnded ? 'FORWARD_COMPLETE_TARGETS_UNVERIFIED' : 'FROZEN_FORWARD_VALIDATION',
    canRecommendProductionSwitch, longTermValidated: canRecommendProductionSwitch,
    blockers, invalidReasons: reasonCounts, lastError,
    modelVersion: model.modelVersion, threshold: model.threshold,
    forwardStartMs: start, forwardEndMs: end, frozenUntilMs: model.frozenUntilMs,
    evaluatedThroughMs: completedThrough, frozenDays: freezeDuration / DAY_MS,
    elapsedDays: (cutoff - start) / DAY_MS, completeExperimentalDays: days.filter(day => day.complete).length,
    progress: Math.min(1, Math.max(0, (cutoff - start) / (FORWARD_DAYS * DAY_MS))),
    totalExperimentalRounds: Math.floor(FORWARD_DAYS * DAY_MS / roundMs),
    ...summary, rawDecidedRounds, invalidDecisions, invalidSettlementRecords,
    missingCalendarRounds: Math.max(0, expectedRounds - overall.observedRounds),
    p50DecisionDelayMs: percentile(delays, 0.5), p95DecisionDelayMs: percentile(delays, 0.95),
    byDay: days, byDirection: directions, rolling7DayWindows: windows,
    last7Days: [...windows].reverse().find(window => window.complete) || null,
    confidenceIntervals: { accuracy: accuracyCI, coverage: coverageCI, dailyBlockBootstrap: bootstrap },
    timingBasis: 'ACTUAL_COMPLETION_BY_SECOND_35',
    denominatorBasis: 'ALL_COMPLETED_CALENDAR_ROUNDS_IN_REGISTERED_FROZEN_EXPERIMENT',
    labelBasis: 'OFFICIAL_STRICT_ROUND_ALIGNED_RESOLUTION_ONLY' };
}
