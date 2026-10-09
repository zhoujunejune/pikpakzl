import test from 'node:test';
import assert from 'node:assert/strict';
import {VERSION,freezeLockTimingSnapshot,summarizeLockTimingForward} from './lock-timing-forward.mjs';
const start=Date.parse('2026-10-09T10:30:00.000Z');
const facts={currentScore:0.72,currentTrendScore:0.81,liveScore:0.52,
 distanceFromOpenBps:1.5,predictionMarketUpMid:0.65,predictionMarketBookAgeMs:200,
 predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
 depthAgeMs:250,lastAggTradeAgeMs:200,tradeCount15s:24,tradeStreamStalled:false,
 absorptionRisk:false,regimeDirection:'UP',regimeAgreement:1};
const row=()=>({roundStartMs:start,prediction:'WAIT',predictedAt:null});
const live=(now,f=facts)=>({round:start,status:'WAIT',generatedAt:now-100,facts:f});
const official=(r,actual='UP')=>({...r,actual,officialDirection:actual,
  resolutionEvidence:'OFFICIAL_'+actual+':variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
  productionPrediction:null});
test('12s freeze is first observed, shadow-only and independent of production',()=>{
 const t=freezeLockTimingSnapshot(row(),live(start+12400),start+12400);
 assert.equal(t.window,'t12'); assert.equal(t.snapshot.decision,'UP');
 assert.equal(t.snapshot.productionEffect,'NONE_SHADOW_ONLY');
 assert.equal(freezeLockTimingSnapshot({...row(),lockTimingForward:{t12:t.snapshot}},live(start+13000),start+13000),null);
});
test('window limits and stale data are strictly rejected',()=>{
 assert.equal(freezeLockTimingSnapshot(row(),live(start+11999),start+11999),null);
 assert.equal(freezeLockTimingSnapshot(row(),live(start+14500),start+14500),null);
 assert.equal(freezeLockTimingSnapshot(row(),live(start+17500),start+17500),null);
 const stale=freezeLockTimingSnapshot(row(),live(start+15300,{...facts,depthAgeMs:null}),start+15300);
 assert.equal(stale.window,'t15'); assert.equal(stale.snapshot.decision,'WAIT');
 assert.ok(stale.snapshot.reasons.includes('STALE_DEPTH'));
 const late=freezeLockTimingSnapshot(row(),live(start+12000),start+15000);
 assert.equal(late.snapshot.decision,'WAIT');assert.ok(late.snapshot.reasons.includes('STALE_OR_FUTURE_SOURCE'));
});
test('source cannot be future and already-locked base is not claimed as incremental early signal',()=>{
 const future=freezeLockTimingSnapshot(row(),live(start+14000),start+12300);
 assert.equal(future.snapshot.decision,'WAIT');
 const locked=freezeLockTimingSnapshot({...row(),prediction:'UP',predictedAt:start+11700},
   { ...live(start+15300),status:'LOCKED' },start+15300);
 assert.equal(locked.snapshot.decision,'WAIT');
 assert.ok(locked.snapshot.reasons.includes('V3_ALREADY_LOCKED'));
});
test('official strict-forward settlement counts only prospective frozen predictions even if base locks later',()=>{
 const f12=freezeLockTimingSnapshot(row(),live(start+12300),start+12300).snapshot;
 const f15=freezeLockTimingSnapshot(row(),live(start+15500),start+15500).snapshot;
 const r=official({...row(),prediction:'UP',predictedAt:start+19000,
   lockTimingForward:{t12:f12,t15:f15}});
 const s=summarizeLockTimingForward(new Map([[start,r]]));
 assert.equal(s.early12.samples,1);assert.equal(s.early15.samples,1);
 assert.equal(s.priority12Then15.samples,1);assert.equal(s.priority12Then15.hits,1);
 assert.equal(s.priority12Then15.incrementalOverProduction.hits,1);
 assert.equal(s.priority12Then15.rawV3LockedLater,1);
 assert.equal(s.autoProduction,false);
});
test('do not count late-created, wrongly attributed or nonofficial snapshots',()=>{
 const x=freezeLockTimingSnapshot(row(),live(start+12300),start+12300).snapshot;
 const r=official({...row(),lockTimingForward:{t12:x}});
 assert.equal(summarizeLockTimingForward(new Map([[start,{...r,resolutionEvidence:'MANUAL_UP'}]])).early12.samples,0);
 assert.equal(summarizeLockTimingForward(new Map([[start,{...r,lockTimingForward:{t12:{...x,sourceAt:start+14000}}]])).early12.samples,0);
 assert.equal(summarizeLockTimingForward(new Map([[start,{...r,lockTimingForward:{t12:{...x,observedAt:start+301000}}]])).early12.samples,0);
});
test('no-side and opposing market signal remain WAIT',()=>{
 const neutral=freezeLockTimingSnapshot(row(),live(start+12500,{...facts,distanceFromOpenBps:0}),start+12500);
 assert.equal(neutral.snapshot.decision,'WAIT');
 const conflict=freezeLockTimingSnapshot(row(),live(start+12500,{...facts,predictionMarketUpMid:0.32}),start+12500);
 assert.equal(conflict.snapshot.decision,'WAIT');
});