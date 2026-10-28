import fs from 'node:fs';
import path from 'node:path';
export const GUARDIAN_REGISTRY='/var/lib/zl-prediction/guardian5/guardian-live-orders.json';
// A record is created BEFORE the owner-armed Binance order POST. It has no
// write authority: it only permits risk monitoring for this exact token/round.
export function guardianRegisterIntent(intent,{file=GUARDIAN_REGISTRY}={}){
 const round=Number(intent?.round),tokenId=String(intent?.tokenId||'');
 if(!Number.isSafeInteger(round)||round%300000!==0||
    !/^[A-Za-z0-9_-]{3,200}$/.test(tokenId))
  throw Error('INVALID_GUARDIAN_INTENT_REGISTRY');
 const dir=path.dirname(file);
 fs.mkdirSync(dir,{recursive:true,mode:0o750});
 let raw={model:GUARDIAN_ID,entries:[]};
 try{raw=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 if(raw.model!==GUARDIAN_ID||!Array.isArray(raw.entries))throw Error('UNTRUSTED_GUARDIAN_REGISTRY');
 const entries=raw.entries.filter(x=>Number.isSafeInteger(x.round)&&x.round>=round-600000&&
   !(x.round===round&&x.tokenId===tokenId)).slice(-90);
 entries.push({round,tokenId,createdAt:Date.now(),status:'INTENT_PREPARED'});
 const tmp=file+'.'+process.pid+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify({model:GUARDIAN_ID,entries}),{mode:0o640});
 fs.renameSync(tmp,file);
 return true;
}
// A trade-route adapter for the existing BTC five-minute single bot.
// No Binance credentials or order-writing capability: it may only authorize an
// existing owner-armed executor when independent evidence is valid.
export function guardianMarkSubmitted(intent,orderId,{file=GUARDIAN_REGISTRY}={}){
 const round=Number(intent?.round),tokenId=String(intent?.tokenId||'');
 if(!Number.isSafeInteger(round)||!tokenId||!orderId)throw Error('GUARDIAN_ORDER_CONFIRMATION_INVALID');
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 if(saved.model!==GUARDIAN_ID||!Array.isArray(saved.entries))throw Error('GUARDIAN_REGISTRY_INVALID');
 const entry=saved.entries.find(x=>x.round===round&&x.tokenId===tokenId&&x.status==='INTENT_PREPARED');
 if(!entry)throw Error('GUARDIAN_PREPARED_INTENT_MISSING');
 entry.status='SUBMITTED';entry.orderId=String(orderId);entry.submittedAt=Date.now();
 const tmp=file+'.'+process.pid+'.submit.tmp';
 fs.writeFileSync(tmp,JSON.stringify(saved),{mode:0o640});fs.renameSync(tmp,file);
 return true;
}
export const GUARDIAN_ID='ZL_GUARDIAN_5M_V1';
export const GUARDIAN_SOURCE='SELECTIVE_V2_FAST8_PRIMARY'; // Legacy mapping key only; NOT the signal source.
export const FIVE_MIN=300000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const roundOf=t=>Math.floor(t/FIVE_MIN)*FIVE_MIN;
export function guardianOrderSignal(status, now=Date.now()){
 const round=roundOf(now),latest=status?.latest||{},records=Array.isArray(status?.records)?status.records:[];
 const record=records.find(r=>r?.round===round&&r.predictedDirection===latest.direction);
 if(status?.ok!==true||status.model!==GUARDIAN_ID||status.orders!==false||
    status.readOnly!==true||status.configured!==true)
   return {ok:false,reason:'UNTRUSTED_GUARDIAN_SOURCE'};
 if(!['UP','DOWN'].includes(latest.direction)||latest.round!==round||
    latest.status!=='SHADOW_OBSERVATION'||!record||record.status!=='PREDICTED'||
    !Number.isSafeInteger(record.at)||record.at<round||record.at>now+300||
    !Number.isSafeInteger(record.marketAt)||now-record.marketAt>300000||
    !Number.isSafeInteger(status.observedAt)||now-status.observedAt>10000||
    now-status.observedAt< -500||round+FIVE_MIN-now<25000)
  return {ok:false,reason:'GUARDIAN_DECISION_NOT_CURRENT'};
 const stats=status.stats||{};
 const qualified=stats.validated===true&&
   Number.isSafeInteger(stats.settled)&&stats.settled>=300&&
   finite(stats.wilsonLower)&&stats.wilsonLower>=0.70&&
   status.officialPriceFeedVerified===true;
 const p=qualified&&finite(stats.wilsonLower)?stats.wilsonLower:null;
 return {ok:true,round,direction:latest.direction,source:GUARDIAN_SOURCE,
   upstreamModel:GUARDIAN_ID,generatedAt:record.at,lockedAt:record.at,
   signalId:GUARDIAN_ID+':'+round+':'+record.at+':'+latest.direction,
   confidence:record.subjectiveConfidence??null, modelProbability:p,
   executionEligible:qualified,calibrationReady:qualified,calibrationSamples:stats.settled??0,
   qualityGate:qualified?'GUARDIAN_REAL_PRICE_AND_FORWARD_CALIBRATION_VERIFIED':'GUARDIAN_RESEARCH_UNCALIBRATED',
   marketAt:status.observedAt};
}
export function guardianQuoteGate(signal,quote,{feeBuffer=0.01,slippageBuffer=0.005,now=Date.now()}={}){
 if(signal?.upstreamModel!==GUARDIAN_ID||signal?.executionEligible!==true||
    signal?.calibrationReady!==true||signal?.calibrationSamples<300||
    !finite(signal.modelProbability)||signal.modelProbability<0.70||
    !Number.isSafeInteger(signal.round)||now>=signal.round+FIVE_MIN-25000)
   return {ok:false,reason:'GUARDIAN_SIGNAL_NOT_VALIDATED'};
 const q=Number(quote?.chance);
 if(!Number.isFinite(q)||q<=0||q>=1||!quote?.quoteId||
    !finite(feeBuffer)||feeBuffer<0||!finite(slippageBuffer)||slippageBuffer<0)
   return {ok:false,reason:'GUARDIAN_REAL_QUOTE_INVALID'};
 const edge=signal.modelProbability-q-feeBuffer-slippageBuffer;
 return edge>=0.05?{ok:true,edge}:{ok:false,reason:'GUARDIAN_NET_EDGE_BELOW_5PP',edge};
}
