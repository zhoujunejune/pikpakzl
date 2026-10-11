// Draft daily-loss guardrail settings only. DO NOT use this module to block/submit trades.
// The official settled daily PnL must be independently validated before activation.
import { createClient } from 'redis';

export const DAILY_LOSS_DRAFT_KEY = 'trade-control:daily-loss-draft:v1';
export const DAILY_LOSS_MODE = 'OBSERVE_ONLY';
export const DAILY_LOSS_TZ = 'Asia/Shanghai';
let redis = null;
let pending = null;

export function normalizeDailyLossDraft(input) {
  // Require finite positive numbers with no more than two decimal places.
  // Do not silently truncate the amount or coerce empty strings/booleans.
  const raw = input && input.dailyLimitUsdt;
  if (!(typeof raw === 'string' || typeof raw === 'number')) throw new RangeError('请输入每日最大亏损 USDT 金额');
  const text = String(raw).trim();
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(text)) throw new RangeError('金额必须是最多两位小数的正数');
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10000000) throw new RangeError('每日最大亏损只能设置为 0.01—100000 USDT');
  return { dailyLimitUsdt: cents / 100, updatedAt: new Date().toISOString(), timezone: DAILY_LOSS_TZ, mode: DAILY_LOSS_MODE };
}

function decodeDraft(raw) {
  if (!raw) return null;
  const data = JSON.parse(raw);
  const validated = normalizeDailyLossDraft({dailyLimitUsdt:data?.dailyLimitUsdt});
  if (data?.mode !== DAILY_LOSS_MODE || data?.timezone !== DAILY_LOSS_TZ ||
      typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)))
    throw new Error('DAILY_LOSS_DRAFT_INVALID');
  if (data.monitorEnabled !== undefined && typeof data.monitorEnabled !== 'boolean') throw new Error('DAILY_LOSS_MONITOR_INVALID');
  return {...validated,updatedAt:data.updatedAt,monitorEnabled:data.monitorEnabled === true};
}

async function client() {
  const url = String(process.env.SIGNAL_REDIS_URL || '').trim();
  if (!url) throw new Error('DAILY_LOSS_REDIS_NOT_CONFIGURED');
  if (redis?.isReady) return redis;
  if (!pending) {
    const candidate = createClient({
      url, disableOfflineQueue:true,
      socket:{connectTimeout:3500,reconnectStrategy:n=>n>=3?new Error('DAILY_LOSS_REDIS_UNAVAILABLE'):250*(n+1)},
    });
    candidate.on('error',()=>{});
    pending = candidate.connect().then(() => { redis=candidate; return redis; })
      .catch(async e=>{pending=null;try{await candidate.disconnect();}catch{}throw new Error('DAILY_LOSS_REDIS_UNAVAILABLE');});
  }
  return pending;
}

export async function getDailyLossDraft() {
  const db=await client();
  return decodeDraft(await db.get(DAILY_LOSS_DRAFT_KEY));
}

export async function saveDailyLossDraft(input) {
  const db=await client();
  const previous=decodeDraft(await db.get(DAILY_LOSS_DRAFT_KEY));
  const data={...normalizeDailyLossDraft(input),monitorEnabled:previous?.monitorEnabled===true};
  await db.set(DAILY_LOSS_DRAFT_KEY,JSON.stringify(data));
  return data;
}

// The switch enables a *draft observation preference*, not live order blocking.
// Callers serialize save/toggle writes so the existing cap is not lost.
export async function setDailyLossMonitoring(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('监控开关必须为布尔值');
  const db=await client();
  const previous=decodeDraft(await db.get(DAILY_LOSS_DRAFT_KEY));
  if (!previous) throw new RangeError('请先保存每日亏损金额，再开启观察开关');
  const data={...previous,monitorEnabled:enabled,updatedAt:new Date().toISOString()};
  await db.set(DAILY_LOSS_DRAFT_KEY,JSON.stringify(data));
  return data;
}
