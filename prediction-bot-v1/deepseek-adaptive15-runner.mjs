// Isolated adaptive DeepSeek runner, no Binance order API or order submission.
// One DeepSeek call after actual opening; 9-second strict hard deadline.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {COLLECT_MS,DEADLINE_MS,roundOf,makeWindow,marketTick,collect,
 analysisRequest,decodeAnalysis,registerAnalysis,finalize,closeExpiredWindow,windowStatus}
 from './deepseek-adaptive15-core.mjs';

const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const API='https://api.deepseek.com/chat/completions';
const desc=e=>String(e?.message||e||'UNKNOWN').slice(0,120);
// Two pre-round passes, up to four evidence-spaced live passes. These are
// maximums, not quotas. Successful judgments lock immediately.
export const MAX_AI_CALLS_PER_ROUND=6;
export const MAX_PRE_ROUND_CALLS=2;
export const MAX_LIVE_CALLS=4;
export const LIVE_REVIEW_MIN_INTERVAL_MS=6000;
const liveCalls=w=>w.modelCalls-w.attemptedPasses.length;
// Exactly one DeepSeek API request during the actual round, no pre-round AI calls.
// Pre-round time is used only to collect authentic market samples.
export const MAX_AI_CALLS_PER_ROUND=1;
export const MAX_PRE_ROUND_CALLS=0;
export const MAX_LIVE_CALLS=1;

export function createAdaptiveRunner({
 env=process.env,clock=()=>Date.now(),fetcher=fetch,
 onLocked=null,onWait=null,getHistoricalFeedback=null
}={}){
 const enabled=env.ADAPTIVE15_ENABLE_AI==='1';
 const key=String(env.DEEPSEEK_API_KEY||'');
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const feed=String(env.ADAPTIVE15_MARKET_URL||FEED);
 const api=String(env.DEEPSEEK_API_URL||API);
 let current=null,lastSignal=null,lastError=null,lastFeedAt=null;
 let inFlight=false,feedBusy=false,feedNext=0,aiLatencyMs=null,aiTokens=null;
 let missed=0,skipped=0,lastCompleted=null,lastCountedRound=null;
 function completeCurrent(now){
  if(!current)return;
  closeExpiredWindow(current,now);
  if(current.terminal&&lastCountedRound!==current.round){
   if(typeof onWait==='function'){
    try{onWait({...current.terminal})}
    catch(e){lastError='WAIT_JOURNAL_WRITE_FAILED_'+desc(e)}
   }
   lastCountedRound=current.round;
   skipped++;
   if(current.terminal.reason==='DEADLINE_9S_EXPIRED')missed++;
   lastCompleted={round:current.round,result:'WAIT',direction:'WAIT',
    reason:current.terminal.reason,detail:current.terminal.detail,
    completedAt:current.terminal.at,signalGenerated:false,orders:false};
  }
 }
 function targetFor(now){
  const r=roundOf(now),elapsed=now-r;
  if(elapsed<DEADLINE_MS&&current?.round===r)return r;
  return elapsed>=300000-COLLECT_MS?r+300000:null;
 }
 function status(){
  const now=clock();completeCurrent(now);
  return {ok:true,mode:'SHADOW_ONLY_NO_ORDERS',
   model:'DEEPSEEK_SINGLE_9S_REALDATA_V1',providerModel:model,
   aiEnabled:enabled,configured:enabled&&Boolean(key),inFlight,aiLatencyMs,aiTokens,
   lastMarketAt:lastFeedAt,lastError,missedRounds:missed,skippedRounds:skipped,
   lastCompleted,window:current?windowStatus(current,now):null,
   currentDecisionStatus:current?.final?'LOCKED':current?.terminal?'WAIT':'ANALYZING',
   targetRound:targetFor(now),lastSignal:lastSignal?{round:lastSignal.round,
    direction:lastSignal.latest.direction,lockedAt:lastSignal.latest.lockedAt}:null,
   orders:false,realOrderEnabled:false,productionIntegration:false};
 }
 function rotate(now){
  completeCurrent(now);
  const target=targetFor(now);
  if(target==null||current?.round===target)return;
  current=makeWindow(target);lastError=null;aiLatencyMs=null;aiTokens=null;
 }
 async function analyzeOnce(w,raw,now){
  if(!enabled||!key||inFlight||w.modelCalls>=1||w.final||w.terminal||
    now<w.round||now>=w.round+DEADLINE_MS-850||w.early.length<1)return;
  let payload;
  try{
   const features=extractFeatures(raw,now);
   const feedback=typeof getHistoricalFeedback==='function'?
    getHistoricalFeedback(features):{};
   payload=analysisRequest(w,'current',now,features,feedback);
  }catch(e){w.lastModelError='INPUT_'+desc(e);lastError=w.lastModelError;return}
  // Count attempts, including unsuccessful API calls. No second model invocation.
  w.modelCalls=1;w.attemptedPasses.push('current');
  inFlight=true;
  const started=clock();
  const budget=Math.max(250,w.round+DEADLINE_MS-started-450);
  try{
   payload.model=model;
   const res=await fetcher(api,{method:'POST',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(budget)});
   aiLatencyMs=clock()-started;
   if(!res.ok)throw Error('DEEPSEEK_HTTP_'+res.status);
   const body=await res.json();
   aiTokens=Number(body?.usage?.total_tokens)||null;
   const choice=body?.choices?.[0];
   if(choice?.finish_reason==='length')throw Error('MODEL_TRUNCATED');
   const at=clock();
   if(at>=w.round+DEADLINE_MS||w.terminal||w.final)throw Error('MODEL_AFTER_9S');
   const result=decodeAnalysis(choice?.message?.content,w.round,at,'current');
   registerAnalysis(w,result);
   if(result.direction==='WAIT'){
    w.provisionalWait='DEEPSEEK_CHOSE_WAIT';
    return;
   }
   // Consume the newest observed data, not the stale snapshot from when the
   // single request began. Market polling continues while DeepSeek reasons.
   const finalAt=clock();
   if(finalAt>=w.round+DEADLINE_MS)throw Error('LOCK_AFTER_9S');
   const source=w.latestRaw||raw;
   const actual=marketTick(source,finalAt);
   collect(w,actual);
   const feedback=typeof getHistoricalFeedback==='function'?
    getHistoricalFeedback(extractFeatures(source,finalAt)):{};
   const decision=finalize(w,clock(),feedback);
   if(decision.ok){
    try{if(typeof onLocked==='function')onLocked(decision,source,clock(),w)}
    catch(e){w.final=null;throw e}
    lastSignal=decision;
    lastCompleted={round:w.round,result:'LOCKED',
      elapsedMs:clock()-w.round,direction:decision.latest.direction};
    lastError=null;
   }else if(decision.skip)lastError=decision.reason;
  }catch(e){w.lastModelError='DEEPSEEK_'+desc(e);lastError=w.lastModelError}
  finally{inFlight=false}
 }
 async function tick(){
  const started=clock();rotate(started);
  if(feedBusy||started<feedNext)return status();
  feedBusy=true;feedNext=started+750;
  const w=current;
  try{
   const res=await fetcher(feed,{headers:{Accept:'application/json'},
     signal:AbortSignal.timeout(1800)});
   if(!res.ok)throw Error('FEED_HTTP_'+res.status);
   const raw=await res.json();
   const obs=marketTick(raw,clock());lastFeedAt=obs.at;
   if(w&&w===current){
    completeCurrent(clock());
    if(collect(w,obs))w.latestRaw=raw;
    const now=clock();
    if(now>=w.round&&now<w.round+DEADLINE_MS&&
      !w.final&&!w.terminal&&w.modelCalls===0)
      void analyzeOnce(w,raw,now);
   }
  }catch(e){lastError='MARKET_'+desc(e);if(w)w.skips.push(lastError)}
  finally{feedBusy=false}
  return status();
 }
 return {status,tick};
}

export function serveAdaptive(runner,port=Number(process.env.ADAPTIVE15_PORT||13043)){
 const server=http.createServer((req,res)=>{
  let path;try{path=new URL(req.url,'http://localhost').pathname}
  catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  if(!['/healthz','/api/status'].includes(path)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  return res.end(JSON.stringify(runner.status()));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runner=createAdaptiveRunner();serveAdaptive(runner);void runner.tick();
 setInterval(()=>void runner.tick(),400);
 console.log('DEEPSEEK_SINGLE9_RUNNING order_write_access=false');
}
