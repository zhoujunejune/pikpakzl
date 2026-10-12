import test from 'node:test';
import assert from 'node:assert/strict';
import { retiredShadowEvidence, hasUnretiredShadowCandidates, retiredShadowCount } from './retired-shadow-tombstones.mjs';

const contest = 'SELECTIVE_V2_NO_BASE_CONTEST_V2';
const rescue = 'WAIT_RESCUE_SHADOW_V1';
const retiredContest = [
  'BALANCED_65_70_PM03', 'PM05_65_70', 'PM08_65_70', 'CURRENT70_70_PM03',
  'TREND80_65_PM03', 'MICRO_65_70_PM03', 'MOM30_65_70_PM03', 'BOTH_65_70_PM03',
];
const retiredRescue = [
  'SAFE_R75_T50_PM03', 'SAFE_R75_T50_PM05', 'SAFE_R75_T60_PM03',
  'SAFE_R75_T60_PM05', 'SAFE_R75_T50_PM03_MICRO', 'SAFE_R75_T50_PM03_MOM',
  'EXP_R60_T60_PM12', 'EXP_R60_T70_PM10',
];

test('all 16 previously retired shadow candidates remain inactive after history rotation', () => {
  assert.equal(retiredShadowCount(contest), 8);
  assert.equal(retiredShadowCount(rescue), 8);
  for (const [version, ids] of [[contest, retiredContest], [rescue, retiredRescue]]) {
    assert.equal(hasUnretiredShadowCandidates(version, ids.map(id => ({ id }))), false);
    for (const id of ids) {
      const evidence = retiredShadowEvidence(version, id);
      assert.equal(evidence.status, 'RETIRED_LOW_ACCURACY');
      assert.equal(evidence.active, false);
      assert.equal(evidence.historicalStrictForwardSamples, 20);
      assert.ok(evidence.historicalStrictForwardAccuracy < 0.65);
    }
  }
});

test('new and unrelated candidates remain eligible for independent forward evaluation', () => {
  assert.equal(retiredShadowEvidence(contest, 'NEW_CANDIDATE'), null);
  assert.equal(retiredShadowEvidence('OTHER_SHADOW', 'SAFE_R75_T50_PM03'), null);
  assert.equal(hasUnretiredShadowCandidates(rescue, [
    { id: 'SAFE_R75_T50_PM03' }, { id: 'NEW_CANDIDATE' },
  ]), true);
  assert.equal(hasUnretiredShadowCandidates(contest, []), false);
  assert.equal(hasUnretiredShadowCandidates(contest, null), false);
});
