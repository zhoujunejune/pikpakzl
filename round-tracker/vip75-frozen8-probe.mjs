// Read-only verification of the exact VIP75 artifact used for the 2026-10-10 production switch.
// Does NOT retrain, change probabilities, change existing locks, or place any orders.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { independentFeatures, independentAdaptiveProbability, chooseIndependentDirection } from './independent-direction-shadow.mjs';
import { createVip75PreviousRoundInputs } from './vip75-preround-features.mjs';

export const FROZEN_VIP75_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3_1791566406774';
const ENGINE_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3';
// Identifies the EXACT production-trained artifact recovered from the 2026-10-10 3/13 period.
export const PINNED_WEIGHT_FINGERPRINT = '08c99732dff85ed6b0a05613b1eecadcef30af827e3a07d71c476535ec51500f';
const PINNED = Object.freeze({ trainingSamples:718, selectedTrainingWindow:320, halfLife:180, l2:0.12, regimeBlend:0.3 });
const within = (x,v) => typeof x==='number' && Number.isFinite(x) && Math.abs(x-v)<1e-12;
const validWeights = w => Array.isArray(w) && w.length===23 && w.every(Number.isFinite);

export function inspectFrozenVip75Artifact(file) {
  let saved;
  try {
    saved=JSON.parse(fs.readFileSync(file,'utf8'));
  } catch (e) { return {ready:false,reason:e?.code==='ENOENT'?'FROZEN_ARTIFACT_NOT_FOUND':'FROZEN_ARTIFACT_READ_FAILED',code:e?.code||null}; }
  if(saved?.schemaVersion!==3 || saved?.version!==ENGINE_VERSION)
    return {ready:false,reason:'MODEL_STATE_SCHEMA_MISMATCH'};
  const m=saved.model;
  if(m?.version!==FROZEN_VIP75_VERSION)
    return {ready:false,reason:'FROZEN_VERSION_NOT_CURRENT_ARTIFACT',foundVersion:m?.version||null,
      knownLineage:Array.isArray(saved.modelLineage) ? saved.modelLineage.some(x=>x.version===FROZEN_VIP75_VERSION):false};
  if(!validWeights(m.weights) || !validWeights(m.regimeWeights?.TREND) || !validWeights(m.regimeWeights?.RANGE))
    return {ready:false,reason:'FROZEN_WEIGHTS_MISSING_OR_INVALID'};
  for(const [k,v] of Object.entries(PINNED)){
    if(!within(m[k],v)) return {ready:false,reason:'FROZEN_PARAMETER_MISMATCH',parameter:k};
  }
  if(!Array.isArray(m.featureKeys) || m.featureKeys.length!==22)
    return {ready:false,reason:'FROZEN_FEATURE_SCHEMA_MISMATCH'};
  const digest=createHash('sha256').update(JSON.stringify({
    version:m.version,weights:m.weights,regimeWeights:m.regimeWeights,
    selectedTrainingWindow:m.selectedTrainingWindow,halfLife:m.halfLife,l2:m.l2,regimeBlend:m.regimeBlend,
    featureKeys:m.featureKeys,
  })).digest('hex');
  if (digest!==PINNED_WEIGHT_FINGERPRINT)
    return {ready:false,reason:'FROZEN_WEIGHT_FINGERPRINT_MISMATCH'};
  return {ready:true,reason:null,model:m,version:m.version,weightFingerprint:digest};
}

export function createFrozenVip75Fast8Probe({file,log=()=>{}}) {
  let model=null, status={ready:false,reason:'NOT_LOADED',version:FROZEN_VIP75_VERSION};
  const previousRoundInputs=createVip75PreviousRoundInputs();
  let round=0, observations=0, earliestValid=null, lastMissing=[], lastInput=null;
  function load(){
    const result=inspectFrozenVip75Artifact(file);
    model=result.ready ? result.model : null;
    status={ready:result.ready,reason:result.reason,version:FROZEN_VIP75_VERSION,
      foundVersion:result.foundVersion||null,knownLineage:result.knownLineage??null,
      weightFingerprint:result.weightFingerprint||null,parameterMismatch:result.parameter||null};
    log('vip75_frozen8_artifact_inspection',status);
    return status;
  }
  function capturePreRound(live,observedAt=Date.now()){
    return previousRoundInputs.capture(live,observedAt);
  }
  function observe(live,observedAt=Date.now()){
    const start=Number(live?.round);
    if(!Number.isFinite(start) || start<=0 || !Number.isFinite(observedAt) || observedAt<start || observedAt>start+8000)return null;
    if(round!==start){round=start;observations=0;earliestValid=null;lastMissing=[];lastInput=null;}
    observations++;
    if(earliestValid)return earliestValid;
    // Prefer the previous round's 22-10s tail; fill a missing field only
    // with a genuine observation, never the original model's implicit zero.
    const prepared=previousRoundInputs.prepare(start,live?.facts);
    lastInput=prepared;
    lastMissing=prepared.missing;
    if(!model || !prepared.complete || !independentFeatures(prepared.facts))return null;
    const probability=independentAdaptiveProbability(model,prepared.facts);
    const direction=chooseIndependentDirection(probability);
    if(!direction)return null;
    earliestValid={roundStartMs:start,observedAt,modelVersion:FROZEN_VIP75_VERSION,
      direction,probability,weightFingerprint:status.weightFingerprint,
      inputVersion:prepared.inputVersion,sourceRound:prepared.sourceRound,
      sourceWindow:prepared.sourceWindow,
      previousRoundFeatureCount:prepared.fromPrevious.length,
      currentRoundFeatureCount:prepared.fromCurrent.length,
      previousBackupFeatureCount:prepared.fromPreviousBackup.length,
      priorContractQuoteUsed:prepared.priorContractQuoteUsed};
    log('vip75_frozen8_first_valid',{round:start,offsetMs:observedAt-start,
      direction,modelVersion:FROZEN_VIP75_VERSION,weightFingerprint:status.weightFingerprint,
      inputVersion:prepared.inputVersion,sourceRound:prepared.sourceRound,
      previousRoundFeatureCount:prepared.fromPrevious.length,
      currentRoundFeatureCount:prepared.fromCurrent.length,
      previousBackupFeatureCount:prepared.fromPreviousBackup.length,
      priorContractQuoteUsed:prepared.priorContractQuoteUsed});
    return earliestValid;
  }
  function report(){return {...status,round,observations,firstValidOffsetMs:earliestValid?earliestValid.observedAt-round:null,
    missingRequired:lastMissing,hasCandidate:!!earliestValid,canUseAt8s:!!earliestValid,
    previousRoundInputCache:previousRoundInputs.report(),
    previousRoundFeatureCount:lastInput?.fromPrevious.length??0,
    currentRoundFeatureCount:lastInput?.fromCurrent.length??0,
    previousBackupFeatureCount:lastInput?.fromPreviousBackup.length??0,
    priorContractQuoteUsed:lastInput?.priorContractQuoteUsed??false,
    inputVersion:lastInput?.inputVersion??null,
    productionEffect:'NONE_READ_ONLY_PROBE'};}
  function decision(start){return model && earliestValid?.roundStartMs===start?{...earliestValid}:null;}
  return {load,capturePreRound,observe,report,decision};
}
