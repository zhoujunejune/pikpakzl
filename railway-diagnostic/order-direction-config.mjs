// Per-signal execution direction. Redis is the authoritative store across restarts.
import { createClient } from 'redis';
export const DIRECTION_SOURCES = Object.freeze([
  'SELECTIVE_V2_FAST8_PRIMARY',
  'EDGE_RESCUE_FAST8_PRIMARY',
  'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION',
]);
export const DIRECTION_REDIS_KEY = 'trade-control:direction-modes:v1';
const defaults = () => Object.fromEntries(DIRECTION_SOURCES.map(source => [source, 'FORWARD']));
let current = {revision: 0,modes: defaults(),updatedAt: null};
let ready = false;
let error = 'NOT_INITIALIZED';
let client = null;
let connection = null;
let initialization = null;
let updateChain = Promise.resolve();
export function directionConfigSnapshot() {
  return {ready, error: ready ? null : error, revision: current.revision,
    updatedAt: current.updatedAt, modes: {...current.modes}};
}
export function validateDirectionSettings(value) {
  if (!value || typeof value !== 'object' ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.modes || typeof value.modes !== 'object') throw Error('INVALID_DIRECTION_CONFIG');
  for (const source of DIRECTION_SOURCES)
    if (!['FORWARD','INVERSE'].includes(value.modes[source])) throw Error('INVALID_DIRECTION_MODE');
  if (value.updatedAt != null && (typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)))) throw Error('INVALID_DIRECTION_TIMESTAMP');
  return {revision:value.revision,modes:Object.fromEntries(
    DIRECTION_SOURCES.map(source => [source,value.modes[source]])),
    updatedAt:value.updatedAt||null};
}
async function getConnection() {
  const url = String(process.env.SIGNAL_REDIS_URL || '').trim();
  if (!url) throw Error('REDIS_NOT_CONFIGURED');
  if (client?.isReady) return client;
  if (connection) return connection;
  const candidate = createClient({url,disableOfflineQueue:true,
    socket:{connectTimeout:3500,reconnectStrategy:retries =>
      retries>=3?new Error('REDIS_DOWN'):250*(retries+1)}});
  candidate.on('error',()=>{});
  connection=candidate.connect().then(()=>{client=candidate;return candidate}).catch(async err=>{
    connection=null;
    try {await candidate.disconnect()}catch{}
    throw Error('REDIS_CONNECT_FAILED:'+String(err?.code||'UNAVAILABLE'));
  });
  return connection;
}
export async function hydrateDirectionSettings() {
  if (ready) return directionConfigSnapshot();
  if (initialization) return initialization;
  initialization=(async()=>{
    try {
      const db=await getConnection();
      const raw=await db.get(DIRECTION_REDIS_KEY);
      current=raw?validateDirectionSettings(JSON.parse(raw)):{revision:0,modes:defaults(),updatedAt:null};
      ready=true;error=null;
      return directionConfigSnapshot();
    }catch(err){
      ready=false;error=String(err?.message||'REDIS_UNAVAILABLE');throw err;
    }finally{initialization=null}
  })();
  return initialization;
}
export function selectedMode(source) {return current.modes[source]||'FORWARD'}
export async function saveDirectionMode(source,mode) {
  if(!DIRECTION_SOURCES.includes(source)||!['FORWARD','INVERSE'].includes(mode))
    throw new RangeError('INVALID_SIGNAL_SOURCE_OR_MODE');
  const operation=updateChain.catch(()=>{}).then(async()=>{
    if(!ready)throw Error('DIRECTION_CONFIG_NOT_READY');
    if(current.modes[source]===mode)return directionConfigSnapshot();
    const next=validateDirectionSettings({revision:current.revision+1,
      updatedAt:new Date().toISOString(),modes:{...current.modes,[source]:mode}});
    const db=await getConnection();
    await db.set(DIRECTION_REDIS_KEY,JSON.stringify(next));
    current=next;
    return directionConfigSnapshot();
  });
  updateChain=operation.catch(()=>{});
  return operation;
}
