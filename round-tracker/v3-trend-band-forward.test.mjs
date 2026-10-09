import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeV3TrendBand,summarizeV3TrendBand,VERSION} from './v3-trend-band-forward.mjs';
const start=Date.parse('2026-10-09T06:00:00Z');
const row=()=>({roundStartMs:start});
const facts=(direction='UP',score=0.52)=>({v3TrendBandShadow:{
 round:start,direction,observedAt:start+15500,score,threshold:0.6,
 eligible:true,frozen:true,productionEffect:'NONE_SHADOW_ONLY'
}});
const resolved=f=>({...row(),v3TrendBandForward:f,
 actual:'UP',officialDirection:'UP',
 resolutionEvidence:'OFFICIAL_UP:variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
 productionPrediction:null});
test('accept first eligible subthreshold candidate only before settlement',()=>{
 const f=freezeV3TrendBand(row(),facts(),start+17000);
 assert.equal(f.version,VERSION);
 assert.equal(f.score,0.52);
 assert.equal(f.direction,'UP');
 assert.equal(f.productionEffect,'NONE_SHADOW_ONLY');
 assert.equal(f.sourceObservedAt,start+15500);
});
test('reject late, round mismatch, fabricated signal and out of band score',()=>{
 assert.equal(freezeV3TrendBand(row(),facts(),start+15000),null);
 assert.equal(freezeV3TrendBand(row(),facts(),start+300001),null);
 assert.equal(freezeV3TrendBand(row(),{v3TrendBandShadow:{...facts().v3TrendBandShadow,round:start+300000}},start+17000),null);
 assert.equal(freezeV3TrendBand(row(),facts('UP',0.62),start+17000),null);
 assert.equal(freezeV3TrendBand(row(),facts('DOWN',0.52),start+17000),null);
 assert.equal(freezeV3TrendBand(row(),{v3TrendBandShadow:{...facts().v3TrendBandShadow,productionEffect:'LIVE'}},start+17000),null);
});
test('settled strict-forward accepts immutable upstream snapshot despite later V3 base lock',()=>{
 const frozen=freezeV3TrendBand(row(),facts(),start+17000);
 const r={...resolved(frozen),prediction:'UP',predictedAt:start+19500};
 const s=summarizeV3TrendBand(new Map([[start,r]]));
 assert.equal(s.eligible.samples,1);
 assert.equal(s.eligible.hits,1);
 assert.equal(s.incrementalOverProduction.samples,1);
 assert.equal(s.autoProduction,false);
 assert.equal(s.status,'COLLECTING');
});
test('refuse fake settlement, outcome mismatch or snapshot recorded after round',()=>{
 const f=freezeV3TrendBand(row(),facts(),start+17000);
 const r=resolved(f);
 r.resolutionEvidence='BACKTEST_UP';
 assert.equal(summarizeV3TrendBand(new Map([[start,r]])).eligible.samples,0);
 r.resolutionEvidence='OFFICIAL_UP:STRICT_ROUND_ALIGNED_TOPIC';
 r.officialDirection='DOWN';
 assert.equal(summarizeV3TrendBand(new Map([[start,r]])).eligible.samples,0);
 r.officialDirection='UP';
 r.v3TrendBandForward={...f,recordedAt:start+300001};
 assert.equal(summarizeV3TrendBand(new Map([[start,r]])).eligible.samples,0);
});
