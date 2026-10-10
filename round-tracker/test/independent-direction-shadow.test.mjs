import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INDEPENDENT_DIRECTION_NAME,
  INDEPENDENT_TARGET,
  chooseIndependentDirection,
  independentFeatures,
  createIndependentDirectionShadow,
} from '../independent-direction-shadow.mjs';

test('shadow identity and review thresholds are preserved', () => {
  assert.equal(INDEPENDENT_DIRECTION_NAME, 'zl_new_vip75');
  assert.equal(INDEPENDENT_TARGET.accuracy, .75);
  assert.equal(independentFeatures({}), null);
});

test('direction selection is deterministic', () => {
  for (const p of [0, .2, .5, .8, 1]) {
    assert.deepEqual(chooseIndependentDirection(p), chooseIndependentDirection(p));
  }
});

test('shadow state persists across restart without losing ledger', () => {
  const dir=mkdtempSync(join(tmpdir(),'vip75-test-'));
  try {
    const file=join(dir,'shadow.json');
    const a=createIndependentDirectionShadow({file,log:()=>{}});
    a.load();
    const b=createIndependentDirectionShadow({file,log:()=>{}});
    b.load();
    const s=b.stats([]);
    assert.equal(s.modelName, 'zl_new_vip75');
    assert.equal(s.activeLearning.officialLedgerRows, 0);
    assert.equal(s.challengerForward.promotionAllowed, false);
    assert.ok(s.activeLearning.enabled);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
