// Independent research-only analysis. Never submits or blocks a live order.
// No price, payout, settlement, or probability may be inferred from an LLM explanation.
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const side=x=>x==='UP'||x==='DOWN';
const round4=x=>Number(x.toFixed(6));
export function assessQuote({direction,quote,calibration,at}={}){
 if(!side(direction))return {ok:false,reason:'DIRECTION_MISSING'};
 if(!calibration||calibration.source!=='FORWARD_CALIBRATED'||
   !finite(calibration.winProbability)||calibration.winProbability<=0||calibration.winProbability>=1)
  return {ok:false,reason:'FORWARD_CALIBRATED_PROBABILITY_REQUIRED'};
 if(!quote||quote.source!=='BINANCE_PREDICTION_EXECUTABLE_QUOTE'||quote.direction!==direction||
   !finite(quote.quotedAt)||!finite(at)||quote.quotedAt>at+500||
   at-quote.quotedAt>3000)
  return {ok:false,reason:'FRESH_EXECUTABLE_QUOTE_REQUIRED'};
 const {ask,payout,fees,slippageAllowance}=quote;
 if(![ask,payout,fees,slippageAllowance].every(finite)||
   !(ask>0&&payout>0&&ask<=payout&&fees>=0&&slippageAllowance>=0))
  return {ok:false,reason:'QUOTE_UNITS_OR_FEES_INVALID'};
 const allIn=ask+fees+slippageAllowance;
 const p=calibration.winProbability,ev=p*payout-allIn,breakEven=allIn/payout;
 return {ok:true,mode:'RESEARCH_ONLY',direction,calibrationSource:calibration.source,
   quoteSource:quote.source,quoteAgeMs:at-quote.quotedAt,
   probability:p,ask,payout,allInCost:round4(allIn),
   breakEvenProbability:round4(breakEven),expectedNetPerShare:round4(ev),
   profitableAtEstimatedProbability:ev>0};
}
const buckets=[[0,60],[60,120],[120,180],[180,240],[240,270]];
function verifiedNet(row){
 const ex=row?.execution;
 if(!ex||ex.verified!==true||ex.status!=='FILLED'||
   ![ex.fillPrice,ex.payout,ex.fees].every(finite)||
   !(ex.fillPrice>0&&ex.payout>0&&ex.fillPrice<=ex.payout&&ex.fees>=0))
  return null;
 return (row.actual===row.direction?ex.payout:0)-ex.fillPrice-ex.fees;
}
export function summarizeTiming(rows=[]){
 const unique=new Map();
 for(const r of rows){
  if(!r||!Number.isSafeInteger(r.round)||!finite(r.signalAt)||
     !finite(r.settledAt)||r.settledAt<r.round+300000||
     !side(r.direction)||!side(r.actual))continue;
  const sec=(r.signalAt-r.round)/1000;
  if(sec<0||sec>=270)continue;
  if(!unique.has(r.round))unique.set(r.round,{...r,elapsedSec:sec});
 }
 return buckets.map(([from,to])=>{
  const selected=[...unique.values()].filter(r=>r.elapsedSec>=from&&r.elapsedSec<to);
  const hits=selected.filter(r=>r.direction===r.actual).length;
  const nets=selected.map(verifiedNet).filter(finite);
  return {window:from+'-'+(to-1)+'s',resolvedPredictions:selected.length,hits,
    accuracy:selected.length?round4(hits/selected.length):null,
    verifiedFills:nets.length,realizedNet:nets.length?round4(nets.reduce((a,b)=>a+b,0)):null,
    note:nets.length?'Only verified filled orders included in realized net':'No verified filled orders; no PnL claim'};
 });
}
export function assessPromotion({rows=[],minimum=300}={}){
 // Only paired, strictly forward, independently settled evidence counts.
 const pairs=rows.filter(r=>Number.isSafeInteger(r?.round)&&side(r.actual)&&
   finite(r.settledAt)&&r.settledAt>=r.round+300000&&
   finite(r.candidate?.trainedThrough)&&r.candidate.trainedThrough<r.round&&
   finite(r.baseline?.trainedThrough)&&r.baseline.trainedThrough<r.round&&
   finite(r.candidate?.decisionAt)&&r.candidate.decisionAt>=r.round&&r.candidate.decisionAt<r.round+270000&&
   finite(r.baseline?.decisionAt)&&r.baseline.decisionAt>=r.round&&r.baseline.decisionAt<r.round+270000&&
   side(r.candidate.direction)&&side(r.baseline.direction)&&
   finite(r.candidate.netPerUnit)&&finite(r.baseline.netPerUnit));
 const unique=[...new Map(pairs.map(r=>[r.round,r])).values()].sort((a,b)=>a.round-b.round);
 const n=unique.length;
 if(n<minimum)return {promote:false,reason:'NOT_ENOUGH_PAIRED_FORWARD_TRADES',paired:n,required:minimum};
 const sum=k=>unique.reduce((a,r)=>a+r[k].netPerUnit,0);
 const candidate=round4(sum('candidate')),baseline=round4(sum('baseline'));
 return {promote:false,reason:candidate>baseline?'REVIEW_REQUIRED_NOT_AUTO_DEPLOY':'NO_FORWARD_NET_IMPROVEMENT',
   paired:n,candidateNet:candidate,baselineNet:baseline,
   note:'Candidate evaluation never changes live model or order parameters'};
}
