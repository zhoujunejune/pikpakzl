// Independent virtual-entry recorder: GET market + GET official settlement only.
// No credentials, POST, execution callback, production signal router or order API.
import {createClient} from 'redis';
import {
 MODEL,ROUND_MS,roundStart,RETRAIN_EVERY_SETTLED,
 extractFeatures,decide,aggregate,fitOnOfficialProbes
} from './dynamic-entry-shadow-core.mjs';
import {verifiedOfficialRoundDirections} from './novice-mix-shadow.mjs';
const origin=String(process.env.NOVICE_MARKET_ORIGIN||
 'https://signal-diagnostic-v3-production.up.railway.app').replace(/\/+$/,'');
const officialOrigin=String(process.env.ROUND_STATS_ORIGIN||
 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/,'');
const KEY='shadow:dynamic_entry_5m_v1:isolated';
const MAX_ROWS=1800;
const valid=x=>x==='UP'||x==='DOWN';
export function createDynamicEntryShadow({
 fetcher=globalThis.fetch,clock=Date.now,
 marketUrl=origin+'/api/shadow-market-data',
 officialUrl=officialOrigin+'/api/round-stats',
 redisUrl=String(process.env.SIGNAL_REDIS_URL||''),
 setTimer=setInterval,clearTimer=clearInterval,
}={}){
 const state={
  rows:[],model:null,training:{status:'COLLECTING',samples:0,required:60,version:0},
  lastTrainedCount:0,lastTickAt:null,lastGoodMarketAt:null,lastOfficialAt:null,
  latestDecision:null,marketError:null,officialError:null,
  storage:'MEMORY_ONLY',persisted:false
 };
 let client=null,timer=null,running=false,officialBusy=false,marketBusy=false;
 let lastOfficialPoll=0,starting=null,lastDiagnosticAt=0;
 function reportHealth(now){
  if(now-lastDiagnosticAt<60000)return;
  lastDiagnosticAt=now;
  const recent=state.rows.slice(-24);
  console.log(JSON.stringify({
   event:'dynamic_entry_shadow_health',model:MODEL,at:now,
   observedRecentRounds:recent.length,
   probedRecentRounds:recent.filter(r=>r.probe).length,
   enteredRecentRounds:recent.filter(r=>r.entry).length,
   currentDirection:state.latestDecision?.direction||null,
   currentStrength:state.latestDecision?.strength??null,
   currentEligibility:state.latestDecision?.eligible??null,
   currentEntryReason:state.latestDecision?.entryReason||null,
   marketError:state.marketError,officialError:state.officialError,
   lastGoodMarketAt:state.lastGoodMarketAt,lastOfficialAt:state.lastOfficialAt,
   trainingSamples:state.training.samples,storage:state.storage
  }));
 }
 const save=async()=>{
  if(!client)return;
  try{
   await client.set(KEY,JSON.stringify({rows:state.rows.slice(-MAX_ROWS),
    model:state.model,training:state.training,lastTrainedCount:state.lastTrainedCount}));
   state.persisted=true;
  }catch{state.persisted=false;state.storage='MEMORY_ONLY';}
 };
 async function restore(){
  if(!redisUrl)return;
  try{
   client=createClient({url:redisUrl,socket:{connectTimeout:2000,reconnectStrategy:()=>false}});
   client.on('error',()=>{});
   await client.connect();
   state.storage='REDIS_ISOLATED_KEY';
   const raw=await client.get(KEY);
   if(!raw)return;
   const saved=JSON.parse(raw);
   if(Array.isArray(saved.rows))state.rows=saved.rows.filter(r=>
    r?.model===MODEL&&Number.isSafeInteger(r.round)&&r.round%ROUND_MS===0)
     .slice(-MAX_ROWS);
   if(Array.isArray(saved.model?.weights)&&saved.model.weights.length===6)
    state.model=saved.model;
   if(saved.training?.status)state.training=saved.training;
   state.lastTrainedCount=Number(saved.lastTrainedCount)||0;
  }catch{
   state.storage='MEMORY_ONLY';
   try{await client?.disconnect();}catch{}
   client=null;
  }
 }
 function getRow(round){
  let row=state.rows.find(x=>x.round===round);
  if(!row){
   row={model:MODEL,round,probe:null,entry:null,actual:null,settledAt:null,
    pendingReason:'AWAITING_OFFICIAL_SETTLEMENT'};
   state.rows.push(row);
   state.rows=state.rows.slice(-MAX_ROWS);
  }
  return row;
 }
 async function scan(){
  if(marketBusy)return;
  marketBusy=true;
  try{
   const start=clock(),round=roundStart(start);
   const res=await fetcher(marketUrl,{method:'GET',cache:'no-store',
    signal:AbortSignal.timeout(1800)});
   if(!res.ok)throw Error('MARKET_HTTP_'+res.status);
   const payload=await res.json();
   const now=clock();
   if(roundStart(now)!==round)return; // Never file a late observation into another round.
   const features=extractFeatures(payload,now);
   if(!features){state.marketError='STALE_OR_INCOMPLETE_LIVE_INPUT';return;}
   state.lastGoodMarketAt=now;state.marketError=null;
   const output=decide(features,state.model);
   if(!output)return;
   state.latestDecision={...output,round,at:now,elapsedMs:features.elapsedMs,
    marketAt:features.marketAt,price:features.price,
    action:output.eligible?'SIMULATED_ENTRY_ELIGIBLE':'MONITOR_ONLY'};
   const row=getRow(round);
   let changed=false;
   if(!row.probe){
    // Probe is a single frozen, in-round, pre-result training example.
    row.probe={at:now,values:[...features.values],price:features.price};
    changed=true;
   }
   // At most one virtual entry per five-minute round; any valid time is allowed.
   if(!row.entry&&output.eligible){
    row.entry={direction:output.direction,at:now,elapsedMs:features.elapsedMs,
     price:features.price,score:output.score,strength:output.strength,
     modelVersion:output.modelVersion,marketAt:features.marketAt};
    changed=true;
   }
   if(changed)await save();
  }catch(e){state.marketError=String(e?.message||'MARKET_UNAVAILABLE').slice(0,120);}
  finally{marketBusy=false;}
 }
 async function resolveOfficial(){
  if(officialBusy)return;
  officialBusy=true;
  try{
   const res=await fetcher(officialUrl,{method:'GET',cache:'no-store',
    signal:AbortSignal.timeout(2500)});
   if(!res.ok)throw Error('OFFICIAL_HTTP_'+res.status);
   const official=verifiedOfficialRoundDirections(await res.json());
   const now=clock();let changed=false;
   for(const row of state.rows){
    if(valid(row.actual)||row.round+ROUND_MS>now)continue;
    const actual=official.byRound.get(row.round);
    if(valid(actual)){
     row.actual=actual;row.settledAt=now;row.pendingReason=null;changed=true;
    }else{
     const reason=official.pending.get(row.round)||
      official.upstreamError||'OFFICIAL_ROUND_MISSING_OR_PENDING';
     if(row.pendingReason!==reason){row.pendingReason=reason;changed=true;}
    }
   }
   state.lastOfficialAt=now;state.officialError=null;
   const officialCount=state.rows.filter(r=>r.probe&&valid(r.actual)).length;
   // Every five NEW official rounds. No model change from pending/unverified data.
   if(officialCount>=60&&officialCount-state.lastTrainedCount>=RETRAIN_EVERY_SETTLED){
    const fit=fitOnOfficialProbes(state.rows,state.model);
    state.training={status:fit.status,samples:fit.samples,
     required:fit.required,holdout:fit.holdout,
     version:(state.training.version||0)+1,at:now,
     nextAtOfficialCount:officialCount+RETRAIN_EVERY_SETTLED,
     source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'};
    if(fit.model)state.model=fit.model;
    state.lastTrainedCount=officialCount;
    changed=true;
   }else if(state.training.status==='COLLECTING'&&officialCount!==state.training.samples){
    state.training={...state.training,samples:officialCount,
     nextAtOfficialCount:officialCount>=60?officialCount+RETRAIN_EVERY_SETTLED:60};
    changed=true;
   }
   if(changed)await save();
  }catch(e){state.officialError=String(e?.message||'OFFICIAL_UNAVAILABLE').slice(0,120);}
  finally{officialBusy=false;}
 }
 async function poll(){
  if(running)return;
  running=true;
  try{
   const now=clock();
   state.lastTickAt=now;
   if(now-lastOfficialPoll>=25000){
    lastOfficialPoll=now;
    void resolveOfficial().catch(()=>{});
   }
   await scan();
  }finally{running=false;reportHealth(clock());}
 }
 function snapshot(){
  const stats=aggregate(state.rows);
  const now=clock(),live=state.latestDecision;
  const current=live?.round===roundStart(now)?live:null;
  return {ok:true,readOnly:true,orders:false,productionIntegration:false,
   model:MODEL,name:'五分钟任意时点动态入场（影子）',
   results:stats,
   latest:state.rows.at(-1)||null,
   currentDecision:current,
   recent:state.rows.slice(-30).reverse().map(r=>({
    round:r.round,direction:r.entry?.direction??null,actual:r.actual,
    entryAt:r.entry?.at??null,elapsedMs:r.entry?.elapsedMs??null,
    strength:r.entry?.strength??null,modelVersion:r.entry?.modelVersion??null,
    status:r.entry?'VIRTUAL_ENTRY':'NO_ENTRY',
    pendingReason:r.pendingReason
   })),
   training:{...state.training,retrainEverySettledRounds:RETRAIN_EVERY_SETTLED,
    liveModelVersion:state.model?.version||'HEURISTIC_V1',
    targetAccuracy:0.75,guaranteed:false},
   timed:{lastTickAt:state.lastTickAt,lastGoodDataAt:state.lastGoodMarketAt,
    nextRoundAt:roundStart(now)+ROUND_MS,noFixedLockSeconds:true},
   health:{marketError:state.marketError,officialError:state.officialError,
    lastOfficialAt:state.lastOfficialAt,storage:state.storage,
    persisted:state.persisted},
   statsScope:'STRICT_FORWARD_VIRTUAL_ENTRIES_OFFICIAL_RESOLUTION_ONLY',
   note:'One simulated entry maximum per round. No bid/ask or fill prices, so direction accuracy is not net profitability.',
   generatedAt:now};
 }
 function handler(res){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8',
   'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(snapshot()));
 }
 async function start(){
  if(starting)return starting;
  starting=(async()=>{await restore();
   timer=setTimer(()=>{void poll().catch(()=>{});},2200);
   timer?.unref?.();await poll();
  })();
  return starting;
 }
 async function stop(){
  if(timer!=null)clearTimer(timer);
  timer=null;
  try{await client?.quit();}catch{}
 }
 return {start,stop,poll,scan,resolveOfficial,snapshot,handler};
}
export const dynamicEntryShadow=createDynamicEntryShadow();
