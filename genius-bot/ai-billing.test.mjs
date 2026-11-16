import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiBillingGate,DEFAULT_BILLING_RETRY_MS} from './ai-billing.mjs';
test('DeepSeek 402 suppresses futile repeated requests without disabling market monitoring',()=>{
 const t=1000000,g=createAiBillingGate();
 assert.equal(g.canCall(t),true);
 assert.equal(g.noteHttpStatus(402,t),true);
 assert.equal(g.isBlocked(t+1),true);
 assert.equal(g.canCall(t+1),false);
 assert.equal(g.snapshot(t+1).retryAfterMs,DEFAULT_BILLING_RETRY_MS-1);
 assert.equal(g.snapshot(t+1).http402Count,1);
 assert.equal(g.snapshot(t+1).blockedCalls,1);
 assert.equal(g.canCall(t+DEFAULT_BILLING_RETRY_MS),true);
 assert.equal(g.isBlocked(t+DEFAULT_BILLING_RETRY_MS),false);
});
test('recover automatically when a new API request succeeds; do not confuse HTTP 429 with 402',()=>{
 const t=1000000,g=createAiBillingGate(2000);
 assert.equal(g.noteHttpStatus(429,t),false);
 assert.equal(g.canCall(t),true);
 g.noteHttpStatus(402,t);
 assert.equal(g.isBlocked(t+1000),true);
 g.noteSuccess(t+1200);
 assert.equal(g.isBlocked(t+1200),false);
 assert.equal(g.snapshot(t+1200).http402Count,1);
 g.noteHttpStatus(402,t+1300);
 assert.equal(g.canCall(t+3299),false);
 assert.equal(g.canCall(t+3300),true);
});
test('invalid billing gate timings rejected',()=>{
 assert.throws(()=>createAiBillingGate(0),/INVALID_BILLING_RETRY_MS/);
 assert.throws(()=>createAiBillingGate(-1),/INVALID_BILLING_RETRY_MS/);
});
