import test from 'node:test';
import assert from 'node:assert/strict';
import {guardianOrderSignal,guardianQuoteGate,GUARDIAN_ID} from './guardian5-live-bridge.mjs';
const now=1793182500000+72000,round=Math.floor(now/300000)*300000;
const record={round,at:round+65000,marketAt:now-2000,status:'PREDICTED',predictedDirection:'UP',subjectiveConfidence:.94};
const good={ok:true,model:GUARDIAN_ID,orders:false,readOnly:true,configured:true,observedAt:now-1000,
 latest:{direction:'UP',round,status:'SHADOW_OBSERVATION'},records:[record],
 stats:{settled:500,validated:true,wilsonLower:.75},officialPriceFeedVerified:true};
test('GUARDIAN shadow observation appears as non-executable signal when unverified',()=>{
 const p={...good,officialPriceFeedVerified:false};
 const r=guardianOrderSignal(p,now);assert.equal(r.ok,true);assert.equal(r.executionEligible,false);assert.equal(r.modelProbability,null);
});
test('GUARDIAN blocks stale, cross-round or missing records',()=>{
 assert.equal(guardianOrderSignal({...good,observedAt:now-20000},now).ok,false);
 assert.equal(guardianOrderSignal({...good,records:[]},now).ok,false);
 assert.equal(guardianOrderSignal({...good,latest:{...good.latest,round:round-300000}},now).ok,false);
});
test('GUARDIAN requires independently verified forward accuracy and reference',()=>{
 const r=guardianOrderSignal({...good,stats:{settled:40,validated:false,wilsonLower:.98}},now);
 assert.equal(r.executionEligible,false);
});
test('GUARDIAN checks actual quote cost rather than AI subjective confidence',()=>{
 const r=guardianOrderSignal(good,now);
 assert.equal(r.executionEligible,true);
 assert.equal(guardianQuoteGate(r,{quoteId:'q',chance:.60},{now}).ok,true);
 assert.equal(guardianQuoteGate(r,{quoteId:'q',chance:.73},{now}).ok,false);
 assert.equal(guardianQuoteGate(r,{chance:.25},{now}).ok,false);
 assert.equal(guardianQuoteGate({...r,executionEligible:false},{quoteId:'q',chance:.1},{now}).ok,false);
});
