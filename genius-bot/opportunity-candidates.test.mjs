import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveOpportunityCandidates} from './opportunity-candidates.mjs';
const now=Date.parse('2026-11-12T01:00:00Z');
const market=(symbol='BTCUSDT',trend1m='DOWN',trend5m='UP')=>({
  symbol,trend1m,trend5m,checkedAt:now,markPrice:75000
});
const frames={complete:true,frames:{
  '15m':{bias:'UP',rsi14:82},'1h':{bias:'MIXED'},
  '4h':{bias:'DOWN'},'1d':{bias:'DOWN'},'1w':{bias:'MIXED'}
}};
const flow=(ratio,change,events=120)=>({trades:{w30:{
  buyRatio:ratio,changePct:change,tradeEvents:events,ageMs:300}}});
test('overbought pullback supported by actual negative order flow creates REVIEW candidate',()=>{
 const x=deriveOpportunityCandidates([market()],{BTCUSDT:flow(.2,-.08)},
    {BTCUSDT:frames},now);
 assert.equal(x.length,1);
 assert.equal(x[0].action,'SHORT');
 assert.equal(x[0].signalType,'OVERBOUGHT_REVERSAL');
 assert.match(x[0].origin,/REQUIRES_AI_APPROVAL/);
});
test('bearish daily trend does not veto confirmed positive short-timeframe momentum',()=>{
 const x=deriveOpportunityCandidates([market('ETHUSDT','UP','UP')],
   {ETHUSDT:flow(.82,.15)},{ETHUSDT:frames},now);
 assert.equal(x[0].action,'LONG');
 assert.equal(x[0].signalType,'SHORT_MOMENTUM');
});
test('no fabricated signals from thin data, stale candles, RSI alone or trade flow disagreement',()=>{
 assert.deepEqual(deriveOpportunityCandidates([market()],{BTCUSDT:flow(.75,.04)},{BTCUSDT:frames},now),[]);
 assert.deepEqual(deriveOpportunityCandidates([market()],{BTCUSDT:flow(.2,-.08,3)},{BTCUSDT:frames},now),[]);
 assert.deepEqual(deriveOpportunityCandidates([{...market(),checkedAt:now-15000}],
   {BTCUSDT:flow(.2,-.08)},{BTCUSDT:frames},now),[]);
 assert.deepEqual(deriveOpportunityCandidates([market()],{BTCUSDT:flow(.2,-.08)},
   {BTCUSDT:{...frames,complete:false}},now),[]);
 assert.deepEqual(deriveOpportunityCandidates([market()],{BTCUSDT:{trades:{w30:{...flow(.2,-.08).trades.w30,ageMs:9000}}}},
   {BTCUSDT:frames},now),[]);
});
test('multiple candidate symbols sorted by observable flow strength, not arbitrary win probability',()=>{
 const x=deriveOpportunityCandidates([market('BTCUSDT','DOWN','UP'),
   market('SOLUSDT','UP','UP')],{BTCUSDT:flow(.25,-.08),SOLUSDT:flow(.85,.17)},
   {BTCUSDT:frames,SOLUSDT:frames},now);
 assert.equal(x.length,2);
 assert.equal(x[0].symbol,'SOLUSDT');
 assert.ok(x[0].evidenceStrength>x[1].evidenceStrength);
});
