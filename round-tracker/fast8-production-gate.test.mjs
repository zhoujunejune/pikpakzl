import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {FAST8_SOURCE,FAST8_MODE,fast8ProductionReadiness} from './fast8-production-gate.mjs';

const R=1791828000000, now=R+2100;
const mock=()=>{
  const stats={ok:true,modelFamily:'ZL_FAST8_65',policyVersion:'FAST8_FULL_COVERAGE_LOGISTIC_V2',
    statusAgeMs:100,health:{journalReady:true},modelVersion:'ZL_FAST8_65-adaptive-v1',
    predictionAccuracy:.48,labeledPredictions:1000,training:{validTrainingSamples:1000},
    validation:{passed:false,expectedRounds:1000,onTimeRounds:1000,labeledPredictions:1000,endToEndAccuracy:.48}};
  const signal={modelFamily:'ZL_FAST8_65',policyVersion:stats.policyVersion,roundStartMs:R,
    direction:'UP',decisionComputedAtMs:R+2002,persistedAtMs:R+2012,
    serverAvailableAtMs:R+2050,maxEventTimeMs:R+1440,
    maxReceivedAtMs:R+1460,capturedAtMs:R+1465,modelVersion:stats.modelVersion,
    pUpRaw:.61,fallbackLevel:'NONE',presentFeatures:17,dataQuality:[]};
  return {stats,latest:{signal}};
};

test('on-time immutable current round works regardless of observed validation accuracy',()=>{
  const {stats,latest}=mock();
  const ready=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(ready.eligible,true);
  assert.equal(ready.preview.direction,'UP');
  assert.equal(ready.preview.fallbackUsed,false);
  assert.equal(fast8ProductionReadiness(stats,latest,R+300000,now).eligible,false);
});
test('read after 8s does not invalidate an already on-time worker signal',()=>{
  const {stats,latest}=mock();
  assert.equal(fast8ProductionReadiness(stats,latest,R,R+45000).eligible,true);
});
test('worker publication later than 8s is not disguised as a timely signal',()=>{
  const {stats,latest}=mock();
  latest.signal.serverAvailableAtMs=R+8001;
  assert.equal(fast8ProductionReadiness(stats,latest,R,R+9000).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
  latest.signal.serverAvailableAtMs=R+2050;
  latest.signal.decisionComputedAtMs=R+8100;
  assert.equal(fast8ProductionReadiness(stats,latest,R,R+9000).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
});
test('degraded depth and trade feeds become explicitly tagged fallback, not WAIT',()=>{
  const {stats,latest}=mock();
  latest.signal.fallbackLevel='MOMENTUM60_BASELINE';
  latest.signal.dataQuality=['PM_MISSING_OR_UNALIGNED','DEPTH_MISSING_OR_STALE','TRADES_MISSING_OR_STALE'];
  latest.signal.presentFeatures=3;
  const ready=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(ready.eligible,true);
  assert.equal(ready.preview.fallbackUsed,true);
  assert.equal(ready.preview.qualityStatus,'UNVERIFIED_DIRECTION_FALLBACK');
  assert.ok(ready.preview.dataQuality.includes('LOW_FEATURE_COVERAGE'));
});
test('no market snapshot is accurately tagged instead of fabricated',()=>{
  const {stats,latest}=mock();
  latest.signal.maxEventTimeMs=null;
  latest.signal.maxReceivedAtMs=null;
  latest.signal.capturedAtMs=null;
  latest.signal.presentFeatures=0;
  latest.signal.dataQuality=['NO_FRESH_SNAPSHOT'];
  latest.signal.fallbackLevel='NO_INFORMATION_FALLBACK';
  const ready=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(ready.eligible,true);
  assert.equal(ready.preview.fallbackUsed,true);
  assert.ok(ready.preview.dataQuality.includes('NO_FRESH_SNAPSHOT'));
  latest.signal.maxEventTimeMs=R+1800;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
});
test('an immutable prediction survives next-model registration without rewriting history',()=>{
  const {stats,latest}=mock();
  stats.modelVersion='ZL_FAST8_65-later-model';
  const ready=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(ready.eligible,true);
  assert.ok(ready.preview.dataQuality.includes('MODEL_VERSION_CHANGED_AFTER_DECISION'));
  stats.statusAgeMs=65000;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_WORKER_OR_JOURNAL_NOT_READY');
});
test('FAST8-only provides deadline contingency and removes WAIT from exclusive route',()=>{
  const src=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  const start=src.indexOf('function fast8ExclusiveSignalPayload(');
  const end=src.indexOf('function productionSignalPayload(',start);
  assert.ok(start>=0 && end>start);
  const exclusive=src.slice(start,end);
  assert.match(src,/PRODUCTION_SIGNAL_SOURCE_MODE \|\| FAST8_MODE/);
  assert.match(src,/PRODUCTION_SIGNAL_SOURCE_MODE === FAST8_MODE && live.source !== FAST8_SOURCE/);
  assert.match(src,/return fast8ExclusiveSignalPayload\(row, expectedRound, now\)/);
  assert.match(src,/function buildLockedSignalEnvelope\(row, live\) \{\s*if \(PRODUCTION_SIGNAL_SOURCE_MODE === FAST8_MODE/);
  assert.match(src,/productionSignalSourceMode:PRODUCTION_SIGNAL_SOURCE_MODE/);
  assert.match(exclusive,/FAST8_GATEWAY_FALLBACK_AT_MS/);
  assert.match(exclusive,/fast8_gateway_contingency_lock/);
  assert.match(exclusive,/status:'PENDING'/);
  assert.doesNotMatch(exclusive,/status:'WAIT'/);
  assert.equal(FAST8_SOURCE,'ZL_FAST8_65_PRIMARY');
  assert.equal(FAST8_MODE,'FAST8_ONLY');
});

test('fresh pre-round market snapshot matches worker and is flagged as unverified cross-round PM',()=>{
  const {stats,latest}=mock();
  latest.signal.maxEventTimeMs=R-248;
  latest.signal.maxReceivedAtMs=R-155;
  latest.signal.capturedAtMs=R-154;
  latest.signal.fallbackLevel='MOMENTUM60_BASELINE';
  const ready=fast8ProductionReadiness(stats,latest,R,now);
  assert.equal(ready.eligible,true);
  assert.equal(ready.preview.direction,'UP');
  assert.equal(ready.preview.fallbackUsed,true);
  assert.ok(ready.preview.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
  assert.ok(ready.preview.dataQuality.includes('PM_ROUND_ALIGNMENT_UNVERIFIED_FOR_REUSED_SNAPSHOT'));
});

test('pre-round snapshots older than the worker window and post-cutoff samples are rejected',()=>{
  const {stats,latest}=mock();
  latest.signal.maxEventTimeMs=R-3001;
  latest.signal.maxReceivedAtMs=R-3000;
  latest.signal.capturedAtMs=R-2999;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');

  latest.signal.maxEventTimeMs=R+1440;
  latest.signal.maxReceivedAtMs=R+1530;
  latest.signal.capturedAtMs=R+1540;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');

  latest.signal.maxEventTimeMs=R+1440;
  latest.signal.maxReceivedAtMs=R+1450;
  latest.signal.capturedAtMs=R+1490;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).eligible,true);

  latest.signal.maxEventTimeMs=R+1460;
  latest.signal.maxReceivedAtMs=R+1440;
  assert.equal(fast8ProductionReadiness(stats,latest,R,now).reason,'FAST8_SIGNAL_LATE_OR_UNVERIFIED');
});
