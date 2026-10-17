// Isolated fourth production-selectable EDGE model.
// This collector is read-only: only public market GETs + verified official labels.
// A selection in the panel is handled by existing Redis selector and order engine.
import {createClient} from 'redis';
import {EDGE_MODEL,INPUT_VERSION,ROUND_MS,roundAt,extractFeatures,scoreDirection,
  trainOnOfficial,summarize,MIN_TRAINING_ROUNDS} from './edge-5m-core.mjs';
import {verifiedOfficialRoundDirections} from './novice-mix-shadow.mjs';
const MARKET_ORIGIN=String(process.env.NOVICE_MARKET_ORIGIN||
  'https://signal-diagnostic-v3-production.up.railway.app').replace(/\/+$/,'');
const OFFICIAL_ORIGIN=String(process.env.ROUND_STATS_ORIGIN||
  'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/,'');
const KEY='shadow:edge_5m_v1:isolated:v1';
const MAX_ROWS=7500;
const valid=x=>x==='UP'||x==='DOWN';
const fetchJson=async(fetcher,url,timeout=1900)=>{
  const response=await fetcher(url,{cache:'no-store',headers:{accept:'application/json'},
    signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw Error('MARKET_HTTP_'+response.status);
  return await response.json();
};
export function createEdge5mService({fetcher=globalThis.fetch,clock=Date.now,
  marketUrl=MARKET_ORIGIN+'/api/shadow-market-data',
  officialUrl=OFFICIAL_ORIGIN+'/api/round-stats',
  redisUrl=String(process.env.SIGNAL_REDIS_URL||''),
  setTimer=setInterval,clearTimer=clearInterval}={}){
 const state={rows:[],model:null,training:{status:'COLLECTING',samples:0,required:MIN_TRAINING_ROUNDS,
   calibrationReady:false},storage:'MEMORY_ONLY',persisted:false,marketError:null,
   officialError:null,lastMarketAt:null,lastOfficialAt:null,lastTickAt:null};
 let client=null,timer=null,starting=null,busy=false,officialBusy=false,lastOfficialPoll=0;
 let lastModelTrainCount=0;
 let trail=[];
 const save=async()=>{
   if(!client?.isReady){state.persisted=false;return;}
   try{await client.set(KEY,JSON.stringify({rows:state.rows.slice(-MAX_ROWS),
     model:state.model,training:state.training,lastModelTrainCount}));
     state.persisted=true;
   }catch{state.persisted=false;state.storage='MEMORY_ONLY';}
 };
 async function restore(){
   if(!redisUrl)return;
   try{
     client=createClient({url:redisUrl,socket:{connectTimeout:2000,reconnectStrategy:()=>false}});
     client.on('error',()=>{});
     await client.connect();state.storage='REDIS_PERSISTENT';
     const raw=await client.get(KEY);if(!raw)return;
     const old=JSON.parse(raw);
     if(Array.isArray(old.rows))state.rows=old.rows.filter(r=>
       r?.model===EDGE_MODEL&&Number.isSafeInteger(r.round)&&r.round%ROUND_MS===0).slice(-MAX_ROWS);
     if(old.model?.weights?.length===6)state.model=old.model;
     if(old.training?.status)state.training=old.training;
     lastModelTrainCount=Number(old.lastModelTrainCount||0);
     state.persisted=true;
   }catch(e){state.storage='MEMORY_ONLY';state.marketError='REDIS_UNAVAILABLE';
     try{await client?.disconnect();}catch{}client=null;}
 }
 function rowFor(round){
   let r=state.rows.find(x=>x.round===round);
   if(!r){r={model:EDGE_MODEL,round,probe:null,direction:null,actual:null,
     settledAt:null,pendingReason:'AWAITING_OFFICIAL_RESOLUTION'};
     state.rows.push(r);state.rows=state.rows.slice(-MAX_ROWS);}
   return r;
 }
 async function scan(){
   if(busy)return;busy=true;
   try{
     const requestAt=clock();
     const urls=[
       marketUrl,
       'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=10',
       'https://data-api.binance.vision/api/v3/aggTrades?symbol=BTCUSDT&limit=200',
       'https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT',
     ];
     const [market,depth,trades,perp]=await Promise.all(urls.map(url=>fetchJson(fetcher,url)));
     const now=clock(),latest=market?.latest;
     if(market?.ok!==true||market?.readOnly!==true||!latest||!Array.isArray(trades)||
       !Array.isArray(depth?.bids)||!Array.isArray(depth?.asks))
       throw Error('INCOMPLETE_REAL_MARKET_DATA');
     const spotPrice=Number(latest.lastPrice),perpBid=Number(perp.bidPrice),
       perpAsk=Number(perp.askPrice);
     const perpPrice=(perpBid+perpAsk)/2;
     const marketAt=Number(latest.eventMs);
     // REST responses have no exchange timestamp on bookTicker. The local
     // receipt time is the observation time; do not disguise it as exchange time.
     if(!Number.isFinite(marketAt)||now-marketAt>3500||marketAt>now+300||
        !Number.isFinite(perpPrice)||perpPrice<=0)
       throw Error('MARKET_DATA_STALE');
     const obs={at:now,spotPrice,perpPrice,spotAt:marketAt,perpAt:now,
       bids:depth.bids,asks:depth.asks,trades};
     const features=extractFeatures(obs,trail,now);
     trail.push({at:now,spotPrice,perpPrice});
     trail=trail.filter(x=>now-x.at<=20000).slice(-32);
     state.lastMarketAt=now;state.marketError=null;
     const round=roundAt(now),elapsed=now-round;
     if(elapsed<1800||elapsed>=7700||!features)return;
     const row=rowFor(round);if(row.probe)return;
     // Lock exactly once before second 8. Never backfill after the cutoff.
     const prediction=scoreDirection(features,state.model);
     if(!prediction)return;
     row.probe=features;row.direction=prediction.direction;row.lockedAt=now;
     row.score=Number(prediction.score.toFixed(6));
     row.modelVersion=state.model?.version||'EDGE5_UNCALIBRATED_PROBE';
     row.modelProbability=prediction.modelProbability;
     row.calibrationReady=prediction.calibrationReady;
     await save();
   }catch(error){state.marketError=String(error?.message||error).slice(0,150);}
   finally{state.lastTickAt=clock();busy=false;}
 }
 async function resolveOfficial(){
   if(officialBusy)return;officialBusy=true;
   try{
     const response=await fetchJson(fetcher,officialUrl,3400);
     const verified=verifiedOfficialRoundDirections(response),now=clock();let changed=false;
     for(const row of state.rows){
       if(!row.probe||valid(row.actual)||row.round+ROUND_MS>now)continue;
       const actual=verified.byRound.get(row.round);
       if(valid(actual)){row.actual=actual;row.settledAt=now;row.pendingReason=null;changed=true;}
       else row.pendingReason=verified.pending.get(row.round)||
         verified.upstreamError||'OFFICIAL_RESOLUTION_NOT_AVAILABLE';
     }
     state.lastOfficialAt=now;state.officialError=null;
     const n=state.rows.filter(r=>r.probe&&valid(r.actual)).length;
     if(n>=MIN_TRAINING_ROUNDS&&n-lastModelTrainCount>=5){
       const result=trainOnOfficial(state.rows);state.training={...result};
       if(result.model){state.model=result.model;}
       lastModelTrainCount=n;changed=true;
     }else if(n<MIN_TRAINING_ROUNDS){
       state.training={status:'COLLECTING',samples:n,required:MIN_TRAINING_ROUNDS,calibrationReady:false};
     }
     if(changed)await save();
   }catch(error){state.officialError=String(error?.message||error).slice(0,140);}
   finally{officialBusy=false;}
 }
 function snapshot(){
   const now=clock(),round=roundAt(now),row=state.rows.find(r=>r.round===round)||null;
   const trusted=state.persisted&&state.storage==='REDIS_PERSISTENT'&&
     state.training?.calibrationReady===true&&state.model?.calibrationReady===true&&
     state.model?.version===row?.modelVersion;
   const latest=row?.probe?{...row,status:'LOCKED',inputVersion:INPUT_VERSION,
     marketAt:row.probe.marketAt,executionEligible:trusted&&row.calibrationReady===true}:null;
   const results=summarize(state.rows);
   return {ok:true,model:EDGE_MODEL,inputVersion:INPUT_VERSION,name:'EDGE 5分钟概率优势',
     readOnly:true,orders:false,productionIntegration:false,
     statsScope:'EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY',
     generatedAt:now,latest,recent:state.rows.slice(-40).reverse().map(r=>({
       round:r.round,direction:r.direction,status:r.probe?'LOCKED':'MISSING',
       lockedAt:r.lockedAt,actual:r.actual,pendingReason:r.pendingReason,
       modelProbability:r.modelProbability,calibrationReady:r.calibrationReady})),
     results,training:{...state.training,version:state.model?.version||null,
       ready:trusted,remaining:Math.max(0,MIN_TRAINING_ROUNDS-Number(state.training.samples||0))},
     timed:{lastTickAt:state.lastTickAt,lastGoodDataAt:state.lastMarketAt,deadlineMs:8000},
     health:{marketError:state.marketError,officialError:state.officialError,
       lastOfficialAt:state.lastOfficialAt,storage:state.storage,persisted:state.persisted}};
 }
 function handler(res){res.writeHead(200,{'content-type':'application/json; charset=utf-8',
   'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(snapshot()));}
 async function start(){if(starting)return starting;starting=(async()=>{
   await restore();timer=setTimer(()=>{void scan();const now=clock();
     if(now-lastOfficialPoll>30000){lastOfficialPoll=now;void resolveOfficial();}},950);
   void scan();void resolveOfficial();
 })();return starting;}
 async function stop(){if(timer){clearTimer(timer);timer=null;}try{await client?.quit();}catch{}}
 return {start,stop,snapshot,handler,scan,resolveOfficial};
}
export const edge5mService=createEdge5mService();
