import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFast8Engine} from './fast8-engine.mjs';
import {ROUND_MS} from './fast8-model.mjs';
import {EXTERNAL_RESEARCH_IDS,EXTERNAL_RESEARCH_VERSION,
  externalResearchDirections} from './external-btc5m-fast8-shadow.mjs';

const ROUND=1791800100000; // exact five-minute boundary
const fields={
  currentScore:0.65,currentTrendScore:0.7,microScore:0.2,regimeScore:0.6,
  normalizedMomentum5s:0.1,normalizedMomentum15s:0.2,
  normalizedMomentum60s:0.55,normalizedMomentum180s:0.4,
  normalizedMomentum300s:0.3,tradePressure15s:0.5,
  tradePressure60s:0.55,ofiNormalized5s:0.6,
  distanceFromOpenBps:3,rangePosition180:0.65,
  predictionMarketUpMid:0.57,liveScore:0.5,spreadBps:0.7,
};
const quality={baselineDirection:'DOWN',snapshotAvailable:true,
  dataQuality:[],sourceAt:ROUND+1000};
function fx(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'external-btc-fast8-'));
  let now=ROUND-1500;
  let engine=createFast8Engine({dir,clock:()=>now});
  assert.equal(engine.load(),true);
  t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true})});
  return {dir,time(x){now=x},get engine(){return engine},reload(){
    engine.close();engine=createFast8Engine({dir,clock:()=>now});
    return engine.load();
  }};
}
function observe(f,round=ROUND,facts=fields) {
  f.time(round+1050);
  const ok=f.engine.capture({round,factsCalculatedAt:round+1000,facts:{
    ...facts,depthAgeMs:50,lastAggTradeAgeMs:50,
    predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
    predictionMarketRound:round,predictionMarketBookAgeMs:150,
    predictionMarketUpdateTimestampMs:round+990
  }},round+1030);
  assert.equal(ok,true);
  f.time(round+2020);
  const frozen=f.engine.tick();
  f.time(round+2060);
  assert.equal(f.engine.acknowledge(round,round+2050),true);
  return frozen;
}
function official(round=ROUND,actual='UP') {
  return {roundStartMs:round,actual,
    actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence:'OFFICIAL_'+actual+':STRICT_ROUND_ALIGNED_TOPIC',
    settledAt:round+ROUND_MS+120};
}
test('external adaptation produces 3 binary 5m directions without WAIT or fake probabilities',()=>{
  const d=externalResearchDirections(fields,quality);
  assert.equal(d.version,EXTERNAL_RESEARCH_VERSION);
  assert.deepEqual(Object.keys(d.predictions),[...EXTERNAL_RESEARCH_IDS]);
  assert.equal(d.regime,'TREND');
  assert.equal(d.fullQuality,true);
  assert.equal(d.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
  assert.equal(d.predictions.REGIME_SWITCH_PROXY_V1.direction,'UP');
  for(const v of Object.values(d.predictions)){
    assert.ok(v.direction==='UP'||v.direction==='DOWN');
    assert.equal(v.fallback,false);
    assert.ok(v.strength>=0 && v.strength<=1);
    assert.equal('probability' in v,false);
  }
  assert.equal(d.executionEligible,false);
  assert.equal(d.autoPromotion,false);
  assert.equal(d.productionEffect,'NONE_SHADOW_ONLY');
});
test('downward order flow and non-trend mean reversion affect directional output',()=>{
 const neg=Object.fromEntries(Object.entries(fields).map(([k,v])=>
   [k,['currentScore','currentTrendScore','microScore','regimeScore',
    'normalizedMomentum60s','normalizedMomentum180s','normalizedMomentum300s',
    'tradePressure15s','tradePressure60s','ofiNormalized5s',
    'distanceFromOpenBps'].includes(k)?-v:v]));
 neg.predictionMarketUpMid=0.43;neg.rangePosition180=0.35;
 const a=externalResearchDirections(neg,quality);
 assert.equal(a.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
 const nonTrend={...fields,currentTrendScore:0.1,regimeScore:-0.1,
  tradePressure15s:0,tradePressure60s:0,ofiNormalized5s:0,microScore:0,
  normalizedMomentum60s:0.9,normalizedMomentum180s:0.8,
  normalizedMomentum300s:0.7,distanceFromOpenBps:9,rangePosition180:0.9,
  predictionMarketUpMid:0.5};
 const b=externalResearchDirections(nonTrend,quality);
 assert.equal(b.regime,'NON_TREND');
 assert.equal(b.predictions.MEAN_REVERSION_FLOW_PROXY_V1.direction,'DOWN');
 assert.equal(b.predictions.REGIME_SWITCH_PROXY_V1.direction,'DOWN');
});
test('no-data still gives baseline directions but marks unusable input',()=>{
 const d=externalResearchDirections({},{
   baselineDirection:'DOWN',snapshotAvailable:false,dataQuality:['NO_FRESH_SNAPSHOT']});
 assert.equal(d.fullQuality,false);
 assert.equal(d.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
 for(const x of Object.values(d.predictions)){
   assert.equal(x.fallback,true);
   assert.equal(x.evidence,'BASELINE_OR_NO_INFO_FALLBACK');
   assert.equal(x.strength,null);
 }
});
test('immutable shadow tracks same-time Binance official resolution without mutating FAST8 lock',t=>{
 const f=fx(t);
 const d=observe(f);
 assert.equal(d.direction,'UP'); // existing baseline untouched
 assert.equal(d.externalResearch.version,EXTERNAL_RESEARCH_VERSION);
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
 assert.equal(d.externalResearch.executionEligible,false);
 const snapshot=JSON.stringify(d.externalResearch);
 f.time(ROUND+5000);
 assert.equal(f.engine.tick().direction,'UP');
 assert.equal(JSON.stringify(f.engine.tick().externalResearch),snapshot);
 f.time(ROUND+ROUND_MS+200);
 assert.equal(f.engine.settle(official()),true);
 assert.equal(f.engine.settle(official()),false);
 let s=f.engine.stats();
 assert.equal(s.hits,1);
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.hits,1);
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.labeledPredictions,1);
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.onTimeHits,1);
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.verifiedHits,1);
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.matchedFast8BaselineAccuracy,1);
 assert.equal(s.externalResearch.autoPromotion,false);
 assert.equal(s.externalResearch.executionEligible,false);
 assert.ok(s.externalResearch.models.FLOW_BOOK_PROXY_V1.confidenceWilson95[0]<1);
 assert.equal(f.reload(),true);
 s=f.engine.stats();
 assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.hits,1);
 assert.equal(s.latest.externalResearch.version,EXTERNAL_RESEARCH_VERSION);
});
test('pre-existing journal rows must not be retroactively assigned new external performance',t=>{
 const f=fx(t);
 observe(f);
 const file=path.join(f.dir,'events.jsonl');
 const events=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 for(const ev of events) if(ev.type==='decision') delete ev.externalResearch;
 fs.writeFileSync(file,events.map(x=>JSON.stringify(x)).join('\n')+'\n');
 f.time(ROUND+ROUND_MS+200);
 assert.equal(f.reload(),true);
 assert.equal(f.engine.settle(official()),true);
 const stats=f.engine.stats();
 assert.equal(stats.hits,1);
 assert.equal(stats.externalResearch.models.FLOW_BOOK_PROXY_V1.labeledPredictions,0);
 assert.equal(stats.externalResearch.candidateRounds,0);
});
test('no future snapshot can backfill after worker lock',t=>{
 const f=fx(t);
 f.time(ROUND+2030);
 const d=f.engine.tick();
 assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.fallback,true);
 assert.ok(['UP','DOWN'].includes(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction));
 f.time(ROUND+5000);
 f.engine.capture({round:ROUND,factsCalculatedAt:ROUND+4900,
   facts:{...fields}},ROUND+4940);
 assert.deepEqual(f.engine.tick().externalResearch,d.externalResearch);
});

test('pre-round market observations are valid causal candidates, never full-quality round evidence',()=>{
 const d=externalResearchDirections(fields,{
   ...quality,roundStartMs:ROUND,sourceAt:ROUND-2200
 });
 assert.equal(d.reusedPreRound,true);
 assert.equal(d.fullQuality,false);
 assert.ok(d.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
 assert.equal(d.predictions.FLOW_BOOK_PROXY_V1.evidence,'DEGRADED_MICROSTRUCTURE_INPUT');
 assert.ok(['UP','DOWN'].includes(d.predictions.FLOW_BOOK_PROXY_V1.direction));
});

test('worker pre-round fallback keeps research but does not classify stale-topic input as verified',t=>{
 const f=fx(t);
 f.time(ROUND-400);
 const earlier=ROUND-ROUND_MS;
 const ok=f.engine.capture({round:earlier,factsCalculatedAt:ROUND-650,
   facts:{...fields,depthAgeMs:50,lastAggTradeAgeMs:50,
     predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
     predictionMarketRound:earlier,predictionMarketBookAgeMs:150,
     predictionMarketUpdateTimestampMs:ROUND-660}
 },ROUND-600);
 assert.equal(ok,true);
 f.time(ROUND+2020);
 const d=f.engine.tick();
 assert.equal(d.externalResearch.reusedPreRound,true);
 assert.equal(d.externalResearch.fullQuality,false);
 assert.ok(d.externalResearch.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
 assert.ok(['UP','DOWN'].includes(d.externalResearch.predictions.REGIME_SWITCH_PROXY_V1.direction));
});
