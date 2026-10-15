import crypto from 'node:crypto';
import {createClient} from 'redis';

// FAST8: six independently persisted source × original-prediction-side modes.
export const ORDER_DIRECTION_POLICY='SOURCE_SIDE_3WAY_V4';
export const PRIMARY_SOURCE='SELECTIVE_V2_FAST8_PRIMARY';
export const RESCUE_SOURCE='EDGE_RESCUE_FAST8_PRIMARY';
export const LOW_CONFIDENCE_SOURCE='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';
export const ORDER_SOURCES=[PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE];
export const ORDER_MODE_REDIS_KEY='trade-control:direction-mode:v4';
export const LEGACY_ORDER_MODE_REDIS_KEY='trade-control:direction-mode:v3';
const SIDES=['UP','DOWN'];
const MODE_VALUES=['FORWARD','INVERSE','OFF'];
let state={ready:false,modes:{},revision:null,updatedAt:null,effectiveAfterRound:null};
let redis=null,opening=null,writing=false;

export function validateDirectionModes(modes){
  if(!modes||typeof modes!=='object'||Array.isArray(modes))throw Error('INVALID_MODES');
  const clean={};
  if(Object.keys(modes).length!==ORDER_SOURCES.length)throw Error('INVALID_SOURCE_COUNT');
  for(const source of ORDER_SOURCES){
    const obj=modes[source];
    if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).length!==2)throw Error('INVALID_SIDES_'+source);
    for(const side of SIDES)if(!MODE_VALUES.includes(obj[side]))throw Error('INVALID_MODE_'+source+'_'+side);
    clean[source]={UP:obj.UP,DOWN:obj.DOWN};
  }
  if(Object.keys(modes).some(k=>!ORDER_SOURCES.includes(k)))throw Error('INVALID_SOURCE');
  return clean;
}

export function migrateLegacyModes(modes){
  if(!modes||typeof modes!=='object'||Array.isArray(modes)||
      Object.keys(modes).length!==ORDER_SOURCES.length)throw Error('INVALID_LEGACY_MODES');
  const next={};
  for(const source of ORDER_SOURCES){
    if(!['FORWARD','INVERSE'].includes(modes[source]))throw Error('INVALID_LEGACY_MODE_'+source);
    next[source]={UP:modes[source],DOWN:modes[source]};
  }
  if(Object.keys(modes).some(k=>!ORDER_SOURCES.includes(k)))throw Error('INVALID_LEGACY_SOURCE');
  return next;
}

export function directionSettingsSnapshot(){
  return {...state,modes:Object.fromEntries(Object.entries(state.modes).map(([k,v])=>[k,{...v}])),
    policy:state.ready?ORDER_DIRECTION_POLICY+':'+state.revision:null};
}
export function applyDirectionSettings(saved){
  const modes=validateDirectionModes(saved?.modes);
  const revision=String(saved?.revision||'');
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(revision))throw Error('INVALID_REVISION');
  const updatedAt=saved.updatedAt??null;
  if(updatedAt!==null&&(typeof updatedAt!=='string'||!Number.isFinite(Date.parse(updatedAt))))throw Error('INVALID_DATE');
  const effectiveAfterRound=saved.effectiveAfterRound??null;
  if(effectiveAfterRound!==null&&(!Number.isSafeInteger(effectiveAfterRound)||effectiveAfterRound<0))throw Error('INVALID_EFFECTIVE_ROUND');
  state={ready:true,modes,revision,updatedAt,effectiveAfterRound};
  return directionSettingsSnapshot();
}
export function invalidateDirectionSettings(){
  state={ready:false,modes:{},revision:null,updatedAt:null,effectiveAfterRound:null};
}

async function client(){
  const url=String(process.env.SIGNAL_REDIS_URL||'').trim();
  if(!url)throw Error('DIRECTION_REDIS_URL_MISSING');
  if(redis?.isReady)return redis;
  if(redis?.isOpen&&!redis?.isReady)throw Error('DIRECTION_REDIS_NOT_READY');
  if(!opening){
    const temp=createClient({url,disableOfflineQueue:true,socket:{
      connectTimeout:3500,reconnectStrategy:n=>n>=3?new Error('REDIS_UNAVAILABLE'):250*(n+1)}});
    temp.on('error',()=>{if(!temp.isReady)invalidateDirectionSettings()});
    temp.on('end',()=>invalidateDirectionSettings());
    opening=temp.connect().then(()=>{redis=temp;opening=null;return redis}).catch(async err=>{
      opening=null;try{await temp.disconnect()}catch{}
      throw Error('DIRECTION_REDIS_CONNECT_FAILED:'+String(err?.code||err?.message||err));
    });
  }
  return opening;
}

// A v4 key is authoritative; migration is atomic and never silently invents defaults.
export async function hydrateDirectionSettings(){
  try{
    const db=await client();
    let raw=await db.get(ORDER_MODE_REDIS_KEY);
    if(!raw){
      const legacyRaw=await db.get(LEGACY_ORDER_MODE_REDIS_KEY);
      if(!legacyRaw)throw Error('DIRECTION_CONFIGURATION_MISSING');
      const legacy=JSON.parse(legacyRaw);
      const modes=migrateLegacyModes(legacy?.modes);
      const migrated={modes,revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};
      const proposed=JSON.stringify(migrated);
      const created=await db.set(ORDER_MODE_REDIS_KEY,proposed,{NX:true});
      raw=created==='OK'?proposed:await db.get(ORDER_MODE_REDIS_KEY);
    }
    if(!raw)throw Error('DIRECTION_CONFIGURATION_MISSING');
    return applyDirectionSettings(JSON.parse(raw));
  }catch(err){invalidateDirectionSettings();throw err}
}

// Refresh from the shared Redis authority to detect changes made on other instances.
export async function refreshDirectionSettings(){return hydrateDirectionSettings()}

// Redis Lua CAS prevents simultaneous writes from losing another client's edits.
const CAS_SCRIPT="local cur=redis.call('GET',KEYS[1]); if not cur then return 'MISSING' end; if cur~=ARGV[1] then return 'CONFLICT' end; redis.call('SET',KEYS[1],ARGV[2]); return 'OK'";
export async function setDirectionMode(source,direction,mode,expectedRevision,effectiveAfterRound=null){
  if(!ORDER_SOURCES.includes(source))throw Error('INVALID_SOURCE');
  if(!SIDES.includes(direction))throw Error('INVALID_DIRECTION');
  if(!MODE_VALUES.includes(mode))throw Error('INVALID_MODE');
  if(typeof expectedRevision!=='string'||!expectedRevision)throw Error('INVALID_EXPECTED_REVISION');
  if(effectiveAfterRound!==null&&(!Number.isSafeInteger(effectiveAfterRound)||effectiveAfterRound<0))throw Error('INVALID_EFFECTIVE_ROUND');
  if(writing)throw Error('DIRECTION_UPDATE_IN_PROGRESS');
  writing=true;
  try{
    const db=await client();
    const raw=await db.get(ORDER_MODE_REDIS_KEY);
    if(!raw)throw Error('DIRECTION_CONFIGURATION_MISSING');
    const saved=JSON.parse(raw);
    applyDirectionSettings(saved);
    if(saved.revision!==expectedRevision)throw Error('DIRECTION_REVISION_CONFLICT');
    if(saved.modes[source][direction]===mode)return {changed:false,...directionSettingsSnapshot()};
    const updated={modes:{...saved.modes,[source]:{...saved.modes[source],[direction]:mode}},
      revision:crypto.randomUUID(),updatedAt:new Date().toISOString(),effectiveAfterRound};
    const result=await db.eval(CAS_SCRIPT,{keys:[ORDER_MODE_REDIS_KEY],arguments:[raw,JSON.stringify(updated)]});
    if(result!=='OK')throw Error(result==='CONFLICT'?'DIRECTION_REVISION_CONFLICT':'DIRECTION_CONFIGURATION_MISSING');
    return {changed:true,...applyDirectionSettings(updated)};
  }catch(err){
    if(!String(err?.message||err).includes('DIRECTION_REVISION_CONFLICT')&&
       !String(err?.message||err).startsWith('INVALID_'))invalidateDirectionSettings();
    throw err;
  }finally{writing=false}
}

export function orderDirectionForProduction(direction,source=null){
  if(!state.ready||!SIDES.includes(direction)||!ORDER_SOURCES.includes(source))return null;
  const mode=state.modes[source]?.[direction];
  if(mode==='OFF')return null;
  if(mode==='INVERSE')return direction==='UP'?'DOWN':'UP';
  return mode==='FORWARD'?direction:null;
}
export function mappedOrderSignal(signal){
  const productionSignal=signal?.status==='LOCKED'?signal.direction:null;
  const productionSource=signal?.source??signal?.upstreamSource??null;
  const valid=signal?.executionEligible!==false;
  const orderSignal=valid?orderDirectionForProduction(productionSignal,productionSource):null;
  const mappingMode=state.ready&&ORDER_SOURCES.includes(productionSource)&&SIDES.includes(productionSignal)
    ?state.modes[productionSource]?.[productionSignal]??'OFF':'OFF';
  return {productionSignal,productionSource,orderSignal,action:orderSignal===null?null:'BUY_'+orderSignal,
    mappingMode,mappingPolicy:state.ready?ORDER_DIRECTION_POLICY+':'+state.revision:null};
}
export function pendingOrderMatchesProduction(pending,liveSignal){
  if(!pending||!liveSignal||liveSignal.status!=='LOCKED'||liveSignal.executionEligible===false||
     String(liveSignal.round)!==String(pending.round))return false;
  const m=mappedOrderSignal(liveSignal);
  return m.orderSignal!==null&&pending.productionSignal===m.productionSignal&&
    pending.productionSource===m.productionSource&&pending.orderSignal===m.orderSignal&&
    pending.signal===m.orderSignal&&pending.action===m.action&&
    pending.mappingMode===m.mappingMode&&pending.orderDirectionPolicy===m.mappingPolicy;
}
