// Evidence-limited error taxonomy. These are audit HYPOTHESES, not proven causes.
// Uses only snapshots captured at the original signal lock and verified settlement.
const isSide=s=>s==='UP'||s==='DOWN';
const num=v=>typeof v==='number'&&Number.isFinite(v);
export function classifyOfficialMistake(p){
 if(!p||!isSide(p.direction)||!isSide(p.actual)||p.settledAt==null||
    !Number.isSafeInteger(p.round)||!Number.isSafeInteger(p.signalAt)||
    p.signalAt<p.round||p.signalAt>=p.round+15000||
    p.settledAt<p.round+300000)return {eligible:false,tags:[]};
 if(p.direction===p.actual)return {eligible:true,correct:true,tags:[]};
 const tags=[];
 const d=p.decisionContext||{};
 const score=Number(d.fromOpenBps);
 const confidence=Number(d.modelSelfConfidence);
 const earlyDirection=num(score)?Math.sign(score):0;
 const predicted=p.direction==='UP'?1:-1;
 if(num(confidence)&&confidence>=.8)tags.push('POSSIBLE_MODEL_OVERCONFIDENCE');
 if(earlyDirection!==0&&earlyDirection!==predicted)
   tags.push('POSSIBLE_EARLY_MOMENTUM_CONFLICT');
 if(d.prewarmDirection&&d.reviewDirection&&d.prewarmDirection!==d.reviewDirection
    &&isSide(d.prewarmDirection)&&isSide(d.reviewDirection))
   tags.push('POSSIBLE_ANALYSIS_REVERSAL');
 if(p.featureRegime==='MIXED')tags.push('POSSIBLE_MIXED_TREND');
 if(num(d.earlySamples)&&d.earlySamples<5)tags.push('POSSIBLE_THIN_EARLY_SAMPLING');
 if(num(d.marketAgeMs)&&d.marketAgeMs>2000)tags.push('POSSIBLE_MARKET_LATENCY');
 if(!Array.isArray(p.caseFeatures))tags.push('CASE_FEATURES_UNAVAILABLE');
 if(tags.length===0)tags.push('UNEXPLAINED_OFFICIAL_MISS');
 return {eligible:true,correct:false,tags};
}
export function summarizeMistakes(predictions,limit=150){
 const recent=(predictions||[]).filter(x=>isSide(x.actual)&&x.settledAt!=null).slice(-limit);
 const eligible=recent.map(classifyOfficialMistake).filter(x=>x.eligible);
 const mistakes=eligible.filter(x=>!x.correct);
 const counts={};
 for(const m of mistakes)for(const k of m.tags)counts[k]=(counts[k]||0)+1;
 const patterns=Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({
  tag,count,shareOfMisses:mistakes.length?Number((count/mistakes.length).toFixed(3)):null
 }));
 return {method:'LOCK_TIME_SNAPSHOT_OFFICIAL_OUTCOME_V1',
  settledWithValidCausality:eligible.length,misses:mistakes.length,
  correct:eligible.length-mistakes.length,patterns,
  interpretation:'Exploratory correlations from historical verified misses; not proven mistake causes or model retraining'};
}
export function pastErrorHints(predictions,nowRound){
 // Only fully settled PREVIOUS rounds may influence current prompts.
 const prior=(predictions||[]).filter(p=>p.round<nowRound &&
  Number.isSafeInteger(p.settledAt)&&p.settledAt<nowRound);
 const summary=summarizeMistakes(prior);
 const supported=summary.settledWithValidCausality>=30&&summary.misses>=10;
 return {usable:supported,settled:summary.settledWithValidCausality,
  misses:summary.misses,patterns:supported?summary.patterns.filter(x=>x.count>=4).slice(0,3):[],
  warning:'Tags describe hypotheses, never give a directional signal or infer future outcomes'};
}
