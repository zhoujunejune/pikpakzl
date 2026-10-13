// BTC 5m order-flow research proxy adapted from PUBLIC microstructure concepts:
// https://github.com/HorseDev77/bitcoin_price_up_down_prediction_5minute
// This is NOT the external authors' trained model and has no promised win rate.
// Only ONE active candidate; historical multi-candidate journal data is retained
// for honest comparisons, not regenerated or relabeled.
export const EXTERNAL_RESEARCH_VERSION='EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1';
export const EXTERNAL_RESEARCH_IDS=Object.freeze(['FLOW_BOOK_PROXY_V1']);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clamp=(x,a=-1,b=1)=>Math.min(b,Math.max(a,x));
const norm=(facts,key,scale=1)=>finite(facts?.[key])?clamp(facts[key]/scale):null;
function scoreWeighted(parts){
 let sum=0,weightSum=0,available=0;
 for(const [value,weight] of parts){
  if(value===null)continue;
  sum+=value*weight;weightSum+=Math.abs(weight);available++;
 }
 return {score:weightSum?sum/weightSum:0,available};
}
export function externalResearchDirections(facts={},{
 baselineDirection='UP',snapshotAvailable=false,
 dataQuality=[],sourceAt=null,roundStartMs=null
}={}){
 const book=scoreWeighted([
  [norm(facts,'ofiNormalized5s'),0.27],
  [norm(facts,'tradePressure15s'),0.17],
  [norm(facts,'tradePressure60s'),0.16],
  [norm(facts,'microScore'),0.09],
  [norm(facts,'currentScore'),0.10],
  [norm(facts,'currentTrendScore'),0.08],
  [norm(facts,'regimeScore'),0.05],
  [norm(facts,'normalizedMomentum60s'),0.05],
  [finite(facts.predictionMarketUpMid)?
    clamp((facts.predictionMarketUpMid-0.5)*2):null,0.03],
 ]);
 const issues=Array.isArray(dataQuality)?[...dataQuality]:['UNKNOWN_DATA_QUALITY'];
 const reusedPreRound=Number.isFinite(roundStartMs)&&Number.isFinite(sourceAt)&&sourceAt<roundStartMs;
 if(reusedPreRound&&!issues.includes('PRE_ROUND_SNAPSHOT_REUSED'))issues.push('PRE_ROUND_SNAPSHOT_REUSED');
 const validInput=!reusedPreRound&&snapshotAvailable===true&&Number.isFinite(sourceAt)&&
  !issues.some(x=>x==='NO_FRESH_SNAPSHOT'||x==='DEPTH_MISSING_OR_STALE'||
   x==='TRADES_MISSING_OR_STALE');
 const fallback=!snapshotAvailable||book.available<4||book.score===0;
 const direction=book.score>0?'UP':book.score<0?'DOWN':
  (baselineDirection==='DOWN'?'DOWN':'UP');
 const selected={
  direction,
  strength:book.available>=4?Number(Math.abs(book.score).toFixed(6)):null,
  evidence:fallback?'BASELINE_OR_NO_INFO_FALLBACK':
   validInput?'FROZEN_MICROSTRUCTURE_INPUT':'DEGRADED_MICROSTRUCTURE_INPUT',
  featureCount:book.available,fallback,
 };
 return {version:EXTERNAL_RESEARCH_VERSION,productionEffect:'NONE_SHADOW_ONLY',
  executionEligible:false,autoPromotion:false,
  predictedHorizonMs:300000,nominalDeadlineMs:8000,
  sourceAt:Number.isFinite(sourceAt)?sourceAt:null,
  reusedPreRound,fullQuality:validInput&&book.available>=4,
  regime:'FLOW_ONLY',dataQuality:issues,
  predictions:{FLOW_BOOK_PROXY_V1:selected}};
}
