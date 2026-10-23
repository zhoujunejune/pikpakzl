import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {reconcileExactUnknownOrder} from './risk-sell-retry.mjs';
import {classifySubmittedRiskSellOrder,safeToRetryUnfilledSubmitted} from './risk-sell-finality.mjs';
const source=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');
const start=source.indexOf('function stateBlocksSell(state) {');
const end=source.indexOf('async function sellPosition(',start);
assert.ok(start>=0 && end>start);
const segment=source.slice(start,end);
function harness({apiResponse, now=Date.now()}={}){
 const events=[],sellState=new Map(),calls=[];
 const DateStub=class extends Date {static now(){return now;}};
 const sandbox={sellState,RETRY_MS:1000,SLOW_RETRY_MS:5000,UNKNOWN_RECONCILE_MS:10000,
   Date:DateStub,reconcileExactUnknownOrder,classifySubmittedRiskSellOrder,safeToRetryUnfilledSubmitted,
   SUBMITTED_RECONCILE_MS:5000,persistPendingSellState:()=>{},
   log:(name,fields)=>events.push({name,...fields}),
   signedGet:async(path,args)=>{
     calls.push({path,args});
     return apiResponse?apiResponse(path,args):{ok:true,data:{orders:[]}};
   }
 };
 vm.runInNewContext(segment+"\nthis.methods={stateBlocksSell,nextRetryDelay,scheduleKnownFailure,parseOrderTimestamp,reconcileUnknownSell};",sandbox);
 return {m:sandbox.methods,events,sellState,calls};
}
test('known SELL 4xx and quote errors schedule quick retries three times, then throttle',()=>{
 const h=harness();
 let state=null;
 for(let i=1;i<=5;i++){
   state=h.m.scheduleKnownFailure('testToken',state,'QUOTE_REJECTED','SELL_POST_KNOWN_FAILURE');
   assert.equal(state.failures,i);
   assert.equal(state.statusUnknown,false);
   assert.equal(state.inFlight,false);
   assert.equal(state.retryAfterAt-state.lastAttemptAt,i<=3?1000:5000);
   assert.equal(h.m.stateBlocksSell(state),false);
 }
 assert.deepEqual(h.events.map(e=>e.retryMs),[1000,1000,1000,5000,5000]);
});
test('unknown SELL result must always block retries even if exchange lists no matching order',async()=>{
 const h=harness();
 const token='XYZ',state={statusUnknown:true,sellRequestAt:Date.now()-2500,lastReconciledAt:0};
 h.sellState.set(token,state);
 assert.equal(h.m.stateBlocksSell(state),true);
 await h.m.reconcileUnknownSell({walletAddress:'testWallet'},{tokenId:token},state);
 assert.equal(h.sellState.get(token).statusUnknown,true);
 assert.equal(h.events[0].name,'risk_unknown_reconcile_pending');
 assert.equal(h.events[0].retrySellBlocked,true);
 assert.equal(h.calls.length,2);
 await h.m.reconcileUnknownSell({walletAddress:'testWallet'},{tokenId:token},state);
 assert.equal(h.calls.length,2,'reconciliation must respect backoff');
});
test('unknown SELL is resolved only with strict current-token, SELL side and recent order timestamp',async()=>{
 const now=Date.now();
 const h=harness({now,apiResponse:async path=>({
   ok:true,data:{orders:path.includes('history')?[
     {tokenId:'TGT',side:'BUY',orderId:'wrongSide',createTime:now},
     {tokenId:'OLD',side:'SELL',orderId:'wrongToken',createTime:now},
     {tokenId:'TGT',side:'SELL',orderId:'oldSell',createTime:now-60000},
   ]:[{tokenId:'TGT',side:'SELL',quoteId:'q123',status:'PENDING',orderId:'order123',createTime:now-500}]}
 })});
 const state={statusUnknown:true,quoteId:'q123',originalShares:5,sellRequestAt:now-1000,lastReconciledAt:0};
 h.sellState.set('TGT',state);
 await h.m.reconcileUnknownSell({walletAddress:'testWallet'},{tokenId:'TGT',shares:5},state);
 assert.equal(h.sellState.get('TGT').statusUnknown,false);
 assert.equal(h.sellState.get('TGT').submitted,true);
 assert.equal(h.sellState.get('TGT').orderId,'order123');
 assert.equal(h.m.stateBlocksSell(h.sellState.get('TGT')),true);
 assert.equal(h.events[0].name,'risk_unknown_order_found');
});
test('ambiguous order without timestamp remains blocked; no invented evidence',async()=>{
 const h=harness({apiResponse:async()=>({ok:true,data:{orders:[{
   tokenId:'TGT',side:'SELL',orderId:'maybe',status:'FILLED'
 }]}})});
 const state={statusUnknown:true,sellRequestAt:Date.now()-800};
 h.sellState.set('TGT',state);
 await h.m.reconcileUnknownSell({walletAddress:'testWallet'},{tokenId:'TGT'},state);
 assert.equal(h.sellState.get('TGT').statusUnknown,true);
 assert.equal(h.events[0].name,'risk_unknown_reconcile_pending');
});
test('retry tick always refreshes market quote and rechecks TP/SL before SELL',()=>{
 for(const marker of [
  'if (state?.retryAfterAt && Date.now() < state.retryAfterAt) continue;',
  'const quoteResult = await getSellQuote(wallet, position, topic);',
  'const evaluation = evaluateRisk(targets, quoteResult.quote);',
  "if (!evaluation.triggered) continue;",
  "const payment = await paymentReady;",
  'await sellPosition(wallet, payment, position, topic, targets, quoteResult, evaluation);',
  "const call = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle', body);",
  'const statusUnknown = Boolean(call?.network) || Number(call?.status || 0) >= 500;',
 ])assert.ok(source.includes(marker),marker);
 assert.ok(!segment.includes('place-order-bundle'));
});
