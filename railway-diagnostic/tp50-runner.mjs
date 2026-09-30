import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CONTROL_FILE = '/tmp/tp50-control.json';
const CHECK_MS = 300;

function envEnabled() {
  return !['0', 'false', 'off', 'no'].includes(String(process.env.AUTO_TAKE_PROFIT_ENABLED || 'false').toLowerCase());
}

function envPercent() {
  const n = Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : 50;
}

function readConfig() {
  const fallback = { enabled: envEnabled(), percent: envPercent(), source: 'env' };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    const percent = Number(parsed?.percent);
    return {
      enabled: Boolean(parsed?.enabled),
      percent: Number.isFinite(percent) && percent >= 1 && percent <= 100 ? percent : fallback.percent,
      source: 'runtime',
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      console.error(JSON.stringify({ event: 'tp50_runtime_config_read_failed', error: e?.message || String(e) }));
    }
    return fallback;
  }
}

function configKey(cfg) {
  return `${cfg.enabled ? 'on' : 'off'}:${cfg.percent}`;
}

let child = null;
let childKey = null;
let desired = readConfig();
let stopping = false;

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, controller: 'tp50-runner', at: new Date().toISOString(), ...extra }));
}

function startWorker(cfg) {
  const key = configKey(cfg);
  childKey = key;
  child = spawn(process.execPath, ['tp50-worker.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTO_TAKE_PROFIT_ENABLED: 'true',
      AUTO_TAKE_PROFIT_PERCENT: String(cfg.percent),
    },
    stdio: 'inherit',
  });

  log('tp50_runtime_worker_started', { enabled: true, percent: cfg.percent, pid: child.pid });

  child.on('exit', (code, signal) => {
    log('tp50_runtime_worker_exited', { code, signal, previousKey: childKey });
    child = null;
    childKey = null;
    if (!stopping) setTimeout(reconcile, 0);
  });
}

function reconcile() {
  desired = readConfig();
  const wantedKey = configKey(desired);

  if (child) {
    if (!desired.enabled || childKey !== wantedKey) {
      log('tp50_runtime_worker_stopping', {
        reason: !desired.enabled ? 'DISABLED' : 'CONFIG_CHANGED',
        from: childKey,
        to: wantedKey,
      });
      child.kill('SIGTERM');
    }
    return;
  }

  if (desired.enabled) startWorker(desired);
}

log('tp50_runtime_controller_started', {
  controlFile: CONTROL_FILE,
  checkMs: CHECK_MS,
  initialEnabled: desired.enabled,
  initialPercent: desired.percent,
  source: desired.source,
});

const timer = setInterval(reconcile, CHECK_MS);
reconcile();

function shutdown(signal) {
  stopping = true;
  clearInterval(timer);
  if (child) child.kill('SIGTERM');
  log('tp50_runtime_controller_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
