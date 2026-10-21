// Standalone FAST10 research runner. No Binance API, no trading controls, no paid
// inference by default. Source HTTP server binds 127.0.0.1 exclusively.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {roundOf,newWindow,observe,normalizeMarket,parsePrewarm,prewarmRequest,finalize,stateInfo} from './deepseek-fast10-shadow-core.mjs';

const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const LLM='https://api.deepseek.com/chat/completions';
const errorCode=e=>String(e?.code||e?.message||'UNKNOWN').slice(0,100);
export function createRunner({env=process.env,clock=()=>Date.now(),fetcher=fetch,
  onLocked=null,getHistoricalFeedback=null}={}){
 const enabled=env.FAST10_SHADOW_ENABLE_AI==='1';
 const key=env.DEEPSEEK_API_KEY||'';
 const feed=env.FAST10_MARKET_URL||FEED;
 const api=env.DEEPSEEK_API_URL||LLM;
 const model=env.DEEPSEEK_MODEL||'deepseek-flash';
 let window=null,lastSignal=null,lastError=null,aiBusy=false,feedBusy=false,feedNextAt=0,aiAttempts=0;
 let aiLatencyMs=null,latestFeedAt=null,consecutiveFeedErrors=0,missedRounds=0,lastMissingReason=null;
 function currentTarget(now){
  const r=roundOf(now),elapsed=now-r;
  if(elapsed<10000&&window?.forRound===r)return r;
  if(elapsed>=180000)return r+300000;
  return null;
 }
 function status(){
  const now=clock(),active=currentTarget(now);
  return {ok:true,mode:'SHADOW_NO_ORDERS',model:'DEEPSEEK_PREWARM_FAST10_SHADOW_V1',
   providerModel:model,aiEnabled:enabled,apiKeyConfigured:enabled&&Boolean(key),
   aiBusy,aiAttempts,aiLatencyMs,latestFeedAt,consecutiveFeedErrors,
   lastError,missedRounds,lastMissingReason,
   window:window?stateInfo(window,now):null,
   currentTarget:active,lastSignal:lastSignal?{
    round:lastSignal.round,direction:lastSignal.latest.direction,
    lockedAt:lastSignal.latest.lockedAt,source:'DEEPSEEK_PREWARM_PLUS_FAST_OPEN'}:null,
   orders:false,realOrderEnabled:false,productionIntegration:false};
 }
 function rotate(now){
  const target=currentTarget(now);
  if(!target)return;
  if(!window||window.forRound!==target){
   if(window&&!window.signal&&now>=window.forRound+10000){
    missedRounds++;lastMissingReason=window.errors.at(-1)||'FAST10_DEADLINE_MISSED';
   }
   window=newWindow(target);lastError=null;aiAttempts=0;aiLatencyMs=null;
  }
 }
 async function callPrewarm(active,raw,now){
  if(!enabled||!key||aiBusy||active.prewarm||aiAttempts>=2)return;
  const remaining=active.forRound-now;
  if(remaining>(aiAttempts===0?75000:27000)||remaining<4000)return;
  let payload;
  try{
   const prev=extractFeatures(raw,now);
   payload=prewarmRequest(active,now,prev);
   if(typeof getHistoricalFeedback==='function'){
    const history=getHistoricalFeedback(prev);
    const original=JSON.parse(payload.messages[1].content);
    payload.messages[1].content=JSON.stringify({...original,officialSettledFeedback:history});
   }
  }catch(e){
   // A bad feature feed must not cause any synthetic AI decision.
   lastError='PREWARM_INPUT_'+errorCode(e);
   active.errors.push(lastError);return;
  }
  aiBusy=true;aiAttempts++;const started=clock();
  try{
   payload.model=model;
   const response=await fetcher(api,{method:'POST',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(Math.min(65000,Math.max(1000,active.forRound-clock()-3500)))});
   aiLatencyMs=clock()-started;
   if(!response.ok)throw Error('LLM_HTTP_'+response.status);
   const body=await response.json();
   if(body?.choices?.[0]?.finish_reason==='length')throw Error('LLM_TRUNCATED');
   const choice=body?.choices?.[0]?.message?.content;
   const result=parsePrewarm(choice,active.forRound,clock());
   active.prewarm=result;
  }catch(e){
   lastError='PREWARM_'+errorCode(e);active.errors.push(lastError);
  }finally{aiBusy=false}
 }
 async function tick(){
  const now=clock();
  rotate(now);
  if(feedBusy||now<feedNextAt)return status();
  const active=window;
  // 400-800ms tick timer; HTTP requests at most once per ~750ms.
  feedBusy=true;feedNextAt=now+750;
  try{
   const response=await fetcher(feed,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(1800)});
   if(!response.ok)throw Error('FEED_HTTP_'+response.status);
   const raw=await response.json(),observed=normalizeMarket(raw,clock());
   latestFeedAt=observed.at;consecutiveFeedErrors=0;
   if(active&&active===window){
    observe(active,observed);
    const t=clock();
    if(t>=active.forRound-75000&&t<active.forRound)
      // Deliberately don't block polling while DeepSeek thinks.
      void callPrewarm(active,raw,t);
    if(t>=active.forRound+6500&&t<active.forRound+10000&&!active.signal){
     try{
      const result=finalize(active,t);
      if(typeof onLocked==='function')onLocked(result,raw,t);
      lastSignal=result;lastError=null;
     }catch(e){lastError=errorCode(e);active.errors.push(lastError)}
    }
   }
  }catch(e){consecutiveFeedErrors++;lastError=errorCode(e);if(active)active.errors.push(lastError)}
  finally{feedBusy=false}
  return status();
 }
 return {status,tick};
}
export function serve(runner,port=Number(process.env.FAST10_SHADOW_PORT||13042)){
 const server=http.createServer((req,res)=>{
  let p;try{p=new URL(req.url,'http://localhost').pathname}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  if(!['/healthz','/api/status'].includes(p)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  return res.end(JSON.stringify(runner.status()));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runner=createRunner();serve(runner);void runner.tick();
 setInterval(()=>void runner.tick(),400);
 console.log('FAST10_SHADOW_STARTED no-orders=true');
}
