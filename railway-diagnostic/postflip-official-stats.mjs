// RSI(14) DIRECT-output official accuracy. READ-ONLY metrics with a new
// persisted epoch; legacy 50% random-flip history stays in its old Redis key.
import {createClient} from 'redis';
import {BASE_MODEL,NOVICE_MODEL,RSI_INPUT_VERSION} from './production-signal-choice.mjs';
import {verifiedOfficialRoundDirections} from './novice-mix-shadow.mjs';

export const POSTFLIP_START_ROUND=Date.parse('2026-10-17T05:35:00.000Z'); // earliest RSI-only version
export const POSTFLIP_STATS_VERSION='RSI14_DIRECT_OFFICIAL_V1_20261017';
export const DIRECT_STATS_SCOPE='RSI14_DIRECT_OFFICIAL_ONLY';
const REDIS_KEY='reporting:rsi14-direct-official:20261017:v1';
const MODELS=[BASE_MODEL,NOVICE_MODEL];
const VALID=d=>d==='UP'||d==='DOWN';
const ROUND_MS=300000;
const MAX_RETAINED_ROWS=50000;
const tally=(rows)=>{
 const settled=rows.filter(x=>VALID(x.actual)&&x.eligible);
 const hits=settled.filter(x=>x.emitted===x.actual).length;
 return {samples:settled.length,hits,accuracy:settled.length?hits/settled.length:null};
};
function validEpoch(v){
 return Number.isSafeInteger(v)&&v>=POSTFLIP_START_ROUND&&v%ROUND_MS===0;
}
export function nextFullRound(at){
 if(!Number.isSafeInteger(at)||at<POSTFLIP_START_ROUND)throw Error('INVALID_DIRECT_EPOCH_TIME');
 return Math.floor(at/ROUND_MS)*ROUND_MS+ROUND_MS;
}
function clean(row,resetAt){
 if(!MODELS.includes(row?.model)||!Number.isSafeInteger(row?.round)||
    row.round<resetAt||row.round%ROUND_MS!==0||
    row.inputVersion!==RSI_INPUT_VERSION||
    !VALID(row.raw)||!VALID(row.emitted)||row.raw!==row.emitted||
    row.flipped!==false||(row.actual!=null&&!VALID(row.actual))||
    typeof row.eligible!=='boolean'||!Number.isFinite(row.lockedAt)||
    row.lockedAt<row.round||row.lockedAt>=row.round+8000)return null;
 return {model:row.model,round:row.round,raw:row.raw,emitted:row.emitted,
   flipped:false,inputVersion:RSI_INPUT_VERSION,actual:row.actual??null,
   eligible:row.eligible,lockedAt:row.lockedAt,
   pendingReason:typeof row.pendingReason==='string'?row.pendingReason.slice(0,120):null};
}
export function createPostflipAccumulator(initial=[],resetAt=POSTFLIP_START_ROUND){
 if(!validEpoch(resetAt))throw Error('INVALID_DIRECT_STATS_RESET');
 const values=new Map();
 for(const raw of initial){
   const r=clean(raw,resetAt);
   if(r)values.set(r.model+':'+r.round,r);
 }
 const changed=[];
 function ingest(model,round,raw,actual,{lockedAt=null,eligible=true}={}){
  if(!MODELS.includes(model)||!Number.isSafeInteger(round)||round<resetAt||
     round%ROUND_MS!==0||!VALID(raw)||!Number.isFinite(lockedAt)||
     lockedAt<round||lockedAt>=round+8000||typeof eligible!=='boolean')return false;
  if(actual!=null&&!VALID(actual))return false;
  const key=model+':'+round,prior=values.get(key);
  if(prior){
   if(prior.raw!==raw||prior.eligible!==eligible)return false;
   if(prior.actual&&actual&&prior.actual!==actual)throw Error('OFFICIAL_SETTLEMENT_CONFLICT');
   if(prior.actual||!actual)return false;
   prior.actual=actual;changed.push(key);return true;
  }
  if(values.size>=MAX_RETAINED_ROWS)throw Error('DIRECT_LEDGER_CAPACITY_REACHED');
  values.set(key,{model,round,raw,emitted:raw,flipped:false,
    inputVersion:RSI_INPUT_VERSION,actual:actual??null,lockedAt,eligible,pendingReason:null});
  changed.push(key);return true;
 }
 // Read-only reconciliation: only official round-tracker evidence changes results.
 function reconcileOfficial(verified){
  let updated=0;
  for(const row of values.values()){
   const official=verified.byRound.get(row.round),key=row.model+':'+row.round;
   if(VALID(official)){
    if(VALID(row.actual)&&row.actual!==official)throw Error('OFFICIAL_SETTLEMENT_CONFLICT');
    if(!VALID(row.actual)){row.actual=official;row.pendingReason=null;changed.push(key);updated++;}
   }else if(!VALID(row.actual)){
    const pending=verified.pending.get(row.round)||
      (row.round<Date.now()-100*ROUND_MS?'OFFICIAL_ROUND_NOT_IN_RECENT_LEDGER':
       verified.upstreamError||'OFFICIAL_RESOLUTION_PENDING');
    if(row.pendingReason!==pending){row.pendingReason=pending;changed.push(key);}
   }
  }
  return updated;
 }
 function view(model){
  if(!MODELS.includes(model))throw Error('INVALID_MODEL');
  const rows=[...values.values()].filter(x=>x.model===model).sort((a,b)=>a.round-b.round);
  const valid=rows.filter(x=>x.eligible),settled=valid.filter(x=>VALID(x.actual));
  const bySide=(side)=>settled.filter(x=>x.emitted===side);
  const recent=rows.slice(-100).reverse().map(x=>({...x,
    direction:x.emitted,status:x.eligible?'LOCKED':'NO_DATA_FALLBACK',
    result:!x.eligible?'DATA_GAP':x.actual==null?'PENDING':x.emitted===x.actual?'HIT':'MISS'}));
  return {model,statsVersion:POSTFLIP_STATS_VERSION,resetAt,
    source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
    statsScope:DIRECT_STATS_SCOPE,readOnly:true,signalOutputMode:'RSI14_DIRECT_V1',
    results:{rounds:rows.length,locked:valid.length,pending:valid.length-settled.length,
      dataGaps:rows.length-valid.length,overall:tally(valid),up:tally(bySide('UP')),
      down:tally(bySide('DOWN')),recent20:tally(settled.slice(-20)),
      recent100:tally(settled.slice(-100))},
    latest:recent[0]||null,recent};
 }
 return {ingest,reconcileOfficial,view,dump:()=>[...values.values()],dirty:()=>changed.length>0,
   acknowledge:()=>{changed.length=0}};
}
export function createPostflipStatsService({
 fetcher=globalThis.fetch,clock=Date.now,
 officialUrl=String(process.env.ROUND_STATS_ORIGIN||'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/,'')+'/api/round-stats',
 noviceRows=()=>[],
 redisUrl=String(process.env.SIGNAL_REDIS_URL||'')
}={}){
 let cache=null,client=null,started=false,busy=false,storageError='STARTING';
 let lastSyncAt=null,lastNoviceAt=null,lastError=null,lastOfficialAt=null,lastOfficialError=null,timer=null;
 async function start(){
  if(started)return;
  started=true;
  try{
   if(!redisUrl)throw Error('STATS_REDIS_URL_MISSING');
   client=createClient({url:redisUrl,disableOfflineQueue:true,
     socket:{connectTimeout:3500,reconnectStrategy:()=>false}});
   client.on('error',()=>{});
   await client.connect();
   // Persist the first complete 5-minute interval following deployment.
   // Reuse it across restarts, and do not count earlier flip-model rounds.
   const initial={version:POSTFLIP_STATS_VERSION,resetAt:nextFullRound(clock()),rows:[]};
   await client.set(REDIS_KEY,JSON.stringify(initial),{NX:true});
   const saved=JSON.parse(await client.get(REDIS_KEY));
   if(saved?.version!==POSTFLIP_STATS_VERSION||!validEpoch(saved?.resetAt)||
      !Array.isArray(saved.rows))throw Error('DIRECT_STATS_STORAGE_VERSION_MISMATCH');
   cache=createPostflipAccumulator(saved.rows,saved.resetAt);
   storageError=null;
  }catch(e){
   storageError=String(e?.message||e);
   try{await client?.disconnect()}catch{}
   client=null;
  }
  timer=setInterval(()=>{void poll().catch(()=>{});},15000);
  timer.unref?.();
  await poll();
 }
 async function poll(){
  if(busy||storageError)return;
  busy=true;
  try{
   // Identical RSI input, no extra direction transformation for either
   // selectable model. Unselected output remains a hypothetical per-model
   // result; final order mapping is not included in this signal accuracy.
   try{
    const rows=noviceRows();
    if(!Array.isArray(rows))throw Error('RSI_ONLY_ROWS_UNAVAILABLE');
    for(const x of rows){
      if(x?.inputVersion!==RSI_INPUT_VERSION||x?.status!=='LOCKED')continue;
      // Keep the 8s-frozen signal; do not trust a shadow outcome as official.
      for(const model of MODELS)
        cache.ingest(model,Number(x.round),x.direction,null,
          {lockedAt:Number(x.lockedAt),eligible:true});
    }
    lastNoviceAt=clock();lastError=null;
   }catch(e){lastError=String(e?.message||e);}
   try{
    const response=await fetcher(officialUrl,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(4500)});
    if(!response.ok)throw Error('OFFICIAL_HTTP_'+response.status);
    const verified=verifiedOfficialRoundDirections(await response.json());
    cache.reconcileOfficial(verified);
    lastOfficialAt=clock();lastOfficialError=verified.upstreamError||null;
   }catch(e){lastOfficialError=String(e?.message||e).slice(0,120);}
   if(cache.dirty()){
    const resetAt=cache.view(BASE_MODEL).resetAt;
    await client.set(REDIS_KEY,JSON.stringify({version:POSTFLIP_STATS_VERSION,
      resetAt,rows:cache.dump()}));
    cache.acknowledge();
   }
   lastSyncAt=clock();
  }catch(e){storageError='DIRECT_STATS_PERSIST_FAILED:'+String(e?.message||e)}
  finally{busy=false;}
 }
 function snapshot(model){
  if(storageError||!cache)return {ok:false,error:storageError||'STARTING',model,
    statsVersion:POSTFLIP_STATS_VERSION};
  return {ok:true,...cache.view(model),health:{lastSyncAt,lastNoviceAt,lastError,
    lastOfficialAt,lastOfficialError,
    officialSource:'ROUND_TRACKER_VERIFIED_BINANCE_PREDICTION_ROUND_LEDGER',
    storage:'REDIS_SEPARATE_DIRECT_REPORTING_KEY'}};
 }
 async function stop(){if(timer)clearInterval(timer);timer=null;try{await client?.quit()}catch{}}
 return {start,poll,snapshot,stop};
}
