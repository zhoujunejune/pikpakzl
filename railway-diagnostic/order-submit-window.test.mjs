import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./wrapper.mjs', import.meta.url), 'utf8');
const helper = source.match(/function orderSubmitDeadlineForModel\(model\) \{[\s\S]*?\n\}/);
if (!helper) throw new Error('ORDER_SUBMIT_DEADLINE_HELPER_NOT_FOUND');
const match = source.match(/function orderSubmitWindowOpen\(round, now = Date\.now\(\), model = null\) \{[\s\S]*?\n\}/);
if (!match) throw new Error('ORDER_SUBMIT_WINDOW_FUNCTION_NOT_FOUND');
// Evaluate the exact standalone pure helper embedded into the production wrapper.
const orderSubmitWindowOpen = new Function(
  'ORDER_SUBMIT_DEADLINE_MS','DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS','SELECTIVE30_ORDER_DEADLINE_MS','DYNAMIC_ORDER_DEADLINE_MS',
  'DYNAMIC_MODEL','EDGE_MODEL','EDGE_ORDER_DEADLINE_MS','SELECTIVE8_MODEL',
  helper[0] + '\n' + match[0] + '\nreturn orderSubmitWindowOpen;',
)(15000,30000,30000,285000,'DYNAMIC_ENTRY_5M_SHADOW_V1','EDGE_5M_V1',8000,'DEEPSEEK_5M_V1');

test('round-relative submit deadline is exactly 15 seconds', () => {
  assert.match(source, /const ORDER_SUBMIT_DEADLINE_MS = 15000;/);
  const round = 1792123800000;
  assert.equal(orderSubmitWindowOpen(round, round - 1), false);
  assert.equal(orderSubmitWindowOpen(round, round), true);
  assert.equal(orderSubmitWindowOpen(round, round + 7999), true);
  assert.equal(orderSubmitWindowOpen(round, round + 14999), true);
  assert.equal(orderSubmitWindowOpen(round, round + 15000), false);
  assert.equal(orderSubmitWindowOpen(round, round + 15001), false);
  assert.equal(orderSubmitWindowOpen(null, round + 1), false);
  assert.equal(orderSubmitWindowOpen(round, round+16000, 'NOVICE_MIX_LOW_V1'),false);
  assert.equal(orderSubmitWindowOpen(round, round+16000, 'DYNAMIC_ENTRY_5M_SHADOW_V1'),true);
  assert.equal(orderSubmitWindowOpen(round, round+240000, 'DYNAMIC_ENTRY_5M_SHADOW_V1'),true);
  assert.equal(orderSubmitWindowOpen(round, round+285000, 'DYNAMIC_ENTRY_5M_SHADOW_V1'),false);
  assert.equal(orderSubmitWindowOpen(round, round+7999,'EDGE_5M_V1'),true);
  assert.equal(orderSubmitWindowOpen(round, round+8000,'EDGE_5M_V1'),false);
});

test('late orders are checked before quoting, before placement and before preparation', () => {
  assert.match(source, /rejectExpiredOrderWindow\(p, 'before_quote'\)/);
  assert.match(source, /rejectExpiredOrderWindow\(p, 'before_place_order'\)/);
  assert.match(source, /if \(!orderSubmitWindowOpen\(signal\.round,Date\.now\(\),choice\.model\)\) return;/);
});

test('quoting safety and one-submission-per-round behavior remain present', () => {
  assert.match(source, /remainingMs < 1200/);
  assert.match(source, /if \(submittedRounds\.has\(String\(p\.round\)\)\)/);
  assert.match(source, /if \(autoAttemptedRounds\.has\(String\(p\.round\)\)\)/);
});