import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFast8Engine } from './fast8-engine.mjs';
import { ROUND_MS } from './fast8-model.mjs';
import { EXTERNAL_RESEARCH_IDS, EXTERNAL_RESEARCH_VERSION, externalResearchDirections } from './external-btc5m-fast8-shadow.mjs';

const ROUND=1791800100000;
const features={
  currentScore:0.65,currentTrendScore:0.7,microScore:0.2,regimeScore:0.6,
  normalizedMomentum5s:0.1,normalizedMomentum15s:0.2,normalizedMomentum60s:0.55,
  normalizedMomentum180s:0.4,normalizedMomentum300s:0.3,tradePressure15s:0.5,
  tradePressure60s:0.55,ofiNormalized5s:0.6,distanceFromOpenBps:3,
  rangePosition180:0.65,predictionMarketUpMid:0.57,liveScore:0.5,spreadBps:0.7,
};
const current={baselineDirection:'DOWN',snapshotAvailable:true,dataQuality:[],
  sourceAt:ROUND+1000,roundStartMs:ROUND};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-fast8-'));
  let now=ROUND-1500,engine=createFast8Engine({dir,clock:()=>now});
  assert.equal(engine.load(),true);
  t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true})});
  return {dir,time(v){now=v},get engine(){return engine},reload(){
    engine.close();engine=createFast8Engine({dir,clock:()=>now});return engine.load();
  }};
}
function frozen(f,round=ROUND){
  f.time(round+1050);
  const ok=f.engine.capture({round,factsCalculatedAt:round+1000,facts:{
    ...features,depthAgeMs:50,lastAggTradeAgeMs:50,predictionMarketMappingReliable:true,
    predictionMarketRoundAligned:true,predictionMarketRound:round,
    predictionMarketBookAgeMs:120,predictionMarketUpdateTimestampMs:round+950,
  }},round+1030);
  assert.equal(ok,true);
  f.time(round+2030);
  const decision=f.engine.tick();
  f.time(round+2060);
  assert.equal(f.engine.acknowledge(round,round+2050),true);
  return decision;
}
function official(round=ROUND,actual='UP'){
  return {roundStartMs:round,actual,actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence:'OFFICIAL_'+actual+':STRICT_ROUND_ALIGNED_TOPIC',
    settledAt:round+ROUND_MS+100};
}
test('only one research candidate is computed, with UP/DOWN and no invented probability',()=>{
  assert.deepEqual(EXTERNAL_RESEARCH_IDS,['FLOW_BOOK_PROXY_V1']);
  const v=externalResearchDirections(features,current);
  assert.equal(v.version,EXTERNAL_RESEARCH_VERSION);
  assert.deepEqual(Object.keys(v.predictions),['FLOW_BOOK_PROXY_V1']);
  const d=v.predictions.FLOW_BOOK_PROXY_V1;
  assert.equal(d.direction,'UP');
  assert.equal(d.fallback,false);
  assert.equal(d.evidence,'FROZEN_REGIME_INPUT');
  assert.equal(v.fullQuality,true);
  assert.equal(v.executionEligible,false);
  assert.equal(v.autoPromotion,false);
  assert.equal('probability' in d,false);
});
test('opposite orderflow produces opposite direction',()=>{
  const opposite={...features,ofiNormalized5s:-0.9,tradePressure15s:-0.8,
    tradePressure60s:-0.7,microScore:-0.8,currentScore:-0.5,
    currentTrendScore:-0.4,regimeScore:-0.5,normalizedMomentum60s:-0.5,
    predictionMarketUpMid:0.35};
  assert.equal(externalResearchDirections(opposite,current).predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
});
test('direct OFI and 60s trade pressure have no influence on FLOW_BOOK score',()=>{
 const a=externalResearchDirections(features,current).predictions.FLOW_BOOK_PROXY_V1;
 const b=externalResearchDirections({...features,ofiNormalized5s:-1,tradePressure60s:-1},current).predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(a.direction,b.direction);
 assert.equal(a.strength,b.strength);
 assert.equal(a.featureCount,b.featureCount);
});
test('15s aggressive flow and currentScore do not directly influence V9 direction or strength',()=>{
 const a=externalResearchDirections(features,current).predictions.FLOW_BOOK_PROXY_V1;
 const b=externalResearchDirections({...features,tradePressure15s:-1,currentScore:-1},current).predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(a.direction,b.direction);
 assert.equal(a.strength,b.strength);
 assert.equal(a.featureCount,b.featureCount);
 assert.equal(a.featureCount,1);
});
test('V9 ignores any supplied legacy prewarm and uses current-round regime only',()=>{
 const legacy={ready:true,nextRoundStartMs:ROUND,predictionMarketContractIncluded:false,
  previewScore:-1,directionPreview:'DOWN',sampleCount:120};
 const only={regimeScore:0.6};
 const a=externalResearchDirections(only,current);
 const b=externalResearchDirections(only,{...current,preparation:legacy});
 assert.deepEqual(a,b);
 const d=b.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(d.direction,'UP');
 assert.equal(d.featureCount,1);
 assert.equal(d.preparationUsed,false);
 assert.equal(d.preWeight,0);
 assert.equal(b.preparation,null);
});
test('regimeScore is the ONLY direct scoring input, regardless of PM quote',()=>{
 const base=externalResearchDirections(features,current).predictions.FLOW_BOOK_PROXY_V1;
 const altered=externalResearchDirections({...features,
  microScore:-1,currentTrendScore:-1,normalizedMomentum60s:-1,
  currentScore:-1,tradePressure15s:-1,tradePressure60s:-1,ofiNormalized5s:-1,
  predictionMarketUpMid:0.01},current)
  .predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(base.direction,altered.direction);
 assert.equal(base.strength,altered.strength);
 assert.equal(base.featureCount,1);
 const down=externalResearchDirections({...features,regimeScore:-1,
  predictionMarketUpMid:0.99},current).predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(down.direction,'DOWN');
 assert.notEqual(down.strength,base.strength);
});
test('regime-only snapshot is fully qualified even without PM quote',()=>{
 const data=externalResearchDirections({regimeScore:0.8},current);
 const v=data.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(v.featureCount,1);
 assert.equal(v.direction,'UP');
 assert.equal(v.fallback,false);
 assert.equal(data.fullQuality,true);
 assert.equal(v.evidence,'FROZEN_REGIME_INPUT');
});
test('missing or zero regime emits clock-only fallback and ignores baseline, PM, momentum',()=>{
  const noRegime=externalResearchDirections({predictionMarketUpMid:0.99,normalizedMomentum60s:1},
    {...current,baselineDirection:'UP'}).predictions.FLOW_BOOK_PROXY_V1;
  const zeroRegime=externalResearchDirections({regimeScore:0,predictionMarketUpMid:0.01},
    {...current,baselineDirection:'UP'}).predictions.FLOW_BOOK_PROXY_V1;
  assert.equal(noRegime.featureCount,0);
  assert.equal(noRegime.fallback,true);
  assert.equal(noRegime.direction,zeroRegime.direction);
  assert.equal(noRegime.direction,'DOWN'); // deterministic clock parity, not legacy baseline
  assert.equal(zeroRegime.fallback,true);
});
test('missing snapshots still produce UP/DOWN and honestly mark no-information fallback',()=>{
  const v=externalResearchDirections({},{
    baselineDirection:'DOWN',snapshotAvailable:false,dataQuality:['NO_FRESH_SNAPSHOT'],
    roundStartMs:ROUND,sourceAt:null});
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.fallback,true);
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.strength,null);
  assert.equal(v.fullQuality,false);
});
test('PM and other unused data quality issues do not downgrade a valid regime observation',()=>{
 const a=externalResearchDirections({regimeScore:0.4},
   {...current,dataQuality:['PM_MISSING_OR_UNALIGNED','DEPTH_MISSING_OR_STALE','TRADES_MISSING_OR_STALE']});
 const p=a.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(a.fullQuality,true);
 assert.equal(p.evidence,'FROZEN_REGIME_INPUT');
 assert.deepEqual(a.dataQuality,[]);
});
test('pre-round observations are rejected as prediction inputs, not reused',()=>{
  const v=externalResearchDirections(features,{...current,sourceAt:ROUND-248});
  assert.equal(v.reusedPreRound,true);
  assert.equal(v.fullQuality,false);
  assert.ok(v.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.evidence,'BASELINE_OR_NO_INFO_FALLBACK');
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.featureCount,0);
  assert.equal(v.predictions.FLOW_BOOK_PROXY_V1.fallback,true);
});
test('worker keeps one immutable external candidate and strictly-forward official score',t=>{
  const f=fixture(t);
  const d=frozen(f);
  assert.equal(d.direction,'UP');
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
  assert.equal(d.externalResearch.executionEligible,false);
  const frozenEvidence=JSON.stringify(d.externalResearch);
  f.time(ROUND+5000);
  assert.equal(JSON.stringify(f.engine.tick().externalResearch),frozenEvidence);
  f.time(ROUND+ROUND_MS+200);
  assert.equal(f.engine.settle(official()),true);
  assert.equal(f.engine.settle(official()),false);
  let s=f.engine.stats();
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.labeledPredictions,1);
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.hits,1);
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.verifiedHits,1);
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.onTimeHits,1);
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.matchedFast8BaselineAccuracy,1);
  assert.equal(s.externalResearch.autoPromotion,false);
  assert.equal(f.reload(),true);
  s=f.engine.stats();
  assert.equal(s.externalResearch.models.FLOW_BOOK_PROXY_V1.hits,1);
});
test('legacy journal predictions are retained without fabricated new model scores',t=>{
  const f=fixture(t);
  frozen(f);
  const journal=path.join(f.dir,'events.jsonl');
  const events=fs.readFileSync(journal,'utf8').trim().split('\n').map(JSON.parse);
  for(const ev of events)if(ev.type==='decision')delete ev.externalResearch;
  fs.writeFileSync(journal,events.map(v=>JSON.stringify(v)).join('\n')+'\n');
  f.time(ROUND+ROUND_MS+200);
  assert.equal(f.reload(),true);
  assert.equal(f.engine.settle(official()),true);
  assert.equal(f.engine.stats().externalResearch.models.FLOW_BOOK_PROXY_V1.labeledPredictions,0);
});
test('no new post-lock data or future event can rewrite the frozen candidate',t=>{
  const f=fixture(t);
  f.time(ROUND+2030);
  const before=f.engine.tick();
  assert.ok(['UP','DOWN'].includes(before.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction));
  f.time(ROUND+5000);
  f.engine.capture({round:ROUND,factsCalculatedAt:ROUND+4950,facts:{...features}},ROUND+4970);
  assert.deepEqual(f.engine.tick().externalResearch,before.externalResearch);
});
