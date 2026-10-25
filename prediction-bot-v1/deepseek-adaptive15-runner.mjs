// Isolated adaptive DeepSeek runner, no Binance order API or order submission.
// 120s prior pre-analysis; current-round reasoning after +15s; strict +40s AI boundary.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {COLLECT_MS,DEADLINE_MS,roundOf,makeWindow,marketTick,collect,
 analysisRequest,decodeAnalysis,registerAnalysis,finalize,closeExpiredWindow,windowStatus}
 from './deepseek-adaptive15-core.mjs';

const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const API='https://api.deepseek.com/chat/completions';
const OFFICIAL_REFERENCE='http://127.0.0.1:13044/api/reference';
const desc=e=>String(e?.message||e||'UNKNOWN').slice(0,120);
// Two pre-round passes, up to four evidence-spaced live passes. These are
// maximums, not quotas. Successful judgments lock immediately.
export const MAX_AI_CALLS_PER_ROUND=5;
export const MAX_PRE_ROUND_CALLS=2;
export const MAX_LIVE_CALLS=3;
export const LIVE_REVIEW_MIN_INTERVAL_MS=6000;
const liveCalls=w=>w.modelCalls-w.attemptedPasses.length;
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
 let officialReference=null,refBusy=false,lastRefTryAt=0,lastRefError=null;
 // Official reference is supplemental only: never blocks model calls or creates a direction.
 async function refreshOfficialReference(round){
  const now=clock();
  if(refBusy||officialReference?.roundStartMs===round||
     now<round||now>=round+DEADLINE_MS||
     now-lastRefTryAt<3500)return;
  refBusy=true;lastRefTryAt=now;
  try{
   const response=await fetcher(String(env.OFFICIAL_REFERENCE_URL||OFFICIAL_REFERENCE)+'?round='+round,
     {headers:{Accept:'application/json'},signal:AbortSignal.timeout(2800)});
   if(!response.ok)throw Error('REFERENCE_HTTP_'+response.status);
   const info=await response.json();
   if(info?.ok!==true||info?.schema!=='OFFICIAL_PREDICTION_START_CHAINLINK_V1'||
      info.roundStartMs!==round||info.roundEndMs!==round+300000||
      info.priceFeedProvider!=='CHAINLINK'||info.priceFeedSymbol!=='BTCUSDT'||
      info.source!=='BINANCE_PREDICTION_SIGNED_MARKET_DETAIL'||
      !(Number(info.officialStartPrice)>0)||
      !Number.isSafeInteger(info.officialPriceObservedAt)||
      info.officialPriceObservedAt<round||info.officialPriceObservedAt>clock()+1000||
      info.officialLivePriceAvailable!==false||info.officialLivePrice!==null)
     throw Error('INVALID_OFFICIAL_REFERENCE');
   // Do not leak previous, next or post-settlement data into a trading prompt.
   if(roundOf(clock())===round)officialReference={...info};
   lastRefError=null;
  }catch(e){lastRefError='REFERENCE_'+desc(e)}
  finally{refBusy=false}
 }
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
   if(current.terminal.reason==='DEADLINE_40S_EXPIRED')missed++;
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
  const target=targetFor(now);
  return {ok:true,mode:'SHADOW_ONLY_NO_ORDERS',
   model:'DEEPSEEK_ADAPTIVE15_EXPERIENCE_V1',providerModel:model,
   aiEnabled:enabled,configured:enabled&&Boolean(key),inFlight,aiLatencyMs,aiTokens,
   lastMarketAt:lastFeedAt,lastError,missedRounds:missed,skippedRounds:skipped,
   lastCompleted,window:current?windowStatus(current,now):null,
   officialReference:officialReference?.roundStartMs===roundOf(now)?{
    available:true,priceFeedProvider:officialReference.priceFeedProvider,
    officialStartPrice:officialReference.officialStartPrice,
    observedAt:officialReference.officialPriceObservedAt,
    oracleLiveQuoteAvailable:false}: {available:false,lastError:lastRefError},
   currentDecisionStatus:current?.final?'LOCKED':current?.terminal?'WAIT':'ANALYZING',
   targetRound:target,lastSignal:lastSignal?{round:lastSignal.round,
    direction:lastSignal.latest.direction,lockedAt:lastSignal.latest.lockedAt}:null,
   orders:false,realOrderEnabled:false,productionIntegration:false};
 }
 function rotate(now){
  completeCurrent(now);
  const target=targetFor(now);
  if(target==null||current?.round===target)return;
  current=makeWindow(target);lastError=null;aiLatencyMs=null;aiTokens=null;
 }
 async function analyze(w,pass,raw,now){
  if(!enabled||!key||inFlight||w.final||w.terminal||
    w.modelCalls>=MAX_AI_CALLS_PER_ROUND||
    (pass==='current'&&liveCalls(w)>=MAX_LIVE_CALLS)||
    (pass!=='current'&&(w.attemptedPasses.length>=MAX_PRE_ROUND_CALLS||
      w.passes.some(x=>x.pass===pass)||w.attemptedPasses.includes(pass))))return;
  const remaining=w.round-now;
  if((pass==='initial'&&(remaining>75000||remaining<34000))||
    (pass==='review'&&(remaining>30000||remaining<4000))||
    (pass==='current'&&(remaining> -15000||remaining< -(DEADLINE_MS-650))))return;
  // A fresh market observation and meaningful elapsed time must separate
  // live calls; never spend tokens re-analysing the same tick every 400ms.
  if(pass==='current'&&(w.lastLiveRequestAt!=null&&
     now-w.lastLiveRequestAt<LIVE_REVIEW_MIN_INTERVAL_MS||
     w.lastLiveMarketAt!=null&&w.early.at(-1)?.at<=w.lastLiveMarketAt))return;
  let payload;
  try{
   const features=extractFeatures(raw,now);
   if(pass==='current'&&officialReference?.roundStartMs===w.round&&
      officialReference.officialPriceObservedAt<=now){
    features.officialReference={...officialReference};
   }
   const feedback=typeof getHistoricalFeedback==='function'?
     getHistoricalFeedback(features):{};
   payload=analysisRequest(w,pass,now,features,feedback);
   // Prompt evidence offered, not demonstrated comprehension or predictive lift.
   w.experienceEvidence??=[];
   w.experienceEvidence.push({pass,at:now,
    historyOffered:feedback?.usable===true,
    similarCaseCount:feedback?.episodicMemory?.usable===true?
      (feedback.episodicMemory.cases?.length||0):0,
    errorPatternsOffered:feedback?.officialErrorPatterns?.usable===true?
      (feedback.officialErrorPatterns.patterns?.length||0):0});
  }catch(e){w.lastModelError='INPUT_'+desc(e);lastError=w.lastModelError;return}
  inFlight=true;
  if(pass!=='current')w.attemptedPasses.push(pass);
  else{w.lastLiveRequestAt=now;w.lastLiveMarketAt=w.early.at(-1)?.at??null;}
  w.modelCalls++;
  // Pre-round prompts are optional preparations. Live analysis calls use the remaining
  // round budget and may repeat when DeepSeek requests new evidence.
  const budget=pass==='current'?
    Math.max(250,w.round+DEADLINE_MS-clock()-350):
    Math.min(pass==='initial'?38000:26000,
      Math.max(1000,w.round-clock()-(pass==='initial'?33000:3000)));
  const started=clock();
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
   const result=decodeAnalysis(choice?.message?.content,w.round,clock(),pass);
   registerAnalysis(w,result);w.lastModelError=null;lastError=null;
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
    collect(w,obs);
    const now=clock(),remaining=w.round-now;
    if(now>=w.round&&now<w.round+DEADLINE_MS)
      void refreshOfficialReference(w.round);
    if(now<w.round){
     if(remaining<=75000&&remaining>=34000&&!w.passes.some(x=>x.pass==='initial'))
      void analyze(w,'initial',raw,now);
     else if(remaining<=30000&&remaining>=4000&&!w.passes.some(x=>x.pass==='review'))
      void analyze(w,'review',raw,now);
    } else if(now>=w.round+15000&&now<w.round+DEADLINE_MS&&!w.final&&!w.terminal){
     // Only DeepSeek decides whether another review improves the evidence.
     // Never hold a finished judgment until an arbitrary 8s/15s milestone.
     const latestCurrent=w.passes.filter(x=>x.pass==='current').at(-1);
     // WAIT is not a final answer while reliable market data and time remain.
     // Re-ask the real DeepSeek model; never fabricate a direction or override
     // its most recent real directional decision.
     const wantsMore=!latestCurrent||latestCurrent.continueAnalysis||latestCurrent.direction==='WAIT';
     const exhausted=liveCalls(w)>=MAX_LIVE_CALLS||w.modelCalls>=MAX_AI_CALLS_PER_ROUND;
     if(wantsMore&&!exhausted&&!inFlight&&now<w.round+DEADLINE_MS-1200)
      void analyze(w,'current',raw,now);
     // When the review budget is exhausted, the last genuine UP/DOWN can
     // lock even if the model asked to continue. Never fabricate from WAIT,
     // or publish while its final scheduled call is still in flight.
     const readyToLock=latestCurrent&&latestCurrent.direction!=='WAIT'&&
       (!latestCurrent.continueAnalysis||(exhausted&&!inFlight));
     const finalChance=now>=w.round+DEADLINE_MS-1100;
     if(now>=w.round&&(readyToLock||finalChance))try{
      let feedback={};
      if(typeof getHistoricalFeedback==='function'){
       const f=extractFeatures(raw,now);
       feedback=getHistoricalFeedback(f);
      }
      const actualDecisionAt=clock();
      if(actualDecisionAt>=w.round+DEADLINE_MS){
       completeCurrent(actualDecisionAt);
      }else{
       const decision=finalize(w,actualDecisionAt,feedback);
       if(decision.ok){
        try{if(typeof onLocked==='function')onLocked(decision,raw,clock(),w)}
        catch(e){w.final=null;throw e}
        lastSignal=decision;lastCompleted={round:w.round,result:'LOCKED',
          elapsedMs:clock()-w.round,direction:decision.latest.direction};
        lastError=null;
       }else if(decision.skip){lastError=decision.reason}
      }
     }catch(e){lastError=desc(e);w.skips.push(lastError)}
    }
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
 console.log('DEEPSEEK_ADAPTIVE15_RUNNING order_write_access=false');
}
