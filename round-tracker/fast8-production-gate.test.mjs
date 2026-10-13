import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {FAST8_SOURCE,FAST8_MODE,fast8ProductionReadiness} from './fast8-production-gate.mjs';

const R=1791828000000, now=R+2100;
const mock=()=>{
  const stats={ok:true,modelFamily:'ZL_FAST8_65',policyVersion:'FAST8_FULL_COVERAGE_LOGISTIC_V2',
    statusAgeMs:100,health:{journalReady:true},modelVersion:'ZL_FAST8_65-adaptive-v1',
    predictionAccuracy:.66,labeledPredictions:1000,training:{validTrainingSamples:1000},
    validation:{passed:true,expectedRounds:1000,onTimeRounds:1000,labeledPredictions:1000,endToEndAccuracy:.66}};
  const signal={modelFamily:'ZL_FAST8_65',policyVersion:stats.policyVersion,roundStartMs:R,
    direction:'UP',decisionComputedAtMs:R+2002,persistedAtMs:R+2012,
    serverAvailableAtMs:R+2050,maxEventTimeMs:R+1440,modelVersion:stats.modelVersion,
    pUpRaw:.61,fallbackLevel:'NONE',presentFeatures:17,dataQuality:[]};
  return {stats,latest:{signal}};
};

test('current-round and timing checks allow a clean learned signal',()=>{
  const {stats,latest}=mock();
  const res=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(res.eligible,true);
  assert.equal(res.preview.direction,'UP');
  assert.equal(fast8ProductionReadiness(stats,latest,R+300000,now).eligible,false);
});
test('explicit FAST8-only route allows timely baseline direction before 65% proof',()=>{
  const {stats,latest}=mock();
  stats.validation={...stats.validation,passed:false,expectedRounds:163,
    onTimeRounds:163,labeledPredictions:163,endToEndAccuracy:74/163};
  stats.training.validTrainingSamples=163;
  stats.modelVersion='ZL_FAST8_65-baseline-v2';
  latest.signal.modelVersion='ZL_FAST8_65-baseline-v2';
  latest.signal.pUpRaw=null;
  latest.signal.fallbackLevel='MOMENTUM60_BASELINE';
  const r=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(r.eligible,true);
  assert.equal(r.reason,null);
  assert.equal(r.preview.direction,'UP');
});
test('reject late publication, stale status and bad features but allow non-trained fallback',()=>{
  const {stats,latest}=mock();
  latest.signal.serverAvailableAtMs=R+8001;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
  latest.signal.serverAvailableAtMs=R+2050;
  latest.signal.fallbackLevel='NO_INFORMATION_FALLBACK';
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).eligible,true);
  latest.signal.fallbackLevel='NONE';
  // PM book is optional when all 16 remaining fields are present.
  latest.signal.presentFeatures=16;
  latest.signal.dataQuality=['PM_MISSING_OR_UNALIGNED'];
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).eligible,true);
  // A degraded order book, trade feed, or additional missing field must not bypass the gate.
  latest.signal.dataQuality=['PM_MISSING_OR_UNALIGNED','DEPTH_MISSING_OR_STALE'];
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_MODEL_OR_FEATURES_NOT_READY');
  latest.signal.dataQuality=['TRADES_MISSING_OR_STALE'];
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_MODEL_OR_FEATURES_NOT_READY');
  latest.signal.dataQuality=['PM_MISSING_OR_UNALIGNED'];
  latest.signal.presentFeatures=15;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_MODEL_OR_FEATURES_NOT_READY');
  latest.signal.dataQuality=[];
  latest.signal.presentFeatures=17;
  stats.statusAgeMs=65000;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_WORKER_OR_JOURNAL_NOT_READY');
});
test('exclusive production disables all legacy locks and cannot replay their frozen envelopes',()=>{
  const src=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  assert.match(src,/PRODUCTION_SIGNAL_SOURCE_MODE \|\| FAST8_MODE/);
  assert.match(src,/PRODUCTION_SIGNAL_SOURCE_MODE === FAST8_MODE && live.source !== FAST8_SOURCE/);
  assert.match(src,/return fast8ExclusiveSignalPayload\(row, expectedRound, now\)/);
  assert.match(src,/function buildLockedSignalEnvelope\(row, live\) \{\s*if \(PRODUCTION_SIGNAL_SOURCE_MODE === FAST8_MODE/);
  assert.match(src,/productionSignalSourceMode:PRODUCTION_SIGNAL_SOURCE_MODE/);
  assert.match(src,/otherProductionSourcesPaused:true/);
  assert.equal(FAST8_SOURCE,'ZL_FAST8_65_PRIMARY');
  assert.equal(FAST8_MODE,'FAST8_ONLY');
});

test('production accepts the exact degraded-PM baseline case but does not accept late/invalid signals',()=>{
  const {stats,latest}=mock();
  stats.modelVersion=latest.signal.modelVersion='ZL_FAST8_65-baseline-v2';
  latest.signal.direction='DOWN';
  latest.signal.fallbackLevel='MOMENTUM60_BASELINE';
  latest.signal.presentFeatures=16;
  latest.signal.dataQuality=['PM_MISSING_OR_UNALIGNED'];
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).eligible,true);
  assert.equal(fast8ProductionReadiness(stats,latest,R,R+8001).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
  latest.signal.modelVersion='OUTDATED_VERSION';
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_MODEL_OR_FEATURES_NOT_READY');
});
