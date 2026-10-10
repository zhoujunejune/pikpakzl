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
