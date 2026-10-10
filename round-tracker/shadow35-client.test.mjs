import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShadow35Client } from './shadow35-client.mjs';

const START = 3000000000000;
const ROUND = 300000;
function fixture(t, predictions = [0.9]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow35-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = START;
  const calls = [];
  const runner = async (action, input) => {
    calls.push({ action, input });
    if (action === 'train') return { ok: true, status: 'CANDIDATE_REGISTERED',
      modelVersion: 'frozen-test-model', modelPath: path.join(dir, 'models', 'model.json'),
      trainedAt: now, threshold: 0.8, qualification: 'UNMET', holdout: { accuracy: 0.6 } };
    const next = predictions.shift();
    const probability = typeof next === 'function' ? await next(input) : next;
    return { ok: true, probability, modelVersion: 'frozen-test-model' };
  };
  const options = { dir, clock: () => now, runner, minRounds: 1 };
  const client = createShadow35Client(options);
  assert.equal(client.load(), true);
  const events = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { client, dir, calls, options, events, setNow(value) { now = value; }, get now() { return now; } };
}
function live(start, sourceAt, overrides = {}) {
  return { round: start, factsCalculatedAt: sourceAt, generatedAt: start + 10000,
    status: 'WAIT', signal: null, facts: { currentScore: 0.4, currentTrendScore: 0.6,
      microScore: 0.1, liveScore: 0.3, distanceFromOpenBps: 1, predictionMarketUpMid: 0.56,
      absorptionRisk: true, depthAgeMs: 10, lastAggTradeAgeMs: 20,
      predictionMarketBookAgeMs: 10, predictionMarketMappingReliable: true,
      predictionMarketRound: start, predictionMarketTopicStartDate: start,
      predictionMarketTopicEndDate: start + ROUND,
      predictionMarketRoundAligned: true, ...overrides } };
}
function official(start, settledAt, actual = 'UP') {
  return { roundStartMs: start, actual, settledAt,
    actualSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence: 'OFFICIAL_' + actual + ':STRICT_ROUND_ALIGNED_TOPIC:test' };
}
async function trainedFixture(t, probabilities) {
  const f = fixture(t, probabilities);
  f.setNow(START + 15000);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 100), f.now);
  f.setNow(START + ROUND + 1);
  assert.equal(f.client.settle(official(START, f.now)), true);
  assert.ok(await f.client.maybeTrain());
  return { ...f, forwardStart: START + 2 * ROUND };
}

test('collects all rounds without a V6 direction; missing slots never get hindsight backfilled', t => {
  const f = fixture(t);
  f.setNow(START + 15000);
  const productionRow = { roundStartMs: START, prediction: 'WAIT', productionPrediction: null };
  const original = structuredClone(productionRow);
  f.client.observe(productionRow, live(START, f.now - 100), f.now);
  f.client.observe(productionRow, live(START, f.now), f.now);
  f.setNow(START + 22500);
  f.client.observe(productionRow, live(START, f.now), f.now);
  f.setNow(START + 34000);
  f.client.observe(productionRow, live(START, f.now - 100), f.now);
  assert.deepEqual(productionRow, original, 'shadow collection cannot alter any production state');
  const snapshots = f.events().filter(x => x.type === 'snapshot');
  assert.equal(snapshots.length, 5);
  assert.equal(snapshots.find(x => x.checkpointMs === 15000).valid, true);
  assert.equal(snapshots.find(x => x.checkpointMs === 35000).valid, true);
  for (const checkpointMs of [20000, 25000, 30000]) {
    const missed = snapshots.find(x => x.checkpointMs === checkpointMs);
    assert.equal(missed.valid, false);
    assert.ok(missed.reasons.includes('CHECKPOINT_MISSED'));
    assert.deepEqual(missed.features, {});
  }
  assert.equal(f.calls.length, 0, 'cold start must collect without manufactured predictions');
  assert.equal(f.client.stats().remainingTrainingRounds, 1);
});

test('requires true feature time; future, stale and wrong-round packets are rejected', t => {
  const f = fixture(t);
  f.setNow(START + 15000);
  const missing = live(START, f.now); delete missing.factsCalculatedAt;
  f.client.observe({ roundStartMs: START }, missing, f.now);
  f.setNow(START + 20000);
  f.client.observe({ roundStartMs: START }, live(START, f.now + 1), f.now);
  f.setNow(START + 25000);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 1500), f.now);
  f.setNow(START + 30000);
  f.client.observe({ roundStartMs: START - ROUND }, live(START - ROUND, f.now), f.now);
  const snapshots = f.events().filter(x => x.type === 'snapshot');
  assert.ok(snapshots[0].reasons.includes('MISSING_SOURCE_TIMESTAMP'));
  assert.ok(snapshots[1].reasons.includes('FUTURE_SOURCE_TIMESTAMP'));
  assert.ok(snapshots[2].reasons.includes('STALE_FEATURE_SNAPSHOT'));
  assert.ok(snapshots[3].reasons.includes('SOURCE_ROUND_MISMATCH'));
  assert.ok(snapshots.every(x => !x.valid));
});

test('rejects a fresh previous-round prediction book and mismatched topic dates', t => {
  const f = fixture(t);
  f.setNow(START + 15000);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 50,
    { predictionMarketRound: START - ROUND }), f.now);
  f.setNow(START + 20000);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 50,
    { predictionMarketTopicStartDate: START - ROUND, predictionMarketTopicEndDate: START }), f.now);
  const snapshots = f.events().filter(x => x.type === 'snapshot');
  assert.ok(snapshots[0].reasons.includes('PM_SOURCE_ROUND_MISMATCH'));
  assert.ok(snapshots[1].reasons.includes('PM_TOPIC_TIME_MISMATCH'));
  assert.ok(snapshots.every(x => !x.valid));
});

test('official strict labels are idempotent, corrections preserve the frozen decision', async t => {
  const f = fixture(t);
  f.setNow(START + ROUND + 1);
  assert.equal(f.client.settle({ ...official(START, f.now), actualSource: 'SPOT_KLINE' }), false);
  assert.equal(f.client.settle({ ...official(START, f.now), resolutionEvidence: 'OFFICIAL_UP:UNALIGNED' }), false);
  assert.equal(f.client.settle(official(START, f.now + 1)), false);
  const label = official(START, f.now);
  const before = structuredClone(label);
  assert.equal(f.client.settle(label), true);
  assert.equal(f.client.settle(label), false);
  assert.deepEqual(label, before);
  assert.equal(f.client.settle(official(START, f.now, 'DOWN')), true);
  assert.equal(f.events().filter(x => x.type === 'settlement').length, 2);
});

test('reevaluates lower confidence at the next checkpoint and freezes only the first qualified direction', async t => {
  const f = await trainedFixture(t, [0.7, 0.91, 0.05]);
  const row = { roundStartMs: f.forwardStart, productionPrediction: 'DOWN', productionSource: 'EXISTING' };
  const before = structuredClone(row);
  f.setNow(f.forwardStart + 15000);
  f.client.observe(row, live(f.forwardStart, f.forwardStart + 14900), f.forwardStart + 15000);
  await f.client.idle();
  assert.equal(f.events().filter(x => x.type === 'decision').length, 0);
  f.setNow(f.forwardStart + 20000);
  f.client.observe(row, live(f.forwardStart, f.forwardStart + 19900), f.forwardStart + 20000);
  await f.client.idle();
  f.setNow(f.forwardStart + 25000);
  f.client.observe(row, live(f.forwardStart, f.forwardStart + 24900), f.forwardStart + 25000);
  await f.client.idle();
  const decisions = f.events().filter(x => x.type === 'decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].direction, 'UP');
  assert.equal(decisions[0].checkpointMs, 20000);
  assert.equal(f.calls.filter(x => x.action === 'predict').length, 2);
  assert.deepEqual(row, before, 'shadow decision must never alter an existing production lock');
});

test('valid 34s snapshot whose inference completes after 35s remains WAIT', async t => {
  let f;
  f = await trainedFixture(t, [() => { f.setNow(f.forwardStart + 35001); return 0.99; }]);
  f.setNow(f.forwardStart + 34000);
  f.client.observe({ roundStartMs: f.forwardStart }, live(f.forwardStart, f.forwardStart + 33900), f.forwardStart + 34000);
  await f.client.idle();
  assert.equal(f.events().filter(x => x.type === 'decision').length, 0);
  assert.ok(f.events().some(x => x.type === 'prediction' && x.reason === 'PREDICTION_COMPLETED_AFTER_DEADLINE'));
  assert.ok(f.events().some(x => x.type === 'round_final' && x.roundStartMs === f.forwardStart && x.direction === 'WAIT'));
});

test('restart preserves snapshot/label/lock idempotency and the 30 day frozen model', async t => {
  const f = await trainedFixture(t, [0.91]);
  f.setNow(f.forwardStart + 15000);
  f.client.observe({ roundStartMs: f.forwardStart }, live(f.forwardStart, f.forwardStart + 14900), f.forwardStart + 15000);
  await f.client.idle();
  const reloaded = createShadow35Client(f.options);
  assert.equal(reloaded.load(), true);
  const before = f.events().length;
  reloaded.observe({ roundStartMs: f.forwardStart }, live(f.forwardStart, f.forwardStart + 14900), f.forwardStart + 15000);
  await reloaded.idle();
  assert.equal(f.events().length, before);
  assert.equal(await reloaded.maybeTrain(), null);
  assert.equal(reloaded.stats(f.forwardStart + 20000).model.frozenUntilMs, f.forwardStart + 30 * 86400000);
  assert.equal(f.calls.filter(x => x.action === 'train').length, 1);
});

test('renaming the experiment replays legacy samples, official labels and frozen decisions without resetting its model', async t => {
  const f = await trainedFixture(t, [0.91, 0.01]);
  f.setNow(f.forwardStart + 15000);
  f.client.observe({ roundStartMs: f.forwardStart }, live(f.forwardStart, f.forwardStart + 14900), f.forwardStart + 15000);
  await f.client.idle();
  f.setNow(f.forwardStart + ROUND + 1);
  const settled = official(f.forwardStart, f.forwardStart + ROUND + 1);
  assert.equal(f.client.settle(settled), true);
  f.client.observe({ roundStartMs: f.forwardStart + ROUND }, null, f.forwardStart + ROUND + 1);
  const originalStats = f.client.stats();
  const journal = path.join(f.dir, 'events.jsonl');
  const legacyEvents = f.events().map(event => ({ ...event, version: 'SHADOW35_PROBABILITY_V1' }));
  fs.writeFileSync(journal, legacyEvents.map(event => JSON.stringify(event)).join('\n') + '\n');

  const reloaded = createShadow35Client(f.options);
  assert.equal(reloaded.load(), true);
  const restored = reloaded.stats();
  assert.equal(restored.version, 'LOCK_QUALITY_SELECTIVE_V7_5');
  assert.deepEqual(restored, { ...originalStats, version: 'LOCK_QUALITY_SELECTIVE_V7_5' });
  assert.equal(restored.collectionStartMs, START, 'a rename must preserve the original calendar denominator');
  assert.equal(restored.validSnapshotCount, 2);
  assert.equal(restored.labeledTrainingRounds, 2);
  assert.equal(restored.forward.decidedRounds, 1);
  assert.equal(restored.forward.labeledDecisions, 1);
  assert.equal(restored.forward.hits, 1);
  assert.equal(restored.model.frozenUntilMs, f.forwardStart + 30 * 86400000);
  assert.equal(f.events().length, legacyEvents.length, 'loading legacy events cannot append a replacement experiment');
  assert.equal(reloaded.settle(settled), false, 'the official settlement remains idempotent after migration');
  reloaded.observe({ roundStartMs: f.forwardStart }, live(f.forwardStart, f.forwardStart + 14900), f.forwardStart + 15000);
  await reloaded.idle();
  assert.equal(f.events().length, legacyEvents.length, 'the old sample and first lock must not be duplicated');
  assert.equal(await reloaded.maybeTrain(), null, 'the registered candidate remains frozen after a rename');

  const nextRound = f.forwardStart + ROUND;
  f.setNow(nextRound + 15000);
  reloaded.observe({ roundStartMs: nextRound }, live(nextRound, nextRound + 14900), nextRound + 15000);
  await reloaded.idle();
  f.setNow(nextRound + ROUND + 1);
  assert.equal(reloaded.settle(official(nextRound, nextRound + ROUND + 1, 'DOWN')), true);
  reloaded.observe({ roundStartMs: nextRound + ROUND }, null, nextRound + ROUND + 1);
  const migratedEvents = f.events();
  assert.deepEqual(migratedEvents.slice(0, legacyEvents.length), legacyEvents, 'old records remain intact');
  assert.ok(migratedEvents.length > legacyEvents.length);
  assert.ok(migratedEvents.slice(legacyEvents.length).every(event => event.version === 'LOCK_QUALITY_SELECTIVE_V7_5'));
  assert.equal(migratedEvents.filter(event => event.type === 'collection_started').length, 1);
  assert.deepEqual(reloaded.stats().model, restored.model, 'new sampling must use the original frozen artifact');
  assert.equal(reloaded.stats().forward.decidedRounds, 2);
  assert.equal(reloaded.stats().forward.hits, 2);
  assert.equal(f.calls.filter(call => call.action === 'train').length, 1);
  assert.equal(f.calls.filter(call => call.action === 'predict').length, 2);
});

test('coverage includes downtime calendar rounds; stats is a read-only view', async t => {
  const f = await trainedFixture(t, []);
  f.setNow(f.forwardStart + 3 * ROUND + 15000);
  f.client.observe({ roundStartMs: f.forwardStart + 3 * ROUND }, null, f.forwardStart + 3 * ROUND + 15000);
  const bytes = fs.statSync(path.join(f.dir, 'events.jsonl')).size;
  const stats = f.client.stats(f.forwardStart + 3 * ROUND + 15000);
  assert.equal(stats.forward.expectedRounds, 3);
  assert.equal(stats.forward.coverage, 0);
  assert.equal(fs.statSync(path.join(f.dir, 'events.jsonl')).size, bytes);
  assert.equal(stats.autoPromotion, false);
  assert.equal(stats.productionEffect, 'NONE_SHADOW_ONLY');
  assert.equal(JSON.stringify(stats).includes(f.dir), false, 'public stats cannot expose storage paths');
});

test('an interrupted final JSONL append is repaired on restart without losing complete records', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.dir, 'events.jsonl'), '{"type":"snapshot"');
  const restarted = createShadow35Client(f.options);
  assert.equal(restarted.load(), true);
  f.setNow(START + 15000);
  restarted.observe({ roundStartMs: START }, live(START, f.now - 100), f.now);
  assert.equal(f.events().filter(x => x.type === 'snapshot').length, 1);
});

test('recovers the frozen artifact when registration was interrupted', async t => {
  const f = await trainedFixture(t, []);
  const journal = path.join(f.dir, 'events.jsonl');
  const events = f.events().filter(x => !['model_registered', 'training_attempt'].includes(x.type));
  fs.writeFileSync(journal, events.map(x => JSON.stringify(x)).join('\n') + '\n');
  const recovered = createShadow35Client({ ...f.options, runner: async action => {
    assert.equal(action, 'train');
    return { ok: true, status: 'FROZEN_CANDIDATE_EXISTS', modelVersion: 'same-frozen-artifact',
      modelPath: path.join(f.dir, 'models', 'model.joblib'), trainedAt: START + ROUND,
      threshold: 0.8, qualification: 'UNMET' };
  } });
  assert.equal(recovered.load(), true);
  assert.ok(await recovered.maybeTrain());
  assert.equal(recovered.stats().model.modelVersion, 'same-frozen-artifact');
});

test('a corrupt complete journal fails closed instead of collecting with partially loaded state', async t => {
  const f = fixture(t);
  const journal = path.join(f.dir, 'events.jsonl');
  fs.appendFileSync(journal, '{invalid-complete-record}\n');
  const restarted = createShadow35Client(f.options);
  assert.equal(restarted.load(), false);
  const bytes = fs.statSync(journal).size;
  f.setNow(START + 15000);
  restarted.observe({ roundStartMs: START }, live(START, f.now), f.now);
  assert.equal(await restarted.maybeTrain(), null);
  assert.equal(fs.statSync(journal).size, bytes);
  assert.equal(restarted.stats().ok, false);
});

test('persists rejected training results and the next retry threshold for scheduled progress reports', async t => {
  const f = fixture(t);
  const blocked = createShadow35Client({ ...f.options, runner: async (action, input) => {
    assert.equal(action, 'train');
    assert.equal(input.targetCoverage, 0.45);
    return { ok: true, status: 'REJECTED_INSUFFICIENT_FOLD_FEATURES_OR_CLASSES' };
  } });
  assert.equal(blocked.load(), true);
  f.setNow(START + 15000);
  blocked.observe({ roundStartMs: START }, live(START, f.now - 100), f.now);
  f.setNow(START + ROUND + 1);
  blocked.settle(official(START, f.now));
  assert.equal(await blocked.maybeTrain(), null);
  const status = blocked.stats();
  assert.equal(status.status, 'TRAINING_BLOCKED');
  assert.equal(status.remainingTrainingRounds, 0);
  assert.equal(status.training.status, 'REJECTED_INSUFFICIENT_FOLD_FEATURES_OR_CLASSES');
  assert.equal(status.training.nextAttemptAtTrainingRounds, 21);
  assert.equal(status.forward.canRecommendProductionSwitch, false);
  assert.deepEqual(status.forward.targets, { accuracy: 0.75, coverage: 0.45 });
  const restarted = createShadow35Client(f.options);
  assert.equal(restarted.load(), true);
  assert.deepEqual(restarted.stats().training, status.training);
  assert.equal(await restarted.maybeTrain(), null, 'do not repeatedly train unchanged rejected data');
});

test('a training attempt interrupted by a restart retries and recovers its frozen artifact', async t => {
  const f = await trainedFixture(t, []);
  const events = f.events().filter(x => !['model_registered', 'training_result'].includes(x.type));
  fs.writeFileSync(path.join(f.dir, 'events.jsonl'), events.map(x => JSON.stringify(x)).join('\n') + '\n');
  const restarted = createShadow35Client(f.options);
  assert.equal(restarted.load(), true);
  assert.equal(restarted.stats().training.status, 'TRAINING_INTERRUPTED');
  assert.ok(await restarted.maybeTrain(), 'a interrupted attempt must not wait for 20 extra labels to retry');
  assert.equal(restarted.stats().training.status, 'CANDIDATE_REGISTERED');
  assert.equal(restarted.stats().model.modelVersion, 'frozen-test-model');
});

test('journal write failure reports unhealthy and recovers after a successful append', t => {
  const f = fixture(t);
  const journal = path.join(f.dir, 'events.jsonl');
  const backup = path.join(f.dir, 'events.backup');
  fs.renameSync(journal, backup);
  fs.mkdirSync(journal);
  f.setNow(START + 15000);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 100), f.now);
  assert.equal(f.client.stats().ok, false);
  assert.equal(f.client.stats().lastError, 'JOURNAL_WRITE_FAILED');
  assert.equal(f.client.stats().forward.canRecommendProductionSwitch, false);
  fs.rmdirSync(journal);
  fs.renameSync(backup, journal);
  f.client.observe({ roundStartMs: START }, live(START, f.now - 100), f.now);
  assert.equal(f.client.stats().ok, true);
  assert.equal(f.client.stats().lastError, null);
  assert.equal(f.client.stats().validSnapshotCount, 1);
});
