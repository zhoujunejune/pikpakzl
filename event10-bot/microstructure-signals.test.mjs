import test from "node:test";
import assert from "node:assert/strict";
import {collectOptionalMicrostructure,chooseMicrostructureDirection,
  parseMicroOrderBook,parseMicroAggTrades,parseMicroIndexKlines,MICRO_FEATURE_NAMES}
 from "./microstructure-signals.mjs";
const AT=Date.parse("2026-11-15T12:34:20Z");
const book=(buyQty=5,sellQty=1,at=AT-400)=>({
 T:at,E:at,lastUpdateId:99,
 bids:Array.from({length:20},(_,i)=>[(70000-i*0.1).toFixed(1),String(buyQty)]),
 asks:Array.from({length:20},(_,i)=>[(70000.1+i*0.1).toFixed(1),String(sellQty)])
});
const trades=(buyCount=48,sellCount=12,at=AT)=>Array.from({length:buyCount+sellCount},(_,i)=>({
 T:at-6000+i*95,p:"70001",q:"0.1",m:i>=buyCount,a:2000+i}));
const indexBars=(up=true,at=AT)=>Array.from({length:6},(_,i)=>{
 const open=Math.floor(at/60000)*60000-(6-i)*60000;
 const close=70000+(up?1:-1)*i*13;
 return [open,String(close-2),String(close+4),String(close-4),String(close),"0",open+59999];
});
const response=d=>({ok:true,json:async()=>d});
test("all three public sources parse with strictly past timestamps and correct taker-side semantics",()=>{
 const b=parseMicroOrderBook(book(),AT),t=parseMicroAggTrades(trades(),AT),k=parseMicroIndexKlines(indexBars(),AT);
 assert.equal(b.vote,"UP");assert.equal(t.vote,"UP");assert.equal(k.vote,"UP");
 assert.ok(b.imbalanceTop20>0.5);assert.ok(t.takerBuyFraction>0.7);
 assert.ok(k.threeMinuteBps>3);
 assert.equal(chooseMicrostructureDirection("DOWN",{
  orderBook:{...b,receivedAt:AT-200},
  aggressiveFlow:{...t,receivedAt:AT-200},
  indexKlines:{...k,receivedAt:AT-200}},AT).side,"UP");
});
test("no-flow or stale-flow never flips; neutral, one-vote, mixed votes and incomplete sources leave direction unchanged",()=>{
 const b=parseMicroOrderBook(book(),AT),t=parseMicroAggTrades(trades(),AT),k=parseMicroIndexKlines(indexBars(),AT);
 const all={
  orderBook:{...b,receivedAt:AT-200},
  aggressiveFlow:{...t,receivedAt:AT-200},
  indexKlines:{...k,receivedAt:AT-200}
 };
 assert.equal(chooseMicrostructureDirection("DOWN",{...all,aggressiveFlow:undefined},AT).changed,false);
 assert.equal(chooseMicrostructureDirection("DOWN",{...all,aggressiveFlow:{...t,receivedAt:AT-200,observedAt:AT-45000}},AT).changed,false);
 assert.equal(chooseMicrostructureDirection("DOWN",{aggressiveFlow:all.aggressiveFlow},AT).changed,false);
 assert.equal(chooseMicrostructureDirection("DOWN",{...all,indexKlines:{...all.indexKlines,vote:"DOWN"},orderBook:undefined},AT).changed,false);
 assert.equal(chooseMicrostructureDirection("UP",all,AT).changed,false);
 assert.equal(chooseMicrostructureDirection("DOWN",{...all,orderBook:{...all.orderBook,receivedAt:AT+1},indexKlines:undefined},AT).changed,false);
 assert.equal(chooseMicrostructureDirection("DOWN",all,AT).reason,"MICRO_CORRECTS_DIRECTION");
});
test("reject future, stale, malformed depth, aggregate trade and index candle data",()=>{
 assert.throws(()=>parseMicroOrderBook(book(5,1,AT+5000),AT),/STALE/);
 assert.throws(()=>parseMicroOrderBook(book(5,1,AT-13000),AT),/STALE/);
 assert.throws(()=>parseMicroOrderBook({...book(),asks:[]},AT),/TOO_FEW/);
 assert.throws(()=>parseMicroAggTrades(trades(0,0),AT),/TOO_FEW/);
 assert.throws(()=>parseMicroAggTrades(trades(48,12,AT-50000),AT),/TOO_FEW/);
 assert.throws(()=>parseMicroIndexKlines(indexBars().slice(0,2),AT),/TOO_FEW/);
 const corrupted=indexBars();corrupted[3][0]+=60000;corrupted[3][6]+=60000;
 assert.throws(()=>parseMicroIndexKlines(corrupted,AT),/GAP|TOO_FEW/);
});
test("optional source errors cannot block a signal; return accurate per-source availability",async()=>{
 let calls=[];
 const fetcher=async url=>{
  calls.push(url);
  if(url.includes("/depth"))return response(book());
  if(url.includes("/aggTrades"))return response(trades());
  if(url.includes("/indexPriceKlines"))return response(indexBars());
  throw Error("UNEXPECTED_MARKET_REQUEST");
 };
 const r=await collectOptionalMicrostructure({fetcher,now:()=>AT,timeoutMs:200});
 assert.deepEqual(MICRO_FEATURE_NAMES,["orderBook","aggressiveFlow","indexKlines"]);
 assert.equal(r.available,3);assert.equal(calls.length,3);
 assert.equal(chooseMicrostructureDirection("DOWN",r.features,AT).changed,true);
 const none=await collectOptionalMicrostructure({now:()=>AT,fetcher:async()=>{throw Error("network offline")},timeoutMs:100});
 assert.equal(none.available,0);
 assert.equal(none.availability.orderBook.available,false);
 assert.equal(chooseMicrostructureDirection("UP",none.features,AT).side,"UP");
});

test("V40 protected rebound resists two stale-noisy bearish votes, but unanimous fresh bearish sources may correct it",()=>{
 const at=AT;
 const buyFlow={...parseMicroAggTrades(trades(10,50),at),receivedAt:at};
 const shortDown={...parseMicroIndexKlines(indexBars(false),at),receivedAt:at};
 const upDepth={...parseMicroOrderBook(book(5,1),at),receivedAt:at};
 const mixed={aggressiveFlow:buyFlow,indexKlines:shortDown,orderBook:upDepth};
 assert.equal(buyFlow.vote,"DOWN");
 assert.equal(shortDown.vote,"DOWN");
 assert.equal(upDepth.vote,"UP");
 assert.equal(chooseMicrostructureDirection("UP",mixed,at).side,"DOWN");
 const guard=chooseMicrostructureDirection("UP",mixed,at,{requireUnanimousDown:true});
 assert.equal(guard.side,"UP");
 assert.equal(guard.changed,false);
 assert.equal(guard.reason,"MICRO_PROTECTED_BOUNCE_REQUIRES_THREE_BEARISH_SOURCES");
 const downDepth={...parseMicroOrderBook(book(1,5),at),receivedAt:at};
 const unanimous=chooseMicrostructureDirection("UP",{...mixed,orderBook:downDepth},at,
   {requireUnanimousDown:true});
 assert.equal(unanimous.side,"DOWN");
 assert.equal(unanimous.changed,true);
 assert.equal(chooseMicrostructureDirection("DOWN",mixed,at,{requireUnanimousDown:true}).side,"DOWN");
});
