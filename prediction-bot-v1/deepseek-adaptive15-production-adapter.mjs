// Compatibility adapter, NOT automatically deployed.
// Retains the exact production /signal schema while decision logic becomes
// pre-round DeepSeek analysis + new-round opening and early-tick reconciliation.
// The adapter itself NEVER interacts with Binance or submits an order.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';
import {roundOf} from './deepseek-adaptive15-core.mjs';

const ID='DEEPSEEK_5M_V1';
const SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const OFFICIAL='http://127.0.0.1:13002/api/round-stats';
export function buildAdaptive15CompatibleSignal(candidate,at,providerModel){
 const r=candidate?.round,d=candidate?.latest?.direction,quoteAt=candidate?.latest?.marketAt;
 if(!Number.isSafeInteger(r)||r%300000!==0||!['UP','DOWN'].includes(d)||
    !Number.isSafeInteger(quoteAt)||quoteAt<r||quoteAt>at||
    at<r||at>=r+15000||candidate?.orders!==false||
    candidate?.productionIntegration!==false)
  throw Error('FAST10_PROD_INVALID_CANDIDATE');
 const score=Math.abs(Number(candidate.latest.hybridScore||0));
 const confidence=null; // A subjective score is NOT a calibrated probability.
 return {ok:true,model:ID,round:r,generatedAt:at,readOnly:true,orders:false,
   productionIntegration:false,providerModel,
   latest:{model:ID,round:r,status:'LOCKED',direction:d,lockedAt:at,
    marketAt:quoteAt,confidence,score:Number(score.toFixed(4)),
    reason:String(candidate.latest.reason||'DEEPSEEK_TWO_PASS_ADAPTIVE15_EXPERIENCE').slice(0,180),
    confidenceIsCalibrated:false,
    selectedModelConfidence:candidate.latest.modelConfidence??null,
    decisionMethod:'DEEPSEEK_TWO_PASS_ADAPTIVE15_V1',
    prewarmDirection:candidate.latest.firstAnalysis,
    reviewDirection:candidate.latest.reviewAnalysis,
    lastSelectedReview:candidate.latest.selectedAnalysis,
    waitAllowed:true,
    fromOpenBps:candidate.latest.fromOpenBps,
    earlyObservationCount:candidate.latest.earlySnapshots,
    entry:{direction:d,at,marketAt:quoteAt,score:Number(score.toFixed(4)),
      strength:Number(score.toFixed(4)),modelVersion:ID}},
   // Existing producer's validation expects this compatibility expiry.
   // It is not the decision creation deadline: that remains strict +10s.
   expiryAt:r+270000};
}
export function createAdaptive15ProductionProvider({env=process.env,clock=()=>Date.now(),fetcher=fetch}={}){
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const key=String(env.DEEPSEEK_API_KEY||'');
 const stateFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/deepseek5/signal.json');
 const learner=newLearner(String(env.DEEPSEEK_LEARNING_FILE||'/var/lib/zl-prediction/deepseek5/learning.json'),clock);
 const waitFile=String(env.DEEPSEEK_WAIT_JOURNAL_FILE||path.join(path.dirname(stateFile),'wait-rounds.json'));
 let waits=[];
 try{
  const stored=JSON.parse(fs.readFileSync(waitFile,'utf8'));
  if(stored?.schema===1&&Array.isArray(stored.records))
   waits=stored.records.filter(x=>Number.isSafeInteger(x?.round)&&x.direction==='WAIT'
    &&Number.isSafeInteger(x?.at)).slice(-2000);
 }catch{}
 function storeWait(term){
  if(!Number.isSafeInteger(term?.round)||term.direction!=='WAIT'
   ||!Number.isSafeInteger(term?.at)||waits.some(x=>x.round===term.round))return;
  waits.push({round:term.round,direction:'WAIT',at:term.at,
   status:'WAIT',reason:String(term.reason||'WAIT').slice(0,90),
   detail:String(term.detail||'').slice(0,120),signalAt:null,
   signalLatencyMs:null,provider:model,actual:null,settledAt:null,hit:null});
  waits=waits.slice(-2000);
  fs.mkdirSync(path.dirname(waitFile),{recursive:true,mode:0o750});
  const tmp=waitFile+'.tmp.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify({schema:1,records:waits}),{mode:0o640});
  fs.renameSync(tmp,waitFile);
 }
 function withWaits(limit){
  const n=Math.max(1,Math.min(100,Math.trunc(Number(limit)||80)));
  const base=learner.history(100);
  const rows=[...(base.records||[]),...waits].sort((a,b)=>b.round-a.round).slice(0,n);
  return {...base,records:rows,
    summary:{...base.summary,recordedWaitRounds:waits.length,
      waitJournalOnlySinceUpgrade:true}};
 }
 let saved=null,pollAt=0,settlementError=null,lastSettlementCount=0,lastError=null;
 try{
  const old=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(old?.model===ID&&old?.orders===false)saved=old;
 }catch{}
 const persist=signal=>{
  fs.mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o750});
  const tmp=stateFile+'.adaptive15.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(signal),{mode:0o640});
  fs.renameSync(tmp,stateFile);
 };
 const runner=createAdaptiveRunner({
  env:{...env,ADAPTIVE15_ENABLE_AI:key?'1':'0'},clock,fetcher,
  getHistoricalFeedback:features=>learner.feedback(features),
  onWait:term=>storeWait(term),
  onLocked:(candidate,raw,at,window)=>{
   if(saved?.round===candidate.round)return; // never duplicate a prior lock
   // Use the ACTUAL clock; an earlier tick timestamp never permits late publishing.
   if(clock()>=candidate.round+15000)throw Error('LATE_LOCK_EXPIRED_WAIT');
   const signal=buildAdaptive15CompatibleSignal(candidate,at,model);
   const features=extractFeatures(raw,at);
   if(features.round!==candidate.round||!features.dataQuality.indicatorsReady)
     throw Error('PRODUCTION_FEATURES_NOT_READY');
   if(clock()>=candidate.round+15000)throw Error('LATE_PERSIST_EXPIRED_WAIT');
   persist(signal);saved=signal;
   try{learner.record(signal,features,window?.modelCalls||1)}
   catch(e){settlementError='RECORD_'+String(e?.message||e).slice(0,70)}
  }});
 function stats(){try{return learner.summary()}catch{return {officialSamples:0,error:'LEARNING_FILE_ERROR'}}}
 function status(){
  const now=clock(),r=roundOf(now),shadow=runner.status(),learning=stats();
  const lockedThisRound=saved?.round===r&&
   Number.isSafeInteger(saved.latest?.lockedAt)&&saved.latest.lockedAt>=r&&
   saved.latest.lockedAt<r+15000&&saved.generatedAt<r+15000;
  const available=lockedThisRound&&now<r+15000;
  const activeWindow=shadow.window?.targetRound===r?shadow.window:null;
  const terminalWait=!lockedThisRound&&
   (now>=r+15000||activeWindow?.status==='WAIT');
  const decisionState=lockedThisRound?'LOCKED':terminalWait?'WAIT':'ANALYZING';
  const decisionReason=terminalWait?(activeWindow?.terminal?.reason||
    shadow.lastCompleted?.reason||'DEADLINE_15S_EXPIRED'):null;
  return {ok:true,model:ID,providerModel:model,configured:Boolean(key),
   round:r,signal:available?saved:null,
   roundDecision:{round:r,status:decisionState,direction:lockedThisRound?saved.latest.direction:
    terminalWait?'WAIT':null,reason:decisionReason,
    decisionDeadlineMs:r+15000,lateSignalsRejected:true,
    lockedAt:lockedThisRound?saved.latest.lockedAt:null},
   lastSignal:saved?{round:saved.round,direction:saved.latest.direction}:null,
   noSignalAfterDeadline:true,
   recordedWaitRounds:waits.length,
   lastDecision:shadow.lastCompleted,
   skippedRounds:shadow.skippedRounds,
   missedRounds:shadow.missedRounds,
   experiencePolicy:'OFFICIAL_SETTLEMENT_EPISODIC_CASES_PLUS_CONSERVATIVE_ABSTENTION',
   tries:shadow.window?.targetRound===r?shadow.window.modelCalls??0:0,maxCallsPerRound:2,
   decisionWindowEndMs:r+15000,decisionRule:'TWO_PASS_PREWARM_ADAPTIVE15_WAIT_ALLOWED',
   prewarmStartMs:r-120000,prewarmStatus:Boolean(shadow.window?.firstAnalysis),
   reviewStatus:shadow.window?.revisedAnalysis??null,
   analysisTargetRound:shadow.window?.targetRound??null,
   analysisFirstDirection:shadow.window?.firstAnalysis??null,
   analysisReviewDirection:shadow.window?.revisedAnalysis??null,
   analysisModelCalls:shadow.window?.modelCalls??0,
   analysisPreviousRoundSnapshots:shadow.window?.priorSamples??0,
   analysisEarlySnapshots:shadow.window?.earlySamples??0,
   analysisLastSkip:shadow.window?.lastSkip??null,
   strictLockDeadlineMs:r+15000,busy:shadow.inFlight,
   error:lastError||shadow.lastError,
   waitReason:shadow.window?.lastSkip||shadow.lastCompleted?.reason||null,
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
 return {tick,status,history:withWaits};
}
export function serveAdaptiveProduction(provider,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data,code=200;
  if(['/healthz','/status','/api/status'].includes(u.pathname))data=provider.status();
  else if(u.pathname==='/api/history'){
   data=provider.history(u.searchParams.get('limit'));code=data?.ok?200:503;
  }else if(u.pathname==='/signal'){
   const current=provider.status();
   data=current.signal;
   if(!data){
    code=503;
    data={ok:false,model:ID,round:current.round,
      direction:current.roundDecision?.status==='WAIT'?'WAIT':null,
      status:current.roundDecision?.status||'WAIT',
      error:current.roundDecision?.reason||'NO_VALID_LOCK_BEFORE_15S',
      signalAvailable:false,lateOrdersForbidden:true};
   }
  }else{res.writeHead(404);return res.end('Not Found')}
  res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(data));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const provider=createAdaptive15ProductionProvider();serveAdaptiveProduction(provider);
 void provider.tick();setInterval(()=>void provider.tick(),400);
 console.log('DEEPSEEK_ADAPTIVE15_PROVIDER_RUNNING order_calls=0');
}
