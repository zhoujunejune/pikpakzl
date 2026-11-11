import test from 'node:test';
import assert from 'node:assert/strict';
import {ingestTrade,summarizeTrades,bookSummary,shouldAnalyze,shouldRefreshClosedCandles,shouldScoutOpportunities} from './market-signals.mjs';
const NOW=Date.parse('2026-11-11T11:00:00Z');
test('1s aggregation and price windows preserve bounded buys/sells',()=>{
 const buckets=[];
 assert.equal(ingestTrade(buckets,{price:100,qty:2,time:NOW-5000,buyerMaker:false},NOW),true);
 assert.equal(ingestTrade(buckets,{price:100.5,qty:1,time:NOW-4500,buyerMaker:true},NOW),true);
 assert.equal(ingestTrade(buckets,{price:101,qty:2,time:NOW-1000,buyerMaker:false},NOW),true);
 const s=summarizeTrades(buckets,NOW);
 assert.equal(s.w10.tradeEvents,3);
 assert.ok(s.w10.changePct>.9);
 assert.ok(s.w10.buyRatio>.7);
 assert.equal(s.w30.tradeEvents,3);
 assert.equal(s.w60.tradeEvents,3);
 assert.equal(ingestTrade(buckets,{price:101,qty:1,time:NOW-180000,buyerMaker:false},NOW),false);
});
test('no stale/malformed book or trade data accepted',()=>{
 const b=[];
 assert.equal(ingestTrade(b,{price:0,qty:1,time:NOW,buyerMaker:false},NOW),false);
 assert.equal(bookSummary({bid:100,ask:101,bidQty:4,askQty:1,at:NOW},NOW).bidQtyRatio,.8);
 assert.equal(bookSummary({bid:100,ask:99,bidQty:4,askQty:1,at:NOW},NOW),null);
 assert.equal(bookSummary({bid:100,ask:101,bidQty:4,askQty:1,at:NOW-10000},NOW),null);
});
test('event-triggered AI analysis is paced and prioritizes open positions',()=>{
 const common={now:NOW,enabled:true,lastAt:NOW-11000};
 assert.equal(shouldAnalyze({...common,holding:false,change10sPct:1}),false);
 assert.equal(shouldAnalyze({...common,holding:true,change10sPct:.15}),true);
 assert.equal(shouldAnalyze({...common,holding:false,lastAt:NOW-13000,change10sPct:.3}),true);
 assert.equal(shouldAnalyze({...common,holding:true,lastAt:NOW-16000,change10sPct:0}),true);
 assert.equal(shouldAnalyze({...common,holding:false,lastAt:NOW-25000,change10sPct:0}),true);
 assert.equal(shouldAnalyze({...common,enabled:false,lastAt:0}),false);
});


test('closed candle cache refreshes near minute and five-minute boundaries without runaway retries',()=>{
 const now=Date.parse('2026-11-11T11:02:08Z');
 const data={savedAt:now-5000,one:[{startMs:Date.parse('2026-11-11T11:00:00Z')}],
   five:[{startMs:Date.parse('2026-11-11T10:55:00Z')}]};
 assert.equal(shouldRefreshClosedCandles(data,now),true);
 const justFetched={...data,savedAt:now-1000};
 assert.equal(shouldRefreshClosedCandles(justFetched,now),false);
 const upToDate={savedAt:now-4000,one:[{startMs:Date.parse('2026-11-11T11:01:00Z')}],
   five:[{startMs:Date.parse('2026-11-11T11:00:00Z')}]};
 assert.equal(shouldRefreshClosedCandles(upToDate,now),false);
 assert.equal(shouldRefreshClosedCandles({...upToDate,savedAt:now-16000},now),true);
 assert.equal(shouldRefreshClosedCandles(null,now),true);
});
test('a scout can only reconsider a sustained all-WAIT scan, never replace held-position decisions',()=>{
 const idle=[{action:'WAIT',symbol:'BTCUSDT'},{action:'WAIT',symbol:'ETHUSDT'}];
 assert.equal(shouldScoutOpportunities({decisions:idle,waitStreak:2}),false);
 assert.equal(shouldScoutOpportunities({decisions:idle,waitStreak:3}),true);
 assert.equal(shouldScoutOpportunities({decisions:idle,waitStreak:4}),false);
 assert.equal(shouldScoutOpportunities({decisions:idle,waitStreak:6,heldCount:1}),false);
 assert.equal(shouldScoutOpportunities({decisions:[{action:'LONG'}],waitStreak:3}),false);
 assert.equal(shouldScoutOpportunities({decisions:idle,waitStreak:3,enabled:false}),false);
});
