// Standalone read-only shadow, using only a public candle endpoint + official
// settlement read endpoint. Separate Redis keyspace. Never imported by trading code.
import { createClient } from 'redis';
import { MODEL,BASE_WEIGHTS,predictMarket,summarize,fitExperimentalWeights } from './novice-mix-core.mjs';
const ROUND_MS=300000,MAX_ROWS=1800;
const DATA_ORIGIN=String(process.env.NOVICE_MARKET_ORIGIN||'https://signal-diagnostic-v3-production.up.railway.app').replace(/\/+$/,'');
const OFFICIAL_ORIGIN=String(process.env.ROUND_STATS_ORIGIN||'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/,'');
const REDIS_KEY='breakout20:research:novice_mix_low_v1:state';
const valid=d=>d==='UP'||d==='DOWN';
const summaryClock=()=>Date.now();
export function createNoviceMixShadow({
  fetcher=globalThis.fetch,clock=summaryClock,
  marketUrl=DATA_ORIGIN+'/api/shadow-market-data',
  officialUrl=OFFICIAL_ORIGIN+'/api/breakout20-official-accuracy',
  redisUrl=String(process.env.SIGNAL_REDIS_URL||''),
  setTimer=setInterval,clearTimer=clearInterval,
}={}){
  const state={rows:[],weights:[...BASE_WEIGHTS],training:{status:'COLLECTING',samples:0,required:80,version:1},
    lastTickAt:null,lastGoodDataAt:null,nextAlarm:null,lastOfficialAt:null,marketError:null,officialError:null,
    persisted:false,storage:'MEMORY_ONLY'};
  let client=null,timer=null,processing=false,starting=null,lastOfficialPoll=0,lastTrainingCount=0;
  const roundAt=ms=>Math.floor(ms/ROUND_MS)*ROUND_MS;
  async function persist(){
    if(!client)return;
    try{
      await client.set(REDIS_KEY,JSON.stringify({
        rows:state.rows.slice(-MAX_ROWS),weights:state.weights,training:state.training,
        lastTrainingCount,lastGoodDataAt:state.lastGoodDataAt
      }));
      state.persisted=true;
    }catch(e){state.storage='MEMORY_ONLY';state.marketError='STATE_WRITE_FAILED';}
  }
  async function restore(){
    if(!redisUrl)return;
    try{
      client=createClient({url:redisUrl,socket:{connectTimeout:2200,reconnectStrategy:()=>false}});
      client.on('error',()=>{});
      await client.connect();
      state.storage='REDIS_SEPARATE_NAMESPACE';
      const raw=await client.get(REDIS_KEY);
      if(raw){
        const saved=JSON.parse(raw);
        if(Array.isArray(saved.rows))state.rows=saved.rows.filter(r=>
          r?.model===MODEL&&Number.isSafeInteger(r.round)&&valid(r.direction)).slice(-MAX_ROWS);
        if(Array.isArray(saved.weights)&&saved.weights.length===7&&saved.weights.every(x=>Number.isFinite(x)&&x>=0))
          state.weights=saved.weights;
        if(saved.training?.version>=1)state.training=saved.training;
        lastTrainingCount=Number(saved.lastTrainingCount||0);
        state.lastGoodDataAt=saved.lastGoodDataAt||null;
      }
    }catch{state.storage='MEMORY_ONLY';try{await client?.disconnect();}catch{}client=null;}
  }
  async function lockOnce(now){
    const round=roundAt(now),elapsed=now-round;
    if(elapsed<4500||elapsed>7750||state.rows.some(x=>x.round===round))return;
    let result=null;
    try{
      const response=await fetcher(marketUrl,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(1800)});
      if(!response.ok)throw Error('MARKET_HTTP_'+response.status);
      const payload=await response.json();
      const at=clock();
      if(roundAt(at)!==round||at-round>=8000)return;
      result=predictMarket(payload,state.rows,state.weights,at);
      if(result.status==='LOCKED'||result.status==='PARTIAL_INPUT')state.lastGoodDataAt=at;
      else state.marketError=result.reason;
    }catch(error){state.marketError=String(error?.message||'MARKET_FETCH_FAILED').slice(0,100);}
    const end=clock();
    if(!result&&end-round>=7400&&end-round<8000)
      result=predictMarket(null,state.rows,state.weights,end);
    if(!result)return;
    // One frozen prediction per round. No mutation after official result.
    if(state.rows.some(x=>x.round===round))return;
    state.rows.push({...result,actual:null,result:'PENDING'});
    state.rows=state.rows.slice(-MAX_ROWS);
    state.lastTickAt=end;
    await persist();
  }
  async function resolveOfficial(now){
    if(now-lastOfficialPoll<30000)return;
    lastOfficialPoll=now;
    try{
      const response=await fetcher(officialUrl,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(2800)});
      if(!response.ok)throw Error('OFFICIAL_HTTP_'+response.status);
      const data=await response.json();
      if(data?.ok!==true||data?.source!=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'||
        data?.statsScope!=='CURRENT_MODEL_VERSION_PRODUCTION_LOCKS_ONLY'||
        !Array.isArray(data?.recent))throw Error('INVALID_OFFICIAL_SOURCE');
      let changed=false;
      for(const official of data.recent){
        if(!valid(official.actual)||!Number.isSafeInteger(official.t))continue;
        const row=state.rows.find(x=>x.round===official.t);
        if(row&&!valid(row.actual)){
          row.actual=official.actual;row.result=row.direction===row.actual?'HIT':'MISS';
          row.settledAt=now;changed=true;
        }
      }
      state.lastOfficialAt=now;state.officialError=null;
      const completed=state.rows.filter(x=>valid(x.actual)&&x.status!=='NO_DATA_FALLBACK').length;
      if(completed>=80&&completed-lastTrainingCount>=20){
        const fit=fitExperimentalWeights(state.rows,state.weights);
        state.weights=fit.weights.slice();
        state.training={...fit,version:(state.training.version||1)+(fit.status==='ADOPTED'?1:0),
          trainedAt:now,required:80,source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'};
        lastTrainingCount=completed;changed=true;
      }else if(completed<80){state.training={...state.training,status:'COLLECTING',samples:completed,required:80};}
      if(changed)await persist();
    }catch(error){state.officialError=String(error?.message||'OFFICIAL_UNAVAILABLE').slice(0,120);}
  }
  async function poll(){
    if(processing)return;processing=true;
    const now=clock(),round=roundAt(now);
    state.nextAlarm=round+ROUND_MS+6000;
    try{
      const elapsed=now-round;
      // Market request only during current round's lock window.
      if(elapsed>=4500&&elapsed<7750)await lockOnce(now);
      if(now-lastOfficialPoll>=30000)await resolveOfficial(clock());
      state.lastTickAt=clock();
    }finally{processing=false;}
  }
  async function start(){
    if(starting)return starting;
    starting=(async()=>{await restore();timer=setTimer(()=>{void poll().catch(()=>{});},400);
      await poll();})();
    return starting;
  }
  async function stop(){if(timer!=null)clearTimer(timer);timer=null;try{await client?.quit();}catch{}}
  function snapshot(){
    const sums=summarize(state.rows);
    return {ok:true,model:MODEL,name:'新手错误混合 · 低胜率研究',
      readOnly:true,orders:false,productionIntegration:false,
      official:{source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
        availability:state.lastOfficialAt!==null,limitation:'ONLY_ROUNDS_PRESENT_IN_BREAKOUT20_PRODUCTION_OFFICIAL_LEDGER'},
      results:sums,
      latest:state.rows.at(-1)||null,recent:state.rows.slice(-30).reverse(),
      training:{...state.training,model:MODEL,weights:state.weights,
        settledSamples:sums.overall.samples,progressPct:Math.min(100,sums.overall.samples/80*100)},
      timed:{lastTickAt:state.lastTickAt,lastGoodDataAt:state.lastGoodDataAt,nextAlarm:state.nextAlarm,
        deadlineMs:8000},health:{marketError:state.marketError,officialError:state.officialError,
        lastOfficialAt:state.lastOfficialAt,storage:state.storage,persisted:state.persisted},
      generatedAt:clock()};
  }
  function handler(res){
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
      'x-content-type-options':'nosniff'});
    res.end(JSON.stringify(snapshot()));
  }
  return {start,stop,poll,snapshot,handler};
}
export const noviceMixShadow=createNoviceMixShadow();
