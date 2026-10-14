import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {summarizeVip75VersionedStats,VIP75_UNKNOWN_INPUT_VERSION} from './vip75-versioned-stats.mjs';

const VERSION='FROZEN_VIP75_V3',V1='PRIOR_ROUND_TAIL_22_TO_10S_V1';
const V2='PRIOR_ROUND_TAIL_22_TO_10S_PLUS_60_TO_22S_BACKFILL_V2';
const R=1791969000000;
const make=(i,attrs={})=>({
  roundStartMs:R+i*300000,productionModel:'zl_new_vip75',
  productionModelVersion:VERSION,productionPrediction:'UP',
  productionActual:'UP',productionFallbackUsed:false,...attrs
});
const run=rows=>summarizeVip75VersionedStats(rows,{modelVersion:VERSION,currentInputVersion:V2});

test('no historical untagged input can inflate current V2 accuracy',()=>{
  const a=run([
    make(0,{productionInputVersion:null,productionActual:'UP'}),
    make(1,{productionInputVersion:V1,productionActual:'DOWN'}),
    make(2,{productionInputVersion:V2,productionPrediction:'DOWN',productionActual:'DOWN',
      productionPreviousRoundFeatureCount:17,productionCurrentRoundFeatureCount:1,
      productionPreviousBackupFeatureCount:3}),
    make(3,{productionInputVersion:V2,productionPrediction:'UP',productionActual:'DOWN'}),
    make(4,{productionInputVersion:V2,productionPrediction:'UP',productionActual:null}),
  ]);
  assert.equal(a.cohortCount,3);
  assert.equal(a.current.inputVersion,V2);
  assert.equal(a.current.signalRounds,3);
  assert.equal(a.current.officialSampleCount,2);
  assert.equal(a.current.originalHits,1);
  assert.equal(a.current.originalMisses,1);
  assert.equal(a.current.originalAccuracyPct,50);
  assert.equal(a.current.inverseHits,1);
  assert.equal(a.current.inverseTheoreticalAccuracyPct,50);
  assert.equal(a.cohorts.find(c=>c.inputVersion===V1).originalAccuracyPct,0);
  const unknown=a.cohorts.find(c=>c.inputVersion===VIP75_UNKNOWN_INPUT_VERSION);
  assert.equal(unknown.historicalInputVersionUnverified,true);
  assert.equal(unknown.originalAccuracyPct,100);
  assert.equal(a.current.averageOlderBackupFeatures,3);
  assert.match(a.inverseCalculation,/NOT_EXECUTED_ORDER_PNL/);
});
test('old deterministic no-information directions must never count as genuine model predictions',()=>{
  const a=run([
    make(0,{productionModelVersion:VERSION+':NO_INFORMATION',productionFallbackUsed:true}),
    make(1,{productionInputVersion:V2,productionPrediction:'UP',productionActual:'DOWN'}),
  ]);
  assert.equal(a.current.officialSampleCount,1);
  assert.equal(a.current.inverseHits,1);
  assert.equal(a.cohorts.find(c=>c.modelVersion.endsWith(':NO_INFORMATION')).officialSampleCount,0);
});
test('split by model version even if input version strings match',()=>{
  const a=run([
    make(0,{productionInputVersion:V2,productionModelVersion:'ANOTHER_VIP75'}),
    make(1,{productionInputVersion:V2,productionActual:'UP'}),
  ]);
  assert.equal(a.cohortCount,2);
  assert.equal(a.current.officialSampleCount,1);
  assert.equal(a.cohorts.find(c=>c.modelVersion==='ANOTHER_VIP75').originalAccuracyPct,null);
});
test('empty current cohort is not silently replaced by mixed historical accuracy',()=>{
  const a=run([make(0,{productionInputVersion:V1})]);
  assert.equal(a.current.signalRounds,0);
  assert.equal(a.current.originalAccuracyPct,null);
  assert.equal(a.current.inverseTheoreticalAccuracyPct,null);
});
test('production locks persist provenance before saveHistory, stats use versioned cohorts',()=>{
  const source=fs.readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
  const freeze=source.slice(source.indexOf('function freezeProductionLock('),
    source.indexOf('function productionRecordView('));
  assert.match(freeze,/row\.productionInputVersion = live\?\.fast8Quality\?\.inputVersion/);
  assert.ok(freeze.indexOf('row.productionInputVersion =')<freeze.indexOf('saveHistory();'));
  assert.match(source,/vip75VersionedAccuracy:summarizeVip75VersionedStats/);
  assert.match(source,/previousBackupFeatureCount:pinned.previousBackupFeatureCount/);
  assert.match(source,/reverseTheoreticalAccuracyPct/);
});
