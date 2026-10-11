import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOrphanedShadowArtifacts } from './shadow-retired-cleanup.mjs';

test('removes old orphan files without touching registered, pinned or unrelated data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-sweep-'));
  try {
    const dir = path.join(root, 'shadow-v3');
    fs.mkdirSync(dir);
    const kept = path.join(dir, 'shadow-v3-automl-111.pkl');
    const pinned = path.join(dir, 'shadow-v3-automl-222.pkl');
    const orphan = path.join(dir, 'shadow-v3-automl-333.pkl');
    const archive = path.join(dir, 'round-history.jsonl');
    for (const file of [kept, pinned, orphan, archive]) fs.writeFileSync(file, 'test');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(orphan, old, old);
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      lastAttemptRound: 300,
      candidates: [{ modelPath: kept }],
    }));
    const out = cleanupOrphanedShadowArtifacts({
      directories: [{ name: 'shadow-v3', dir }],
      protectedModelVersions: ['shadow-v3-automl-222'],
      minAgeMs: 1_000,
    });
    assert.equal(out.deleted, 1);
    assert.ok(!fs.existsSync(orphan));
    assert.ok(fs.existsSync(kept));
    assert.ok(fs.existsSync(pinned));
    assert.ok(fs.existsSync(archive));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'))).lastAttemptRound, 300);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt or missing registry prevents deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-sweep-'));
  try {
    const dir = path.join(root, 'shadow-v5');
    fs.mkdirSync(dir);
    const orphan = path.join(dir, 'shadow-v5-minirocket-333.pkl');
    fs.writeFileSync(orphan, 'test');
    const opts = { directories: [{ name: 'shadow-v5', dir }], minAgeMs: 0 };
    assert.equal(cleanupOrphanedShadowArtifacts(opts).deleted, 0);
    fs.writeFileSync(path.join(dir, 'registry.json'), '{broken');
    assert.equal(cleanupOrphanedShadowArtifacts(opts).deleted, 0);
    assert.ok(fs.existsSync(orphan));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not remove models inside the write grace period', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-sweep-'));
  try {
    const dir = path.join(root, 'shadow-v7');
    fs.mkdirSync(dir);
    const candidate = path.join(dir, 'shadow-v7-mapie-arf-333.pkl');
    fs.writeFileSync(candidate, 'test');
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schemaVersion: 1, candidates: [] }));
    assert.equal(cleanupOrphanedShadowArtifacts({directories:[{name:'shadow-v7',dir}], minAgeMs:600000}).deleted, 0);
    assert.ok(fs.existsSync(candidate));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
