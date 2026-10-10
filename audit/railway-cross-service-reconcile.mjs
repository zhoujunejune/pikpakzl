// Read-only cross-service reconciliation; no Binance credentials leave Railway.
// This independently refetches V3 resolution, but is NOT direct-to-Binance independent certification.
const v2=process.env.V2_URL||'https://signal-diagnostic-v2-production.up.railway.app';
const v3=process.env.V3_URL||'https://signal-diagnostic-v3-production.up.railway.app';
const get=async url=>{
 let lastError;
 for(let attempt=1;attempt<=4;attempt++){
  try{
   const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{accept:'application/json'}});
   if(!r.ok){if(r.status<500&&r.status!==429)throw Error('PERMANENT_HTTP_'+r.status);throw Error('HTTP_'+r.status)}
   return await r.json();
  }catch(e){
   lastError=e;
   if(String(e).includes('PERMANENT_HTTP_'))break;
   if(attempt<4)await new Promise(resolve=>setTimeout(resolve,Math.min(8000,1000*2**(attempt-1))));
  }
 }
 throw Error('REQUEST_FAILED '+new URL(url).pathname+' '+String(lastError));
};
const history=await get(v2+'/api/round-stats');
if(!Array.isArray(history.records))throw Error('Missing V2 records');
const seen=new Set(),items=[];
for(const row of history.records){
 const round=Number(row.roundStartMs),prediction=row.productionPrediction;
 if(!Number.isSafeInteger(round)||seen.has(round)){items.push({round,status:'INVALID_DUPLICATE'});continue}
 seen.add(round);
 if(!['UP','DOWN'].includes(prediction))continue;
 const lock=Number(row.productionLockedAt);
 if(row.productionLockedAt==null||!Number.isFinite(lock)||lock<round||lock>=round+300000){items.push({round,status:'INVALID_FREEZE'});continue}
 const topic=row.predictionMarketTopicId??row.officialSettlementAudit?.marketTopicId;
 const url=new URL('/api/prediction-resolution',v3);url.searchParams.set('round',String(round));
 if(topic)url.searchParams.set('marketTopicId',String(topic));
 try{
  const result=await get(url.toString());
  if(result.ok!==true||!result.resolved||!['UP','DOWN'].includes(result.direction)){items.push({round,status:'UNRESOLVED'});continue}
  if(result.rejectedTopicId){items.push({round,status:'STALE_TOPIC_REJECTED',rejectedTopicId:result.rejectedTopicId,refetchedTopicId:result.marketTopicId});continue}
  if(result.marketTopicId&&topic&&String(result.marketTopicId)!==String(topic)){items.push({round,status:'TOPIC_MISMATCH'});continue}
  if(result.startDate==null||result.endDate==null||!Number.isFinite(Number(result.startDate))||!Number.isFinite(Number(result.endDate))||Math.abs(Number(result.startDate)-round)>30000||Math.abs(Number(result.endDate)-(round+300000))>30000){items.push({round,status:'ROUND_MISMATCH'});continue}
  const direction=result.direction;
  items.push({round,status:direction===(row.officialDirection??row.productionActual)?'MATCH':'MISMATCH',direction,calculatedResult:direction===prediction?'HIT':'MISS',topic:result.marketTopicId,hash:result.auditEvidence?.detailPayloadSha256??null,hashComparable:Boolean(result.auditEvidence?.detailPayloadSha256&&row.officialSettlementAudit?.detailPayloadSha256),storedHashMatches:result.auditEvidence?.detailPayloadSha256&&row.officialSettlementAudit?.detailPayloadSha256?result.auditEvidence.detailPayloadSha256===row.officialSettlementAudit.detailPayloadSha256:null});
 }catch(e){items.push({round,status:'ERROR',reason:String(e)})}
}
const matched=items.filter(x=>x.status==='MATCH'),hits=matched.filter(x=>x.calculatedResult==='HIT').length;
const summary={event:'cross_service_settlement_reconciliation',at:new Date().toISOString(),source:'V3_REFETCH_NOT_DIRECT_BINANCE_INDEPENDENT',roundsSeen:seen.size,productionSignals:items.length,matched:matched.length,hits,misses:matched.length-hits,accuracy:matched.length?hits/matched.length:null,exceptions:items.filter(x=>x.status!=='MATCH'),items};
console.log(JSON.stringify(summary));if(summary.exceptions.length)process.exitCode=2;
