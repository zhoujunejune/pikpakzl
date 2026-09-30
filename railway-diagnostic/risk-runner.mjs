import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CONTROL_FILE = '/tmp/risk-control.json';
const CHECK_MS = 300;

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function percentEnv(name, fallback = 50) {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback;
}

function fallbackConfig() {
  return {
    takeProfitEnabled: boolEnv('AUTO_TAKE_PROFIT_ENABLED', false),
    takeProfitPercent: percentEnv('AUTO_TAKE_PROFIT_PERCENT', 50),
    stopLossEnabled: boolEnv('AUTO_STOP_LOSS_ENABLED', false),
    stopLossPercent: percentEnv('AUTO_STOP_LOSS_PERCENT', 50),
    source: 'env',
  };
}

function readConfig() {
  const fallback = fallbackConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    const tp = Number(parsed?.takeProfitPercent);
    const sl = Number(parsed?.stopLossPercent);
    return {
      takeProfitEnabled: Boolean(parsed?.takeProfitEnabled),
      takeProfitPercent: Number.isFinite(tp) && tp >= 1 && tp <= 100 ? tp : fallback.takeProfitPercent,
      stopLossEnabled: Boolean(parsed?.stopLossEnabled),
      stopLossPercent: Number.isFinite(sl) && sl >= 1 && sl <= 100 ? sl : fallback.stopLossPercent,
      source: 'runtime',
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(JSON.stringify({ event: 'risk_runtime_config_read_failed', error: e?.message || String(e) }));
    return fallback;
  }
}

function configKey(c) {
  return [c.takeProfitEnabled ? 'tp1' : 'tp0', c.takeProfitPercent, c.stopLossEnabled ? 'sl1' : 'sl0', c.stopLossPercent].join(':');
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, controller: 'risk-runner', at: new Date().toISOString(), ...extra }));
}

let child = null;
let childKey = null;
let stopping = false;

function startWorker(cfg) {
  childKey = configKey(cfg);
  child = spawn(process.execPath, ['risk-worker.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTO_TAKE_PROFIT_ENABLED: cfg.takeProfitEnabled ? 'true' : 'false',
      AUTO_TAKE_PROFIT_PERCENT: String(cfg.takeProfitPercent),
      AUTO_STOP_LOSS_ENABLED: cfg.stopLossEnabled ? 'true' : 'false',
      AUTO_STOP_LOSS_PERCENT: String(cfg.stopLossPercent),
    },
    stdio: 'inherit',
  });
  log('risk_worker_started', { pid: child.pid, ...cfg });
  child.on('exit', (code, signal) => {
    log('risk_worker_exited', { code, signal, previousKey: childKey });
    child = null;
    childKey = null;
    if (!stopping) setTimeout(reconcile, 0);
  });
}

function reconcile() {
  const cfg = readConfig();
  const wanted = configKey(cfg);
  const anyEnabled = cfg.takeProfitEnabled || cfg.stopLossEnabled;

  if (child) {
    if (!anyEnabled || childKey !== wanted) {
      log('risk_worker_stopping', { reason: !anyEnabled ? 'ALL_DISABLED' : 'CONFIG_CHANGED', from: childKey, to: wanted });
      child.kill('SIGTERM');
    }
    return;
  }
  if (anyEnabled) startWorker(cfg);
}

const initial = readConfig();
log('risk_runtime_controller_started', { controlFile: CONTROL_FILE, checkMs: CHECK_MS, ...initial });
const timer = setInterval(reconcile, CHECK_MS);
reconcile();

function shutdown(signal) {
  stopping = true;
  clearInterval(timer);
  if (child) child.kill('SIGTERM');
  log('risk_runtime_controller_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
