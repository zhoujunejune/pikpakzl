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
import {makeQualityStore} from './deepseek-adaptive15-quality-store.mjs';
import {roundOf} from './deepseek-adaptive15-core.mjs';

const ID='DEEPSEEK_5M_V1';
const SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const OFFICIAL='http://127.0.0.1:13002/api/round-stats';
export function buildAdaptive15CompatibleSignal(candidate,at,providerModel){
 const r=candidate?.round,d=candidate?.latest?.direction,quoteAt=candidate?.latest?.marketAt;
 if(!Number.isSafeInteger(r)||r%300000!==0||!['UP','DOWN'].includes(d)||
    candidate?.latest?.aiVerified!==true||candidate?.latest?.selectedAnalysis!=='current'||
    !Number.isSafeInteger(candidate?.latest?.analysisAt)||
    candidate.latest.analysisAt<r+15000||candidate.latest.analysisAt>at||
    !Number.isSafeInteger(quoteAt)||quoteAt<r||quoteAt>at||
    at<r+15000||at>=r+40000||candidate?.orders!==false||
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
    decisionMethod:'DEEPSEEK_PREWARM120_LIVE40_AI_ONLY',
    aiVerified:true,analysisPhase:'current',
    analysisAt:candidate.latest.analysisAt,
    directionalPolicy:'DEEPSEEK_DIRECT_AUTONOMOUS',
    uncertainty:String(candidate.latest.uncertainty||'UNSPECIFIED').slice(0,90),
    prewarmDirection:candidate.latest.firstAnalysis,
    reviewDirection:candidate.latest.reviewAnalysis,
    lastSelectedReview:candidate.latest.selectedAnalysis,
    waitAllowed:true,
    fromOpenBps:candidate.latest.fromOpenBps,
    earlyObservationCount:candidate.latest.earlySnapshots,
    entry:{direction:d,at,marketAt:quoteAt,score:Number(score.toFixed(4)),
      strength:Number(score.toFixed(4)),modelVersion:ID}},
   // Existing producer expects an immutable compatibility expiry; actual hard AI cutoff is +40s.
   // The decision creation deadline is strictly 25 seconds, never 270 seconds.
   expiryAt:r+270000};
}
export function createAdaptive15ProductionProvider({env=process.env,clock=()=>Date.now(),fetcher=fetch}={}){
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const key=String(env.DEEPSEEK_API_KEY||'');
 const stateFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/deepseek5/signal.json');
 const learner=newLearner(String(env.DEEPSEEK_LEARNING_FILE||'/var/lib/zl-prediction/deepseek5/learning.json'),clock);
 const quality=makeQualityStore(
  String(env.DEEPSEEK_QUALITY_JOURNAL_FILE||path.join(path.dirname(stateFile),'quality-v1.json')),
  clock,String(env.DEEPSEEK_VERIFIED_ORDER_AUDIT_FILE||''));
 let qualityError=null;
 // Recover only authentic original lock-time snapshots: no imputation or hindsight data.
 let originalSnapshotsRecovered=0;
 try{originalSnapshotsRecovered=quality.backfillOriginalSnapshots(learner.qualitySnapshotEvidence())}
 catch(e){qualityError='QUALITY_ORIGINAL_SNAPSHOT_RECOVERY_'+String(e?.message||e).slice(0,65)}
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
  getHistoricalFeedback:features=>{
   const original=learner.feedback(features);
   const currentRound=Number(features?.round);
   // All feedback MUST originate from older officially settled rounds.
   return {...original,officialErrorPatterns:quality.feedback(currentRound)};
  },
  onWait:term=>storeWait(term),
  onLocked:(candidate,raw,at,window)=>{
   if(saved?.round===candidate.round)return; // never duplicate a prior lock
   // Use the ACTUAL clock; an earlier tick timestamp never permits late publishing.
   if(clock()>=candidate.round+40000)throw Error('LATE_LOCK_EXPIRED_WAIT');
   const signal=buildAdaptive15CompatibleSignal(candidate,at,model);
   const features=extractFeatures(raw,at);
   // Technical integrity only: DeepSeek selects its own indicators; 35-candle readiness
   // is descriptive, not a veto when real BTC ticks are fresh.
   if(features.round!==candidate.round||features.dataQuality.marketAgeMs>4000)
     throw Error('PRODUCTION_MARKET_UNVERIFIED');
   if(clock()>=candidate.round+40000)throw Error('LATE_PERSIST_EXPIRED_WAIT');
   persist(signal);saved=signal;
   try{learner.record(signal,features,window?.modelCalls||1)}
   catch(e){settlementError='RECORD_'+String(e?.message||e).slice(0,70)}
   try{quality.record(signal,features,{llmPasses:window?.modelCalls||1,
    experienceEvidence:window?.experienceEvidence??[]})}
   catch(e){qualityError='QUALITY_RECORD_'+String(e?.message||e).slice(0,70)}
  }});
 function stats(){try{return learner.summary()}catch{return {officialSamples:0,error:'LEARNING_FILE_ERROR'}}}
 function status(){
  const now=clock(),r=roundOf(now),shadow=runner.status(),learning=stats();
  const lockedThisRound=saved?.round===r&&
   Number.isSafeInteger(saved.latest?.lockedAt)&&saved.latest.lockedAt>=r&&
   saved.latest.lockedAt>=r+15000&&saved.latest.lockedAt<r+40000&&saved.generatedAt<r+40000&&
   saved.latest.aiVerified===true&&saved.latest.decisionMethod==='DEEPSEEK_PREWARM120_LIVE40_AI_ONLY';
  const available=lockedThisRound&&now<r+45000; // immutable AI lock before +40s; order retrieval until +45s
  const activeWindow=shadow.window?.targetRound===r?shadow.window:null;
  const terminalWait=!lockedThisRound&&
   (now>=r+40000||activeWindow?.status==='WAIT');
  const decisionState=lockedThisRound?'LOCKED':terminalWait?'WAIT':'ANALYZING';
  const decisionReason=terminalWait?(activeWindow?.terminal?.reason||
    shadow.lastCompleted?.reason||'DEADLINE_40S_EXPIRED'):null;
  return {ok:true,model:ID,providerModel:model,configured:Boolean(key),
   round:r,signal:available?saved:null,
   roundDecision:{round:r,status:decisionState,direction:lockedThisRound?saved.latest.direction:
    terminalWait?'WAIT':null,reason:decisionReason,
    decisionDeadlineMs:r+40000,lateSignalsRejected:true,
    lockedAt:lockedThisRound?saved.latest.lockedAt:null},
   lastSignal:saved?{round:saved.round,direction:saved.latest.direction}:null,
   noSignalAfterDeadline:true,
   recordedWaitRounds:waits.length,
   strategyQuality:quality.summary(),
   originalSnapshotsRecovered,
   qualityError,
   lastDecision:shadow.lastCompleted,
   skippedRounds:shadow.skippedRounds,
   missedRounds:shadow.missedRounds,
   experiencePolicy:'OFFICIAL_SETTLEMENT_FEEDBACK_ONLY_MODEL_DECIDES',
   tries:shadow.window?.targetRound===r?shadow.window.modelCalls??0:0,
   maxCallsPerRound:5,preRoundMaxCalls:2,currentRoundMaxCalls:3,
   liveReviewMinIntervalMs:6000,analysisCountLimit:'PRE2_LIVE3_TOTAL5',
   decisionWindowEndMs:r+40000,decisionRule:'PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S',
   aiDirectionalRequired:true,
   skipOnLowConfidence:false,
   skipOnWeakHistoricalDirection:false,
   prewarmStartMs:r-120000,prewarmStatus:Boolean(shadow.window?.firstAnalysis),
   reviewStatus:shadow.window?.revisedAnalysis??null,
   analysisTargetRound:shadow.window?.targetRound??null,
   analysisFirstDirection:shadow.window?.firstAnalysis??null,
   analysisReviewDirection:shadow.window?.revisedAnalysis??null,
    analysisCurrentDirection:shadow.window?.currentAnalysis??null,
    officialReference:shadow.officialReference??{available:false},
   analysisModelCalls:shadow.window?.modelCalls??0,
   analysisPreviousRoundSnapshots:shadow.window?.priorSamples??0,
   analysisEarlySnapshots:shadow.window?.earlySamples??0,
   analysisLastSkip:shadow.window?.lastSkip??null,
   strictLockDeadlineMs:r+40000,busy:shadow.inFlight,
   error:lastError||shadow.lastError,
   waitReason:shadow.window?.lastSkip||shadow.lastCompleted?.reason||null,
   lastApiLatencyMs:shadow.aiLatencyMs,featuresVersion:'BTC_OHLCV_RSI_MACD_ATR_V2',
   featureReady:Number.isSafeInteger(shadow.lastMarketAt)&&now-shadow.lastMarketAt<=4000,
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
   try{quality.settle(raw);qualityError=null}
   catch(e){qualityError='QUALITY_SETTLE_'+String(e?.message||e).slice(0,70)}
  }catch(e){settlementError=String(e?.message||e).slice(0,100)}
 }
 function tick(){void pollOfficial();return runner.tick()}
 function learningEffect(){
  const q=quality.summary(),l=learner.summary();
  return {ok:true,model:ID,providerModel:model,
   evidence:q.learningEvidence,
   errors:q.errors,
   experiment:q.controlledExperiment,
   comparableOfficialCases:l.comparableOfficialCases??0,
   similarCaseMinimum:l.similarCaseMinimum??50,
   officialSamples:l.allOfficialSamples??0,
   originalSnapshotsRecovered,
   historyRole:'Historical examples are prompt context, not weight updates',
   controlledComparisonVerdict:'NOT_PROVEN',
   additionalApiCalls:0,productionDirectionUnaffected:true,
   maxCallsPerRound:5,hardDecisionDeadlineMs:40000};
 }
 return {tick,status,history:withWaits,quality:()=>quality.summary(),learningEffect};
}
export function serveAdaptiveProduction(provider,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data,code=200;
  if(['/healthz','/status','/api/status'].includes(u.pathname))data=provider.status();
  else if(u.pathname==='/api/quality')data=provider.quality();
  else if(u.pathname==='/api/learning-effect')data=provider.learningEffect();
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
      error:current.roundDecision?.reason||'NO_VALID_CURRENT_ROUND_AI_BEFORE_40S',
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
