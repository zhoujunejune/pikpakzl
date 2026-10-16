// Real-order model selection: separate from research-model viewing selection.
// PIN is enforced at the HTTP layer. Redis CAS guards concurrent browser tabs.
// This module never places orders or edits the upstream Cloudflare/production V2 signal.
import crypto from 'node:crypto';
import {createClient} from 'redis';

export const MODEL_CHOICE_KEY='trade-control:order-signal-choice:v1';
export const BASE_MODEL='BREAKOUT20_RSI_MACD_RANGE_V1';
export const NOVICE_MODEL='NOVICE_MIX_LOW_V1';
export const ORDER_SIGNAL_MODELS=Object.freeze([
 {id:BASE_MODEL,name:'突破20%即可（Cloudflare 生产信号）'},
 {id:NOVICE_MODEL,name:'新手错误混合（独立影子信号）'}
]);
const isChoice=m=>ORDER_SIGNAL_MODELS.some(x=>x.id===m);
const roundOf=t=>Math.floor(t/300000)*300000;
const CAS="local v=redis.call('GET',KEYS[1]); if v~=ARGV[1] then return 'CONFLICT' end; return redis.call('SET',KEYS[1],ARGV[2])";
let client=null,loading=null,updating=false;
let state={ready:false,model:null,revision:null,updatedAt:null,effectiveAfterRound:null,storageError:null};
function apply(raw){
 const x=typeof raw==='string'?JSON.parse(raw):raw;
 if(!isChoice(x?.model))throw Error('INVALID_MODEL_SELECTION');
 if(typeof x?.revision!=='string'||!x.revision)throw Error('INVALID_MODEL_CHOICE_REVISION');
 if(x.effectiveAfterRound!=null&&(!Number.isSafeInteger(x.effectiveAfterRound)||x.effectiveAfterRound<=0))
   throw Error('INVALID_EFFECTIVE_AFTER_ROUND');
 state={ready:true,model:x.model,revision:x.revision,updatedAt:x.updatedAt??null,
   effectiveAfterRound:x.effectiveAfterRound??null,storageError:null};
 return snapshot();
}
export function snapshot(){
 return {...state,models:ORDER_SIGNAL_MODELS.map(x=>({...x})),
   policy:state.ready?'ORDER_SIGNAL_CHOICE_V1:'+state.revision:null};
}
export function selectionPermitsRound(round,s=snapshot()){
 return s.ready===true&&Number.isSafeInteger(round)&&
   (s.effectiveAfterRound==null||round>s.effectiveAfterRound);
}
export function selectedSignalMatches(pending,currentChoice=snapshot()){
 return !!pending&&selectionPermitsRound(Number(pending.round),currentChoice)&&
   pending.signalModelChoice===currentChoice.model&&
   pending.signalModelChoiceRevision===currentChoice.revision;
}
export function invalidate(reason='UNAVAILABLE'){
 state={ready:false,model:null,revision:null,updatedAt:null,effectiveAfterRound:null,
   storageError:reason};
}
async function db(){
 if(client?.isReady)return client;
 const url=String(process.env.SIGNAL_REDIS_URL||'').trim();
 if(!url)throw Error('MODEL_CHOICE_REDIS_MISSING');
 if(loading)return loading;
 loading=(async()=>{
   if(client){try{await client.disconnect()}catch{}client=null;}
   const next=createClient({url,socket:{connectTimeout:2000,reconnectStrategy:()=>false}});
   next.on('error',()=>{});
   next.on('end',()=>invalidate('REDIS_CONNECTION_CLOSED'));
   try{await next.connect();client=next;return next;}
   catch(err){try{await next.disconnect()}catch{};throw err;}
 })().finally(()=>{loading=null});
 return loading;
}
export async function refreshModelSelection(){
 try{
   const redis=await db();
   let raw=await redis.get(MODEL_CHOICE_KEY);
   if(!raw){
     const initial=JSON.stringify({model:BASE_MODEL,revision:crypto.randomUUID(),
       updatedAt:new Date().toISOString(),effectiveAfterRound:null});
     const created=await redis.set(MODEL_CHOICE_KEY,initial,{NX:true});
     raw=created==='OK'?initial:await redis.get(MODEL_CHOICE_KEY);
   }
   if(!raw)throw Error('MODEL_CHOICE_NOT_PERSISTED');
   return apply(raw);
 }catch(err){invalidate(String(err?.message||err).slice(0,150));throw err}
}
export async function setModelSelection(model,expectedRevision,now=Date.now()){
 if(!isChoice(model))throw Error('INVALID_MODEL_CHOICE');
 if(typeof expectedRevision!=='string'||!expectedRevision)throw Error('INVALID_EXPECTED_REVISION');
 if(updating)throw Error('MODEL_CHOICE_UPDATE_IN_PROGRESS');
 updating=true;
 try{
   const redis=await db(),oldRaw=await redis.get(MODEL_CHOICE_KEY);
   if(!oldRaw)throw Error('MODEL_CHOICE_NOT_PERSISTED');
   const old=JSON.parse(oldRaw);
   if(old.revision!==expectedRevision)throw Error('MODEL_CHOICE_REVISION_CONFLICT');
   if(old.model===model)return {changed:false,...apply(old)};
   const value={model,revision:crypto.randomUUID(),updatedAt:new Date(now).toISOString(),
     effectiveAfterRound:roundOf(now)};
   const ok=await redis.eval(CAS,{keys:[MODEL_CHOICE_KEY],arguments:[oldRaw,JSON.stringify(value)]});
   if(ok!=='OK')throw Error('MODEL_CHOICE_REVISION_CONFLICT');
   return {changed:true,...apply(value)};
 }catch(err){
   if(!/INVALID_|CONFLICT|IN_PROGRESS/.test(String(err?.message||err)))invalidate(String(err?.message||err));
   throw err;
 }finally{updating=false}
}
export function validateNoviceSignal(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest;
 if(body?.ok!==true||body?.model!==NOVICE_MODEL||body?.readOnly!==true||
   body?.orders!==false||body?.productionIntegration!==false)
   return {ok:false,reason:'UNTRUSTED_NOVICE_MODEL'};
 if(lock?.model!==NOVICE_MODEL||lock?.status!=='LOCKED'||lock.round!==round||
   !['UP','DOWN'].includes(lock.direction)||!Number.isSafeInteger(lock.lockedAt)||
   lock.lockedAt<round||lock.lockedAt>=round+8000||lock.lockedAt>now+250)
   return {ok:false,reason:'NOVICE_NOT_FROZEN_BEFORE_8S'};
 if(!Number.isFinite(Number(lock.marketSnapshotAt))||
   lock.marketSnapshotAt<round||lock.marketSnapshotAt>lock.lockedAt||
   (typeof lock.score!=='number'||!Number.isFinite(lock.score)))
   return {ok:false,reason:'NOVICE_MARKET_EVIDENCE_MISSING'};
 if(!Number.isSafeInteger(body.generatedAt)||body.generatedAt<lock.lockedAt||
   body.generatedAt>now+250||now-body.generatedAt>4000)
   return {ok:false,reason:'NOVICE_STATUS_STALE'};
 return {ok:true,round,direction:lock.direction,model:NOVICE_MODEL,
   lockedAt:lock.lockedAt,score:lock.score};
}
