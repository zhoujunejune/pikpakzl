// Shared persistence for the UI configuration (not the prediction/trade decision logic).
// Redis is the authoritative store across Railway container replacements.
import fs from 'node:fs';
import { createClient } from 'redis';

export const RISK_CONFIG_FILE = process.env.RISK_CONTROL_FILE || '/tmp/risk-control.json';
export const RISK_REDIS_KEY = 'trade-control:risk-config:v1';
let client = null;
let connecting = null;

export function validatedRiskConfig(value) {
  if (!value || typeof value !== 'object' ||
      typeof value.takeProfitEnabled !== 'boolean' ||
      typeof value.stopLossEnabled !== 'boolean') throw new Error('INVALID_RISK_CONFIG_BOOLEAN');
  const tp = Number(value.takeProfitPercent);
  const sl = Number(value.stopLossPercent);
  if (!Number.isFinite(tp) || tp < 1 || tp > 100 ||
      !Number.isFinite(sl) || sl < 1 || sl > 100) throw new Error('INVALID_RISK_CONFIG_PERCENT');
  if(value.dynamicExitEnabled!==undefined&&typeof value.dynamicExitEnabled!=='boolean') throw new Error('INVALID_DYNAMIC_EXIT_BOOLEAN');
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('INVALID_RISK_CONFIG_DATE');
  return {
    takeProfitEnabled: value.takeProfitEnabled,
    takeProfitPercent: tp,
    stopLossEnabled: value.stopLossEnabled,
    stopLossPercent: sl,
    dynamicExitEnabled: value.dynamicExitEnabled === true,
    updatedAt: value.updatedAt,
  };
}

function writeLocal(config) {
  const serialized = JSON.stringify(config);
  try {
    if (fs.readFileSync(RISK_CONFIG_FILE, 'utf8') === serialized) return;
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const temporary = RISK_CONFIG_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, serialized, 'utf8');
  fs.renameSync(temporary, RISK_CONFIG_FILE);
}

async function redisClient() {
  const url = String(process.env.SIGNAL_REDIS_URL || '').trim();
  if (!url) throw new Error('RISK_REDIS_URL_NOT_CONFIGURED');
  if (client?.isReady) return client;
  if (!connecting) {
    const candidate = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 3500, reconnectStrategy: retries =>
        retries >= 3 ? new Error('RISK_REDIS_UNAVAILABLE') : 250 * (retries + 1) },
    });
    candidate.on('error', () => {}); // prevent socket errors from crashing the process; callers handle failures.
    connecting = candidate.connect().then(() => {
      client = candidate;
      return client;
    }).catch(async error => {
      connecting = null;
      try { if (typeof candidate.disconnect === 'function') await candidate.disconnect(); else if (typeof candidate.destroy === 'function') candidate.destroy(); } catch {}
      throw new Error('RISK_REDIS_CONNECT_FAILED:' + String(error?.code || error?.message || 'UNKNOWN'));
    });
  }
  return connecting;
}

export async function hydrateRiskConfig() {
  const db = await redisClient();
  const raw = await db.get(RISK_REDIS_KEY);
  if (!raw) return { ok: true, restored: false };
  const restored = validatedRiskConfig(JSON.parse(raw));
  writeLocal(restored);
  return { ok: true, restored: true, updatedAt: restored.updatedAt };
}

export async function persistRiskConfig(next) {
  const data = validatedRiskConfig(next);
  const db = await redisClient();
  await db.set(RISK_REDIS_KEY, JSON.stringify(data));
  writeLocal(data);
  return { ...data, source: 'redis' };
}

export async function closeRiskStorage() {
  if (client) {
    try { await client.quit(); } catch {}
    client = null;
    connecting = null;
  }
}
