import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {nextDefiniteRetry,isDefiniteRetryReady,reconcileExactUnknownOrder} from './risk-sell-retry.mjs';
const source=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');

test('clear SELL rejection retry is delayed and backs off, never infinite tight loop',()=>{
 const a=nextDefiniteRetry({},10000,1000,10000);
 assert.equal(a.failures,1);assert.equal(a.retryAt,11000);
 assert.equal(isDefiniteRetryReady({error:'EXPLICIT_REJECT',retryAt:11000},10999),false);
 assert.equal(isDefiniteRetryReady({error:'EXPLICIT_REJECT',retryAt:11000},11000),true);
 const b=nextDefiniteRetry(a,11000,1000,10000);
 const c=nextDefiniteRetry(b,13000,1000,10000);
 assert.equal(b.delayMs,2000);
 assert.equal(c.delayMs,4000);
 assert.equal(nextDefiniteRetry(c,17000,1000,10000).delayMs,4000);
});
test('in-flight, submitted, or unknown SELL never authorizes retry',()=>{
 for(const state of [{inFlight:true},{submitted:true},{statusUnknown:true}])
  assert.equal(isDefiniteRetryReady(state,Date.now()),false);
});
test('missing or mismatched quote/token cannot authorize ambiguous SELL retry',()=>{
 const e={quoteId:'A',tokenId:'BTC-UP',side:'SELL',status:'FAILED',filledShares:'0'};
 assert.equal(reconcileExactUnknownOrder(e,{quoteId:'B',tokenId:'BTC-UP'}),'UNVERIFIED');
 assert.equal(reconcileExactUnknownOrder(e,{quoteId:'A',tokenId:'BTC-DOWN'}),'UNVERIFIED');
 assert.equal(reconcileExactUnknownOrder({...e,side:'BUY'},{quoteId:'A',tokenId:'BTC-UP'}),'UNVERIFIED');
 assert.equal(reconcileExactUnknownOrder(null,{quoteId:'A',tokenId:'BTC-UP'}),'UNVERIFIED');
});
test('only exact terminal rejection with explicit ZERO fill permits fresh-quote reevaluation',()=>{
 const q={quoteId:'A',tokenId:'BTC-UP',side:'SELL',status:'REJECTED',filledShares:'0'};
 const x={quoteId:'A',tokenId:'BTC-UP'};
 assert.equal(reconcileExactUnknownOrder(q,x),'REJECTED_NO_FILL_CAN_REEVALUATE');
 assert.equal(reconcileExactUnknownOrder({...q,status:'PENDING'},x),'ORDER_OBSERVED_DO_NOT_RETRY');
 assert.equal(reconcileExactUnknownOrder({...q,status:'FILLED'},x),'ORDER_OBSERVED_DO_NOT_RETRY');
 assert.equal(reconcileExactUnknownOrder({...q,filledShares:'0.01'},x),'UNVERIFIED');
 assert.equal(reconcileExactUnknownOrder({...q,filledShares:undefined},x),'UNVERIFIED');
 assert.equal(reconcileExactUnknownOrder({...q,status:'UNKNOWN'},x),'UNVERIFIED');
});
test('worker tracks exact quoteId and current position shares on uncertain SELL; never blindly retries',()=>{
 for(const phrase of [
  "quoteId:quoteResult.quote.quoteId",
  "originalShares:position.shares",
  "async function reconcileUnknownSell(",
  "reconcileExactUnknownOrder(o,",
  "sameShares",
  "history.ok&&active.ok",
  "'BINANCE_RECONCILED_REJECTION'",
  "risk_unknown_reconcile_pending",
  "statusUnknown: true",
  "if (state?.statusUnknown)",
  "getSellQuote(wallet, position, topic)",
  "evaluateRisk(targets, quoteResult.quote)",
  "risk_retry_scheduled",
  "risk_sell_submitted",
 ])assert.ok(source.includes(phrase),phrase);
});
