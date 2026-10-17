// New, strictly post-2026-10-17 random-flip OUTPUT accuracy ledger.
// Read-only with respect to original model training, signal and order execution.
// Persist a separate Redis reporting key so redeploys do not reset measurements.
import {createClient} from 'redis';
import {applyRandomSignalFlip} from './signal-random-flip.mjs';
import {BASE_MODEL,NOVICE_MODEL} from './production-signal-choice.mjs';

export const POSTFLIP_START_ROUND=Date.parse('2026-10-17T03:40:00.000Z');
export const POSTFLIP_STATS_VERSION='POSTFLIP_OUTPUT_OFFICIAL_V1_20261017';
const REDIS_KEY='reporting:postflip-output-official:20261017:v1';
const MODELS=[BASE_MODEL,NOVICE_MODEL];
const VALID=d=>d==='UP'||d==='DOWN';
const ROUND_MS=300000;
const MAX_RETAINED_ROWS=50000; // long-lived per-round history; refuse truncation
const tally=(rows)=>{const settled=rows.filter(x=>VALID(x.actual)&&x.eligible);
 const hits=settled.filter(x=>x.emitted===x.actual).length;
 return {samples:settled.length,hits,accuracy:settled.length?hits/settled.length:null};};
function clean(row){
 if(!MODELS.includes(row?.model)||!Number.isSafeInteger(row?.round)||
    row.round<POSTFLIP_START_ROUND||row.round%ROUND_MS!==0||
    !VALID(row.raw)||!VALID(row.emitted)||
    typeof row.flipped!=='boolean'||(row.actual!=null&&!VALID(row.actual))||
    typeof row.eligible!=='boolean')return null;
 // Never trust persisted or remote flip direction. Re-derive for every row.
 const signed=applyRandomSignalFlip({round:row.round,status:'LOCKED',direction:row.raw},row.model);
 if(signed.direction!==row.emitted||signed.randomFlipApplied!==row.flipped)return null;
 return {model:row.model,round:row.round,raw:row.raw,emitted:row.emitted,
   flipped:row.flipped,actual:row.actual??null,eligible:row.eligible,lockedAt:row.lockedAt??null};
}
export function createPostflipAccumulator(initial=[]){
 const values=new Map();
 for(const raw of initial){const r=clean(raw);if(r)values.set(r.model+':'+r.round,r);}
 const changed=[];
 function ingest(model,round,raw,actual,{lockedAt=null,eligible=true}={}){
  if(!MODELS.includes(model)||!Number.isSafeInteger(round)||round<POSTFLIP_START_ROUND||
     round%ROUND_MS!==0||!VALID(raw)||!Number.isFinite(lockedAt)||lockedAt<round||
     lockedAt>=round+8000)return false;
  if(actual!=null&&!VALID(actual))return false;
  const key=model+':'+round,prior=values.get(key);
  if(prior){
   // Never relabel original predictions or rewrite an already official outcome.
   if(prior.raw!==raw||prior.eligible!==eligible)return false;
   if(prior.actual&&actual&&prior.actual!==actual)throw Error('OFFICIAL_SETTLEMENT_CONFLICT');
   if(prior.actual||!actual)return false;
   prior.actual=actual;changed.push(key);return true;
  }
  if(values.size>=MAX_RETAINED_ROWS)throw Error('POSTFLIP_LEDGER_CAPACITY_REACHED');
  const output=applyRandomSignalFlip({round,status:'LOCKED',direction:raw},model);
  values.set(key,{model,round,raw,emitted:output.direction,
    flipped:output.randomFlipApplied,actual:actual??null,lockedAt,eligible});
  changed.push(key);return true;
 }
 function view(model){
  if(!MODELS.includes(model))throw Error('INVALID_MODEL');
  const rows=[...values.values()].filter(x=>x.model===model).sort((a,b)=>a.round-b.round);
  const valid=rows.filter(x=>x.eligible),settled=valid.filter(x=>VALID(x.actual));
  const bySide=(side)=>settled.filter(x=>x.emitted===side);
  const recent=rows.slice(-100).reverse().map(x=>({...x,
    direction:x.emitted,status:x.eligible?'LOCKED':'NO_DATA_FALLBACK',
    result:!x.eligible?'DATA_GAP':x.actual==null?'PENDING':x.emitted===x.actual?'HIT':'MISS'}));
  return {model,statsVersion:POSTFLIP_STATS_VERSION,resetAt:POSTFLIP_START_ROUND,
    source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
    statsScope:'POSTFLIP_EMITTED_SIGNAL_ONLY',readOnly:true,
    results:{rounds:rows.length,locked:valid.length,pending:valid.length-settled.length,
      dataGaps:rows.length-valid.length,overall:tally(valid),up:tally(bySide('UP')),
      down:tally(bySide('DOWN')),recent20:tally(settled.slice(-20)),
      recent100:tally(settled.slice(-100))},
    latest:recent[0]||null,recent};
 }
 return {ingest,view,dump:()=>[...values.values()],dirty:()=>changed.length>0,
   acknowledge:()=>{changed.length=0}};
}
export function createPostflipStatsService({
 fetcher=globalThis.fetch,clock=Date.now,
 officialUrl=String(process.env.ROUND_STATS_ORIGIN||'https://signal-diagnostic-v2-production.up.railway.app').replace(/\\/+$/,'')+'/api/breakout20-official-accuracy',
 noviceRows=()=>[],
 redisUrl=String(process.env.SIGNAL_REDIS_URL||'')
}={}){
 let cache=createPostflipAccumulator(),client=null,started=false,busy=false,storageError='STARTING',lastSyncAt=null,lastOfficialAt=null,lastNoviceAt=null,lastError=null,timer=null;
 async function start(){
  if(started)return;
  started=true;
  try{
   if(!redisUrl)throw Error('STATS_REDIS_URL_MISSING');
   client=createClient({url:redisUrl,disableOfflineQueue:true,
     socket:{connectTimeout:3500,reconnectStrategy:()=>false}});
   client.on('error',()=>{});
   await client.connect();
   const saved=await client.get(REDIS_KEY);
   if(saved){
    const parsed=JSON.parse(saved);
    if(parsed?.version!==POSTFLIP_STATS_VERSION||!Array.isArray(parsed.rows))throw Error('STATS_STORAGE_VERSION_MISMATCH');
    cache=createPostflipAccumulator(parsed.rows);
   }
   storageError=null;
  }catch(e){storageError=String(e?.message||e);try{await client?.disconnect()}catch{};client=null;}
  timer=setInterval(()=>{void poll().catch(()=>{});},15000);
  timer.unref?.();
  await poll();
 }
 async function poll(){
  if(busy||storageError)return;
  busy=true;
  try{
   // Each source has an independent official-backed model ledger.
   try{
    const r=await fetcher(officialUrl,{cache:'no-store',signal:AbortSignal.timeout(4000)});
    if(!r.ok)throw Error('BASELINE_OFFICIAL_HTTP_'+r.status);
    const j=await r.json();
    if(j?.ok!==true||j?.model!==BASE_MODEL||
       j?.source!=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'||
       j?.statsScope!=='CURRENT_MODEL_VERSION_PRODUCTION_LOCKS_ONLY'||
       !Array.isArray(j.recent))throw Error('BASELINE_OFFICIAL_PROVENANCE_INVALID');
    for(const x of j.recent){
     cache.ingest(BASE_MODEL,Number(x.t),x.direction,VALID(x.actual)?x.actual:null,{lockedAt:Number(x.lockedAt)});
    }
    lastOfficialAt=clock();lastError=null;
   }catch(e){lastError=String(e?.message||e);}
   try{
    const rows=noviceRows();
    if(!Array.isArray(rows))throw Error('NOVICE_ROWS_UNAVAILABLE');
    for(const x of rows){
     if(x?.status!=='LOCKED'&&x?.status!=='PARTIAL_INPUT')continue;
     cache.ingest(NOVICE_MODEL,Number(x.round),x.direction,
       VALID(x.actual)?x.actual:null,{lockedAt:Number(x.lockedAt),eligible:true});
    }
    lastNoviceAt=clock();
   }catch(e){lastError=String(e?.message||e);}
   if(cache.dirty()){
    await client.set(REDIS_KEY,JSON.stringify({version:POSTFLIP_STATS_VERSION,rows:cache.dump()}));
    cache.acknowledge();
   }
   lastSyncAt=clock();
  }catch(e){storageError='STATS_PERSIST_FAILED:'+String(e?.message||e);}
  finally{busy=false}
 }
 function snapshot(model){
  if(storageError)return {ok:false,error:storageError,model,statsVersion:POSTFLIP_STATS_VERSION,
    resetAt:POSTFLIP_START_ROUND};
  return {ok:true,...cache.view(model),health:{lastSyncAt,lastOfficialAt,lastNoviceAt,lastError,
    storage:'REDIS_SEPARATE_REPORTING_KEY'}};
 }
 async function stop(){if(timer)clearInterval(timer);timer=null;try{await client?.quit()}catch{}}
 return {start,poll,snapshot,stop};
}
