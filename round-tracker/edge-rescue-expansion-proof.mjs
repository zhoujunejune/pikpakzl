// Auditable strict-forward evidence and incremental-WAIT promotion checks.
const isDir=x=>x==='UP'||x==='DOWN';
const time=x=>x!==null&&x!==undefined&&x!==''&&Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;

export function isOfficialStrictSettlement(r){
  if(!r||!isDir(r.actual)||r.officialDirection!==r.actual)return false;
  if(r.actualSource!=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION')return false;
  const proof=String(r.resolutionEvidence||'');
  if(!proof.startsWith('OFFICIAL_'+r.actual+':')||!proof.includes('STRICT_ROUND_ALIGNED_TOPIC'))return false;
  if(/PERSISTED_EVIDENCE|REVALIDATING|WINNER_FLAG/i.test(proof))return false;
  if(!Number.isSafeInteger(Number(r.predictionMarketTopicId))||Number(r.predictionMarketTopicId)<=0)return false;
  const start=time(r.roundStartMs),end=time(r.roundEndMs),settled=time(r.settledAt);
  if(!start||!end||!settled||end<=start||settled<=end)return false;
  if(r.result==='PENDING'||r.needsOfficialArchiveCorrection===true)return false;
  if(isDir(r.prediction)&&r.result!==(r.prediction===r.actual?'HIT':'MISS'))return false;
  if(isDir(r.productionPrediction)&&r.productionResult!==(r.productionPrediction===r.actual?'HIT':'MISS'))return false;
  return true;
}

export function isFrozenFinalBaselineWait(r,version){
  if(!isOfficialStrictSettlement(r))return false;
  const ev=r.selectiveV2EdgeExpansionShadow;
  if(!ev||ev.version!==version||!ev.candidates)return false;
  const start=time(r.roundStartMs),end=time(r.roundEndMs),settled=time(r.settledAt);
  const predicted=time(r.predictedAt),evaluated=time(ev.evaluatedAt),witness=time(r.expansionBaselineWaitAt);
  if(!start||!end||!settled||!predicted||!evaluated||!witness)return false;
  if(!(start<=predicted&&predicted<=evaluated&&evaluated<=witness&&witness<end&&end<settled))return false;
  if(!isDir(r.prediction)||ev.baseDirection!==r.prediction||r.lockQualitySelectiveV2?.pass!==false)return false;
  if(isDir(r.productionPrediction)&&r.productionSource!=='SELECTIVE_V2_EDGE_EXPANSION_PRIMARY')return false;
  if(!isDir(r.productionPrediction)&&time(r.productionLockedAt))return false;
  if(r.productionSource==='SELECTIVE_V2_EDGE_EXPANSION_PRIMARY'){
    if(r.productionPrediction!==r.prediction)return false;
    const generated=time(r.productionGeneratedAt),locked=time(r.productionLockedAt);
    if(!generated||!locked||generated>locked||locked>=end)return false;
  }
  return true;
}

export function productionBaselineSummary(settledRows){
  const rows=(settledRows||[]).filter(r=>{
    if(!isOfficialStrictSettlement(r)||!isDir(r.productionPrediction)||r.productionSource==='SELECTIVE_V2_EDGE_EXPANSION_PRIMARY')return false;
    const gen=time(r.productionGeneratedAt),locked=time(r.productionLockedAt),end=time(r.roundEndMs);
    return Boolean(gen&&locked&&end&&gen<=locked&&locked<end);
  });
  const hits=rows.filter(r=>r.productionPrediction===r.actual).length;
  return {samples:rows.length,hits,misses:rows.length-hits,accuracy:rows.length?Number((hits/rows.length).toFixed(4)):null};
}

export function prospectiveCombinedSummary(baseline,rescueDecisions){
  const rescue=rescueDecisions||[];
  const rescueHits=rescue.filter(x=>isDir(x.decision)&&x.decision===x.actual).length;
  const samples=baseline.samples+rescue.length,hits=baseline.hits+rescueHits;
  const accuracy=samples?Number((hits/samples).toFixed(4)):null;
  return {
    baselineSamples:baseline.samples,baselineAccuracy:baseline.accuracy,
    incrementalSamples:rescue.length,incrementalHits:rescueHits,
    samples,hits,accuracy,
    notWorseThanBaseline:baseline.samples>0&&samples>0&&hits*baseline.samples>=baseline.hits*samples,
    meetsAbsoluteFloor:accuracy!==null&&accuracy>=0.70
  };
}

export function wilsonLowerBound(hits,samples,z=1.96){
  if(!Number.isInteger(samples)||samples<=0||!Number.isInteger(hits)||hits<0||hits>samples)return null;
  const p=hits/samples,zz=z*z;
  return Number(((p+zz/(2*samples)-z*Math.sqrt((p*(1-p)+zz/(4*samples))/samples))/(1+zz/samples)).toFixed(4));
}
