import test from 'node:test';
import assert from 'node:assert/strict';
import {vip75StatsByInputVersion,VIP75_LEGACY_UNKNOWN_INPUT}
  from './vip75-version-stats.mjs';
const MODEL='FROZEN_TEST_VIP75';
const V1='PRIOR_ROUND_TAIL_22_TO_10S_V1';
const V2='PRIOR_ROUND_TAIL_22_TO_10S_RESERVE120_STRICT_V2';
const base=1800000000000;
function sample(i,pred,actual,version,patch={}) {
  return {
    roundStartMs:base+i*300000,productionModel:'zl_new_vip75',
    productionModelVersion:MODEL,productionPrediction:pred,
    productionActual:actual,actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    productionInputVersion:version,...patch,
  };
}
test('never misattribute old unknown snapshots to current version',()=>{
  const rows=[
    sample(0,'UP','UP',null),
    sample(1,'UP','DOWN',V1),
    sample(2,'DOWN','DOWN',V2),
    sample(3,'UP','DOWN',V2),
  ];
  const out=vip75StatsByInputVersion(rows,MODEL,V2);
  assert.equal(out.statsScope,'CURRENT_EXACT_INPUT_VERSION_ONLY');
  assert.equal(out.settledRounds,2);
  assert.equal(out.hits,1);
  assert.equal(out.misses,1);
  assert.equal(out.accuracyPct,50);
  assert.equal(out.historicalCombined.settledRounds,4);
  assert.equal(out.byInputVersion[VIP75_LEGACY_UNKNOWN_INPUT].settledRounds,1);
  assert.equal(out.byInputVersion[V1].accuracyPct,0);
  assert.equal(out.byInputVersion[V2].accuracyPct,50);
  assert.equal(out.inputVersion,V2);
});
test('hypothetical inverted direction is NOT actual executed order win rate',()=>{
  const rows=[sample(0,'UP','DOWN',V2),sample(1,'DOWN','DOWN',V2)];
  const current=vip75StatsByInputVersion(rows,MODEL,V2);
  assert.equal(current.originalDirection.hits,1);
  assert.equal(current.hypotheticalInverseDirection.hits,1);
  assert.equal(current.hypotheticalInverseDirection.isActualOrderWinRate,false);
  assert.equal(current.actualExecutedOrderWinRatePct,null);
});
test('exclude no-information and unofficial settlement; count missing signal in coverage',()=>{
  const rows=[
    sample(0,'UP','UP',V2),
    sample(1,null,'DOWN',null,{productionModel:null,productionModelVersion:null}),
    sample(2,'DOWN','DOWN',V2,{actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE'}),
    sample(3,'DOWN','UP',V2),
    sample(4,'UP','UP',null,{productionModelVersion:MODEL+':NO_INFORMATION',productionFallbackUsed:true}),
  ];
  const out=vip75StatsByInputVersion(rows,MODEL,V2);
  assert.equal(out.settledRounds,2);
  assert.equal(out.accuracyPct,50);
  assert.equal(out.coveragePct,50); // 2 current official locks / 4 official calendar rounds
  assert.equal(out.noInformationRounds,1);
  assert.equal(out.byInputVersion[VIP75_LEGACY_UNKNOWN_INPUT],undefined);
});
test('new version with no forward outcomes returns null not fabricated 75%',()=>{
  const out=vip75StatsByInputVersion([sample(0,'UP','UP',V1)],MODEL,V2);
  assert.equal(out.accuracyPct,null);
  assert.equal(out.settledRounds,0);
  assert.equal(out.byInputVersion[V1].accuracyPct,100);
});
