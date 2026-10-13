import {PgEventStore} from './pg-store.mjs';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {ROUND_MS, ADAPTIVE_VERSION, observeCandles, featureVector,
  adaptiveProbability, adaptiveDrift} from './core.mjs';

// This process has no production Redis, routing, PIN, trading API or write clients.
const MARKET='https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=16';
const LABELS='https://signal-diagnostic-v2-production.up.railway.app/api/fast8-stats';
const store = new PgEventStore();
const port=Number(process.env.PORT||3000);
const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const rows=new Map();
let start=null,model=null,latest=null,lastTraining=null,lastTrainingCount=0;
let ready=false,busy=false,market=null,marketError=null,labelsError=null;
const pendingDecisions = new Set();
let lastMarketSuccess=null,lastLabelSuccess=null;
const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,10);
const state=r=>{if(!rows.has(r))rows.set(r,{round:r});return rows.get(r)};
function apply(e){
  if(e.type==='start')start=e.round;
  if(e.type==='model')model=e.model;
  if(e.type==='disable')model=null;
  if(e.type==='training'){lastTraining=e;if(e.status!=='STARTED')lastTrainingCount=e.count}
  if(e.type==='decision'){const s=state(e.round);if(!s.decision)s.decision=e;latest=s.decision}
  if(e.type==='publish'){const s=state(e.round);if(s.decision&&!s.decision.publishedAt)s.decision.publishedAt=e.at}
  if(e.type==='settlement'){const s=state(e.round);if(!s.label)s.label=e}
}
async function append(data){
  if(!ready)throw Error('DATABASE_NOT_READY');
  const e={schemaVersion:1,policy:ADAPTIVE_VERSION,...data};
  // Complete PostgreSQL COMMIT before locally publishing or applying the event.
  await store.append(e);
  apply(e);
  return e;
}
async function boot(){
  await store.open();
  for(const e of await store.replay(ADAPTIVE_VERSION)){
    if(e.schemaVersion!==1||e.policy!==ADAPTIVE_VERSION)throw Error('WRONG_JOURNAL_VERSION');
    apply(e);
  }
  ready=true;
  if(start===null)await append({type:'start',round:Math.ceil(Date.now()/ROUND_MS)*ROUND_MS,
    targetAccuracy:.65,deadlineMs:8000,createdAt:Date.now()});
}
const fetchJson=async(url,timeout=3500)=>{
  const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('HTTP_'+r.status);return r.json();
};
let marketPolling=false,labelsPolling=false;
async function pollMarket(){
  if(marketPolling)return;marketPolling=true;
  try{
    const requestedAt=Date.now(),candles=await fetchJson(MARKET,3500),receivedAt=Date.now();
    const features=observeCandles(candles);
    if(!features||receivedAt-requestedAt>4000)throw Error('BAD_OR_STALE_MARKET');
    market={...features,receivedAt,source:'BINANCE_SPOT_PUBLIC_1M_CANDLES'};
    marketError=null;lastMarketSuccess=receivedAt;
  }catch(e){marketError=String(e?.message||e).slice(0,100)}
  finally{marketPolling=false}
}
function fallback(round,snapshot){
  if(snapshot)return {signal:snapshot.baseline,reason:'SPOT_1M_MOMENTUM'};
  const old=[...rows.values()].filter(r=>r.round<round&&r.label)
    .sort((a,b)=>b.round-a.round).slice(0,60);
  const up=old.filter(r=>r.label.actual==='UP').length;
  if(old.length&&up*2!==old.length)
    return {signal:up*2>old.length?'UP':'DOWN',reason:'PAST_OFFICIAL_MAJORITY'};
  return {signal:(round/ROUND_MS)%2?'DOWN':'UP',reason:'NO_INFORMATION_PARITY'};
}
async function decide(){
  if(!ready)return;
  const t=Date.now(),round=roundOf(t);
  if(round<start||t<round+2000||state(round).decision||pendingDecisions.has(round))return;
  pendingDecisions.add(round);
  try {
  // Snapshot must have been received before T0+1.5s. No retrospective substitution.
  const snap=market?.receivedAt<=round+1500&&market?.receivedAt>=round-15000?market:null;
  const base=fallback(round,snap);
  const p=model&&model.effectiveFromRound<=round&&snap?
    adaptiveProbability(model.weights,snap.facts,snap.regime):null;
  const chosen=p===null?base.signal:p>=.5?'UP':'DOWN';
  const event={type:'decision',round,decisionAt:t,signal:chosen,baseline:base.signal,
    fallbackLevel:p===null?base.reason:'LEARNED_REGIME',
    regime:snap?.regime??'NO_MARKET',x:snap?featureVector(snap.facts):null,
    featureCount:snap?.featureCount??0,featureReceivedAt:snap?.receivedAt??null,
    snapshotSource:snap?.source??null,featureCutoffMs:round+1500,
    score:p,modelVersion:p===null?'ADAPTIVE_BASELINE_V1':model.version,
    trainingThroughRound:p===null?null:model.trainingThroughRound};
  // A durable DB insert freezes the direction. Publication is also committed.
  await append(event);
  await append({type:'publish',round,at:Date.now()});
  const d=state(round).decision;
  console.log(JSON.stringify({event:'adaptive_direction_locked',round,direction:d.signal,
    regime:d.regime,delayMs:d.publishedAt-round,modelVersion:d.modelVersion}));
  } finally { pendingDecisions.delete(round); }
}
async function pollLabels(){
  if(labelsPolling)return;labelsPolling=true;
  try{
    const stats=await fetchJson(LABELS,4500);
    if(stats.modelFamily!=='ZL_FAST8_65'||!Array.isArray(stats.latestSettlements))
      throw Error('INVALID_SHADOW_LABEL_RESPONSE');
    labelsError=null;lastLabelSuccess=Date.now();
    for(const s of stats.latestSettlements){
      if(!Number.isSafeInteger(s.roundStartMs)||!['UP','DOWN'].includes(s.actual)||
        s.roundStartMs+ROUND_MS>Date.now()||s.roundStartMs<start)continue;
      const r=rows.get(s.roundStartMs);
      if(!r?.decision||r.label)continue;
      await append({type:'settlement',round:s.roundStartMs,actual:s.actual,labelReceivedAt:Date.now(),
        provenance:'EXISTING_FAST8_INTERNAL_OFFICIAL_SOURCE_NOT_INDEPENDENTLY_CERTIFIED'});
      console.log(JSON.stringify({event:'adaptive_round_settled',round:s.roundStartMs,
        actual:s.actual,hit:r.decision.signal===s.actual}));
    }
    await maybeTrain();
  }catch(e){labelsError=String(e?.message||e).slice(0,100)}
  finally{labelsPolling=false}
}
function samples(){
  return [...rows.values()].filter(r=>r.label&&r.decision&&r.decision.publishedAt&&
    r.decision.publishedAt<=r.round+8000&&r.decision.featureReceivedAt<=r.round+1500&&
    r.decision.featureCount>=5&&Array.isArray(r.decision.x))
    .sort((a,b)=>a.round-b.round).map(r=>({roundStartMs:r.round,x:r.decision.x,
      regime:r.decision.regime,y:Number(r.label.actual==='UP'),baseline:r.decision.baseline,
      decisionAt:r.decision.decisionAt,labelReceivedAt:r.label.labelReceivedAt}));
}
function recent(n=100){
  const r=[...rows.values()].filter(v=>v.decision&&v.label).sort((a,b)=>a.round-b.round).slice(-n);
  const h=r.filter(s=>s.decision.signal===s.label.actual).length;
  return {samples:r.length,hits:h,accuracy:r.length?h/r.length:null,
    regimes:Object.fromEntries(['TREND','RANGE','HIGH_VOL'].map(name=>{
      const a=r.filter(s=>s.decision.regime===name),hit=a.filter(s=>s.decision.signal===s.label.actual).length;
      return [name,{samples:a.length,hits:hit,accuracy:a.length?hit/a.length:null}];
    }))};
}
async function guardActiveModel(){
  if(!model)return;
  const r=[...rows.values()].filter(v=>v.decision?.modelVersion===model.version&&v.label)
    .sort((a,b)=>a.round-b.round).slice(-100);
  if(r.length<100)return;
  const hits=r.filter(v=>v.decision.signal===v.label.actual).length;
  const baselineHits=r.filter(v=>v.decision.baseline===v.label.actual).length;
  if(hits+5<baselineHits){
    await append({type:'disable',version:model.version,at:Date.now(),
      reason:'100_FORWARD_DECISIONS_BELOW_BASELINE',hits,baselineHits});
    console.log(JSON.stringify({event:'adaptive_rollback',hits,baselineHits}));
  }
}
async function maybeTrain(){
  if(busy||!ready)return;
  await guardActiveModel();
  const data=samples(),count=data.length;
  if(count<300)return;
  const ordered=[...rows.values()].filter(r=>r.decision&&r.label)
    .sort((a,b)=>a.round-b.round).map(r=>({...r.decision,y:Number(r.label.actual==='UP')}));
  const drift=adaptiveDrift(ordered),need=lastTrainingCount===0?300:drift?50:100;
  if(count-lastTrainingCount<need &&
    !(lastTraining?.status==='STARTED'&&lastTraining.count===count))return;
  busy=true;
  try { await append({type:'training',count,status:'STARTED',at:Date.now(),reason:drift?'DRIFT':'SCHEDULED'}); }
  catch(e){ busy=false;throw e; }
  const worker=new Worker(new URL('./trainer.mjs',import.meta.url),{workerData:{rows:data.slice(-2000)}});
  let finished=false;
  const timeout=setTimeout(()=>finish(null,'TRAINER_TIMEOUT'),20000);
  async function finish(result,error){
    if(finished)return;finished=true;clearTimeout(timeout);busy=false;
    void worker.terminate();
    try{
      let status=error?'FAILED':result?.accepted?'ACCEPTED':'REJECTED';
      if(!error&&result?.accepted){
        const weight=result.weights;
        const version='ZL_FAST8_ADAPTIVE-'+count+'-'+hash(weight);
        await append({type:'model',model:{version,weights:weight,trainingThroughRound:result.trainingThroughRound,
          effectiveFromRound:roundOf(Date.now())+ROUND_MS},at:Date.now()});
      }
      await append({type:'training',count,status,at:Date.now(),reason:drift?'DRIFT':'SCHEDULED',
        holdouts:result?.holdouts??null,error:error??null});
      console.log(JSON.stringify({event:'adaptive_training_result',count,status,
        holdouts:result?.holdouts??null,error:error??null}));
    }catch(e){ready=false;console.error('SHADOW_JOURNAL_FAILURE',String(e))}
  }
  worker.once('message',m=>{void finish(m.ok?m.result:null,m.ok?null:m.error)});
  worker.once('error',e=>{void finish(null,String(e))});
  worker.once('exit',code=>{if(!finished)void finish(null,'TRAINER_EXIT_'+code)});
}
function stats(){
  const ended=roundOf(Date.now()),expected=start===null?0:Math.max(0,(ended-start)/ROUND_MS);
  const r=[...rows.values()].filter(s=>s.round>=start&&s.round<ended).sort((a,b)=>a.round-b.round);
  const decided=r.filter(x=>x.decision),ontime=decided.filter(x=>x.decision.publishedAt&&
    x.decision.publishedAt<=x.round+8000),labeled=r.filter(x=>x.label&&x.decision);
  const hits=labeled.filter(x=>x.decision.signal===x.label.actual).length;
  const timings=decided.filter(x=>x.decision.publishedAt).map(x=>x.decision.publishedAt-x.round).sort((a,b)=>a-b);
  const latestView=latest?{round:latest.round,direction:latest.signal,regime:latest.regime,
    delayMs:latest.publishedAt?latest.publishedAt-latest.round:null,
    fallbackLevel:latest.fallbackLevel,modelVersion:latest.modelVersion}:null;
  const first=r.filter(s=>s.round<start+1000*ROUND_MS);
  const settledFirst=first.filter(s=>s.label&&s.decision),timelyFirst=settledFirst.filter(s=>
    s.decision.publishedAt&&s.decision.publishedAt<=s.round+8000);
  const firstHits=timelyFirst.filter(s=>s.decision.signal===s.label.actual).length;
  const firstExpected=Math.min(expected,1000),firstPublished=first.filter(s=>s.decision&&
    s.decision.publishedAt&&s.decision.publishedAt<=s.round+8000).length;
  const validated=firstExpected===1000&&firstPublished===1000&&
    settledFirst.length===1000&&firstHits>=650;
  return {family:ADAPTIVE_VERSION,generatedAt:new Date().toISOString(),shadowOnly:true,
    productionEffect:'NONE_SHADOW_ONLY',autoPromotion:false,executionEligible:false,
    state:model?'ADAPTIVE_MODEL_ACTIVE':'BASELINE_COLLECTING',experimentStartRound:start,
    expectedRounds:expected,decidedRounds:decided.length,missingRounds:expected-decided.length,
    coverage:expected?decided.length/expected:null,onTimeRounds:ontime.length,
    onTimeCoverage:expected?ontime.length/expected:null,
    labeled:labeled.length,pending:decided.length-labeled.length,hits,misses:labeled.length-hits,
    accuracy:labeled.length?hits/labeled.length:null,
    validation:{window:'FIRST_1000_CONSECUTIVE_CALENDAR_ROUNDS',
      expected:firstExpected,onTime:firstPublished,settled:settledFirst.length,
      hits:firstHits,passed:validated,
      status:validated?'OBSERVED_TARGET_MET':firstExpected<1000?'COLLECTING':'NOT_MET_OR_PENDING'},
    latest:latestView,recent100:recent(),
    publicationMs:{p95:timings.length?timings[Math.ceil(timings.length*.95)-1]:null,
      max:timings.at(-1)??null},
    training:{samples:samples().length,required:300,last:lastTraining,busy,
      triggerEveryAdditional:100,earlyDriftTriggerAdditional:50,
      note:'No training before 300 timely labeled market snapshots'},
    model:model?{version:model.version,effectiveFromRound:model.effectiveFromRound}:null,
    health:{journalReady:ready,lastMarketSuccess,marketError,lastLabelSuccess,labelsError},
    labelEvidence:'EXISTING_FAST8_INTERNAL_OFFICIAL_SOURCE_NOT_INDEPENDENTLY_CERTIFIED'};
}
function handler(req,res){
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!['/healthz','/api/shadow/status','/api/shadow/latest'].includes(pathname)){
    res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"NOT_FOUND"}');return;
  }
  const status=stats(),body=pathname==='/healthz'?{ok:ready,journalReady:ready}:
    pathname==='/api/shadow/latest'?status.latest:status;
  res.writeHead(pathname==='/healthz'&&!ready?503:200,{
    'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));
}
await boot();
http.createServer(handler).listen(port,'0.0.0.0',()=>console.log(JSON.stringify({
  event:'adaptive_shadow_ready',port,start,version:ADAPTIVE_VERSION})));
setInterval(()=>{void decide().catch(e=>{ready=false;console.error('SHADOW_TICK_ERROR',String(e))})},40);
setInterval(()=>{void pollMarket()},5000);
setInterval(()=>{void pollLabels()},15000);
setInterval(()=>console.log(JSON.stringify({event:'adaptive_shadow_status',...stats()})),60000);
void pollMarket();void pollLabels();void maybeTrain();
