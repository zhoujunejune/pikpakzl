import test from 'node:test';
import assert from 'node:assert/strict';
import {isOfficialStrictSettlement,isFrozenFinalBaselineWait,productionBaselineSummary,prospectiveCombinedSummary,wilsonLowerBound} from './edge-rescue-expansion-proof.mjs';

const VERSION='SELECTIVE_V2_EDGE_EXPANSION_SHADOW_V1';
const base=()=>({
  roundStartMs:1800000000000,roundEndMs:1800000299999,
  predictedAt:1800000010000,settledAt:1800000340000,expansionBaselineWaitAt:1800000030000,
  actual:'UP',officialDirection:'UP',actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
  resolutionEvidence:'OFFICIAL_UP:BINANCE_RESOLUTION:STRICT_ROUND_ALIGNED_TOPIC',predictionMarketTopicId:654321,
  prediction:'UP',lockQualitySelectiveV2:{pass:false},
  selectiveV2EdgeExpansionShadow:{version:VERSION,evaluatedAt:1800000020000,baseDirection:'UP',candidates:{c:{decision:'UP'}}},
  productionPrediction:null,productionLockedAt:null,result:'HIT'
});
const clone=x=>structuredClone(x);
test('official settled forward WAIT passes',()=>{
  const r=base();assert.equal(isOfficialStrictSettlement(r),true);assert.equal(isFrozenFinalBaselineWait(r,VERSION),true);
});
test('reject missing or unreliable settlement provenance',()=>{
  for(const [key,value] of [['actualSource',null],['officialDirection','DOWN'],['resolutionEvidence','OFFICIAL_UP:PERSISTED_EVIDENCE'],['resolutionEvidence','OFFICIAL_UP:WINNER_FLAG:STRICT_ROUND_ALIGNED_TOPIC'],['resolutionEvidence','OFFICIAL_UP:RESOLVED'],['predictionMarketTopicId',null],['settledAt',1800000299999]]){
    const r=base();r[key]=value;assert.equal(isOfficialStrictSettlement(r),false,key+':'+value);
  }
});
test('reject after-the-fact predictions, no WAIT witness, conflicting signals',()=>{
  for(const [key,value] of [['predictedAt',1800000350000],['expansionBaselineWaitAt',null],['expansionBaselineWaitAt',1800000400000],['productionPrediction','DOWN']]){
    const r=base();r[key]=value;assert.equal(isFrozenFinalBaselineWait(r,VERSION),false,key+':'+value);
  }
  const x=base();x.selectiveV2EdgeExpansionShadow.evaluatedAt=1800000350000;assert.equal(isFrozenFinalBaselineWait(x,VERSION),false);
  const y=base();y.lockQualitySelectiveV2.pass=true;assert.equal(isFrozenFinalBaselineWait(y,VERSION),false);
});
test('another tier production lock cannot be counted as incremental WAIT',()=>{
  const r=base();r.productionPrediction='UP';r.productionSource='SELECTIVE_V2_EDGE_RESCUE_PRIMARY';r.productionLockedAt=1800000040000;r.productionResult='HIT';
  assert.equal(isFrozenFinalBaselineWait(r,VERSION),false);
  const x=base();x.productionPrediction='UP';x.productionSource='SELECTIVE_V2_EDGE_EXPANSION_PRIMARY';x.productionLockedAt=1800000040000;x.productionGeneratedAt=1800000035000;x.productionResult='HIT';
  assert.equal(isFrozenFinalBaselineWait(x,VERSION),true);
});
test('combined accuracy cannot degrade original production',()=>{
  const baseline={samples:10,hits:9,accuracy:0.9};
  assert.equal(prospectiveCombinedSummary(baseline,[{decision:'UP',actual:'DOWN'}]).notWorseThanBaseline,false);
  assert.equal(prospectiveCombinedSummary(baseline,[{decision:'UP',actual:'UP'}]).notWorseThanBaseline,true);
  assert.equal(prospectiveCombinedSummary({samples:0,hits:0,accuracy:null},[{decision:'UP',actual:'UP'}]).notWorseThanBaseline,false);
});
test('baseline excludes unverified, after-freeze and expansion records',()=>{
  const a=base();a.productionPrediction='UP';a.productionSource='SELECTIVE_V2_EDGE_RESCUE_PRIMARY';a.productionGeneratedAt=1800000015000;a.productionLockedAt=1800000020000;a.productionResult='HIT';
  const b=clone(a);b.productionPrediction='DOWN';b.productionSource='LOCK_QUALITY_SELECTIVE_V2_PRIMARY';b.productionResult='MISS';
  const c=clone(a);c.productionSource='SELECTIVE_V2_EDGE_EXPANSION_PRIMARY';
  const d=clone(a);d.resolutionEvidence='OFFICIAL_UP:PERSISTED_EVIDENCE';
  assert.deepEqual(productionBaselineSummary([a,b,c,d]),{samples:2,hits:1,misses:1,accuracy:0.5});
});
test('Wilson lower bound rejects weak 60-sample accuracy',()=>{
  assert.equal(wilsonLowerBound(0,0),null);
  assert.ok(wilsonLowerBound(45,60)<0.70);
  assert.ok(wilsonLowerBound(53,60)>0.70);
});