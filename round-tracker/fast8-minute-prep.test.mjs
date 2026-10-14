import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createNextRoundPreparation,PREP_WINDOW_MS,NEXT_ROUND_PREP_VERSION} from './fast8-minute-prep.mjs';
import {createFast8Engine} from './fast8-engine.mjs';
import {externalResearchDirections,EXTERNAL_RESEARCH_VERSION} from './external-btc5m-fast8-shadow.mjs';
import {LOCK_MS,ROUND_MS,CUTOFF_MS} from './fast8-model.mjs';
import {marketRoundClock,minuteOpenAligned} from '../fast-signal-engine/market-round-clock.mjs';
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
   issues:['DEPTH_MISSING_OR_STALE','TRADES_MISSING_OR_STALE'],features:spot}),false);
 // At >=500ms a fresh degraded sample is recorded, never merged into the
 // previous genuine good-depth observation.
 assert.equal(prep.observe({roundStartMs:PREV,sourceAt:x+600,receivedAt:x+630,
   issues:['DEPTH_MISSING_OR_STALE','TRADES_MISSING_OR_STALE'],features:spot}),true);
 const prepared=prep.preparedFor(R);
 assert.equal(prepared.ready,false);
 assert.equal(prepared.sampleCount,2);
 assert.equal('ofiNormalized5s' in prepared.featureSamples,false);
 assert.equal('tradePressure60s' in prepared.featureSamples,false);
 assert.equal('tradePressure15s' in prepared.featureSamples,false);
 assert.equal(prepared.featureSamples.microScore,1);
});
test('previous-minute score is unchanged by OFI and 60s trade-pressure values',()=>{
 const preview=(ofi,flow)=>{
  const prep=createNextRoundPreparation();
  for(let at=R-58000;at<=R-1000;at+=1000){
   prep.observe({roundStartMs:PREV,sourceAt:at,receivedAt:at+25,
    features:{...goodSpot(1),ofiNormalized5s:ofi,tradePressure60s:flow}});
  }
  return prep.preparedFor(R);
 };
 const x=preview(1,1),y=preview(-1,-1);
 assert.equal(x.ready,true);assert.equal(y.ready,true);
 assert.equal(x.previewScore,y.previewScore);
 assert.equal('ofiNormalized5s' in y.avgFeatures,false);
 assert.equal('tradePressure60s' in y.avgFeatures,false);
});
test('previous minute preview ignores 15s trade pressure as well as removed OFI/60s pressure',()=>{
 const preview=(pressure)=>{
  const prep=createNextRoundPreparation();
  for(let at=R-58000;at<=R-1000;at+=1000){
   prep.observe({roundStartMs:PREV,sourceAt:at,receivedAt:at+25,
    features:{...goodSpot(1),tradePressure15s:pressure}});
  }
  return prep.preparedFor(R);
 };
 const a=preview(1),b=preview(-1);
 assert.equal(a.ready,true);assert.equal(b.ready,true);
 assert.equal(a.previewScore,b.previewScore);
 assert.equal(a.directionPreview,b.directionPreview);
 assert.equal('tradePressure15s' in b.avgFeatures,false);
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
 assert.equal(journal.features.currentScore,null);
 assert.equal(journal.features.currentTrendScore,null);
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
 prewarm(f,1,{endAt:R-4000});
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

test('200ms real market polling builds many INDEPENDENT snapshots over 60s',()=>{
 const prep=createNextRoundPreparation();
 let polls=0,accepted=0;
 for(let t=R-59500;t<=R-100;t+=200){
  polls++;
  if(prep.observe({roundStartMs:PREV,sourceAt:t,receivedAt:t+40,
    features:goodSpot(1)}))accepted++;
 }
 const snapshot=prep.preparedFor(R);
 assert.ok(polls>=290);
 assert.ok(accepted>=90&&accepted<=120,'should retain 100ish not one');
 assert.equal(snapshot.sampleCount,accepted);
 assert.ok(snapshot.spanMs>=55000);
 assert.ok(snapshot.lastAgeMs<=1500);
 assert.equal(snapshot.ready,true);
 assert.equal(snapshot.predictionMarketContractIncluded,false);
 assert.ok(['UP','DOWN'].includes(snapshot.directionPreview));
});


test('fresh spot from a delayed upstream round label is bridged without old PM or open scores',t=>{
 const f=fx(t);
 prewarm(f,-1);
 f.time(R+800);
 const freshSpot={...sample(1),depthAgeMs:80,lastAggTradeAgeMs:60,
   currentScore:-1,currentTrendScore:-1,liveScore:-1,
   distanceFromOpenBps:-100,predictionMarketUpMid:0.01,
   predictionMarketRound:PREV,predictionMarketUpdateTimestampMs:R-1000};
 assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R+700,facts:freshSpot},R+750),true);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 const prediction=d.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(d.maxEventTimeMs,R+700);
 assert.equal(d.inputProvenance,'FRESH_SPOT_PRIOR_ROUND_METADATA');
 assert.ok(d.dataQuality.includes('CROSS_ROUND_FRESH_SPOT_BRIDGE'));
 assert.equal(d.externalResearch.fullQuality,false);
 assert.equal(prediction.preparationUsed,true);
 assert.equal(prediction.evidence,'DEGRADED_MICROSTRUCTURE_INPUT');
 const events=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const features=events.find(e=>e.type==='decision'&&e.roundStartMs===R).features;
 for(const key of ['predictionMarketUpMid','distanceFromOpenBps',
   'currentScore','currentTrendScore','liveScore'])assert.equal(features[key],null);
});
test('a delayed old round without any post-boundary depth or trades cannot fabricate fresh input',t=>{
 const f=fx(t);
 prewarm(f,-1);
 f.time(R+1000);
 const stale={...sample(1),depthAgeMs:1600,lastAggTradeAgeMs:2600};
 assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R+850,facts:stale},R+900),false);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 assert.notEqual(d.inputProvenance,'FRESH_SPOT_PRIOR_ROUND_METADATA');
 assert.ok(d.maxEventTimeMs===null || d.maxEventTimeMs<R);
});
test('aligned current-round facts replace a bridge; a later delayed label cannot overwrite them',t=>{
 const f=fx(t);
 f.time(R+550);
 assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R+450,
   facts:{...sample(-1),depthAgeMs:70,lastAggTradeAgeMs:70}},R+500),true);
 f.time(R+1020);
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+900,
   facts:{...sample(1),predictionMarketRound:R,
     predictionMarketUpdateTimestampMs:R+820}},R+1000),true);
 f.time(R+1320);
 assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R+1150,
   facts:{...sample(-1),depthAgeMs:90,lastAggTradeAgeMs:90}},R+1200),true);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 assert.equal(d.inputProvenance,'ALIGNED_CURRENT_ROUND');
 assert.equal(d.maxEventTimeMs,R+900);
 assert.equal(d.externalResearch.fullQuality,true);
 assert.ok(!d.dataQuality.includes('CROSS_ROUND_FRESH_SPOT_BRIDGE'));
});

test('UTC 5m event clock advances while previous kline open is still pending',()=>{
 const old=R-ROUND_MS;
 const before=marketRoundClock(R-1,old);
 assert.equal(before.start,old);
 assert.equal(before.roundOpenAligned,true);
 const crossed=marketRoundClock(R+200,old);
 assert.equal(crossed.start,R);
 assert.equal(crossed.end,R+ROUND_MS-1);
 assert.equal(crossed.roundOpenAligned,false);
 assert.equal(marketRoundClock(R+1200,R).roundOpenAligned,true);
 assert.equal(minuteOpenAligned(R+300,R-60000),false);
 assert.equal(minuteOpenAligned(R+300,R),true);
});
test('aligned market round retains safe micro/trend while refusing previous 5m opening price',t=>{
 const f=fx(t);
 prewarm(f,-1);
 f.time(R+1040);
 const facts={...sample(1),roundOpenAligned:false,
   distanceFromOpenBps:99,
   predictionMarketRound:PREV,predictionMarketUpdateTimestampMs:R-100};
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+940,facts},R+1000),true);
 f.time(R+LOCK_MS+10);
 const d=f.engine.tick();
 assert.equal(d.inputProvenance,'ALIGNED_CURRENT_ROUND');
 assert.ok(d.dataQuality.includes('CURRENT_ROUND_OPEN_NOT_YET_ALIGNED'));
 const events=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const captured=events.find(e=>e.type==='decision'&&e.roundStartMs===R).features;
 assert.equal(captured.distanceFromOpenBps,null);
 assert.equal(captured.currentTrendScore,facts.currentTrendScore);
 assert.equal(captured.currentScore,facts.currentScore);
 assert.equal(captured.predictionMarketUpMid,null);
});
test('4s and 6s snapshots are durable shadow-only comparisons; cannot edit 1.8s production direction',t=>{
 const f=fx(t);
 prewarm(f,-1);
 f.time(R+1000);
 const early={...sample(-1),roundOpenAligned:false,
   predictionMarketRound:PREV,predictionMarketUpdateTimestampMs:R-100};
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+920,facts:early},R+970),true);
 f.time(R+LOCK_MS+20);
 const frozen=f.engine.tick();
 assert.equal(frozen.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
 f.time(R+LOCK_MS+45);
 assert.equal(f.engine.acknowledge(R,R+LOCK_MS+40),true);
 const later={...sample(1),roundOpenAligned:true,
   predictionMarketRound:R,predictionMarketUpMid:.90,
   predictionMarketUpdateTimestampMs:R+3850,
   ofiNormalized5s:1,tradePressure15s:1,tradePressure60s:1,
   microScore:1,currentScore:1,currentTrendScore:1,regimeScore:1,
   normalizedMomentum60s:1};
 f.time(R+4120);
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+4000,facts:later},R+4070),true);
 later.predictionMarketUpdateTimestampMs=R+5850;
 f.time(R+6130);
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+6020,facts:later},R+6070),true);
 assert.equal(f.engine.tick().externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
 f.time(R+8000);
 assert.equal(f.engine.capture({round:R,factsCalculatedAt:R+7900,facts:later},R+7950),true);
 const journal=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const shadows=journal.filter(e=>e.type==='checkpoint'&&e.roundStartMs===R);
 assert.deepEqual(shadows.map(e=>e.checkpointMs),[4000,6000]);
 assert.deepEqual(shadows.map(e=>e.direction),['UP','UP']);
 assert.ok(shadows.every(e=>e.productionEffect==='TIMING_SHADOW_ONLY'&&!e.executionEligible));
 assert.equal(journal.filter(e=>e.type==='decision'&&e.roundStartMs===R).length,1);
 f.time(R+ROUND_MS+150);
 assert.equal(f.engine.settle({roundStartMs:R,actual:'UP',
   actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
   resolutionEvidence:'OFFICIAL_UP:STRICT_ROUND_ALIGNED_TOPIC',
   settledAt:R+ROUND_MS+100}),true);
 const timing=f.engine.stats().externalResearch.timingShadowComparison;
 assert.equal(timing['4000'].accuracy,1);
 assert.equal(timing['6000'].accuracy,1);
 assert.equal(timing['4000'].matchedEarlyAccuracy,0);
 assert.equal(f.published.length,1);
});
