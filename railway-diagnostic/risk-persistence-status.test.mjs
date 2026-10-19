import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const storage=file('risk-config-storage.mjs');
const control=file('control-shell.mjs');
const runner=file('risk-runner.mjs');
const worker=file('risk-worker.mjs');
const page=file('index.mjs');
const wrapper=file('wrapper.mjs');

test('risk configuration validator rejects damaged saved settings and retains both independent values',()=>{
 const begin=storage.indexOf('export function validatedRiskConfig(value) {');
 const end=storage.indexOf('\nfunction writeLocal',begin);
 assert.ok(begin>=0 && end>begin);
 const fn=vm.runInNewContext(storage.slice(begin,end).replace('export ','')+'\nvalidatedRiskConfig');
 const valid={takeProfitEnabled:false,takeProfitPercent:37.5,stopLossEnabled:true,stopLossPercent:15,updatedAt:'2026-10-11T00:00:00.000Z'};
 const saved=fn(valid);
 assert.equal(saved.takeProfitPercent,37.5);
 assert.equal(saved.stopLossPercent,15);
 assert.equal(saved.stopLossEnabled,true);
 assert.throws(()=>fn({...valid,takeProfitPercent:0}),/INVALID_RISK_CONFIG_PERCENT/);
 assert.throws(()=>fn({...valid,stopLossPercent:120}),/INVALID_RISK_CONFIG_PERCENT/);
 assert.throws(()=>fn({...valid,stopLossEnabled:'false'}),/INVALID_RISK_CONFIG_BOOLEAN/);
 assert.throws(()=>fn({...valid,updatedAt:'invalid-date'}),/INVALID_RISK_CONFIG_DATE/);
});

test('risk config is Redis authoritative, validated, atomic locally and no successful edit response until persisted',()=>{
 assert.match(storage,/SIGNAL_REDIS_URL/);
 assert.match(storage,/db\.set\(RISK_REDIS_KEY, JSON\.stringify\(data\)\)/);
 assert.match(storage,/writeLocal\(data\)/);
 assert.ok(storage.indexOf('await db.set(RISK_REDIS_KEY, JSON.stringify(data))')<storage.indexOf('writeLocal(data)'));
 assert.match(storage,/fs\.renameSync\(temporary, RISK_CONFIG_FILE\)/);
 assert.match(control,/await persistRiskConfig\(payload\)/);
 assert.match(control,/serializedRiskWrite/);
 assert.match(control,/persistenceReady \|\| !persistenceHealthy/);
 assert.match(control,/source: persistenceHealthy && persistenceRestored \? 'redis' : 'runtime'/);
 assert.match(runner,/await hydrateRiskConfig\(\)/);
 assert.match(runner,/if \(!storageReady\) return;/);
 assert.match(runner,/const syncTimer = setInterval/);
 assert.match(control,/const persistenceSyncTimer = setInterval/);
});

test('internal worker telemetry may continue but redundant status endpoint and UI are retired',()=>{
 assert.match(runner,/const STATUS_FILE = process\.env\.RISK_STATUS_FILE \|\| '\/tmp\/risk-runtime-status\.json'/);
 assert.match(runner,/workerRunning: running/);
 assert.match(runner,/configApplied:/);
 assert.match(runner,/persistenceHealthy: storageHealthy/);
 assert.doesNotMatch(control,/url\.pathname === '\/api\/risk-runtime-status'/);
 assert.doesNotMatch(control,/RISK_MONITOR_STATUS_UNAVAILABLE|riskLiveStatus/);
 assert.doesNotMatch(page,/quickRiskState|realRiskStatusCard/);
 assert.match(control,/url\.pathname === '\/api\/risk-control'/);
});

test('authenticated login and existing order/strategy controls remain unchanged',()=>{
 assert.match(control,/x-zl-verified-login/);
 assert.match(page,/id="tradeInputsCard"/);
 assert.match(page,/id="riskControlsAnchor"/);
 assert.match(wrapper,/AUTO_CONFIRM_ENABLED/);
 assert.match(wrapper,/submitPendingOrder/);
 assert.match(page,/async function confirmOrder/);
 assert.match(worker,/const tpTriggered = TAKE_PROFIT_ENABLED/);
 assert.match(worker,/const slTriggered = STOP_LOSS_ENABLED/);
});

test('only monitoring and persistence are wired: no new automatic financial fuse',()=>{
 assert.doesNotMatch(runner,/DAILY_LOSS_HALT|MAX_DAILY_TRADES|AUTO_MAX_LOSS/);
 assert.doesNotMatch(control,/DAILY_LOSS_HALT|MAX_DAILY_TRADES|AUTO_MAX_LOSS/);
 assert.match(page,/id="tradeInputsCard"/);
 assert.match(page,/id="riskControlsAnchor"/);
});
