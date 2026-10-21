// Independent post-settlement quality store. Does not replace the installed
// production learner, use unverified official labels, or mutate DeepSeek weights.
import fs from 'node:fs';
import path from 'node:path';
import {classifyOfficialMistake,summarizeMistakes,pastErrorHints} from './deepseek-adaptive15-error-attribution.mjs';
import {caseSnapshot} from './deepseek-5m-episodic-memory.mjs';
const good=s=>s==='UP'||s==='DOWN';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const OFFICIAL='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
function save(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
 const tmp=file+'.tmp.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o640});
 fs.renameSync(tmp,file);
}
export function makeQualityStore(file,clock=()=>Date.now(),orderAuditFile=''){
 let records=[];
 try{
  const j=JSON.parse(fs.readFileSync(file,'utf8'));
  if(j?.schema===1&&Array.isArray(j.records))records=j.records.filter(x=>Number.isSafeInteger(x.round)).slice(-2000);
 }catch{}
 const persist=()=>save(file,{schema:1,records,updatedAt:clock()});
 function record(signal,features,extra={}){
  const r=signal?.round,t=signal?.latest?.lockedAt;
  if(!Number.isSafeInteger(r)||!Number.isSafeInteger(t)||t<r||t>=r+25000||
   !good(signal.latest.direction)||records.some(x=>x.round===r))return false;
  const d=signal.latest;
  records.push({round:r,direction:d.direction,signalAt:t,
   provider:signal.providerModel||'unknown',strategyVersion:'ADAPTIVE15_QUALITY_V1',
   reason:String(d.reason||'').slice(0,180),
   featureRegime:features?.oneMinute?.ready&&features?.fiveMinute?.ready?
    (features.oneMinute.ema9>features.oneMinute.ema21&&features.fiveMinute.ema9>features.fiveMinute.ema21?
     'TREND_UP':features.oneMinute.ema9<features.oneMinute.ema21&&features.fiveMinute.ema9<features.fiveMinute.ema21?
      'TREND_DOWN':'MIXED'):'UNKNOWN',
   caseFeatures:caseSnapshot(features), // Causal immutable lock-time feature snapshot.
   decisionContext:{
    prewarmDirection:d.prewarmDirection||null,
    reviewDirection:d.reviewDirection||null,
    modelSelfConfidence:finite(Number(d.selectedModelConfidence))?Number(d.selectedModelConfidence):null,
    fromOpenBps:finite(Number(d.fromOpenBps))?Number(d.fromOpenBps):null,
    marketAgeMs:t-Number(d.marketAt),
    earlySamples:Number(d.earlyObservationCount)||null,
    observedMarketAt:Number(d.marketAt)||null,
    llmPasses:Number(extra.llmPasses)||null,
   },
   experienceEvidence:Array.isArray(extra.experienceEvidence)?extra.experienceEvidence.slice(0,6).map(x=>({
    pass:String(x.pass||'').slice(0,16),at:Number(x.at)||null,
    historyOffered:x.historyOffered===true,
    similarCaseCount:Math.max(0,Math.min(4,Number(x.similarCaseCount)||0)),
    errorPatternsOffered:Math.max(0,Math.min(3,Number(x.errorPatternsOffered)||0))})):[],
   officialSource:null,actual:null,settledAt:null,hit:null,errorTags:[]});
  records=records.slice(-2000);persist();return true;
 }
 function settle(raw){
  if(raw?.ok!==true||raw?.settlementSource!==OFFICIAL||!Array.isArray(raw.records))return 0;
  const outcomes=new Map();
  for(const x of raw.records){
   const r=Number(x?.roundStartMs),a=x?.productionActual;
   const at=Number(x?.productionSettledAt??x?.settledAt);
   if(Number.isSafeInteger(r)&&good(a)&&Number.isSafeInteger(at)&&at>=r+300000&&
      (x.officialSettlementAudit!=null||x.resolutionEvidence!=null))
      outcomes.set(r,{actual:a,settledAt:at});
  }
  let n=0;
  for(const r of records){
   if(r.actual||!outcomes.has(r.round))continue;
   const o=outcomes.get(r.round);
   if(clock()<r.round+300000||o.settledAt<r.round+300000)continue;
   r.actual=o.actual;r.settledAt=o.settledAt;r.officialSource=OFFICIAL;
   r.hit=r.direction===o.actual;
   r.errorTags=classifyOfficialMistake(r).tags;n++;
  }
  if(n)persist();return n;
 }
 function backfillOriginalSnapshots(original=[]){
  if(!Array.isArray(original))return 0;
  const byRound=new Map(original.filter(x=>Number.isSafeInteger(x.round)).map(x=>[x.round,x]));
  let updated=0;
  for(const p of records){
   if(Array.isArray(p.caseFeatures)&&p.caseFeatures.length===12)continue;
   const old=byRound.get(p.round);
   if(!old||old.direction!==p.direction||old.signalAt!==p.signalAt||
     !Array.isArray(old.caseFeatures)||old.caseFeatures.length!==12)continue;
   p.caseFeatures=old.caseFeatures.slice();
   if(good(p.actual))p.errorTags=classifyOfficialMistake(p).tags;
   updated++;
  }
  if(updated)persist();
  return updated;
 }
 function mistakeReport(){
  const official=records.filter(x=>x.officialSource===OFFICIAL&&good(x.actual));
  return {...summarizeMistakes(official),strategyVersion:'ADAPTIVE15_QUALITY_V1',
   coverageBeginsAt:records[0]?.round??null,verifiedPredictions:records.length,
   officiallySettled:official.length};
 }
 function feedback(nextRound){
  const settled=records.filter(x=>x.officialSource===OFFICIAL&&good(x.actual));
  return pastErrorHints(settled,nextRound);
 }
 function actualProfitAudit(){
  // Unknown is not zero profit. Quotes alone and backtested payouts are never
  // presented as realized profit. Require reconciled exchange order evidence.
  const result={realizedNetPnl:null,currency:null,verifiedFills:0,
   linkedVerifiedOrders:0,available:false,
   reason:'NO_EXCHANGE_CONFIRMED_FILL_AND_SETTLEMENT_RECONCILIATION',
   signalAccuracyIsNotRealizedProfit:true};
  if(!orderAuditFile)return result;
  let ledger;
  try{ledger=JSON.parse(fs.readFileSync(orderAuditFile,'utf8'))}catch{return result}
  // Do not trust an arbitrary user-provided JSON or self-attested numbers:
  // no exchange verification connector in this module.
  return {...result,orderFilePresent:Boolean(ledger),
   reason:'ORDER_RECORD_SOURCE_NOT_AUTHENTICATED_WITH_EXCHANGE'};
 }
 function summary(){
  const mistakes=mistakeReport(),profit=actualProfitAudit();
  const withSnapshots=records.filter(x=>Array.isArray(x.caseFeatures)&&x.caseFeatures.length===12);
  const settledCases=withSnapshots.filter(x=>x.officialSource===OFFICIAL&&good(x.actual));
  const tracked=records.filter(x=>Array.isArray(x.experienceEvidence)&&x.experienceEvidence.length>0);
  const offeredHistory=tracked.filter(x=>x.experienceEvidence.some(t=>t.historyOffered));
  const offeredSimilar=tracked.filter(x=>x.experienceEvidence.some(t=>t.similarCaseCount>0));
  const offeredError=tracked.filter(x=>x.experienceEvidence.some(t=>t.errorPatternsOffered>0));
  return {strategyVersion:'ADAPTIVE15_QUALITY_V1',
   signal:{predictions:mistakes.verifiedPredictions,
    officiallySettled:mistakes.officiallySettled,
    settledHits:mistakes.correct,settledMisses:mistakes.misses,
    officialHitRate:mistakes.settledWithValidCausality?
      Number((mistakes.correct/mistakes.settledWithValidCausality).toFixed(4)):null},
   errors:mistakes,
   economics:profit,
   lastOfficialUpdateAt:Math.max(0,...records.filter(x=>x.officialSource===OFFICIAL).map(x=>x.settledAt)),
   learningType:'CASE_MEMORY_AND_RULE_FEEDBACK_NOT_LLM_WEIGHT_TRAINING',
   learningEvidence:{allRecordedPredictions:records.length,featureSnapshotCount:withSnapshots.length,
    settledFeatureSnapshots:settledCases.length,modelRequestsAuditedRounds:tracked.length,
    roundsWithHistoricalFeedbackOffered:offeredHistory.length,
    roundsWithSimilarCasesOffered:offeredSimilar.length,
    roundsWithErrorPatternsOffered:offeredError.length,
    claim:'Proves prompts were prepared with historical evidence, not that DeepSeek used it or improved accuracy'},
   controlledExperiment:{state:'NOT_STARTED_NO_EXTRA_API_CALLS',pairedRounds:0,
    effectVerified:false,reason:'Requires paired memory-on versus memory-off DeepSeek predictions on same-time snapshots and prospective settlement'} };
 }
 return {record,settle,feedback,summary,backfillOriginalSnapshots,readOnlyRecords:()=>records.map(x=>({...x}))};
}
