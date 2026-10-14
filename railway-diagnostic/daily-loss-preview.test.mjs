import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = name => fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const page=read('index.mjs'),shell=read('control-shell.mjs');
const wrapper=read('wrapper.mjs'),worker=read('risk-worker.mjs');

test('daily-loss preview has no live card, handler, client or scheduled audit',()=>{
 assert.doesNotMatch(page,/id="dailyLossCard"|id="dailyLossAuditArea"/);
 assert.doesNotMatch(shell,/daily-loss-client\.js|\/api\/daily-loss-limit|\/api\/daily-loss-audit/);
 assert.doesNotMatch(shell,/startDailyLossAuditService\(\)|stopDailyLossAuditService\(\)/);
});
test('independent TP/SL settings, risk scan and existing trading routes remain',()=>{
 assert.match(page,/id="realRiskStatusCard"/);
 assert.match(shell,/tpEditor/);
 assert.match(shell,/slEditor/);
 assert.match(shell,/\/api\/risk-control/);
 assert.match(shell,/\/risk-monitor-client\.js/);
 assert.match(worker,/const tpTriggered = TAKE_PROFIT_ENABLED/);
 assert.match(worker,/const slTriggered = STOP_LOSS_ENABLED/);
 assert.match(wrapper,/async function submitPendingOrder/);
 assert.match(page,/id="tradeInputsCard"/);
});
