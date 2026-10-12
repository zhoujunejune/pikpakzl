import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFast8Engine } from './fast8-engine.mjs';
import { featureVector, trainFast8, probability, MIN_TRAINING, ROUND_MS } from './fast8-model.mjs';
import { createFast8Client } from './fast8-client.mjs';

const START = 1791800100000;
function fixture(t, at = START - 500) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast8-'));
  let now = at;
  const published = [];
  let engine = createFast8Engine({ dir, clock: () => now, publish: d => published.push(d) });
  assert.equal(engine.load(), true);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get engine() { return engine; }, dir, published, time: value => { now = value; },
    reload() { engine.close(); engine = createFast8Engine({ dir, clock: () => now, publish: d => published.push(d) }); return engine.load(); } };
}
function live(round = START, at = round + 6400, momentum = 0.4) {
  return { round, factsCalculatedAt: at, facts: {
    currentScore: 0.6, currentTrendScore: 0.5, microScore: 0.3, regimeScore: 0.2,
    liveScore: 0.4, distanceFromOpenBps: 2, normalizedMomentum60s: momentum,
    depthAgeMs: 50, lastAggTradeAgeMs: 50, tradePressure15s: 0.5,
    predictionMarketMappingReliable: true, predictionMarketRoundAligned: true,
    predictionMarketRound: round, predictionMarketBookAgeMs: 100, predictionMarketUpMid: 0.55 } };
}
function settle(round = START, actual = 'UP') {
  return { roundStartMs: round, actual, actualSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence: 'OFFICIAL_' + actual + ':STRICT_ROUND_ALIGNED_TOPIC', settledAt: round + ROUND_MS + 100 };
}
function freeze(f, round = START, momentum = 0.4) {
  f.time(round + 6450);
  f.engine.capture(live(round, round + 6400, momentum), round + 6440);
  f.time(round + 7020);
  const d = f.engine.tick();
  f.time(round + 7030);
  f.engine.acknowledge(round, round + 7025);
  return d;
}

test('every round freezes a single durable direction before 8s; never edits after lock', t => {
  const f = fixture(t);
  const d = freeze(f);
  assert.equal(d.direction, 'UP');
  assert.equal(d.fallbackLevel, 'MOMENTUM60_BASELINE');
  assert.equal(f.published.length, 1);
  f.time(START + 7900);
  f.engine.capture(live(START, START + 7890, -0.8), START + 7895);
  assert.equal(f.engine.tick().direction, 'UP');
  assert.equal(f.published.length, 1);
  f.time(START + ROUND_MS + 200);
  assert.equal(f.engine.settle(settle()), true);
  const s = f.engine.stats();
  assert.equal(s.onTimeCoverage, 1);
  assert.equal(s.hits, 1);
  assert.equal(s.predictionAccuracy, 1);
  assert.equal(s.productionEffect, 'NONE_SHADOW_ONLY');
});

test('missing data still produces an explicitly uninformative direction', t => {
  const f = fixture(t);
  f.time(START + 7010);
  const d = f.engine.tick();
  assert.ok(['UP', 'DOWN'].includes(d.direction));
  assert.equal(d.fallbackLevel, 'NO_INFORMATION_FALLBACK');
  assert.equal(d.pUpRaw, null);
  assert.deepEqual(d.dataQuality, ['NO_FRESH_SNAPSHOT']);
});

test('rejects future, stale and cross-round data and never admits post-cutoff receipt', t => {
  const f = fixture(t);
  f.time(START + 6400);
  assert.equal(f.engine.capture(live(START, START + 6401), START + 6400), false);
  assert.equal(f.engine.capture(live(START - ROUND_MS, START - 1), START + 6400), false);
  assert.equal(f.engine.capture(live(START, START + 3000), START + 6400), false);
  f.time(START + 6600);
  f.engine.capture(live(START, START + 6400, 0.8), START + 6600);
  f.time(START + 7000);
  assert.equal(f.engine.tick().fallbackLevel, 'NO_INFORMATION_FALLBACK');
});

test('publication at 8000ms is timely but at 8001ms is a breach; pending is not a miss', t => {
  const f = fixture(t);
  f.time(START + 7000);
  f.engine.tick();
  f.time(START + 8001);
  f.engine.acknowledge(START, START + 8001);
  f.time(START + ROUND_MS);
  let s = f.engine.stats();
  assert.equal(s.onTimeCoverage, 0);
  assert.equal(s.pendingLabels, 1);
  assert.equal(s.misses, 0);
  assert.equal(s.predictionAccuracy, null);
  f.time(START + ROUND_MS + 7000);
  f.engine.tick();
  f.time(START + ROUND_MS + 8000);
  f.engine.acknowledge(START + ROUND_MS, START + ROUND_MS + 8000);
  f.time(START + 2 * ROUND_MS);
  s = f.engine.stats();
  assert.equal(s.onTimeCoverage, 0.5);
});

test('all calendar rounds including downtime enter coverage; late recovery cannot backdate', t => {
  const f = fixture(t);
  freeze(f);
  f.time(START + 2 * ROUND_MS + 9000);
  const late = f.engine.tick();
  assert.equal(late.decisionComputedAtMs, START + 2 * ROUND_MS + 9000);
  f.engine.acknowledge(late.roundStartMs, late.decisionComputedAtMs);
  f.time(START + 3 * ROUND_MS);
  const s = f.engine.stats();
  assert.equal(s.expectedRounds, 3);
  assert.equal(s.missingRounds, 1);
  assert.equal(s.directionCoverage, 2 / 3);
  assert.equal(s.onTimeCoverage, 1 / 3);
});

test('restart preserves identity, direction, experiment start and first publication timestamp', t => {
  const f = fixture(t);
  const d = freeze(f);
  f.time(START + 15000);
  assert.equal(f.reload(), true);
  assert.equal(f.engine.tick().direction, d.direction);
  assert.equal(f.engine.acknowledge(START, START + 15000), false);
  assert.equal(f.engine.stats().latest.publishedAtMs, START + 7025);
  assert.equal(f.engine.stats().experimentStartRound, START);
});

test('complete journal corruption is never silently reset; incomplete crash tail is repaired', t => {
  const f = fixture(t);
  freeze(f);
  fs.appendFileSync(path.join(f.dir, 'events.jsonl'), '{"crash":');
  assert.equal(f.reload(), true);
  assert.equal(f.engine.stats().latest.direction, 'UP');
  fs.appendFileSync(path.join(f.dir, 'events.jsonl'), '{bad}\n');
  assert.equal(f.reload(), false);
  assert.equal(f.engine.stats().ok, false);
});

test('only official aligned settlements count, duplicates do not, corrections remain auditable', t => {
  const f = fixture(t);
  freeze(f);
  f.time(START + ROUND_MS + 200);
  assert.equal(f.engine.settle({ ...settle(), actualSource: 'SPOT_KLINE' }), false);
  assert.equal(f.engine.settle({ ...settle(), resolutionEvidence: 'OFFICIAL_UP:UNALIGNED' }), false);
  assert.equal(f.engine.settle({ ...settle(), settledAt: START + ROUND_MS + 300 }), false);
  assert.equal(f.engine.settle(settle()), true);
  assert.equal(f.engine.settle(settle()), false);
  assert.equal(f.engine.settle(settle(START, 'DOWN')), true);
  assert.equal(f.engine.stats().labeledPredictions, 1);
  assert.equal(f.engine.stats().misses, 1);
  const events = fs.readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'settlement').length, 2);
});

test('fallback and missing predictions cannot be excluded to claim 65 percent', t => {
  const f = fixture(t);
  freeze(f);
  f.time(START + 2 * ROUND_MS + 200);
  f.engine.settle(settle());
  f.engine.settle(settle(START + ROUND_MS));
  const s = f.engine.stats();
  assert.equal(s.predictionAccuracy, 1);
  assert.equal(s.endToEndAccuracy, 0.5);
  assert.equal(s.onTimeCoverage, 0.5);
  assert.equal(s.validation.passed, false);
});

test('temporal L2 learner trains without abstention and rejects premature training', () => {
  assert.throws(() => trainFast8([]), /INVALID_TRAINING_ROWS/);
  const samples = Array.from({ length: MIN_TRAINING }, (_, i) => {
    const y = i % 2;
    return { roundStartMs: START + i * ROUND_MS, decisionAt: START + i * ROUND_MS + 7000,
      labelReceivedAt: START + (i + 1) * ROUND_MS + 100, x: featureVector({ currentScore: y ? 0.8 : -0.8 }),
      baseline: y ? 'UP' : 'DOWN', y };
  });
  const result = trainFast8(samples);
  assert.equal(result.accepted, true);
  assert.equal(result.holdout.coverage, 1);
  assert.ok(probability(result.weights, samples[1].x) > 0.5);
  assert.ok(probability(result.weights, samples[0].x) < 0.5);
});

test('integration adds only shadow data, settlement, lifecycle and read-only routes', () => {
  const src = fs.readFileSync(new URL('./index-rest.mjs', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('./fast8-client.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("url.pathname === '/api/fast8-stats'"));
  assert.ok(src.includes("url.pathname === '/api/fast8-latest'"));
  assert.equal((src.match(/fast8\.observe\(/g) || []).length, 1);
  assert.equal((src.match(/fast8\.settle\(/g) || []).length, 2);
  assert.ok(!/productionSignalPayload\(|publishLockedSignal\(|createClient\(/.test(client));
});

test('real worker starts independently and exposes a fresh read-only shadow status', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast8-worker-'));
  let ready;
  const booted = new Promise(resolve => { ready = resolve; });
  const client = createFast8Client({ dir, onReady: ready });
  t.after(async () => { await client.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  client.start();
  await Promise.race([booted, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('WORKER_BOOT_TIMEOUT')), 5000);
    timeout.unref();
  })]);
  assert.equal(client.stats().ok, true);
  assert.equal(client.stats().modelFamily, 'ZL_FAST8_65');
  assert.equal(client.stats().autoPromotion, false);
  assert.equal(client.latest().executionEligible, false);
});
