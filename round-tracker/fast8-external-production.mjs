// Immutable worker-side candidate selection for the FAST8-only production route.
// Only the selected external FLOW_BOOK_PROXY_V1 strategy may drive production.
// This adapter has no access to order APIs, risk settings or wallet data.
export const EXTERNAL_PRODUCTION_ID='FLOW_BOOK_PROXY_V1';
export const EXTERNAL_PRODUCTION_VERSION='EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1/FLOW_BOOK_PROXY_V1';
export const EXTERNAL_PRODUCTION_START_POLICY='SELECTED_EXTERNAL_8S_SINGLE_DIRECTION_V1';
export function chooseExternalFast8WorkerDirection(worker,expectedRound){
  if(!worker || worker.roundStartMs!==expectedRound ||
      worker.externalResearch?.version!=='EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1')return null;
  const selected=worker.externalResearch.predictions?.[EXTERNAL_PRODUCTION_ID];
  if(!selected || !['UP','DOWN'].includes(selected.direction))return null;
  const workerIssues=Array.isArray(worker.dataQuality)?worker.dataQuality:[];
  const researchIssues=Array.isArray(worker.externalResearch.dataQuality)?
    worker.externalResearch.dataQuality:[];
  const issues=[...new Set([...workerIssues,...researchIssues])];
  if(worker.externalResearch.reusedPreRound)issues.push('PRE_ROUND_SNAPSHOT_REUSED');
  const fallbackUsed=selected.fallback===true ||
    worker.externalResearch.fullQuality!==true ||
    issues.length>0;
  return {
    direction:selected.direction,model:EXTERNAL_PRODUCTION_ID,
    modelVersion:EXTERNAL_PRODUCTION_VERSION,
    evidence:selected.evidence??null,
    sourceAt:worker.externalResearch.sourceAt??null,
    featureCount:selected.featureCount??0,
    strength:null, // Uncalibrated weights are never traded as confidence/probability.
    fallbackUsed,qualityStatus:fallbackUsed?
       'UNVERIFIED_EXTERNAL_DIRECTION':'FROZEN_EXTERNAL_MICROSTRUCTURE',
    dataQuality:issues,
    fallbackReason:fallbackUsed?
      (selected.fallback===true?'EXTERNAL_FLOW_NO_INFO_FALLBACK':issues[0]||'EXTERNAL_FLOW_QUALITY_DEGRADED'):null,
    estimatedWinProbability:null,
    source:'FAST8_WORKER_FROZEN_RESEARCH_CANDIDATE',
  };
}
