import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CONTROL_FILE = '/tmp/risk-control.json';
const CHECK_MS = 300;

function envBool(name, fallback = 'false') {
  return !['0', 'false', 'off', 'no'].includes(String(process.env[name] || fallback).toLowerCase());
}

function envPercent(name, fallback = 50) {
  const n = Number(process.env[name] || fallback);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback;
}

function defaultConfig() {
  return {
    takeProfitEnabled: envBool('AUTO_TAKE_PROFIT_ENABLED', 'false'),
    takeProfitPercent: envPercent('AUTO_TAKE_PROFIT_PERCENT', 50),
    stopLossEnabled: envBool('AUTO_STOP_LOSS_ENABLED', 'false'),
    stopLossPercent: envPercent('AUTO_STOP_LOSS_PERCENT', 50),
    source: 'env',
    updatedAt: null,
  };
}

function readConfig() {
  const fallback = defaultConfig();
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
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(JSON.stringify({ event: 'risk_runtime_config_read_failed', error: e?.message || String(e) }));
    return fallback;
  }
}

function configKey(cfg) {
  return `${cfg.takeProfitEnabled ? 'tp1' : 'tp0'}:${cfg.takeProfitPercent}:${cfg.stopLossEnabled ? 'sl1' : 'sl0'}:${cfg.stopLossPercent}`;
}

let child = null;
let childKey = null;
let desired = readConfig();
let stopping = false;

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, controller: 'risk-runner', at: new Date().toISOString(), ...extra }));
}

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
  log('risk_runtime_worker_started', {
    takeProfitEnabled: cfg.takeProfitEnabled,
    takeProfitPercent: cfg.takeProfitPercent,
    stopLossEnabled: cfg.stopLossEnabled,
    stopLossPercent: cfg.stopLossPercent,
    pid: child.pid,
  });
  child.on('exit', (code, signal) => {
    log('risk_runtime_worker_exited', { code, signal, previousKey: childKey });
    child = null;
    childKey = null;
    if (!stopping) setTimeout(reconcile, 0);
  });
}

function reconcile() {
  desired = readConfig();
  const enabled = desired.takeProfitEnabled || desired.stopLossEnabled;
  const wantedKey = configKey(desired);
  if (child) {
    if (!enabled || childKey !== wantedKey) {
      log('risk_worker_stopping', { reason: !enabled ? 'DISABLED' : 'CONFIG_CHANGED', from: childKey, to: wantedKey });
      child.kill('SIGTERM');
    }
    return;
  }
  if (enabled) startWorker(desired);
}

log('risk_runtime_controller_started', {
  controlFile: CONTROL_FILE,
  checkMs: CHECK_MS,
  ...desired,
});

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
