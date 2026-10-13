import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EXTERNAL_PRODUCTION_ID,EXTERNAL_PRODUCTION_VERSION,
 chooseExternalFast8WorkerDirection} from './fast8-external-production.mjs';
const ROUND=1791888600000;
const worker=(direction='UP')=>({
 roundStartMs:ROUND,dataQuality:[],fallbackLevel:'MOMENTUM60_BASELINE',
 externalResearch:{version:'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1',fullQuality:true,
  dataQuality:[],sourceAt:ROUND+950,reusedPreRound:false,
  predictions:{FLOW_BOOK_PROXY_V1:{direction,featureCount:9,evidence:'FROZEN_MICROSTRUCTURE_INPUT',fallback:false,strength:0.34}}}
});
test('production selector chooses only external order-flow frozen direction, not prior FAST8 momentum',()=>{
 const r=chooseExternalFast8WorkerDirection(worker('DOWN'),ROUND);
 assert.equal(EXTERNAL_PRODUCTION_ID,'FLOW_BOOK_PROXY_V1');
 assert.equal(r.model,EXTERNAL_PRODUCTION_ID);
 assert.equal(r.modelVersion,EXTERNAL_PRODUCTION_VERSION);
 assert.equal(r.direction,'DOWN');
 assert.equal(r.fallbackUsed,false);
 assert.equal(r.strength,null);
 assert.equal(r.estimatedWinProbability,null);
 assert.equal(chooseExternalFast8WorkerDirection(worker('UP'),ROUND).direction,'UP');
});
test('shadow candidate must be same round and exact version, never fallback to wrong experiment',()=>{
 const r=worker();
 assert.equal(chooseExternalFast8WorkerDirection(r,ROUND+300000),null);
 r.externalResearch.version='UNRELATED';
 assert.equal(chooseExternalFast8WorkerDirection(r,ROUND),null);
 r.externalResearch.version='EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1';
 delete r.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
 assert.equal(chooseExternalFast8WorkerDirection(r,ROUND),null);
});
test('missing data and previous-round timestamps stay honest fallbacks',()=>{
 const r=worker('UP');
 r.externalResearch.fullQuality=false;r.externalResearch.reusedPreRound=true;
 r.externalResearch.dataQuality=['PRE_ROUND_SNAPSHOT_REUSED'];
 const x=chooseExternalFast8WorkerDirection(r,ROUND);
 assert.equal(x.direction,'UP');assert.equal(x.fallbackUsed,true);
 assert.ok(x.dataQuality.includes('PRE_ROUND_SNAPSHOT_REUSED'));
 r.externalResearch.predictions.FLOW_BOOK_PROXY_V1.fallback=true;
 assert.match(chooseExternalFast8WorkerDirection(r,ROUND).fallbackReason,/NO_INFO/);
});
test('production code declares selected external router, one immutable lock, and unchanged transport',()=>{
 const src=fs.readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
 const begin=src.indexOf('function fast8ExclusiveSignalPayload('),end=src.indexOf('function productionSignalPayload(',begin);
 const body=src.slice(begin,end);
 assert.ok(begin>=0&&end>begin);
 assert.match(body,/chooseExternalFast8WorkerDirection/);
 assert.match(body,/model:EXTERNAL_PRODUCTION_ID,modelVersion:EXTERNAL_PRODUCTION_VERSION/);
 assert.match(body,/direction:selected.direction/);
 assert.match(body,/alreadyLocked/);
 assert.match(src,/FAST8_GATEWAY_FALLBACK_AT_MS = 7000/);
 assert.match(body,/status:'PENDING'/);
 assert.doesNotMatch(body,/status:'WAIT'/);
 assert.match(src,/function freezeProductionLock\(/);
 assert.match(src,/emitLockedSignal\(row, live\)/);
 assert.match(src,/locked_signal_redis_published/);
});
