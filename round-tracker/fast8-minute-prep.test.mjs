import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createNextRoundPreparation,PREP_WINDOW_MS,NEXT_ROUND_PREP_VERSION} from './fast8-minute-prep.mjs';
import {createFast8Engine} from './fast8-engine.mjs';
import {externalResearchDirections,EXTERNAL_RESEARCH_VERSION} from './external-btc5m-fast8-shadow.mjs';
import {LOCK_MS,ROUND_MS,CUTOFF_MS} from './fast8-model.mjs';
const R=1791800100000;
const PREV=R-ROUND_MS;
const goodSpot=(sign=1)=>({
 currentScore:.3*sign,currentTrendScore:.3*sign,microScore:.4*sign,
 regimeScore:.2*sign,normalizedMomentum60s:.4*sign,
 ofiNormalized5s:.9*sign,tradePressure15s:.8*sign,tradePressure60s:.7*sign,
 predictionMarketUpMid:sign>0?.99:.01,distanceFromOpenBps:23*sign
});
function sample(sign=1){
 return {...goodSpot(sign),depthAgeMs:100,lastAggTradeAgeMs:100,
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketRound:PREV,predictionMarketBookAgeMs:150,
  predictionMarketUpdateTimestampMs:R-1000};
}
function fx(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fast8-prep60-'));
 let now=PREV+ROUND_MS-PREP_WINDOW_MS;
 const published=[];
 const engine=createFast8Engine({dir,clock:()=>now,publish:d=>published.push(d)});
 assert.equal(engine.load(),true);
 t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true})});
 return {dir,published,engine,time:v=>{now=v}};
}
function prewarm(f,sign=1,{firstAt=R-59000,endAt=R-1000,interval=1000}={}){
 let accepted=0;
 for(let t=firstAt;t<=endAt;t+=interval){
  f.time(t+20);
  const facts=sample(sign);
  facts.predictionMarketUpdateTimestampMs=t-30;
  if(f.engine.capture({round:PREV,factsCalculatedAt:t-30,facts},t+10))accepted++;
 }
 return accepted;
}
test('prep opens only in previous round final 60 seconds and never copies contract fields',()=>{
 const prep=createNextRoundPreparation();
 const early={roundStartMs:PREV,sourceAt:R-60001,receivedAt:R-60000,features:goodSpot()};
 assert.equal(prep.observe(early),false);
 for(let at=R-58000;at<=R-1000;at+=1000){
  assert.equal(prep.observe({roundStartMs:PREV,sourceAt:at,receivedAt:at+25,
   features:goodSpot(-1)}),true);
 }
 const x=prep.preparedFor(R);
 assert.equal(x.version,NEXT_ROUND_PREP_VERSION);
 assert.equal(x.ready,true);
 assert.equal(x.sampleCount,58);
 assert.equal(x.directionPreview,'DOWN');
 assert.ok(x.spanMs>=50000);
 assert.equal(x.lastAgeMs,1000);
 assert.equal(x.predictionMarketContractIncluded,false);
 assert.equal('predictionMarketUpMid' in x.avgFeatures,false);
 assert.equal('distanceFromOpenBps' in x.avgFeatures,false);
 assert.equal(x.executionEligible,false);
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:R+10,
   receivedAt:R+20,features:goodSpot(-1)}),false);
});
test('poll duplicates, late arrivals, poor depth and future source cannot fabricate a ready preview',()=>{
 const prep=createNextRoundPreparation();
 const x=R-2000, spot=goodSpot(1);
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:x,receivedAt:x+100,features:spot}),true);
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:x,receivedAt:x+120,features:spot}),false);
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:x+60,receivedAt:x+2050,features:spot}),false);
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:x+100,receivedAt:x+130,
   issues:['DEPTH_MISSING_OR_STALE','TRADES_MISSING_OR_STALE'],features:spot}),true);
 const prepared=prep.preparedFor(R);
 assert.equal(prepared.ready,false);
 assert.equal(prepared.sampleCount,1); // <500ms replaces latest, no duplicate inflation
 assert.equal(prepared.avgFeatures.ofiNormalized5s,null);
 assert.equal(prepared.avgFeatures.tradePressure15s,null);
});
test('upcoming model receives a real ready prep one minute ahead, not prior-round PM',t=>{
 const f=fx(t);
 assert.ok(prewarm(f,-1)>=50);
 f.time(R-150);
 let before=f.engine.stats().nextRoundPreparation;
 assert.equal(before.ready,true);
 assert.equal(before.directionPreview,'DOWN');
 assert.equal(before.predictionMarketContractIncluded,false);
 // No on-round snapshot: use only causal pre-round spot context.
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 assert.equal(d.externalResearch.version,EXTERNAL_RESEARCH_VERSION);
 assert.equal(d.externalResearch.preparation.ready,true);
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparationUsed,true);
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparationOnly,false);
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
 assert.equal(d.maxEventTimeMs<R,true);
 assert.ok(d.dataQuality.includes('PREVIOUS_CONTRACT_AND_ROUND_OPEN_EXCLUDED'));
 assert.ok(d.externalResearch.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
 assert.equal(d.externalResearch.preparation.predictionMarketContractIncluded,false);
 const events=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const journal=events.find(e=>e.type==='decision'&&e.roundStartMs===R);
 assert.equal(journal.features.predictionMarketUpMid,null);
 assert.equal(journal.features.distanceFromOpenBps,null);
 assert.equal(journal.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparedSampleCount>=40,true);
 assert.equal(f.published.length,1);
 f.time(R+LOCK_MS+60);assert.equal(f.engine.acknowledge(R,R+LOCK_MS+40),true);
 assert.equal(f.engine.stats().onTimeCoverage,null); // currently not a completed round
});
test('fresh current-round snapshot confirms (or contradicts) prior-minute preview',t=>{
 const f=fx(t);
 prewarm(f,-1);
 const fresh={...sample(1),ofiNormalized5s:1,tradePressure15s:1,
  tradePressure60s:1,microScore:1,currentScore:1,currentTrendScore:1,
  regimeScore:1,normalizedMomentum60s:1,
  predictionMarketRound:R,predictionMarketUpMid:0.80,
  predictionMarketUpdateTimestampMs:R+850};
 f.time(R+1100);
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+950,facts:fresh},R+1020),true);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 const q=d.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(q.preparationUsed,true);
 assert.equal(q.preWeight,.30);
 assert.equal(q.preparedDirection,'DOWN');
 assert.equal(q.direction,'UP'); // strong current flow wins, not rigid old direction
 assert.equal(q.fallback,false);
 assert.equal(d.maxEventTimeMs,R+950);
 assert.equal(d.externalResearch.reusedPreRound,false);
 assert.equal(d.externalResearch.fullQuality,true);
 assert.equal(f.published.length,1);
 f.time(R+7900);assert.equal(f.engine.tick().externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
 assert.equal(f.published.length,1);
});
test('no current snapshot but a full prepared minute still yields a tagged binary direction',t=>{
 const f=fx(t);
 prewarm(f,1,{endAt:R-3100});
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 const q=d.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
 assert.ok(['UP','DOWN'].includes(q.direction));
 assert.equal(q.preparationUsed,true);
 assert.equal(q.preparationOnly,true);
 assert.equal(q.evidence,'PREPARED_60S_CONTEXT_ONLY');
 assert.equal(d.externalResearch.fullQuality,false);
 assert.deepEqual(d.dataQuality,['NO_FRESH_SNAPSHOT']);
});
test('not enough 60s history never pretends prepared or changes the prior fallback',t=>{
 const f=fx(t);
 f.time(R-500);
 const facts=sample(-1);
 assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R-530,facts},R-520),true);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 assert.equal(d.externalResearch.preparation.ready,false);
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparationUsed,false);
 assert.ok(['UP','DOWN'].includes(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction));
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparedSampleCount,0);
});
