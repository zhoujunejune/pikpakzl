import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vip75DataGapResponse,VIP75_DATA_GAP_DIAGNOSTIC_MS,
  VIP75_DATA_GAP_DEADLINE_MS,VIP75_DATA_GAP_POLICY_VERSION,
} from './vip75-data-gap-policy.mjs';

const R=1791969600000;
const options={round:R,artifactReady:true,source:'ZL_FAST8_65_PRIMARY',
  modelVersion:'FROZEN_VIP75',productionPolicy:'FAST8_ONLY',
  probe:{missingRequired:['ofiNormalized60s','tradePressure60s'],
    previousRoundFeatureCount:15,currentRoundFeatureCount:1,
    inputVersion:'PRIOR_ROUND_TAIL_22_TO_10S_V1'}};
test('at 7s, missing facts never create an arbitrary UP/DOWN signal',()=>{
  assert.equal(VIP75_DATA_GAP_DIAGNOSTIC_MS,7000);
  const x=vip75DataGapResponse({...options,now:R+7000});
  assert.equal(x.status,'PENDING');
  assert.equal(x.signal,null);
  assert.equal(x.generatedAt,null);
  assert.equal(x.tradingAllowed,false);
  assert.equal(x.fallbackUsed,false);
  assert.equal(x.pendingReason,'VIP75_REQUIRED_MARKET_FEATURES_MISSING');
  assert.deepEqual(x.fast8Quality.missingFeatures,options.probe.missingRequired);
  assert.equal(x.fast8Quality.dataGapPolicyVersion,VIP75_DATA_GAP_POLICY_VERSION);
});
test('between 7 and 8s the model may keep acquiring real data',()=>{
  const x=vip75DataGapResponse({...options,now:R+7999});
  assert.equal(x.status,'PENDING');
  assert.equal(x.signal,null);
  assert.equal(x.deadlineMs,VIP75_DATA_GAP_DEADLINE_MS);
});
test('at 8s and later a missing or invalid snapshot closes without trade',()=>{
  for(const time of [8000,8001,50000]) {
    const x=vip75DataGapResponse({...options,now:R+time});
    assert.equal(x.status,'DATA_UNAVAILABLE');
    assert.equal(x.signal,null);
    assert.equal(x.tradingAllowed,false);
    assert.equal(x.fast8Quality.status,'VIP75_DATA_UNAVAILABLE_NO_TRADE');
    assert.equal(x.pendingReason,null);
  }
});
test('unavailable pinned weights cannot be portrayed as a VIP75 prediction',()=>{
  const x=vip75DataGapResponse({...options,artifactReady:false,now:R+9000});
  assert.equal(x.dataGapReason,'VIP75_FROZEN_MODEL_UNAVAILABLE');
  assert.equal(x.signal,null);
  assert.equal(x.fast8Quality.trainedPrediction,false);
});
test('malformed round and impossible timestamps are rejected',()=>{
  assert.throws(()=>vip75DataGapResponse({...options,round:R+1,now:Infinity}),/INVALID_VIP75_ROUND_OR_TIME/);
  assert.throws(()=>vip75DataGapResponse({...options,now:R-1}),/INVALID_VIP75_ROUND_OR_TIME/);
});
