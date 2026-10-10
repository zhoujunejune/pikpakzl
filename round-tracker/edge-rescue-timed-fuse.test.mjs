import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTimedEdgeRescueFuse } from './edge-rescue-timed-fuse.mjs';

const HALF_HOUR = 30 * 60 * 1000;
const bad = { fuse: { globalFused: true }, up: { fused: true }, down: { fused: false } };
const healthy = { fuse: { globalFused: false }, up: { fused: false }, down: { fused: false } };
const settled = (round, result = 'HIT', direction = 'UP') => ({
  roundStartMs: round,
  actualSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
  productionSource: 'SELECTIVE_V2_EDGE_RESCUE_PRIMARY',
  productionPrediction: direction,
  productionResult: result,
});

test('30-minute minimum cooldown, one pending trial, two official hits to reopen', () => {
  let t = 1000000;
  const fuse = createTimedEdgeRescueFuse({ now: () => t });
  assert.equal(fuse.check('UP', bad).reason, 'GLOBAL_COOLDOWN');
  t += HALF_HOUR - 1;
  assert.equal(fuse.check('UP', healthy).allowed, false, 'recovered readings cannot bypass minimum cooldown');
  t++;
  assert.equal(fuse.check('UP', bad).trial, true);
  fuse.recordLock('UP', 300000);
  assert.equal(fuse.check('UP', bad).reason, 'GLOBAL_TRIAL_AWAITING_OFFICIAL_SETTLEMENT');
  fuse.onSettled(settled(300000, 'HIT'));
  assert.equal(fuse.check('UP', bad).trial, true);
  fuse.recordLock('UP', 600000);
  fuse.onSettled(settled(600000, 'HIT'));
  const status = fuse.status();
  assert.equal(status.scopes.GLOBAL.mode, 'PROBATION_OPEN');
  assert.equal(status.scopes.UP.mode, 'PROBATION_OPEN');
  assert.equal(fuse.check('UP', bad).allowed, true);
  fuse.onSettled(settled(900000, 'MISS'));
  assert.equal(fuse.check('UP', bad).allowed, false, 'a probation miss immediately refreezes');
});

test('half-open MISS starts a fresh 30-minute fuse', () => {
  let t = 1000000;
  const fuse = createTimedEdgeRescueFuse({ now: () => t });
  fuse.check('UP', bad);
  t += HALF_HOUR;
  fuse.check('UP', bad);
  fuse.recordLock('UP', 300000);
  t += 10000;
  fuse.onSettled(settled(300000, 'MISS'));
  assert.equal(fuse.status().scopes.GLOBAL.until, t + HALF_HOUR);
  assert.equal(fuse.check('UP', bad).allowed, false);
});

test('direction-specific fuse never blocks the unaffected side', () => {
  const fuse = createTimedEdgeRescueFuse({ now: () => 1000000 });
  const upOnly = { ...bad, fuse: { globalFused: false } };
  assert.equal(fuse.check('UP', upOnly).reason, 'UP_COOLDOWN');
  assert.equal(fuse.check('DOWN', upOnly).allowed, true);
});

test('pending trial survives restart and cannot silently open without settlement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fuse-test-'));
  const file = path.join(dir, 'edge-fuse.json');
  let t = 1000000;
  try {
    const a = createTimedEdgeRescueFuse({ file, now: () => t });
    a.check('UP', bad);
    t += HALF_HOUR;
    a.check('UP', bad);
    a.recordLock('UP', 300000);
    const b = createTimedEdgeRescueFuse({ file, now: () => t });
    assert.equal(b.check('UP', bad).allowed, false);
    b.reconcile([settled(300000, 'HIT')]);
    assert.equal(b.check('UP', bad).allowed, true);
    assert.equal(b.status().scopes.GLOBAL.consecutiveHits, 1);
    b.reconcile([settled(300000, 'HIT')]);
    assert.equal(b.status().scopes.GLOBAL.consecutiveHits, 1, 'reconciliation is idempotent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unverified or unrelated settlement cannot clear an outstanding trial', () => {
  let t = 1000000;
  const fuse = createTimedEdgeRescueFuse({ now: () => t });
  fuse.check('UP', bad);
  t += HALF_HOUR;
  fuse.check('UP', bad);
  fuse.recordLock('UP', 300000);
  fuse.onSettled({ ...settled(300000), actualSource: 'BINANCE_5M_KLINE_OPEN_CLOSE' });
  fuse.onSettled(settled(600000));
  assert.equal(fuse.check('UP', bad).allowed, false);
});


test('one-time manual clearing releases an existing fuse, ignoring stale failures until new adverse settlement', () => {
  let t = 1000000;
  const fuse = createTimedEdgeRescueFuse({ now: () => t });
  assert.equal(fuse.check('UP', bad).allowed, false);
  assert.equal(fuse.rearmOnce('manual-reset-v1', { GLOBAL: 300000, UP: 300000, DOWN: 150000 }), true);
  const historicalFailure = {
    ...bad,
    fuse: { ...bad.fuse, latestEligible: { roundStartMs: 300000, miss: true } },
    up: { ...bad.up, latestEligible: { roundStartMs: 300000, miss: true } },
  };
  assert.equal(fuse.check('UP', historicalFailure).allowed, true, 'stale failure must not instant re-fuse');
  assert.equal(fuse.rearmOnce('manual-reset-v1', { GLOBAL: 999000, UP: 999000, DOWN: 999000 }), false);
  const newHitStillPoor = {
    ...historicalFailure,
    fuse: { ...bad.fuse, latestEligible: { roundStartMs: 600000, miss: false } },
    up: { ...bad.up, latestEligible: { roundStartMs: 600000, miss: false } },
  };
  assert.equal(fuse.check('UP', newHitStillPoor).allowed, true, 'new HIT cannot retrip legacy poor window');
  const newMiss = {
    ...historicalFailure,
    fuse: { ...bad.fuse, latestEligible: { roundStartMs: 900000, miss: true } },
    up: { ...bad.up, latestEligible: { roundStartMs: 900000, miss: true } },
  };
  assert.equal(fuse.check('UP', newMiss).reason, 'GLOBAL_COOLDOWN');
  assert.equal(fuse.status().scopes.GLOBAL.rearmAfterRound, null, 'next fuse is normally armed');
});

test('manual clear revision persists and cannot silently reset a later fuse on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fuse-rearm-test-'));
  const file = path.join(dir, 'fuse.json');
  try {
    const fuse = createTimedEdgeRescueFuse({ file, now: () => 1000000 });
    fuse.rearmOnce('live-one-time-1', { GLOBAL: 100, UP: 100, DOWN: 50 });
    const badNewMiss = {
      ...bad,
      fuse: { globalFused: true, latestEligible: { roundStartMs: 200, miss: true } },
      up: { fused: true, latestEligible: { roundStartMs: 200, miss: true } },
    };
    assert.equal(fuse.check('UP', badNewMiss).allowed, false);
    const restarted = createTimedEdgeRescueFuse({ file, now: () => 1000010 });
    assert.equal(restarted.rearmOnce('live-one-time-1', { GLOBAL: 999, UP: 999 }), false);
    assert.equal(restarted.status().scopes.GLOBAL.mode, 'COOLDOWN');
    assert.equal(restarted.check('UP', badNewMiss).allowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manual clear does not bypass regular rescue direction fuse after fresh miss', () => {
  const fuse = createTimedEdgeRescueFuse({ now: () => 1000000 });
  fuse.rearmOnce('live-one-time-2', { GLOBAL: 500, UP: 500, DOWN: 100 });
  const upBadOnly = {
    fuse: { globalFused: false, latestEligible: { roundStartMs: 600, miss: true } },
    up: { fused: true, latestEligible: { roundStartMs: 600, miss: true } },
    down: { fused: false, latestEligible: { roundStartMs: 110, miss: false } },
  };
  assert.equal(fuse.check('UP', upBadOnly).reason, 'UP_COOLDOWN');
  assert.equal(fuse.check('DOWN', upBadOnly).allowed, true);
});
