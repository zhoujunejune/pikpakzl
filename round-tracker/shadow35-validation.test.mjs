import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeShadow35Validation } from './shadow35-validation.mjs';

const DAY = 86400000;
const ROUND = 300000;
const START = 1728000000000;
const END = START + 30 * DAY;
const VERSION = 'LOCK_QUALITY_SELECTIVE_V7_5_TEST_FROZEN';
const model = { modelVersion: VERSION, threshold: 0.8,
  trainedAt: START - ROUND, registeredAt: START - 1000,
  forwardStartMs: START, frozenUntilMs: END };

function official(start, actual) {
  return { roundStartMs: start, actual,
    actualSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence: 'OFFICIAL_' + actual + ':TEST:STRICT_ROUND_ALIGNED_TOPIC',
    settledAt: start + ROUND, recordedAt: start + ROUND };
}

function fixture({ coverage = 0.6, accuracy = 0.9, driftAfterDay = null,
  driftAccuracy = 0.55, oneDirection = false } = {}) {
  const result = [];
  for (let day = 0; day < 30; day++) {
    const predictions = Math.floor(288 * coverage);
    const dayAccuracy = driftAfterDay != null && day >= driftAfterDay ? driftAccuracy : accuracy;
    for (let slot = 0; slot < 288; slot++) {
      const roundStartMs = START + day * DAY + slot * ROUND;
      const state = { snapshots: new Map(), final: { direction: 'WAIT' }, decision: null, settlement: null };
      if (slot < predictions) {
        const direction = oneDirection || Math.floor(slot / 2) % 2 === 0 ? 'UP' : 'DOWN';
        const hit = Math.floor((slot + 1) * dayAccuracy) > Math.floor(slot * dayAccuracy);
        const actual = hit ? direction : direction === 'UP' ? 'DOWN' : 'UP';
        state.decision = { modelVersion: VERSION, roundStartMs,
          direction, observedAt: roundStartMs + 15000, completedAt: roundStartMs + 16000,
          // The DOWN probability is the complementary UP probability.
          probability: direction === 'UP' ? 0.9 : 0.1 };
        state.final.direction = direction;
        state.settlement = official(roundStartMs, actual);
      }
      result.push([roundStartMs, state]);
    }
  }
  return result;
}

const summarize = (rows, options = {}) => summarizeShadow35Validation({ model, rows, now: END, ...options });

test('training data without a registered frozen model cannot recommend a switch', () => {
  const stats = summarize([], { model: null });
  assert.equal(stats.status, 'COLLECTING_TRAINING_DATA');
  assert.equal(stats.canRecommendProductionSwitch, false);
  assert.equal(stats.autoPromotion, false);
  assert.ok(stats.blockers.includes('NO_FROZEN_MODEL_REGISTERED'));
});

test('excellent point metrics before day 30 remain explicitly unqualified', () => {
  const stats = summarize(fixture(), { now: END - ROUND });
  assert.ok(stats.accuracy >= 0.75);
  assert.ok(stats.coverage >= 0.45);
  assert.equal(stats.expectedRounds, 8639);
  assert.equal(stats.completeExperimentalDays, 29);
  assert.equal(stats.canRecommendProductionSwitch, false);
  assert.ok(stats.blockers.includes('FROZEN_FORWARD_PERIOD_NOT_COMPLETE'));
  assert.ok(stats.blockers.includes('INSUFFICIENT_COMPLETE_DAILY_BLOCKS'));
});

test('a full frozen 30-day experiment passing all independent checks qualifies for review only', () => {
  const rows = fixture();
  const original = JSON.stringify(rows);
  const stats = summarize(rows);
  assert.equal(stats.expectedRounds, 8640);
  assert.equal(stats.observedRounds, 8640);
  assert.equal(stats.decidedRounds, 30 * 172);
  assert.equal(stats.labeledDecisions, stats.decidedRounds);
  assert.equal(stats.pendingLabels, 0);
  assert.equal(stats.status, 'READY_FOR_PRODUCTION_REVIEW');
  assert.equal(stats.canRecommendProductionSwitch, true);
  assert.equal(stats.longTermValidated, true);
  assert.equal(stats.autoPromotion, false);
  assert.equal(stats.productionEffect, 'NONE_SHADOW_ONLY');
  assert.deepEqual(stats.blockers, []);
  assert.equal(stats.byDay.length, 30);
  assert.equal(stats.rolling7DayWindows.length, 24);
  assert.ok(stats.rolling7DayWindows.every(window => window.complete && window.passes));
  assert.equal(stats.last7Days.startDay, 24);
  assert.equal(stats.last7Days.endDay, 30);
  assert.ok(stats.confidenceIntervals.accuracy.lower >= 0.75);
  assert.ok(stats.confidenceIntervals.coverage.lower >= 0.45);
  assert.equal(stats.confidenceIntervals.dailyBlockBootstrap.resamples, 1024);
  assert.ok(stats.confidenceIntervals.dailyBlockBootstrap.accuracy.lower >= 0.75);
  assert.ok(stats.confidenceIntervals.dailyBlockBootstrap.coverage.lower >= 0.45);
  assert.equal(stats.p50DecisionDelayMs, 16000);
  assert.equal(stats.p95DecisionDelayMs, 16000);
  assert.equal(JSON.stringify(rows), original, 'read-only summary must not alter the journal');
});

test('daily block confidence intervals are deterministic for identical evidence', () => {
  const rows = fixture({ driftAfterDay: 27, driftAccuracy: 0.8 });
  assert.deepEqual(summarize(rows).confidenceIntervals.dailyBlockBootstrap,
    summarize(rows).confidenceIntervals.dailyBlockBootstrap);
});

test('late completion, a different model version and unofficial labels cannot qualify', () => {
  const rows = fixture();
  rows[0][1].decision.completedAt = rows[0][0] + 35001;
  rows[1][1].decision.modelVersion = 'OTHER_MODEL';
  rows[2][1].settlement.actualSource = 'PRICE_HEURISTIC';
  const stats = summarize(rows);
  assert.equal(stats.invalidDecisions, 2);
  assert.equal(stats.rawDecidedRounds, 30 * 172 - 1);
  assert.equal(stats.decidedRounds, 30 * 172 - 2);
  assert.equal(stats.invalidSettlementRecords, 1);
  assert.equal(stats.pendingLabels, 1);
  assert.equal(stats.canRecommendProductionSwitch, false);
  assert.ok(stats.blockers.includes('INVALID_DECISION_RECORDS'));
  assert.ok(stats.blockers.includes('INVALID_OFFICIAL_SETTLEMENT_RECORDS'));
  assert.ok(stats.invalidReasons.DECISION_COMPLETED_OUTSIDE_DEADLINE);
  assert.ok(stats.invalidReasons.DECISION_MODEL_VERSION_MISMATCH);
  assert.ok(stats.invalidReasons.SETTLEMENT_NOT_OFFICIAL);
});

test('all outage calendar rounds remain in coverage and every daily block', () => {
  const rows = fixture().filter(([start]) => start >= START + 15 * DAY);
  const stats = summarize(rows);
  assert.equal(stats.expectedRounds, 8640);
  assert.equal(stats.observedRounds, 4320);
  assert.equal(stats.missingCalendarRounds, 4320);
  assert.ok(stats.coverage < 0.45);
  assert.ok(stats.accuracy >= 0.75);
  assert.equal(stats.byDay[0].expectedRounds, 288);
  assert.equal(stats.byDay[0].decidedRounds, 0);
  assert.equal(stats.byDay[0].coverage, 0);
  assert.equal(stats.confidenceIntervals.dailyBlockBootstrap.fullDays, 30);
  assert.ok(stats.blockers.includes('COVERAGE_POINT_TARGET_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('last-week drift fails stability even when aggregate accuracy remains excellent', () => {
  const stats = summarize(fixture({ accuracy: 1, driftAfterDay: 23, driftAccuracy: 0.55 }));
  assert.ok(stats.accuracy > 0.85);
  assert.ok(stats.confidenceIntervals.accuracy.lower > 0.75);
  assert.ok(stats.last7Days.accuracy < 0.6);
  assert.equal(stats.last7Days.passes, false);
  assert.ok(stats.blockers.includes('ROLLING_7_DAY_STABILITY_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('unresolved and future receipt labels remain pending and block recommendation', () => {
  const rows = fixture();
  rows[0][1].settlement = null;
  rows[1][1].settlement.recordedAt = END + 1;
  const stats = summarize(rows);
  assert.equal(stats.pendingLabels, 2);
  assert.equal(stats.labeledDecisions, stats.decidedRounds - 2);
  assert.ok(stats.blockers.includes('PENDING_OFFICIAL_DECISION_LABELS'));
  assert.ok(stats.invalidReasons.SETTLEMENT_RECEIPT_TIME_INVALID);
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('45 percent point coverage is insufficient when its confidence lower bound is below 45 percent', () => {
  const rows = fixture({ coverage: 1, accuracy: 1 });
  for (let index = 0; index < rows.length; index++) {
    if (Math.floor((index + 1) * 0.45) === Math.floor(index * 0.45)) {
      rows[index][1].decision = null;
      rows[index][1].settlement = null;
    }
  }
  const stats = summarize(rows);
  assert.equal(stats.decidedRounds, 3888);
  assert.equal(stats.coverage, 0.45);
  assert.ok(!stats.blockers.includes('COVERAGE_POINT_TARGET_NOT_MET'));
  assert.ok(stats.confidenceIntervals.coverage.lower < 0.45);
  assert.ok(stats.blockers.includes('COVERAGE_WILSON_LOWER_BOUND_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('75 percent point accuracy alone cannot satisfy the confidence requirement', () => {
  const rows = fixture({ coverage: 1, accuracy: 1 });
  for (let index = 0; index < rows.length; index += 4) {
    const [start, state] = rows[index];
    state.settlement = official(start, state.decision.direction === 'UP' ? 'DOWN' : 'UP');
  }
  const stats = summarize(rows);
  assert.equal(stats.accuracy, 0.75);
  assert.ok(!stats.blockers.includes('ACCURACY_POINT_TARGET_NOT_MET'));
  assert.ok(stats.confidenceIntervals.accuracy.lower < 0.75);
  assert.ok(stats.blockers.includes('ACCURACY_WILSON_LOWER_BOUND_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('both directions require enough official outcomes, even with perfect overall results', () => {
  const stats = summarize(fixture({ coverage: 1, accuracy: 1, oneDirection: true }));
  assert.equal(stats.byDirection.DOWN.labeledDecisions, 0);
  assert.ok(stats.blockers.includes('INSUFFICIENT_DOWN_LABELED_DECISIONS'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('a weaker direction blocks readiness despite excellent aggregate and rolling metrics', () => {
  const rows = fixture({ coverage: 1, accuracy: 1 });
  for (let index = 0; index < rows.length; index++) {
    const [start, state] = rows[index];
    state.decision.direction = index % 5 === 0 ? 'DOWN' : 'UP';
    const hit = state.decision.direction === 'UP' || Math.floor(index / 5) % 20 >= 7;
    state.settlement = official(start, hit ? state.decision.direction : 'UP');
  }
  const stats = summarize(rows);
  assert.ok(stats.accuracy > 0.9);
  assert.ok(stats.rolling7DayWindows.every(window => window.passes));
  assert.ok(stats.byDirection.DOWN.labeledDecisions >= 100);
  assert.ok(stats.byDirection.DOWN.accuracy < 0.75);
  assert.ok(stats.blockers.includes('DOWN_ACCURACY_POINT_TARGET_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('daily accuracy variability can fail bootstrap while every rolling point window and Wilson bound pass', () => {
  const rows = fixture({ coverage: 1, accuracy: 1 });
  for (let index = 0; index < rows.length; index++) {
    const day = Math.floor(index / 288);
    const slot = index % 288;
    if (day < 26 && day % 2 === 0) {
      const [start, state] = rows[index];
      const hit = Math.floor((slot + 1) * 0.57) > Math.floor(slot * 0.57);
      state.settlement = official(start, hit ? state.decision.direction : state.decision.direction === 'UP' ? 'DOWN' : 'UP');
    }
  }
  const stats = summarize(rows);
  assert.ok(stats.rolling7DayWindows.every(window => window.passes));
  assert.ok(stats.confidenceIntervals.accuracy.lower > 0.75);
  assert.ok(stats.confidenceIntervals.dailyBlockBootstrap.accuracy.lower < 0.75);
  assert.ok(stats.blockers.includes('ACCURACY_DAILY_BOOTSTRAP_LOWER_BOUND_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('daily coverage variability can fail bootstrap while every rolling point window and Wilson bound pass', () => {
  const rows = fixture({ coverage: 1, accuracy: 1 });
  for (let index = 0; index < rows.length; index++) {
    const day = Math.floor(index / 288);
    const slot = index % 288;
    const count = day < 26 && day % 2 === 0 ? 77 : 201;
    if (slot >= count) {
      rows[index][1].decision = null;
      rows[index][1].settlement = null;
      rows[index][1].final.direction = 'WAIT';
    }
  }
  const stats = summarize(rows);
  assert.ok(stats.rolling7DayWindows.every(window => window.passes));
  assert.ok(stats.confidenceIntervals.coverage.lower > 0.45);
  assert.ok(stats.confidenceIntervals.dailyBlockBootstrap.coverage.lower < 0.45);
  assert.ok(stats.blockers.includes('COVERAGE_DAILY_BOOTSTRAP_LOWER_BOUND_NOT_MET'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('35 second completion boundary and later official label delivery are accepted', () => {
  const rows = fixture({ accuracy: 1 });
  rows[0][1].decision.completedAt = rows[0][0] + 35000;
  rows[0][1].settlement.recordedAt = END + DAY;
  const beforeDelivery = summarize(rows);
  const afterDelivery = summarize(rows, { now: END + DAY });
  assert.equal(beforeDelivery.pendingLabels, 1);
  assert.equal(beforeDelivery.canRecommendProductionSwitch, false);
  assert.equal(afterDelivery.invalidDecisions, 0);
  assert.equal(afterDelivery.pendingLabels, 0);
  assert.equal(afterDelivery.canRecommendProductionSwitch, true);
  assert.equal(afterDelivery.expectedRounds, 8640, 'post-experiment rounds do not change the frozen denominator');
});

test('missing decision timestamps are invalid evidence rather than inferred from a snapshot', () => {
  const rows = fixture();
  delete rows[0][1].decision.observedAt;
  delete rows[1][1].decision.completedAt;
  const stats = summarize(rows);
  assert.equal(stats.invalidDecisions, 2);
  assert.ok(stats.invalidReasons.DECISION_OBSERVED_AT_MISSING);
  assert.ok(stats.invalidReasons.DECISION_COMPLETED_AT_MISSING);
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('journal corruption, duplicate rounds and pre-registered model timing inconsistencies block readiness', () => {
  const rows = fixture();
  rows.push(rows[0]);
  const duplicate = summarize(rows);
  assert.ok(duplicate.blockers.includes('DUPLICATE_JOURNAL_ROUND'));
  assert.equal(duplicate.canRecommendProductionSwitch, false);
  const corrupted = summarize(fixture(), { lastError: 'JOURNAL_LOAD_FAILED' });
  assert.ok(corrupted.blockers.includes('JOURNAL_OR_MODEL_INTEGRITY_ERROR'));
  assert.equal(corrupted.canRecommendProductionSwitch, false);
  const registration = summarize(fixture(), { model: { ...model, registeredAt: START + 1 } });
  assert.ok(registration.blockers.includes('MODEL_REGISTERED_AFTER_FORWARD_START'));
  assert.equal(registration.canRecommendProductionSwitch, false);
});

test('any current runtime error requires review before a production recommendation', () => {
  const stats = summarize(fixture(), { lastError: 'MODEL_PREDICTION_FAILED' });
  assert.ok(stats.blockers.includes('RUNTIME_ERROR_REQUIRES_REVIEW'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('a changed threshold under the same model version breaks the frozen experiment', () => {
  const rows = fixture();
  rows[0][1].decision.threshold = 0.81;
  rows[1][1].decision.threshold = model.threshold;
  const stats = summarize(rows);
  assert.equal(stats.invalidDecisions, 1);
  assert.equal(stats.invalidReasons.DECISION_FROZEN_THRESHOLD_MISMATCH, 1);
  assert.ok(stats.blockers.includes('INVALID_DECISION_RECORDS'));
  assert.equal(stats.canRecommendProductionSwitch, false);
});

test('invalid model metadata or a freeze shorter than 30 days cannot bypass the calendar requirement', () => {
  const invalid = summarize([], { model: { ...model, forwardStartMs: START + 1 } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.canRecommendProductionSwitch, false);
  const tooShort = summarize(fixture(), { model: { ...model, frozenUntilMs: END - DAY } });
  assert.equal(tooShort.completeExperimentalDays, 29);
  assert.ok(tooShort.blockers.includes('FROZEN_WINDOW_SHORTER_THAN_30_DAYS'));
  assert.equal(tooShort.canRecommendProductionSwitch, false);
});

test('invalid validation input is a read-only error result', () => {
  const stats = summarizeShadow35Validation({ model, rows: null, now: END });
  assert.equal(stats.ok, false);
  assert.equal(stats.canRecommendProductionSwitch, false);
  assert.ok(stats.blockers.includes('INVALID_VALIDATION_INPUT'));
});
