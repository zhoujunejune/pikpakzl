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
// GUARDIAN signal adapter for the existing, owner-armed BTC 5M executor.
// Signal-service readOnly/orders:false mean it cannot submit orders itself.
// They MUST NOT be confused with the executor's independently authenticated live switch.
export const GUARDIAN_ID='ZL_GUARDIAN_5M_V1';
export const GUARDIAN_SOURCE='SELECTIVE_V2_FAST8_PRIMARY'; // Legacy mapping key only.
export const FIVE_MIN=300000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const roundOf=t=>Math.floor(t/FIVE_MIN)*FIVE_MIN;

export function guardianOrderSignal(status,now=Date.now()){
 const round=roundOf(now),latest=status?.latest||{},
       records=Array.isArray(status?.records)?status.records:[];
 const record=records.find(r=>r?.round===round&&r.predictedDirection===latest.direction);
 // Trust a specific configured source with an exact, current-round observation.
 // No statistical sample size, Wilson score or historical price-feed gate here.
 if(status?.ok!==true||status?.model!==GUARDIAN_ID||
    status?.readOnly!==true||status?.orders!==false||status?.configured!==true)
   return {ok:false,reason:'UNTRUSTED_GUARDIAN_SOURCE'};
 if(!['UP','DOWN'].includes(latest.direction)||latest.round!==round||
    latest.status!=='SHADOW_OBSERVATION'||!record||record.status!=='PREDICTED'||
    !Number.isSafeInteger(record.at)||record.at<round||record.at>now+300||
    !Number.isSafeInteger(record.marketAt)||record.marketAt>now+500||
    now-record.marketAt>FIVE_MIN||
    !Number.isSafeInteger(status.observedAt)||
    status.observedAt>now+500||now-status.observedAt>10000||
    now<round||now>=round+FIVE_MIN)
   return {ok:false,reason:'GUARDIAN_DECISION_NOT_CURRENT'};
 const stats=status.stats||{};
 return {ok:true,round,direction:latest.direction,source:GUARDIAN_SOURCE,
   upstreamModel:GUARDIAN_ID,generatedAt:record.at,lockedAt:record.at,
   signalId:GUARDIAN_ID+':'+round+':'+record.at+':'+latest.direction,
   confidence:record.subjectiveConfidence??null,
   modelProbability:null, // Do not treat observed win rate as market probability.
   executionEligible:true,calibrationReady:stats.validated===true,
   calibrationSamples:Number.isSafeInteger(stats.settled)?stats.settled:0,
   qualityGate:'GUARDIAN_FRESH_SIGNAL_AWAITING_EXCHANGE_QUOTE',
   marketAt:status.observedAt};
}

export function guardianQuoteGate(signal,quote,{now=Date.now()}={}){
 if(signal?.upstreamModel!==GUARDIAN_ID||signal?.executionEligible!==true||
    !['UP','DOWN'].includes(signal.direction)||
    !Number.isSafeInteger(signal.round)||signal.round!==roundOf(now)||
    now>=signal.round+FIVE_MIN)
   return {ok:false,reason:'GUARDIAN_SIGNAL_OR_MARKET_EXPIRED'};
 const chance=Number(quote?.chance),expireAt=Number(quote?.expireAt);
 if(!quote?.quoteId||!Number.isFinite(chance)||chance<=0||chance>=1||
    !Number.isFinite(expireAt)||expireAt<=now+1200)
   return {ok:false,reason:'GUARDIAN_REAL_QUOTE_INVALID_OR_EXPIRED'};
 return {ok:true,edge:null,quoteChance:chance,quoteExpireAt:expireAt};
}
