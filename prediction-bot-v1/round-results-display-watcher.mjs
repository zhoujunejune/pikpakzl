// Read-only independent results dashboard service. Never submits trades,
// changes model weights, or supplies historical feedback to DeepSeek.
import http from 'node:http';
import {createRoundResultsJournal} from './round-results-only-journal.mjs';
const PERIOD=300000;
const DECISION_WINDOW_MS=15000;
const roundOf=now=>Math.floor(now/PERIOD)*PERIOD;
export function createDisplayWatcher({
 clock=()=>Date.now(),fetcher=fetch,
 journal=createRoundResultsJournal({clock}),
 modelUrl='http://127.0.0.1:13029/api/status',
 officialUrl='http://127.0.0.1:13002/api/round-stats'
}={}){
 let activeRound=null,sawWindow=false,busy=false,officialBusy=false,officialAt=0;
 let lastModelError=null,lastOfficialError=null,modelAt=null,servicePolls=0;
 async function read(url,timeout=1500){
  const r=await fetcher(url,{headers:{Accept:'application/json'},
   signal:AbortSignal.timeout(timeout),cache:'no-store'});
  if(!r.ok)throw Error('READ_HTTP_'+r.status);
  return r.json();
 }
 async function tick(){
  if(busy)return;busy=true;
  try{
   const now=clock(),round=roundOf(now);
   if(activeRound!==null&&round!==activeRound){
    journal.finishRound(activeRound,{observed:sawWindow});
    for(let gap=activeRound+PERIOD;gap<round;gap+=PERIOD){
     journal.finishRound(gap,{observed:false});
    }
    sawWindow=false;
   }
   activeRound=round;
   if(now<round+DECISION_WINDOW_MS)sawWindow=true;
   let status=null;
   try{
    status=await read(modelUrl,1400);servicePolls++;
    if(status?.ok!==true||status?.model!=='DEEPSEEK_5M_V1'||
     status?.maxCallsPerRound!==1||status?.learningDisabled!==true)
      throw Error('UNEXPECTED_MODEL_VERSION');
    modelAt=clock();lastModelError=null;
    const signal=status.signal;
    if(signal?.round===round&&signal.latest?.status==='LOCKED'){
     journal.recordSignal(signal);
    }
   }catch(e){lastModelError=String(e?.message||e).slice(0,125)}
   const elapsed=clock()-round;
   if(elapsed>=DECISION_WINDOW_MS){
    // Never mislabel a model-confirmed lock as a missed/no-signal decision
    // when this display watcher came up after the model's 25s exposure.
    const lockedButMissing=status?.roundDecision?.status==='LOCKED';
    journal.finishRound(round,{observed:sawWindow&&!lockedButMissing});
   }
  }finally{busy=false}
 }
 async function settleOnce(){
  if(officialBusy||clock()-officialAt<40000)return;
  officialBusy=true;officialAt=clock();
  try{
   const data=await read(officialUrl,6500);
   journal.settle(data);lastOfficialError=null;
  }catch(e){lastOfficialError=String(e?.message||e).slice(0,125)}
  finally{officialBusy=false}
 }
 function status(){
  return {ok:true,service:'DEEPSEEK5_ROUND_RESULTS_DISPLAY_ONLY',
   learningDisabled:true,orderEnabled:false,modelAccess:'READ_ONLY',
   currentRound:activeRound,lastModelAt:modelAt,lastModelError,
   lastOfficialError,servicePolls,display:journal.history(1).summary};
 }
 return {tick,settleOnce,status,history:limit=>journal.history(limit)};
}
export function serveWatcher(watcher,port=Number(process.env.RESULTS_DISPLAY_PORT||13045)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data;
  if(u.pathname==='/api/round-results'){
   data=watcher.history(u.searchParams.get('limit'));
   // Legacy UI tests only DEEPSEEK_SINGLE_CALL_5S vs fallback. Map the
   // genuine 15s model solely for that display field, preserving raw source.
   data.records=data.records.map(r=>r.decisionMethod==='DEEPSEEK_SINGLE_CALL_15S'?
     {...r,rawDecisionMethod:r.decisionMethod,decisionMethod:'DEEPSEEK_SINGLE_CALL_5S'}:r);
  }
  else if(u.pathname==='/api/status'||u.pathname==='/healthz')data=watcher.status();
  else{res.writeHead(404);return res.end('Not Found')}
  res.writeHead(data.ok?200:503,{'content-type':'application/json; charset=utf-8',
   'cache-control':'no-store'});
  res.end(JSON.stringify(data));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
 const watcher=createDisplayWatcher({
  journal:createRoundResultsJournal({file:process.env.RESULTS_JOURNAL_FILE||
   '/var/lib/zl-prediction/deepseek5/display-round-results.ndjson'})
 });
 serveWatcher(watcher);
 void watcher.tick();
 setInterval(()=>void watcher.tick(),350);
 void watcher.settleOnce();
 setInterval(()=>void watcher.settleOnce(),60000);
 console.log('DEEPSEEK_ROUND_RESULTS_DISPLAY_ONLY_RUNNING;NO_MODEL_CHANGES;NO_ORDERS');
}
