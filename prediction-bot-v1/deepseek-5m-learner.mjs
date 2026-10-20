// Official-settlement-only online feedback store for the independent DeepSeek
// model. This DOES NOT fine-tune weights of DeepSeek's hosted model.
// It incrementally builds post-settlement empirical priors and forward-test stats.
import fs from 'node:fs';
import path from 'node:path';
const okSide=x=>x==='UP'||x==='DOWN';
const source='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
function load(file){
 try{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  return data?.schema===1&&Array.isArray(data.predictions)?data:{schema:1,predictions:[],updatedAt:null};
 }catch{return {schema:1,predictions:[],updatedAt:null}}
}
function save(file,state){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
 const tmp=file+'.tmp.'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o640});fs.renameSync(tmp,file);
}
const regime=f=>{
 const one=f?.oneMinute,five=f?.fiveMinute;
 if(!one?.ready||!five?.ready)return 'UNKNOWN';
 const a=Number(one.ema9)-Number(one.ema21);
 const b=Number(five.ema9)-Number(five.ema21);
 if(Number.isFinite(a)&&Number.isFinite(b)&&a*b>0)
   return a>0?'TREND_UP':'TREND_DOWN';
 return 'MIXED';
};
export function newLearner(file,clock=()=>Date.now()){
 const state=load(file);
 function record(signal,features,attempts){
  const id=Number(signal?.round);
  if(!Number.isSafeInteger(id)||!okSide(signal?.latest?.direction))return;
  if(state.predictions.some(x=>x.round===id))return;
  state.predictions.push({
   round:id,direction:signal.latest.direction,
   confidence:signal.latest.confidence??null,
   signalAt:signal.latest.lockedAt,
   featureRegime:regime(features),
   signalLatencyMs:signal.latest.lockedAt-id,
   provider:signal.providerModel,
   attemptCount:attempts,
   actual:null,settledAt:null
  });
  state.predictions=state.predictions.slice(-2000);
  state.updatedAt=clock();save(file,state);
 }
 function settle(stats){
  if(stats?.ok!==true||stats?.settlementSource!==source||!Array.isArray(stats.records))return 0;
  const records=new Map();
  for(const r of stats.records){
   const round=Number(r?.roundStartMs);
   const actual=r?.productionActual;
   if(Number.isSafeInteger(round)&&okSide(actual)&&
      (r.productionSettledAt!=null||r.settledAt!=null) &&
      (r.officialSettlementAudit!=null||r.resolutionEvidence!=null))
      records.set(round,{actual,settledAt:r.productionSettledAt??r.settledAt});
  }
  let count=0;
  for(const pred of state.predictions){
   if(pred.actual||!records.has(pred.round))continue;
   const r=records.get(pred.round);
   if(clock()<pred.round+300000)continue;
   pred.actual=r.actual;pred.settledAt=r.settledAt;
   pred.hit=pred.direction===r.actual;
   count++;
  }
  if(count){state.updatedAt=clock();save(file,state)}
  return count;
 }
 function summary(){
  const settled=state.predictions.filter(x=>okSide(x.actual));
  const recent=settled.slice(-150),hits=recent.filter(x=>x.hit).length;
  const sides=Object.fromEntries(['UP','DOWN'].map(side=>{
   const subset=recent.filter(x=>x.direction===side);
   return [side,{samples:subset.length,hits:subset.filter(x=>x.hit).length}];
  }));
  const regimes=Object.fromEntries(['TREND_UP','TREND_DOWN','MIXED'].map(key=>{
   const subset=recent.filter(x=>x.featureRegime===key);
   return [key,{samples:subset.length,hits:subset.filter(x=>x.hit).length}];
  }));
  return {officialSamples:recent.length,officialHits:hits,
   recentAccuracy:recent.length?Number((hits/recent.length).toFixed(4)):null,
   allOfficialSamples:settled.length,upDown:sides,regimes,
   predictions:state.predictions.length,unsettled:state.predictions.length-settled.length,
   readyForAnalysis:recent.length>=30,
   note:'Empirical post-settlement feedback only; not probability calibration or model weight training'};
 }
 function feedback(features){
  const stats=summary();
  if(stats.officialSamples<30)return {usable:false,samples:stats.officialSamples};
  const key=regime(features),subset=stats.regimes[key];
  return {usable:true,samples:stats.officialSamples,regime:key,
    regimeSampleCount:subset?.samples??0,
    regimeHistoricalAccuracy:subset?.samples>=15?Number((subset.hits/subset.samples).toFixed(4)):null,
    upSamples:stats.upDown.UP.samples,downSamples:stats.upDown.DOWN.samples,
    upHistoricalAccuracy:stats.upDown.UP.samples>=15?
      Number((stats.upDown.UP.hits/stats.upDown.UP.samples).toFixed(4)):null,
    downHistoricalAccuracy:stats.upDown.DOWN.samples>=15?
      Number((stats.upDown.DOWN.hits/stats.upDown.DOWN.samples).toFixed(4)):null,
    interpretation:'Descriptive rolling accuracy from older resolved rounds only; no guarantee of predictive lift. Choose on CURRENT data, not by historical label alone.'};
 }
 function history(limit=80){
  const n=Math.max(1,Math.min(100,Math.trunc(Number(limit)||80)));
  return {ok:true,model:'DEEPSEEK_5M_V1',officialSource:source,
   generatedAt:clock(),summary:summary(),
   records:state.predictions.slice(-n).reverse().map(x=>({
    round:x.round,direction:x.direction,confidence:x.confidence,
    signalAt:x.signalAt,signalLatencyMs:x.signalLatencyMs,
    featureRegime:x.featureRegime,provider:x.provider,
    attemptCount:x.attemptCount,actual:x.actual,
    settledAt:x.settledAt,hit:x.actual===null?null:x.hit
   }))};
 }
 return {record,settle,summary,feedback,history};
}
