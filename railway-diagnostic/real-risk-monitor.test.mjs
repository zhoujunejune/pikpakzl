import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('./' + path, import.meta.url), 'utf8');
const index = read('index.mjs');
const shell = read('control-shell.mjs');
const runner = read('risk-runner.mjs');
const worker = read('risk-worker.mjs');
const client = read('wrapper.mjs');

test('retired real-risk status monitoring has no UI, standalone browser script or backend API route', () => {
  for (const marker of [
    'realRiskStatusCard', 'realRiskHeadline', 'realRiskScan', 'realRiskQuote',
    'quickRiskState', '交易风控 · 真实运行状态'
  ]) assert.equal(index.includes(marker), false, marker);
  assert.doesNotMatch(shell, /risk-monitor-client\.js|\/api\/risk-runtime-status|runtimeStatus\(\)|riskLiveStatus/);
});

test('TP/SL settings and execution worker remain unchanged and available', () => {
  assert.match(shell, /url\.pathname === '\/api\/risk-control'/);
  assert.match(shell, /takeProfitEnabled/);
  assert.match(shell, /stopLossEnabled/);
  assert.match(shell, /\$\{riskCards\}\$\{marker\}/);
  assert.match(shell, /\$\{riskScript\}<\/body>/);
  assert.match(runner, /\['risk-worker\.mjs'\]/);
  assert.match(worker, /risk_sell_submitted/);
  assert.match(client, /submitPendingOrder/);
  assert.match(index, /id="confirmBtn"/);
  assert.match(index, /id="riskControlsAnchor"/);
});

test('monitoring removal does not add order placement or change the signal path', () => {
  assert.doesNotMatch(shell, /place-order-bundle/);
  assert.match(index, /locked_signal_websocket_connected/);
  assert.match(index, /signalTransport/);
});
