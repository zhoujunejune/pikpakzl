import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SINGLE_EXTERNAL_PRIMARY_ID, SINGLE_EXTERNAL_PRIMARY_VERSION, selectExternalFast8Production } from './external-fast8-primary.mjs';

const R=1791888300000, now=R+2100;
function sample(){
  const stats={ok:true,statusAgeMs:100,modelFamily:'ZL_FAST8_65',
    policyVersion:'FAST8_FULL_COVERAGE_LOGISTIC_V2',health:{journalReady:true},
    training:{status:'CANDIDATE_BELOW_BASELINE'}};
  const signal={roundStartMs:R,modelFamily:'ZL_FAST8_65',
    policyVersion:stats.policyVersion,direction:'UP',
    decisionComputedAtMs:R+2003,persistedAtMs:R+2012,
    publishedAtMs:R+2030,serverAvailableAtMs:R+2021,
    maxEventTimeMs:R-240,maxReceivedAtMs:R-150,
    capturedAtMs:R-145,presentFeatures:17,
    externalResearch:{version:'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V8_CURRENT_ONLY_REGIME_PM',
      predictedHorizonMs:300000,fullQuality:false,
      dataQuality:['PRE_ROUND_SNAPSHOT_REUSED'],
      predictions:{FLOW_BOOK_PROXY_V1:{direction:'DOWN',fallback:false,
        strength:0.41,evidence:'DEGRADED_MICROSTRUCTURE_INPUT'}}}};
  const readiness={eligible:true,preview:{persistedAtMs:R+2012}};
  return {stats,latest:{signal},readiness};
}
test('the only selected live direction comes from external FLOW_BOOK, not original FAST8',()=>{
  const {stats,latest,readiness}=sample();
  const selected=selectExternalFast8Production(stats,latest,R,readiness);
  assert.equal(selected.eligible,true);
  assert.equal(selected.direction,'DOWN');
  assert.notEqual(selected.direction,latest.signal.direction);
  assert.equal(selected.model,SINGLE_EXTERNAL_PRIMARY_ID);
  assert.equal(selected.modelVersion,SINGLE_EXTERNAL_PRIMARY_VERSION);
  assert.equal(selected.generatedAt,R+2012);
  assert.equal(selected.fallbackUsed,true);
  assert.equal(selected.qualityStatus,'EXTERNAL_PRIMARY_UNVERIFIED_INPUT');
  assert.equal(selected.strength,0.41);
  assert.equal('confidence' in selected,false);
});
test('rejects wrong round, missing candidate or lack of production worker readiness',()=>{
  const {stats,latest,readiness}=sample();
  assert.equal(selectExternalFast8Production(stats,latest,R+300000,readiness).eligible,false);
  const missing=structuredClone(latest);delete missing.signal.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
  assert.equal(selectExternalFast8Production(stats,missing,R,readiness).reason,
    'EXTERNAL_PRIMARY_CURRENT_ROUND_MISSING');
  assert.equal(selectExternalFast8Production(stats,latest,R,{eligible:false,reason:'JOURNAL_NOT_READY'}).reason,'JOURNAL_NOT_READY');
});
test('rejects candidate that was computed or published later than 8 seconds',()=>{
  const {stats,latest,readiness}=sample();
  latest.signal.decisionComputedAtMs=R+8001;
  assert.equal(selectExternalFast8Production(stats,latest,R,readiness).reason,'EXTERNAL_PRIMARY_NOT_FROZEN_WITHIN_8S');
  latest.signal.decisionComputedAtMs=R+2003;
  latest.signal.publishedAtMs=R+8001;
  assert.equal(selectExternalFast8Production(stats,latest,R,readiness).reason,'EXTERNAL_PRIMARY_NOT_FROZEN_WITHIN_8S');
});
test('full-quality one-model observation is tagged as frozen, not 65%-verified',()=>{
  const {stats,latest,readiness}=sample();
  latest.signal.externalResearch.fullQuality=true;
  latest.signal.externalResearch.dataQuality=[];
  latest.signal.externalResearch.predictions.FLOW_BOOK_PROXY_V1.evidence='FROZEN_MICROSTRUCTURE_INPUT';
  const result=selectExternalFast8Production(stats,latest,R,readiness);
  assert.equal(result.fallbackUsed,false);
  assert.equal(result.qualityStatus,'EXTERNAL_PRIMARY_FROZEN_INPUT');
  assert.equal('accuracy' in result,false);
});
test('production route remains single source, no WAIT and stores official winning metrics separately',()=>{
  const source=fs.readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
  const a=source.indexOf('function fast8ExclusiveSignalPayload(');
  const b=source.indexOf('function productionSignalPayload(',a);
  assert.ok(a>=0&&b>a);
  const route=source.slice(a,b);
  assert.match(route,/selectExternalFast8Production\(stats,current,expectedRound,readiness\)/);
  assert.match(route,/model:SINGLE_EXTERNAL_PRIMARY_ID/);
  assert.match(route,/external_fast8_primary_production_lock/);
  assert.match(route,/FAST8_GATEWAY_FALLBACK_AT_MS/);
  assert.match(route,/status:'PENDING'/);
  assert.doesNotMatch(route,/status:'WAIT'/);
  assert.match(source,/activeFast8Primary:/);
  assert.match(source,/activeProductionModel:/);
  assert.match(source,/PRODUCTION_SIGNAL_SOURCE_MODE === FAST8_MODE && live.source !== FAST8_SOURCE/);
});
