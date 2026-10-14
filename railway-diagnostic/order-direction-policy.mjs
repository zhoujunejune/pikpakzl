import crypto from 'node:crypto';
import {createClient} from 'redis';

// One persisted FORWARD/INVERSE choice for each production signal source.
export const ORDER_DIRECTION_POLICY='SOURCE_MODE_3WAY_V3';
export const PRIMARY_SOURCE='SELECTIVE_V2_FAST8_PRIMARY';
export const RESCUE_SOURCE='EDGE_RESCUE_FAST8_PRIMARY';
export const LOW_CONFIDENCE_SOURCE='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';
export const ORDER_SOURCES=[PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE];
export const ORDER_MODE_REDIS_KEY='trade-control:direction-mode:v3';
const defaults=()=>Object.fromEntries(ORDER_SOURCES.map(s=>[s,'FORWARD']));
let state={ready:false,modes:defaults(),revision:'uninitialized',updatedAt:null};
let redis=null,opening=null,writing=false;

export function validateDirectionModes(modes){
  if (!modes||typeof modes!=='object'||Array.isArray(modes)) throw Error('INVALID_MODES');
  const clean={};
  for(const source of ORDER_SOURCES){
    if(modes[source]!=='FORWARD'&&modes[source]!=='INVERSE')throw Error('INVALID_MODE_'+source);
    clean[source]=modes[source];
  }
  if(Object.keys(modes).some(k=>!ORDER_SOURCES.includes(k)))throw Error('INVALID_SOURCE');
  return clean;
}
export function applyDirectionSettings(saved){
  const modes=validateDirectionModes(saved?.modes);
  const revision=String(saved?.revision||'');
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(revision))throw Error('INVALID_REVISION');
  const updatedAt=saved.updatedAt??null;
  if(updatedAt!==null&&!Number.isFinite(Date.parse(updatedAt)))throw Error('INVALID_DATE');
  state={ready:true,modes,revision,updatedAt};
  return directionSettingsSnapshot();
}
export function directionSettingsSnapshot(){
  return {...state,modes:{...state.modes},policy:state.ready?ORDER_DIRECTION_POLICY+':'+state.revision:null};
}
async function client(){
  const url=String(process.env.SIGNAL_REDIS_URL||'').trim();
  if(!url)throw Error('DIRECTION_REDIS_URL_MISSING');
  if(redis?.isReady)return redis;
  if(!opening){
    const temp=createClient({url,disableOfflineQueue:true,socket:{
      connectTimeout:3500,reconnectStrategy:n=>n>=3?new Error('REDIS_UNAVAILABLE'):250*(n+1)}});
    temp.on('error',()=>{});
    opening=temp.connect().then(()=>{redis=temp;return redis}).catch(async err=>{
      opening=null;try{await temp.disconnect()}catch{}
      throw Error('DIRECTION_REDIS_CONNECT_FAILED:'+String(err?.code||err?.message||err));
    });
  }
  return opening;
}
export async function hydrateDirectionSettings(){
  const db=await client();
  const raw=await db.get(ORDER_MODE_REDIS_KEY);
  return applyDirectionSettings(raw?JSON.parse(raw):{modes:defaults(),revision:'initial',updatedAt:null});
}
export async function setDirectionMode(source,mode){
  if(!ORDER_SOURCES.includes(source))throw Error('INVALID_SOURCE');
  if(mode!=='FORWARD'&&mode!=='INVERSE')throw Error('INVALID_MODE');
  if(!state.ready)throw Error('DIRECTION_NOT_READY');
  if(writing)throw Error('DIRECTION_UPDATE_IN_PROGRESS');
  if(state.modes[source]===mode)return {changed:false,...directionSettingsSnapshot()};
  writing=true;
  try{
    const db=await client();
    const saved={modes:{...state.modes,[source]:mode},revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};
    await db.set(ORDER_MODE_REDIS_KEY,JSON.stringify(saved));
    applyDirectionSettings(saved);
    return {changed:true,...directionSettingsSnapshot()};
  }finally{writing=false}
}
export function orderDirectionForProduction(direction,source=null){
  if(!state.ready||(direction!=='UP'&&direction!=='DOWN'))return null;
  return state.modes[source]==='INVERSE'?(direction==='UP'?'DOWN':'UP'):direction;
}
export function mappedOrderSignal(signal){
  const productionSignal=signal?.status==='LOCKED'?signal.direction:null;
  const productionSource=signal?.source??signal?.upstreamSource??null;
  const orderSignal=orderDirectionForProduction(productionSignal,productionSource);
  return {productionSignal,productionSource,orderSignal,action:orderSignal===null?null:'BUY_'+orderSignal,
    mappingMode:state.modes[productionSource]==='INVERSE'?'INVERSE':'FORWARD',
    mappingPolicy:state.ready?ORDER_DIRECTION_POLICY+':'+state.revision:null};
}
export function pendingOrderMatchesProduction(pending,liveSignal){
  if(!pending||!liveSignal||liveSignal.status!=='LOCKED'||String(liveSignal.round)!==String(pending.round))return false;
  const m=mappedOrderSignal(liveSignal);
  return m.orderSignal!==null&&pending.productionSignal===m.productionSignal&&
    pending.productionSource===m.productionSource&&pending.orderSignal===m.orderSignal&&
    pending.signal===m.orderSignal&&pending.action===m.action&&
    pending.mappingMode===m.mappingMode&&pending.orderDirectionPolicy===m.mappingPolicy;
}
