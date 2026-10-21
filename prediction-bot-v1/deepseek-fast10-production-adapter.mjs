// Compatibility adapter, NOT automatically deployed.
// Retains the exact production /signal schema while decision logic becomes
// pre-round DeepSeek analysis + new-round opening and early-tick reconciliation.
// The adapter itself NEVER interacts with Binance or submits an order.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRunner} from './deepseek-fast10-shadow-runner.mjs';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';
import {roundOf} from './deepseek-fast10-shadow-core.mjs';

const ID='DEEPSEEK_5M_V1';
const SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const OFFICIAL='http://127.0.0.1:13002/api/round-stats';
export function buildCompatibleSignal(candidate,at,providerModel){
 const r=candidate?.round,d=candidate?.latest?.direction,quoteAt=candidate?.latest?.marketAt;
 if(!Number.isSafeInteger(r)||r%300000!==0||!['UP','DOWN'].includes(d)||
    !Number.isSafeInteger(quoteAt)||quoteAt<r||quoteAt>at||
    at<r||at>=r+10000||candidate?.orders!==false||
    candidate?.productionIntegration!==false)
  throw Error('FAST10_PROD_INVALID_CANDIDATE');
 const score=Math.abs(Number(candidate.latest.rawHybridScore||0));
 const confidence=null; // A subjective score is NOT a calibrated probability.
 return {ok:true,model:ID,round:r,generatedAt:at,readOnly:true,orders:false,
   productionIntegration:false,providerModel,
   latest:{model:ID,round:r,status:'LOCKED',direction:d,lockedAt:at,
    marketAt:quoteAt,confidence,score:Number(score.toFixed(4)),
    reason:'DEEPSEEK_PREWARM_PLUS_NEXT_OPEN_FAST10',
    decisionMethod:'HYBRID_PREWARM_FAST10_V1',
    prewarmDirection:candidate.latest.rawPrewarmDirection,
    fromOpenBps:candidate.latest.fromOpenBps,
    earlyObservationCount:candidate.latest.earlySnapshots,
    entry:{direction:d,at,marketAt:quoteAt,score:Number(score.toFixed(4)),
      strength:Number(score.toFixed(4)),modelVersion:ID}},
   // Existing producer's validation expects this compatibility expiry.
   // It is not the decision creation deadline: that remains strict +10s.
   expiryAt:r+270000};
}
export function createFast10ProductionProvider({env=process.env,clock=()=>Date.now(),fetcher=fetch}={}){
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const key=String(env.DEEPSEEK_API_KEY||'');
 const stateFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/deepseek5/signal.json');
 const learner=newLearner(String(env.DEEPSEEK_LEARNING_FILE||'/var/lib/zl-prediction/deepseek5/learning.json'),clock);
 let saved=null,pollAt=0,settlementError=null,lastSettlementCount=0,lastError=null;
 try{
  const old=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(old?.model===ID&&old?.orders===false)saved=old;
 }catch{}
 const persist=signal=>{
  fs.mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o750});
  const tmp=stateFile+'.fast10.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(signal),{mode:0o640});
  fs.renameSync(tmp,stateFile);
 };
 const runner=createRunner({
  env:{...env,FAST10_SHADOW_ENABLE_AI:key?'1':'0'},clock,fetcher,
  getHistoricalFeedback:features=>learner.feedback(features),
  onLocked:(candidate,raw,at)=>{
   if(saved?.round===candidate.round)return; // never duplicate a prior lock
   const signal=buildCompatibleSignal(candidate,at,model);
   const features=extractFeatures(raw,at);
   if(features.round!==candidate.round||!features.dataQuality.indicatorsReady)
     throw Error('PRODUCTION_FEATURES_NOT_READY');
   persist(signal);saved=signal;
   try{learner.record(signal,features,1)}
   catch(e){settlementError='RECORD_'+String(e?.message||e).slice(0,70)}
  }});
 function stats(){try{return learner.summary()}catch{return {officialSamples:0,error:'LEARNING_FILE_ERROR'}}}
 function status(){
  const r=roundOf(clock()),shadow=runner.status(),learning=stats();
  return {ok:true,model:ID,providerModel:model,configured:Boolean(key),
   round:r,signal:saved?.round===r?saved:null,
   lastSignal:saved?{round:saved.round,direction:saved.latest.direction}:null,
   tries:shadow.currentTarget===r?shadow.aiAttempts:0,maxCallsPerRound:2,
   decisionWindowEndMs:r+10000,decisionRule:'PREWARM_120S_NEWROUND_FAST10',
   prewarmStartMs:r-120000,prewarmStatus:shadow.window?.prewarmAvailable||false,
   strictLockDeadlineMs:r+10000,busy:shadow.aiBusy,
   error:lastError||shadow.lastError,waitReason:shadow.lastMissingReason,
   lastApiLatencyMs:shadow.aiLatencyMs,featuresVersion:'BTC_OHLCV_RSI_MACD_ATR_V2',
   featureReady:shadow.consecutiveFeedErrors===0,
   reasoning:{enabled:true,effort:'high'},
   learning:{...learning,lastOfficialUpdates:lastSettlementCount,lastError:settlementError,
    autoFeedback:true,modelWeightsFineTuned:false},
   realOrderEnabled:false,tradeIntegration:false};
 }
 async function pollOfficial(){
  const now=clock();
  if(pollAt&&now-pollAt<65000)return;
  pollAt=now;
  try{
   const resp=await fetcher(String(env.DEEPSEEK_OFFICIAL_STATS_URL||OFFICIAL),
     {signal:AbortSignal.timeout(9000)});
   if(!resp.ok)throw Error('OFFICIAL_HTTP_'+resp.status);
   const raw=await resp.json();
   if(raw?.settlementSource!==SOURCE)throw Error('UNTRUSTED_OFFICIAL_SOURCE');
   lastSettlementCount=learner.settle(raw);settlementError=null;
  }catch(e){settlementError=String(e?.message||e).slice(0,100)}
 }
 function tick(){void pollOfficial();return runner.tick()}
 return {tick,status,history:(limit)=>learner.history(limit)};
}
export function serveProduction(provider,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data,code=200;
  if(['/healthz','/status','/api/status'].includes(u.pathname))data=provider.status();
  else if(u.pathname==='/api/history'){
   data=provider.history(u.searchParams.get('limit'));code=data?.ok?200:503;
  }else if(u.pathname==='/signal'){
   data=provider.status().signal;
   if(!data){code=503;data={ok:false,error:'FAST10_SIGNAL_NOT_AVAILABLE'}}
  }else{res.writeHead(404);return res.end('Not Found')}
  res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(data));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const provider=createFast10ProductionProvider();serveProduction(provider);
 void provider.tick();setInterval(()=>void provider.tick(),400);
 console.log('DEEPSEEK_FAST10_PROVIDER_RUNNING order_calls=0');
}
