import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {reconcileExactUnknownOrder} from './risk-sell-retry.mjs';
import {classifySubmittedRiskSellOrder,safeToRetryUnfilledSubmitted} from './risk-sell-finality.mjs';
const source=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');
const start=source.indexOf('function stateBlocksSell(state) {');
const end=source.indexOf('async function sellPosition(',start);
assert.ok(start>0&&end>start);
const segment=source.slice(start,end);
function harness({history=[],active=[],historyOk=true,activeOk=true,now=Date.now()}={}){
 const calls=[],events=[],states=new Map(),persistence=[];
 const DateMock=class extends Date {static now(){return now}};
 const context={
  sellState:states,RETRY_MS:1000,SLOW_RETRY_MS:5000,
  UNKNOWN_RECONCILE_MS:10000,SUBMITTED_RECONCILE_MS:5000,
  Date:DateMock,reconcileExactUnknownOrder,classifySubmittedRiskSellOrder,
  safeToRetryUnfilledSubmitted,log:(event,fields)=>events.push({event,...fields}),
  persistPendingSellState:()=>persistence.push([...states.entries()].map(([k,v])=>({k,state:{...v}}))),
  signedGet:async(path,args)=>{
   calls.push({path,args});
   if(path.endsWith('/history'))return {ok:historyOk,data:{orders:history}};
   if(path.endsWith('/list'))return {ok:activeOk,data:{orders:active}};
   throw Error('NON_READONLY_API');
  }
 };
 vm.runInNewContext(segment+'\nthis.actions={reconcileSubmittedSell,stateBlocksSell,scheduleKnownFailure}',context);
 return {actions:context.actions,states,events,calls,persistence};
}
const id='SELL-100';
const tokenId='TOKEN';
const initial={submitted:true,statusUnknown:false,orderId:id,
 originalShares:'12.5',submittedAt:Date.now()-9000,lastStatusCheckAt:0};
const order={orderId:id,side:'SELL',status:'FAILED',filledShareQty:'0.00',
 filledUsdtAmount:'0.00',fillPercentage:'0.00'};
const wallet={walletAddress:'TEST-WALLET'};
const position={tokenId,shares:'12.5'};
test('post-submission terminal failed and zero filled is scheduled for retry with new quote',async()=>{
 const h=harness({history:[order],active:[]});
 h.states.set(tokenId,{...initial});
 await h.actions.reconcileSubmittedSell(wallet,position,h.states.get(tokenId));
 const st=h.states.get(tokenId);
 assert.equal(st.submitted,false);
 assert.equal(st.statusUnknown,false);
 assert.equal(st.failures,1);
 assert.equal(st.retryAfterAt-st.lastAttemptAt,1000);
 assert.equal(h.actions.stateBlocksSell(st),false);
 assert.equal(h.events.some(x=>x.event==='risk_sell_final_failed_retry_scheduled'),true);
 assert.equal(h.calls.length,2);
 assert.equal(h.calls[1].args.orderId,id);
 assert.ok(h.persistence.length>0);
});
test('accepted sale eventually FILLED is confirmed and never re-sold',async()=>{
 const h=harness({history:[{...order,status:'FILLED',filledShareQty:'12.5'}]});
 h.states.set(tokenId,{...initial});
 await h.actions.reconcileSubmittedSell(wallet,position,h.states.get(tokenId));
 assert.equal(h.states.get(tokenId).submitted,true);
 assert.equal(h.states.get(tokenId).confirmedFilled,true);
 assert.equal(h.actions.stateBlocksSell(h.states.get(tokenId)),true);
 assert.ok(h.events.find(x=>x.event==='risk_sell_fill_confirmed'));
});
test('partially filled failures, changed shares and pending active orders never resubmit',async()=>{
 for(const params of [
   {history:[{...order,filledShareQty:'1'}],active:[],pos:position},
   {history:[order],active:[{...order,status:'SUBMITTED'}],pos:position},
   {history:[order],active:[],pos:{...position,shares:'11.5'}},
   {history:[{...order,orderId:'WRONG'}],active:[],pos:position},
   {history:[order],active:[],activeOk:false,pos:position},
  ]){
  const h=harness(params);
  h.states.set(tokenId,{...initial});
  await h.actions.reconcileSubmittedSell(wallet,params.pos,h.states.get(tokenId));
  assert.equal(h.states.get(tokenId).submitted,true);
  assert.equal(h.events.some(x=>x.event==='risk_sell_final_failed_retry_scheduled'),false);
 }
});
test('pending order, lookup failure or stale list does not clear submitted fence',async()=>{
 for(const opts of [
 {history:[{...order,status:'SUBMITTED'}]},
 {historyOk:false},
 {history:[],active:[]}
 ]){
 const h=harness(opts);
 h.states.set(tokenId,{...initial});
 await h.actions.reconcileSubmittedSell(wallet,position,h.states.get(tokenId));
 assert.equal(h.states.get(tokenId).submitted,true);
 assert.ok(h.events.some(x=>x.event==='risk_sell_finality_pending'));
 }
});
test('retry worker writes pre-POST fence to persistent store, then monitors Binance orderId',()=>{
 const body=source.slice(source.indexOf('async function sellPosition('),source.indexOf('function cleanupSellState('));
 assert.ok(body.indexOf('persistPendingSellState(); // must succeed BEFORE sending a real SELL')>=0);
 assert.ok(body.indexOf('persistPendingSellState(); // must succeed BEFORE sending a real SELL')<
   body.indexOf('const placed = await placeSell('));
 assert.ok(body.includes('orderId: placed.orderId'));
 assert.ok(source.includes('if(state?.submitted){'));
 assert.ok(source.includes('await reconcileSubmittedSell(wallet,position,state)'));
 assert.match(source,/if\s*\(!evaluation\.triggered\)\s*continue;/);
 assert.ok(source.includes('const quoteResult = await getSellQuote(wallet, position, topic);'));
});
test('durable in-flight fence restores as UNKNOWN after a process crash',()=>{
 const a=source.indexOf('function persistPendingSellState(){');
 const b=source.indexOf('// Read-only health output',a);
 assert.ok(a>0&&b>a);
 const section=source.slice(a,b);
 const files=new Map();
 const path='/tmp/unit-test-risk-order-store.json';
 function mockFs(){
  return {
   existsSync:p=>files.has(p),
   readFileSync:p=>files.get(p),
   writeFileSync:(p,s)=>files.set(p,s),
   renameSync:(p,q)=>{files.set(q,files.get(p));files.delete(p)},
   unlinkSync:p=>files.delete(p)
  };
 }
 const mk=()=>{const ctx={sellState:new Map(),fs:mockFs(),
   SELL_PENDING_FILE:path,process:{pid:19},Date,Error};
   vm.runInNewContext(section+'\nthis.io={persistPendingSellState,restorePendingSellState}',ctx);
   return ctx;};
 const before=mk();
 before.sellState.set('T',{inFlight:true,statusUnknown:false,quoteId:'q',
   originalShares:5,sellRequestAt:123});
 before.io.persistPendingSellState();
 const restart=mk();
 assert.equal(restart.sellState.get('T').statusUnknown,true);
 assert.equal(restart.sellState.get('T').inFlight,false);
 assert.equal(restart.sellState.get('T').quoteId,'q');
});
