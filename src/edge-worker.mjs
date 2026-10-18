// EDGE_5M_V1: Cloudflare Free isolated read-only predictor.
// No Binance order API, no Railway mutation, no effect on existing Workers.
import {DurableObject} from 'cloudflare:workers';
import {bestMarket} from './provider-market.mjs';
import {verifiedDirectOfficialResolution} from './edge-official-backfill.mjs';
import {predictionSnapshot,v2Features,v2Summary} from './edge-v2-shadow.mjs';
import {EDGE_MODEL,INPUT_VERSION,ROUND_MS,roundAt,extractFeatures,scoreDirection,
  trainOnOfficial,MIN_TRAINING_ROUNDS,MIN_FIT_ROUNDS} from './edge-core.mjs';

const OFFICIAL_URL='https://zl-signal-v2-migration.onrender.com/api/round-stats';
const RAILWAY_MARKET_URL='https://zl-signal-v3-migration.onrender.com/api/shadow-market-data';
const V2_PM_URL='https://zl-signal-v3-migration.onrender.com/api/signal';
const OFFICIAL_SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const PHASES=[-15000,-12000,-9000,-6000,-3000,1900,4500,6050,6800,7450,25000];
const TTL=ROUND_MS*25;
const valid=d=>d==='UP'||d==='DOWN';
const msg=e=>String(e?.message||e).slice(0,180);
const json=(body,code=200)=>Response.json(body,{status:code,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const nextTick=now=>{
 const current=roundAt(now),times=[...PHASES.map(x=>current+x),...PHASES.map(x=>current+ROUND_MS+x)];
 return times.find(x=>x>now+500)||current+ROUND_MS+PHASES[0];
};
async function readJson(url,timeout=2700){
 const response=await fetch(url,{method:'GET',cache:'no-store',
  headers:{accept:'application/json'},signal:AbortSignal.timeout(timeout)});
 if(!response.ok)throw Error('HTTP_'+response.status+'_'+new URL(url).host);
 return await response.json();
}
async function firstGood(urls,test){
 const errors=[];
 for(const url of urls){
  try{const payload=await readJson(url);
   if(!test(payload))throw Error('INVALID_SCHEMA');
   return {payload,url,receivedAt:Date.now()};
  }catch(e){errors.push(new URL(url).host+':'+msg(e));}
 }
 throw Error('PROVIDERS_UNAVAILABLE_'+errors.join('|').slice(0,150));
}
async function binanceObservation(){
 const [spot,depth,trades,perp]=await Promise.all([
  firstGood([RAILWAY_MARKET_URL,'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT'],
   p=>(p?.ok===true&&p?.readOnly===true&&Number(p?.latest?.lastPrice)>0)||
      (p?.symbol==='BTCUSDT'&&Number(p?.price)>0)),
  firstGood(['https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=10',
   'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=10'],
   p=>Array.isArray(p?.bids)&&p.bids.length>=5&&Array.isArray(p?.asks)&&p.asks.length>=5),
  firstGood(['https://data-api.binance.vision/api/v3/aggTrades?symbol=BTCUSDT&limit=200',
   'https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=200'],
   p=>Array.isArray(p)&&p.length>=3),
  firstGood(['https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT',
   'https://fapi1.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT'],
   p=>Number(p?.bidPrice)>0&&Number(p?.askPrice)>0)
 ]);
 const snapshot=spot.payload,receivedAt=Date.now();
 const fromRailway=snapshot.ok===true;
 const spotPrice=fromRailway?Number(snapshot.latest.lastPrice):Number(snapshot.price);
 const spotAt=fromRailway?Number(snapshot.latest.eventMs):spot.receivedAt;
 const perpPrice=(Number(perp.payload.bidPrice)+Number(perp.payload.askPrice))/2;
 // Binance REST spot price fallback does not provide exchange time:
 // we record the receipt timestamp, never invent an exchange event timestamp.
 if(fromRailway&&(receivedAt-spotAt>3500||spotAt>receivedAt+300))
   throw Error('RAILWAY_SPOT_EVENT_STALE');
 return {venue:'BINANCE',at:receivedAt,spotPrice,spotAt,perpPrice,perpAt:perp.receivedAt,
   bids:depth.payload.bids,asks:depth.payload.asks,trades:trades.payload,
   providers:{spot:spot.url,depth:depth.url,trades:trades.url,perp:perp.url}};
}
const observation=(venue=null)=>bestMarket(venue,binanceObservation);
// The V2 research candidate avoids Binance Futures HTTP 451 entirely.
// It requires independent real Binance spot price, L5 book and signed trades.
async function binanceV2SpotObservation(){
 const [spot,depth,trade]=await Promise.all([
  firstGood([RAILWAY_MARKET_URL,
    'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT'],
    p=>(p?.ok===true&&p?.readOnly===true&&
      Number(p?.latest?.lastPrice)>0&&Number(p?.latest?.eventMs)>0)||
      (p?.symbol==='BTCUSDT'&&Number(p?.price)>0)),
  firstGood(['https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=10'],
    p=>Array.isArray(p?.bids)&&p.bids.length>=5&&
      Array.isArray(p?.asks)&&p.asks.length>=5),
  firstGood(['https://data-api.binance.vision/api/v3/aggTrades?symbol=BTCUSDT&limit=200'],
    p=>Array.isArray(p)&&p.length>=3)
 ]);
 const at=Date.now(),fromV3=spot.payload?.ok===true;
 const spotPrice=fromV3?Number(spot.payload.latest.lastPrice):Number(spot.payload.price);
 const spotAt=fromV3?Number(spot.payload.latest.eventMs):spot.receivedAt;
 if(!(spotPrice>0&&spotAt<=at+300&&at-spotAt<=2500))
  throw Error('V2_BINANCE_SPOT_STALE');
 const rows=trade.payload.map(t=>({T:Number(t.T),q:t.q,m:t.m}));
 if(rows.filter(t=>Number(t.q)>0&&at-t.T>=-300&&at-t.T<=4000).length<3)
  throw Error('V2_BINANCE_TRADES_STALE');
 return {venue:'BINANCE',spotPrice,spotAt,
  bids:depth.payload.bids,asks:depth.payload.asks,trades:rows,
  at,source:fromV3?'BINANCE_WS_EVENT':'BINANCE_SPOT_REST_RECEIPT'};
}
function officialRounds(payload){
 if(payload?.ok!==true||payload?.settlementSource!==OFFICIAL_SOURCE||
   !Array.isArray(payload?.records))throw Error('OFFICIAL_LEDGER_PROVENANCE_INVALID');
 const result=new Map();
 for(const row of payload.records){
  const round=Number(row.roundStartMs),direction=row.productionActual;
  if(!Number.isSafeInteger(round)||round%ROUND_MS!==0||!valid(direction))continue;
  const match=/^OFFICIAL_(UP|DOWN)(?::|$)/.exec(String(row.resolutionEvidence||''));
  const evidence=row.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION'||match;
  if(!evidence||(match&&match[1]!==direction)||
    (valid(row.officialDirection)&&row.officialDirection!==direction)||
    (valid(row.actual)&&row.actual!==direction))continue;
  if(result.has(round)&&result.get(round)!==direction)throw Error('OFFICIAL_CONFLICT');
  result.set(round,direction);
 }
 return result;
}
function initialResults(){return {observedRounds:0,locked:0,pending:0,
 overall:{samples:0,hits:0,misses:0,accuracy:null},
 up:{samples:0,hits:0,misses:0,accuracy:null},
 down:{samples:0,hits:0,misses:0,accuracy:null}};}
function updatedResults(row,prev){
 const r=structuredClone(prev),direction=row.direction;
 if(!valid(direction))return r;
 const overall=r.overall,side=direction==='UP'?r.up:r.down;
 for(const obj of [overall,side]){obj.samples++;if(row.actual===direction)obj.hits++;
  else obj.misses++;obj.accuracy=obj.hits/obj.samples;}
 r.pending=Math.max(0,r.pending-1);
 return r;
}
export class Edge5 extends DurableObject{
 constructor(ctx,env){
  super(ctx,env);
  this.ctx.storage.sql.exec(
   "CREATE TABLE IF NOT EXISTS edge_rounds ("+
   "round INTEGER PRIMARY KEY,direction TEXT,lockedAt INTEGER,marketAt INTEGER,"+
   "score REAL,modelVersion TEXT,modelProbability REAL,calibrationReady INTEGER,"+
   "features TEXT,actual TEXT,settledAt INTEGER,pendingReason TEXT)");
  // V1 SQL history and direction stay completely unchanged. V2 is shadow-only.
  this.ctx.storage.sql.exec(
   "CREATE TABLE IF NOT EXISTS edge_v2_shadow ("+
   "round INTEGER PRIMARY KEY,pmDirection TEXT,blendDirection TEXT,"+
   "lockedAt INTEGER,marketAt INTEGER,pmMarketId INTEGER,pmUpMid REAL,"+
   "features TEXT,actual TEXT,settledAt INTEGER)");
 }
 async meta(){return await this.ctx.storage.get('meta')||{
  model:null,training:{status:'COLLECTING',samples:0,required:MIN_TRAINING_ROUNDS,
    calibrationReady:false,ready:false},results:initialResults(),trail:[],
  lastTickAt:null,lastGoodDataAt:null,lastOfficialAt:null,
  marketError:null,officialError:null,activeVenue:null,storage:'CLOUDFLARE_SQLITE_DURABLE_OBJECT'};
 }
 async schedule(){if(await this.ctx.storage.getAlarm()===null)
   await this.ctx.storage.setAlarm(nextTick(Date.now()));}
 latestRows(n=40){
  return this.ctx.storage.sql.exec(
   'SELECT round,direction,lockedAt,marketAt,score,modelVersion,modelProbability,calibrationReady,actual,settledAt,pendingReason '+
   'FROM edge_rounds ORDER BY round DESC LIMIT ?',n).toArray().map(r=>({
    round:r.round,direction:r.direction,lockedAt:r.lockedAt,marketAt:r.marketAt,
    score:r.score,modelVersion:r.modelVersion,modelProbability:r.modelProbability,
    calibrationReady:!!r.calibrationReady,actual:r.actual,settledAt:r.settledAt,
    pendingReason:r.pendingReason,status:r.direction?'LOCKED':'MISSING'}));
 }
 async observeV2(m,startedAt){
  try{
   const obs=await binanceV2SpotObservation(),at=Date.now();
   const trail=Array.isArray(m.v2Trail)?m.v2Trail.filter(
     t=>at-t.at<=25000&&t.venue==='BINANCE'):[];
   if(roundAt(at)!==roundAt(startedAt))return;
   const elapsed=at-roundAt(at);
   if(elapsed>=5600&&elapsed<8000){
    const old=this.ctx.storage.sql.exec(
     'SELECT round FROM edge_v2_shadow WHERE round=?',roundAt(at)).toArray()[0];
    if(!old){
     const source=await readJson(V2_PM_URL,1900),freezeAt=Date.now(),
       round=roundAt(freezeAt),pm=predictionSnapshot(source,round,freezeAt);
     if(round===roundAt(startedAt)&&freezeAt-round<8000&&pm){
      const f=v2Features(obs,trail,pm,freezeAt);
      if(f){
       this.ctx.storage.sql.exec(
        'INSERT INTO edge_v2_shadow(round,pmDirection,blendDirection,lockedAt,'+
        'marketAt,pmMarketId,pmUpMid,features,actual,settledAt) '+
        'VALUES (?,?,?,?,?,?,?,?,?,?)',
        f.round,f.baselineDirection,f.blendDirection,freezeAt,
        f.marketAt,f.pmMarketId,f.pmUpMid,JSON.stringify(f),null,null);
       m.v2LastGoodAt=freezeAt;
       m.v2Error=null;
      }else m.v2Error='V2_REAL_FEATURES_INCOMPLETE';
     }else m.v2Error='V2_PM_MARKET_NOT_READY_OR_TOO_LATE';
    }
   }
   trail.push({at,spotPrice:obs.spotPrice,venue:'BINANCE'});
   m.v2Trail=trail.slice(-20);
  }catch(e){m.v2Error=msg(e);}
 }
 async scan(){
  const m=await this.meta(),start=Date.now(),round=roundAt(start);
  m.lastTickAt=start;
  if(start-round>=8000&&start-round<ROUND_MS-16000)return;
  // Start both independent input reads at the same alarm tick.
  // Never await the research candidate before the original live V1 lock.
  const v2Work=this.observeV2(m,start);
  try{
   const obs=await observation(m.activeVenue),now=Date.now();
   if(m.activeVenue&&m.activeVenue!==obs.venue)throw Error('MARKET_VENUE_CHANGED');
   if(!m.activeVenue){m.activeVenue=obs.venue;m.trail=[];}
   if(roundAt(now)!==roundAt(start))return;
   m.lastGoodDataAt=now;m.marketError=null;
   const trail=m.trail.filter(x=>now-x.at<=20000);
   const f=extractFeatures(obs,trail,now);
   if(f)f.venue=obs.venue;
   trail.push({at:now,spotPrice:obs.spotPrice,perpPrice:obs.perpPrice});
   m.trail=trail.slice(-30);
   const elapsed=now-roundAt(now);
   if(elapsed>=1500&&elapsed<8000&&f){
    const existing=this.ctx.storage.sql.exec('SELECT round FROM edge_rounds WHERE round=?',f.round).toArray()[0];
    if(!existing){
     const p=scoreDirection(f,m.model);
     if(p){
      const version=m.model?.version||'EDGE5_UNCALIBRATED_PROBE';
      this.ctx.storage.sql.exec(
       'INSERT INTO edge_rounds(round,direction,lockedAt,marketAt,score,modelVersion,'+
       'modelProbability,calibrationReady,features,actual,settledAt,pendingReason) '+
       'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
       f.round,p.direction,now,f.marketAt,p.score,version,p.modelProbability,
       p.calibrationReady?1:0,JSON.stringify(f),null,null,'AWAITING_OFFICIAL_RESOLUTION');
      m.results.observedRounds++;m.results.locked++;m.results.pending++;
     }
    }
   }
  }catch(e){m.marketError=msg(e);}
  finally{
   await v2Work;
   await this.ctx.storage.put('meta',m);
  }
 }
 async resolveOfficial(){
  const m=await this.meta();
  try{
   const map=officialRounds(await readJson(OFFICIAL_URL,3500));
   // Query only unsettled records visible to the official tracker.
   const pending=this.ctx.storage.sql.exec(
    'SELECT round,direction,features FROM edge_rounds WHERE actual IS NULL ORDER BY round DESC LIMIT 120').toArray();
   // V2 migration started with an empty archive. Recheck absent older rounds
   // against V3's authenticated Binance Prediction market-detail resolver.
   // Four bounded read-only requests per 5m; no invented labels or reset.
   const now=Date.now();
   const missing=pending.filter(r=>r.round+ROUND_MS<=now&&!valid(map.get(r.round)));
   const start=missing.length?Number(m.backfillIndex||0)%missing.length:0;
   const targets=Array.from({length:Math.min(4,missing.length)},(_,i)=>
     missing[(start+i)%missing.length]);
   if(missing.length)m.backfillIndex=(start+targets.length)%missing.length;
   const attempts=await Promise.all(targets.map(async r=>{
    try{
     const u='https://zl-signal-v3-migration.onrender.com/api/prediction-resolution?round='+r.round;
     const direct=await readJson(u,10000);
     return {round:r.round,direction:verifiedDirectOfficialResolution(direct,r.round),
       error:direct?.error||(!direct?.resolved?'UNRESOLVED_OR_UNVERIFIED':null)};
    }catch(e){return {round:r.round,direction:null,error:msg(e)};}
   }));
   m.backfillLookups=Number(m.backfillLookups||0)+attempts.length;
   m.backfillLastAt=now;
   for(const r of attempts){
    if(valid(r.direction)){map.set(r.round,r.direction);m.backfillRecovered=Number(m.backfillRecovered||0)+1;}
    else if(r.error)this.ctx.storage.sql.exec(
      'UPDATE edge_rounds SET pendingReason=? WHERE round=? AND actual IS NULL',
      String(r.error).slice(0,150),r.round);
   }
   let additions=0;
   for(const row of pending){
    const actual=map.get(row.round);
    if(!valid(actual))continue;
    if(row.round+ROUND_MS>Date.now())continue;
    this.ctx.storage.sql.exec(
     'UPDATE edge_rounds SET actual=?,settledAt=?,pendingReason=NULL WHERE round=? AND actual IS NULL',
     actual,Date.now(),row.round);
    m.results=updatedResults({...row,actual},m.results);
    additions++;
   }
   // Independently settle only V2 predictions frozen before outcome.
   // Reuse exclusively authenticated, round-aligned official directions.
   const v2Pending=this.ctx.storage.sql.exec(
    'SELECT round FROM edge_v2_shadow WHERE actual IS NULL ORDER BY round DESC LIMIT 120').toArray();
   for(const row of v2Pending){
    const actual=map.get(row.round);
    if(!valid(actual)||row.round+ROUND_MS>Date.now())continue;
    this.ctx.storage.sql.exec(
     'UPDATE edge_v2_shadow SET actual=?,settledAt=? WHERE round=? AND actual IS NULL',
     actual,Date.now(),row.round);
   }
   m.lastOfficialAt=Date.now();m.officialError=null;
   const settled=m.results.overall.samples;
   m.training.samples=settled;
   if(settled>=MIN_FIT_ROUNDS&&(settled-(m.lastTrainedCount||0)>=5)){
    const rows=this.ctx.storage.sql.exec(
     'SELECT round,direction,features,actual,settledAt FROM edge_rounds WHERE actual IS NOT NULL ORDER BY round ASC LIMIT 7500').toArray()
      .map(r=>({round:r.round,direction:r.direction,
        probe:JSON.parse(r.features),actual:r.actual,settledAt:r.settledAt}));
    const fit=trainOnOfficial(rows);
    m.training={...fit,model:undefined,ready:fit.calibrationReady===true,
      version:fit.model?.version||null};
    if(fit.model)m.model=fit.model;
    m.lastTrainedCount=settled;
   }
  }catch(e){m.officialError=msg(e);}
  finally{await this.ctx.storage.put('meta',m);}
 }
 async alarm(){
  // Schedule first: one failure never disables future attempts.
  await this.ctx.storage.setAlarm(nextTick(Date.now()));
  const now=Date.now(),elapsed=now-roundAt(now);
  if(elapsed>=24000&&elapsed<40000){await this.resolveOfficial();return;}
  await this.scan();
 }
 async fetch(request){
  const pathname=new URL(request.url).pathname;
  if(!['/status','/latest','/health','/market-check'].includes(pathname))
   return new Response('Not Found',{status:404});
  await this.schedule();
  const m=await this.meta(),now=Date.now(),round=roundAt(now);
  const recent=this.latestRows(pathname==='/status'?40:1);
  const v2Rows=this.ctx.storage.sql.exec(
   'SELECT round,pmDirection,blendDirection,lockedAt,marketAt,pmMarketId,'+
   'pmUpMid,features,actual,settledAt FROM edge_v2_shadow '+
   'ORDER BY round DESC LIMIT 500').toArray();
  const v2Results=v2Summary(v2Rows);
  const v2Latest=v2Rows[0]||null;
  const row=recent.find(r=>r.round===round);
  const execOk=Boolean(row&&valid(row.direction)&&
    Number.isFinite(row.lockedAt)&&row.lockedAt>=round&&row.lockedAt<round+8000&&
    Number.isFinite(row.marketAt)&&row.marketAt<=row.lockedAt&&
    row.lockedAt-row.marketAt<=4000&&Number.isFinite(row.score));
  const latest=row?{...row,status:'LOCKED',inputVersion:INPUT_VERSION,
    executionEligible:execOk}:null;
  const payload={ok:true,model:EDGE_MODEL,inputVersion:INPUT_VERSION,name:'EDGE 5分钟概率优势',
   readOnly:true,orders:false,productionIntegration:false,
   statsScope:'EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY',
   generatedAt:now,latest,
   recent,results:m.results,
   shadowV2:{name:'EDGE5_BINANCE_PM_V2_SHADOW',productionEffect:'NONE',
     lockTargetMs:6800,featureNames:[
      'binance_spot_momentum','binance_spot_book_imbalance',
      'binance_aggressive_flow','binance_spot_realized_vol',
      'prediction_up_mid_logodds','prediction_book_depth_imbalance'],
     results:v2Results,
     latest:v2Latest?{round:v2Latest.round,pmDirection:v2Latest.pmDirection,
       blendDirection:v2Latest.blendDirection,lockedAt:v2Latest.lockedAt,
       pmUpMid:v2Latest.pmUpMid,actual:v2Latest.actual,
       pmMarketId:v2Latest.pmMarketId}:null,
     error:m.v2Error||null,lastGoodAt:m.v2LastGoodAt||null},
   training:{...m.training,
    remaining:Math.max(0,MIN_TRAINING_ROUNDS-(m.training?.samples||0)),
    ready:m.training?.ready===true,
    fitRequired:MIN_FIT_ROUNDS,signalIndependentOfCalibration:true,
    version:m.model?.version||null},
   timed:{lastTickAt:m.lastTickAt,lastGoodDataAt:m.lastGoodDataAt,
    deadlineMs:8000,nextAlarm:await this.ctx.storage.getAlarm()},
   health:{marketError:m.marketError,officialError:m.officialError,
    lastOfficialAt:m.lastOfficialAt,venue:m.activeVenue,storage:m.storage,persisted:true,
    officialOrigin:OFFICIAL_URL,marketOrigin:RAILWAY_MARKET_URL,
     backfillLookups:Number(m.backfillLookups||0),
     backfillRecovered:Number(m.backfillRecovered||0),backfillLastAt:m.backfillLastAt||null}};
  if(pathname==='/health')return json({ok:true,model:EDGE_MODEL,orders:false,readOnly:true,
   lastTickAt:m.lastTickAt,lastGoodDataAt:m.lastGoodDataAt,
   marketError:m.marketError,officialError:m.officialError,
   calibrationReady:!!m.training?.ready,
   nextAlarm:payload.timed.nextAlarm});
  if(pathname==='/latest')return json({ok:true,model:EDGE_MODEL,latest});
  if(pathname==='/market-check'){
   try{const o=await observation(m.activeVenue);
    return json({ok:true,marketAt:o.at,venue:o.venue,
      spotPrice:o.spotPrice,perpPrice:o.perpPrice,
      providers:o.providers,realData:true,orders:false});
   }catch(e){return json({ok:false,error:msg(e),orders:false},502);}
  }
  return json(payload);
 }
}
export default{
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/'){
   return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<title>EDGE_5M_V1 实时观察</title><body style="font-family:system-ui;'+
    'background:#111827;color:#f9fafb;padding:24px;line-height:1.8">'+
    '<h2>EDGE_5M_V1 · Cloudflare 独立观察</h2>'+
    '<p>实时行情 / 独立官方结算 / 概率训练。方向≠成交；训练与方向预测分离，真实订单由交易系统控制。</p>'+
    '<pre id="state" style="white-space:pre-wrap;word-break:break-word">读取中...</pre>'+
    '<script>async function go(){try{let d=await (await fetch("/status")).json();'+
    'let r=d.results||{},t=d.training||{},h=d.health||{},l=d.latest;'+
    'document.querySelector("#state").textContent='+
    'JSON.stringify({model:d.model,currentDirection:l?.direction||"尚未冻结",'+
    'executionEligible:l?.executionEligible===true,trainingSamples:t.samples,'+
    'required:5000,calibrationReady:t.ready,accuracy:r.overall,'+
    'UP:r.up,DOWN:r.down,marketError:h.marketError,'+
    'officialError:h.officialError,latest:l},null,2)}catch(e){'+
    'document.querySelector("#state").textContent=String(e)}}go();setInterval(go,5000)</script>'+
    '</body></html>',{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  }
  if(!['/status','/latest','/health','/market-check'].includes(url.pathname))
   return new Response('Not Found',{status:404});
  const id=env.EDGE5.idFromName('edge5-one-instance');
  return env.EDGE5.get(id,{locationHint:'apac'}).fetch(request);
 }
};
