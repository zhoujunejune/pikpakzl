// Read-only verification of the exact VIP75 artifact used for the 2026-10-10 production switch.
// Does NOT retrain, change probabilities, change existing locks, or place any orders.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { independentFeatures, independentAdaptiveProbability, chooseIndependentDirection } from './independent-direction-shadow.mjs';

export const FROZEN_VIP75_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3_1791566406774';
const ENGINE_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3';
const PINNED = Object.freeze({ trainingSamples:718, selectedTrainingWindow:320, halfLife:180, l2:0.12, regimeBlend:0.3 });
const REQUIRED = ['regimeScore','currentScore','microScore','currentTrendScore'];
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
  return {ready:true,reason:null,model:m,version:m.version,weightFingerprint:digest};
}

export function createFrozenVip75Fast8Probe({file,log=()=>{}}) {
  let model=null, status={ready:false,reason:'NOT_LOADED',version:FROZEN_VIP75_VERSION};
  let round=0, observations=0, earliestValid=null, lastMissing=[];
  function load(){
    const result=inspectFrozenVip75Artifact(file);
    model=result.ready ? result.model : null;
    status={ready:result.ready,reason:result.reason,version:FROZEN_VIP75_VERSION,
      foundVersion:result.foundVersion||null,knownLineage:result.knownLineage??null,
      weightFingerprint:result.weightFingerprint||null,parameterMismatch:result.parameter||null};
    log('vip75_frozen8_artifact_inspection',status);
    return status;
  }
  function observe(live,observedAt=Date.now()){
    const start=Number(live?.round);
    if(!Number.isFinite(start) || start<=0 || !Number.isFinite(observedAt) || observedAt<start || observedAt>start+8000)return null;
    if(round!==start){round=start;observations=0;earliestValid=null;lastMissing=[];}
    observations++;
    const facts=live?.facts;
    lastMissing=REQUIRED.filter(k=>!facts || facts[k]===null || facts[k]===undefined || facts[k]==='' || !Number.isFinite(Number(facts[k])));
    if(!model || lastMissing.length || !facts || !independentFeatures(facts))return null;
    if(earliestValid)return earliestValid;
    const probability=independentAdaptiveProbability(model,facts);
    const direction=chooseIndependentDirection(probability);
    if(!direction)return null;
    earliestValid={roundStartMs:start,observedAt,modelVersion:FROZEN_VIP75_VERSION,
      direction,probability,weightFingerprint:status.weightFingerprint};
    log('vip75_frozen8_first_valid',{round:start,offsetMs:observedAt-start,
      direction,modelVersion:FROZEN_VIP75_VERSION,weightFingerprint:status.weightFingerprint});
    return earliestValid;
  }
  function report(){return {...status,round,observations,firstValidOffsetMs:earliestValid?earliestValid.observedAt-round:null,
    missingRequired:lastMissing,hasCandidate:!!earliestValid,canUseAt8s:!!earliestValid,
    productionEffect:'NONE_READ_ONLY_PROBE'};}
  function decision(start){return model && earliestValid?.roundStartMs===start?{...earliestValid}:null;}
  return {load,observe,report,decision};
}
