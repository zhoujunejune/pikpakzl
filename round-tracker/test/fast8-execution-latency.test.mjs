import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reconcileOrderUpdate } from '../../railway-diagnostic/order-status-state.mjs';

const pending = { orderId: 'A', status: 'PENDING', state: 'SUBMITTED_PENDING_CONFIRMATION',
  fillPercentage: 0, filledUsdtAmount: 0 };
test('terminal filled order ignores stale pending and submitted polls', () => {
  const filled = { ...pending, ...reconcileOrderUpdate(pending, {status:'FILLED', fillPercentage:'1', filledUsdtAmount:'0.94'}) };
  for (const status of ['PENDING','SUBMITTED']) {
    const next = { ...filled, ...reconcileOrderUpdate(filled,{status,fillPercentage:'0',filledUsdtAmount:'0'}) };
    assert.equal(next.state,'CONFIRMED_FILLED');
    assert.equal(next.status,'FILLED');
    assert.equal(next.filledUsdtAmount,'0.94');
  }
});
test('filled then failed is a disputed exchange state, not a safe failure', () => {
  const filled = { ...pending, ...reconcileOrderUpdate(pending,{status:'FILLED',fillPercentage:1,filledUsdtAmount:'0.94'}) };
  const dispute = { ...filled, ...reconcileOrderUpdate(filled,{status:'FAILED',fillPercentage:0,filledUsdtAmount:0}) };
  assert.equal(dispute.state,'RECONCILIATION_REQUIRED');
  assert.equal(dispute.conflictingStatus,'FAILED');
  assert.equal(dispute.filledUsdtAmount,'0.94');
  assert.equal(reconcileOrderUpdate(dispute,{status:'PENDING'}).state,'RECONCILIATION_REQUIRED');
});
test('failed then filled is disputed, terminal failed ignores stale pending', () => {
  const failure = { ...pending, ...reconcileOrderUpdate(pending,{status:'FAILED'}) };
  assert.equal(reconcileOrderUpdate(failure,{status:'PENDING'}).status,'FAILED');
  assert.equal(reconcileOrderUpdate(failure,{status:'FILLED',fillPercentage:1}).state,'RECONCILIATION_REQUIRED');
});
test('FAST8 remains locked at existing cutoff and execution uses parallel read-only signal and quote', () => {
  const f8 = fs.readFileSync(new URL('../fast8-model.mjs',import.meta.url),'utf8');
  const worker = fs.readFileSync(new URL('../fast8-client.mjs',import.meta.url),'utf8');
  const main = fs.readFileSync(new URL('../index-rest.mjs',import.meta.url),'utf8');
  const wrapper = fs.readFileSync(new URL('../../railway-diagnostic/wrapper.mjs',import.meta.url),'utf8');
  assert.match(f8,/CUTOFF_MS = 1500/);
  assert.match(f8,/LOCK_MS = 1800/);
  assert.match(worker,/onDecision\(latest\)/);
  assert.match(main,/onDecision: decision =>/);
  assert.match(wrapper,/Promise\.all\(\[\s*getSignal\(\{ forceHttp: true \}\),\s*getFreshQuote\(p\._internal\),?\s*\]\)/);
  assert.match(wrapper,/submitPendingOrder\(pendingAction, \{ source: 'auto' \}\)/);
});
