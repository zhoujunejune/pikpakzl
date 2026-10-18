// Deployment-only marker: Cloudflare EDGE status is read by the existing Railway trade-control-panel; no trade rules altered.
// Real-order model selection: separate from research-model viewing selection.
// PIN is enforced at the HTTP layer. Redis CAS guards concurrent browser tabs.
// This module never places orders or edits the upstream Cloudflare/production V2 signal.
import crypto from 'node:crypto';
import {createClient} from 'redis';

export const MODEL_CHOICE_KEY='trade-control:order-signal-choice:v1';
export const BASE_MODEL='BREAKOUT20_RSI_MACD_RANGE_V1';
export const NOVICE_MODEL='NOVICE_MIX_LOW_V1';
export const DYNAMIC_MODEL='DYNAMIC_ENTRY_5M_SHADOW_V1';
export const EDGE_MODEL='EDGE_5M_V1';
export const EDGE_INPUT_VERSION='EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1';
export const RSI_INPUT_VERSION='RSI_ONLY_14_V1';
export const ORDER_SIGNAL_MODELS=Object.freeze([
 {id:BASE_MODEL,name:'BASELINE（RSI14单指标 · Railway 信号）'},
 {id:EDGE_MODEL,name:'EDGE_5M_V1（前8秒 · 训练与方向分离）'}
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
   // Retired selections are not re-enabled after a restart.
   // Change revision to invalidate any pending order from the retired model,
   // and only allow baseline from the following five-minute round.
   const saved=JSON.parse(raw);
   if(saved.model===NOVICE_MODEL||saved.model===DYNAMIC_MODEL){
     const migrated=JSON.stringify({model:BASE_MODEL,revision:crypto.randomUUID(),
       updatedAt:new Date().toISOString(),effectiveAfterRound:roundOf(Date.now())});
     const swapped=await redis.eval(CAS,{keys:[MODEL_CHOICE_KEY],arguments:[raw,migrated]});
     if(swapped==='OK')raw=migrated;
     else raw=await redis.get(MODEL_CHOICE_KEY); // reread concurrent selected state
   }
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
 if(body?.ok!==true||body?.model!==NOVICE_MODEL||body?.inputVersion!==RSI_INPUT_VERSION||
   lock?.inputVersion!==RSI_INPUT_VERSION||body?.readOnly!==true||
   body?.orders!==false||body?.productionIntegration!==false)
   return {ok:false,reason:'UNTRUSTED_NOVICE_MODEL'};
 if(lock?.model!==NOVICE_MODEL||lock?.status!=='LOCKED'||lock.round!==round||
   !['UP','DOWN'].includes(lock.direction)||!Number.isSafeInteger(lock.lockedAt)||
   lock.lockedAt<round||lock.lockedAt>=round+8000||lock.lockedAt>now+250)
   return {ok:false,reason:'NOVICE_NOT_FROZEN_BEFORE_8S'};
 if(!Number.isFinite(Number(lock.marketSnapshotAt))||
   lock.marketSnapshotAt<round||lock.marketSnapshotAt>lock.lockedAt||
   (typeof lock.score!=='number'||!Number.isFinite(lock.score))||
   (typeof lock.rsi!=='number'||!Number.isFinite(lock.rsi)||lock.rsi<0||lock.rsi>100)||
   lock.direction!==(lock.rsi>=50?'UP':'DOWN'))
   return {ok:false,reason:'NOVICE_MARKET_EVIDENCE_MISSING'};
 if(!Number.isSafeInteger(body.generatedAt)||body.generatedAt<lock.lockedAt||
   body.generatedAt>now+250||now-body.generatedAt>4000)
   return {ok:false,reason:'NOVICE_STATUS_STALE'};
 return {ok:true,round,direction:lock.direction,model:NOVICE_MODEL,
   lockedAt:lock.lockedAt,score:lock.score,rsi:lock.rsi,inputVersion:RSI_INPUT_VERSION};
}

// Promote only a frozen virtual entry as a separately selectable real-order signal.
// NEVER promote an unfrozen directional preview or a stale/synthetic market reading.
export function validateDynamicEntrySignal(body,now=Date.now()){
 const round=roundOf(now),row=body?.latest,entry=row?.entry;
 if(body?.ok!==true||body?.model!==DYNAMIC_MODEL||
   body?.readOnly!==true||body?.orders!==false||body?.productionIntegration!==false||
   body?.statsScope!=='STRICT_FORWARD_VIRTUAL_ENTRIES_OFFICIAL_RESOLUTION_ONLY')
   return {ok:false,reason:'UNTRUSTED_DYNAMIC_MODEL'};
 if(!Number.isSafeInteger(body.generatedAt)||body.generatedAt>now+250||
   now-body.generatedAt>6000||body.health?.marketError!=null)
   return {ok:false,reason:'DYNAMIC_STATUS_STALE'};
 const goodAt=Number(body.timed?.lastGoodDataAt);
 if(!Number.isSafeInteger(goodAt)||goodAt>now+250||now-goodAt>7500)
   return {ok:false,reason:'DYNAMIC_MARKET_STALE'};
 if(row?.round!==round||!entry||!['UP','DOWN'].includes(entry.direction)||
   !Number.isSafeInteger(entry.at)||entry.at<round||entry.at>=round+300000||
   !Number.isSafeInteger(entry.marketAt)||entry.marketAt>entry.at||
   entry.at-entry.marketAt>10000||entry.at>now+250)
   return {ok:false,reason:'DYNAMIC_ENTRY_MISSING_OR_UNFROZEN'};
 // The 5-minute strategy may enter at any second, but old entry alerts cannot
 // be replayed minutes later as new trades. Leave time for quote and settlement.
 if(now-entry.at>45000||now>=round+285000)
   return {ok:false,reason:'DYNAMIC_ENTRY_EXPIRED'};
 if(typeof entry.score!=='number'||!Number.isFinite(entry.score)||
   typeof entry.strength!=='number'||!Number.isFinite(entry.strength)||
   entry.strength<0||entry.strength>1||
   !/^HEURISTIC_V[0-9]+|^DYN5_FROZEN_[0-9]+_/.test(String(entry.modelVersion||'')))
   return {ok:false,reason:'DYNAMIC_ENTRY_EVIDENCE_INVALID'};
 return {ok:true,round,direction:entry.direction,model:DYNAMIC_MODEL,
   lockedAt:entry.at,marketAt:entry.marketAt,score:entry.score,
   strength:entry.strength,modelVersion:entry.modelVersion};
}


export function validateEdgeSignal(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest;
 if(body?.ok!==true||body.model!==EDGE_MODEL||body.inputVersion!==EDGE_INPUT_VERSION||
    body.readOnly!==true||body.orders!==false||body.productionIntegration!==false||
    body.statsScope!=='EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY')
   return {ok:false,reason:'UNTRUSTED_EDGE_SOURCE'};
 if(!Number.isSafeInteger(body.generatedAt)||body.generatedAt>now+300||
   now-body.generatedAt>3500)
   return {ok:false,reason:'EDGE_MARKET_OR_STATUS_STALE'};
 if(!lock||lock.round!==round||lock.status!=='LOCKED'||
   !['UP','DOWN'].includes(lock.direction)||!Number.isSafeInteger(lock.lockedAt)||
   lock.lockedAt<round||lock.lockedAt>=round+8000||lock.lockedAt>now+250||
   lock.inputVersion!==EDGE_INPUT_VERSION||
   !Number.isSafeInteger(lock.marketAt)||lock.marketAt>lock.lockedAt||
   lock.lockedAt-lock.marketAt>4000||
   typeof lock.score!=='number'||!Number.isFinite(lock.score)||
   !/^EDGE5_(?:OFFICIAL_[0-9]+_[0-9]+|UNCALIBRATED_PROBE)$/.test(String(lock.modelVersion||'')))
   return {ok:false,reason:'EDGE_LOCK_EVIDENCE_MISSING'};
 const ready=lock.calibrationReady===true&&
   body.training?.ready===true&&body.training?.calibrationReady===true&&
   body.training?.version===lock.modelVersion&&
   Number(body.training.samples)>=5000;
 const probability=lock.modelProbability;
 if(ready&&(!(typeof probability==='number'&&Number.isFinite(probability))||
   probability<0.5||probability>1))
   return {ok:false,reason:'EDGE_CALIBRATION_INVALID'};
 // Execution eligibility depends on a genuine, timely, immutable locked
 // direction, NOT on statistical calibration. Uncalibrated score is not a
 // probability or evidence of predictive advantage.
 return {ok:true,round,direction:lock.direction,model:EDGE_MODEL,
   lockedAt:lock.lockedAt,marketAt:lock.marketAt,score:lock.score,
   modelVersion:lock.modelVersion,modelProbability:ready?probability:null,
   calibrationReady:ready,calibrationSamples:Number(body.training?.samples||0),
   executionEligible:lock.executionEligible===true};
}


// Per-round, cross-restart limit for real Binance POSTs. Redis is the same
// authority already required for real-order model switching.
export const MAX_ORDER_SUBMIT_ATTEMPTS=1;
const ORDER_SUBMIT_PREFIX='trade-control:order-submit:v1:';
const CLAIM_POST_SCRIPT="local marker=redis.call('GET',KEYS[2]); if marker and marker~='REJECTED' then return -2 end; local n=tonumber(redis.call('GET',KEYS[1]) or '0'); if n>=tonumber(ARGV[1]) then return -1 end; n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; redis.call('SET',KEYS[2],'IN_FLIGHT:'..n,'EX',7200); return n";
function checkedSubmitRound(round){
 if(!Number.isSafeInteger(round)||round<1||round%300000!==0)throw Error('INVALID_SUBMIT_ROUND');
 return ORDER_SUBMIT_PREFIX+round;
}
export async function claimOrderSubmitAttempt(round){
 const prefix=checkedSubmitRound(round),redis=await db();
 const count=Number(await redis.eval(CLAIM_POST_SCRIPT,{keys:[prefix+':count',prefix+':closed'],arguments:[String(MAX_ORDER_SUBMIT_ATTEMPTS)]}));
 if(count===-2)throw Error('ROUND_SUBMISSION_ALREADY_PLACED_OR_UNKNOWN');
 if(count===-1)throw Error('ROUND_SUBMISSION_ATTEMPTS_EXHAUSTED');
 if(!Number.isSafeInteger(count)||count<1||count>MAX_ORDER_SUBMIT_ATTEMPTS)
   throw Error('ROUND_SUBMISSION_ATTEMPT_CLAIM_FAILED');
 return {attempt:count,maxAttempts:MAX_ORDER_SUBMIT_ATTEMPTS};
}
export async function closeOrderSubmitRound(round,reason){
 if(!['SUBMITTED','UNKNOWN'].includes(reason))throw Error('INVALID_SUBMIT_CLOSE_REASON');
 const prefix=checkedSubmitRound(round),redis=await db();
 const script="local m=redis.call('GET',KEYS[1]); if not m or string.sub(m,1,10)~='IN_FLIGHT:' then return 'CONFLICT' end; return redis.call('SET',KEYS[1],ARGV[1],'EX',7200)";
 const outcome=await redis.eval(script,{keys:[prefix+':closed'],arguments:[reason]});
 if(outcome!=='OK')throw Error('ORDER_ROUND_CLOSE_CONFLICT');
}
export async function releaseRejectedOrderSubmitAttempt(round,attempt){
 const prefix=checkedSubmitRound(round),redis=await db();
 if(!Number.isSafeInteger(attempt)||attempt<1||attempt>MAX_ORDER_SUBMIT_ATTEMPTS)
   throw Error('INVALID_ORDER_SUBMIT_ATTEMPT');
 const script="if redis.call('GET',KEYS[1])~=ARGV[1] then return 'CONFLICT' end; return redis.call('SET',KEYS[1],'REJECTED','EX',7200)";
 const outcome=await redis.eval(script,{keys:[prefix+':closed'],arguments:['IN_FLIGHT:'+attempt]});
 if(outcome!=='OK')throw Error('ORDER_REJECTION_FENCE_CONFLICT');
}
// A network timeout, HTTP 5xx, and even an empty success response may have
// created an order. Only a clear Binance quote/price rejection is retryable.
// HTTP 451, authentication, balance and generic trade errors must never retry.
export function retryableRejectedOrderPost(call){
 if(call?.ok===true||call?.network===true)return false;
 if(![400,409,422].includes(Number(call?.status)))return false;
 const data=call?.data||{};
 const reason=[data.code??'',data.msg??'',data.message??''].map(String).join(' ').toUpperCase();
 if(/RESTRICTED|ELIGIBILITY|UNAUTHORIZED|INSUFFICIENT|BALANCE|PERMISSION|SIGNATURE/.test(reason))return false;
 return /QUOTE[_ -]?(?:EXPIRED|INVALID|STALE|NOT_FOUND)|(?:EXPIRED|INVALID|STALE)[_ -]?QUOTE|PRICE[_ -]?(?:CHANGED|MOVED|OUTDATED)|REQUOTE|SLIPPAGE[_ -]?EXCEEDED/.test(reason);
}
