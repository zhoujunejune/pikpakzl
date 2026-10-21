// Evidence-bounded episodic memory for the EXISTING DeepSeek signal prompt.
// Never invents official outcomes, mutates model weights or sends orders.
// Comparable cases are selected exclusively from rounds settled before this round.
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clip=x=>Math.max(-1,Math.min(1,x));
const bounded=(x,scale)=>finite(x)?Number(clip(x/scale).toFixed(4)):null;
const read=(f,k)=>f?.[k]??null;
export const MIN_OFFICIALLY_SETTLED_CASES=50;
export const MAX_SIMILAR_CASES=4;
export const CASE_FEATURE_NAMES=Object.freeze([
  'fromOpen','elapsed','rsi1m','rsi5m','volume1m','volume5m',
  'momentum1m','momentum5m','range1m','range5m','macd1m','macd5m'
]);
export function caseSnapshot(f){
  if(!f?.oneMinute?.ready||!f?.fiveMinute?.ready||!finite(f.lastPrice)||f.lastPrice<=0) return null;
  const one=f.oneMinute,five=f.fiveMinute;
  const elapsed=finite(f.elapsedSec)?f.elapsedSec:null;
  const vals=[
    bounded(f.fromOpenPct,0.3),
    bounded(elapsed===null?null:elapsed-135,135),
    bounded(finite(one.rsi14)?one.rsi14-50:null,50),
    bounded(finite(five.rsi14)?five.rsi14-50:null,50),
    bounded(finite(one.volumeRelative)?one.volumeRelative-1:null,2),
    bounded(finite(five.volumeRelative)?five.volumeRelative-1:null,2),
    bounded(one.momentum1Pct,0.25),
    bounded(five.momentum1Pct,0.25),
    bounded(finite(one.rangePosition20)?one.rangePosition20-.5:null,.5),
    bounded(finite(five.rangePosition20)?five.rangePosition20-.5:null,.5),
    bounded(finite(one.macd?.hist)?one.macd.hist/f.lastPrice*10000:null,4),
    bounded(finite(five.macd?.hist)?five.macd.hist/f.lastPrice*10000:null,4)
  ];
  if(vals.filter(finite).length<10)return null;
  return vals;
}
export function caseDistance(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==CASE_FEATURE_NAMES.length||b.length!==a.length)return null;
  let sum=0,n=0;
  for(let i=0;i<a.length;i++){
    if(!finite(a[i])||!finite(b[i]))continue;
    sum+=Math.abs(a[i]-b[i]);n++;
  }
  return n>=10?Number((sum/n).toFixed(4)):null;
}
export function retrieveOfficialCases(predictions,currentFeatures,{minimum=MIN_OFFICIALLY_SETTLED_CASES,limit=MAX_SIMILAR_CASES}={}){
  const current=caseSnapshot(currentFeatures);
  const nowRound=Number(currentFeatures?.round);
  if(!current||!Number.isSafeInteger(nowRound))return {usable:false,reason:'CURRENT_CASE_FEATURES_UNAVAILABLE',officialComparableCases:0,cases:[]};
  const eligible=(Array.isArray(predictions)?predictions:[]).filter(p=>
    Number.isSafeInteger(p.round)&&p.round<nowRound&&
    (p.actual==='UP'||p.actual==='DOWN')&&
    (p.direction==='UP'||p.direction==='DOWN')&&
    p.settledAt!=null&&p.round+300000<=nowRound&&
    Array.isArray(p.caseFeatures)&&caseDistance(current,p.caseFeatures)!==null);
  // Requiring many *prospectively captured, officially resolved* snapshots makes
  // it harder to overfit random patterns from the original 69 sparse records.
  if(eligible.length<minimum)return {usable:false,reason:'AWAIT_OFFICIAL_COMPARABLE_CASES',officialComparableCases:eligible.length,cases:[]};
  const ranked=eligible.map(p=>({p,d:caseDistance(current,p.caseFeatures)}))
    .filter(x=>x.d!==null&&x.d<=.42)
    .sort((a,b)=>a.d-b.d||b.p.round-a.p.round);
  if(ranked.length<8)return {usable:false,reason:'SIMILARITY_SUPPORT_TOO_SMALL',officialComparableCases:eligible.length,similarCases:ranked.length,cases:[]};
  const picked=ranked.slice(0,Math.max(1,Math.min(limit,MAX_SIMILAR_CASES)));
  const cases=picked.map(({p,d})=>({
    priorRound:p.round,similarityDistance:d,originalPrediction:p.direction,
    officialOutcome:p.actual,wasCorrect:p.direction===p.actual,
    originalReason:typeof p.reason==='string'?p.reason.slice(0,100):null
  }));
  return {usable:true,officialComparableCases:eligible.length,similarCases:ranked.length,
    cases,interpretation:'Illustrative, sparse similar historical cases only; avoid blindly copying past labels. Current evidence and official settlement basis take precedence; no causal or calibrated accuracy claim.'};
}
