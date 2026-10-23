import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');
const a=source.indexOf('async function sellPosition(');
const b=source.indexOf('function cleanupSellState(',a);
assert.ok(a>0&&b>a);
const segment=source.slice(a,b);

test('EROFS from local journal BEFORE exchange POST is retryable, not unknown, and never sends a SELL',async()=>{
 const sellState=new Map(),events=[];
 let posted=0;
 const ctx={
   sellState,
   Date,
   stateBlocksSell:()=>false,
   quoteTooCloseToExpiry:()=>false,
   persistPendingSellState:()=>{const e=Error('read only file system');e.code='EROFS';throw e;},
   scheduleKnownFailure:(id,prev,error,stage)=>({
     ...prev,submitted:false,inFlight:false,statusUnknown:false,
     error,stage,failures:(prev?.failures||0)+1,retryAfterAt:Date.now()+1000
   }),
   placeSell:async()=>{posted++;return {ok:true,orderId:'SHOULD_NOT_EXIST'}},
   log:(e,v)=>events.push({event:e,...v})
 };
 vm.runInNewContext(segment+'\nthis.run=sellPosition;',ctx);
 const wallet={walletAddress:'TEST',walletId:'w'};
 const payment={accountType:'SPOT'};
 const position={tokenId:'T',shares:'5'};
 const targets={tokenId:'T',totalCost:1,tpTarget:1.35,slTarget:0.65};
 const quote={ok:true,quote:{quoteId:'Q',expireAt:Date.now()+15000,amountOut:'1000'}};
 const evaluation={ok:true,triggered:true,reason:'TAKE_PROFIT',currentSellAmount:1.4};
 await ctx.run(wallet,payment,position,{},targets,quote,evaluation);
 assert.equal(posted,0,'Must not submit Binance SELL while durable write fails');
 assert.equal(sellState.get('T').statusUnknown,false,'We know no POST occurred');
 assert.equal(sellState.get('T').submitted,false);
 assert.equal(sellState.get('T').failures,1);
 assert.equal(events.some(e=>e.event==='risk_sell_not_submitted_journal_unavailable' &&
  e.code==='EROFS' && e.failedBeforeExchangePost===true),true);
 assert.equal(events.some(e=>e.event==='risk_sell_unknown'),false);
});
