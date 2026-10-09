import fs from 'node:fs';

export const INDEPENDENT_DIRECTION_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3';
export const INDEPENDENT_TARGET = Object.freeze({
  accuracy: 0.75, coverage: 1.00, minForwardRounds: 200, minDecisions: 200,
  recentDecisions: 100, longWindow: 200, trainingSamples: 320,
});

const REQUIRES = ['regimeScore','currentScore','microScore','currentTrendScore'];
const FEATURE_KEYS = [
  'regimeScore','currentScore','microScore','currentTrendScore',
  'normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
  'normalizedMomentum180s','normalizedMomentum300s',
  'tradePressure15s','tradePressure60s','ofiNormalized5s','ofiNormalized60s',
  'rangePosition180','predictionMarketUpMid','absorptionRisk',
  'liveScore','distanceFromOpenBps',
  'currentTrendInteraction','microTrendInteraction','shortLongMomentumGap','marketCurrentAgreement',
];

export const ADAPTIVE_POLICY = Object.freeze({
  retrainEverySettledRounds:24, driftMinSamples:20, driftAccuracy:0.65,
  minChallengerGain:0.015, maxHistoryVersions:128,
});

const finite = x => x === null || x === undefined || x === '' ? null :
  (Number.isFinite(Number(x)) ? Number(x) : null);
const clip = (x, lo = -3, hi = 3) => Math.max(lo,Math.min(hi,x));
function sigmoid(z) {return z >= 0 ? 1/(1+Math.exp(-z)) : Math.exp(z)/(1+Math.exp(z));}
// Regime is computed entirely from the market snapshot, never from a future outcome.
export function independentMarketRegime(f) {
  const current=finite(f?.currentScore),trend=finite(f?.currentTrendScore);
  if(current===null||trend===null) return 'UNKNOWN';
  const momentum=finite(f?.normalizedMomentum60s)??0;
  return Math.abs(trend)>=0.55 && Math.sign(trend)===Math.sign(current) &&
    Math.abs(current)>=0.45 && Math.sign(momentum)===Math.sign(trend)
      ? 'TREND' : 'RANGE';
}
export function independentFeatures(f) {
  if (!f || typeof f !== 'object' || REQUIRES.some(k => finite(f[k]) === null)) return null;
  const v = k => clip(finite(f[k]) ?? 0);
  const upMid = finite(f.predictionMarketUpMid);
  const current = v('currentScore'), trend = v('currentTrendScore'), micro = v('microScore');
  const mom15 = v('normalizedMomentum15s'), mom300 = v('normalizedMomentum300s');
  return [
    v('regimeScore'), current, micro, trend,
    mom15,v('normalizedMomentum30s'),v('normalizedMomentum60s'),
    v('normalizedMomentum180s'),mom300,
    v('tradePressure15s'),v('tradePressure60s'),
    v('ofiNormalized5s'),v('ofiNormalized60s'),
    v('rangePosition180'),
    upMid === null ? 0 : clip((upMid - 0.5)*2),
    f.absorptionRisk === true ? 1 : 0,
    v('liveScore'),clip((finite(f.distanceFromOpenBps)??0)/10),
    clip(current*trend),clip(micro*trend),clip(mom15-mom300),
    upMid === null ? 0 : clip(current*(upMid-0.5)*2),
  ];
}
export function validLiveObservation(row) {
  const start = finite(row?.roundStartMs), observed = finite(row?.shadowObservedAt);
  const end = finite(row?.roundEndMs) ?? ((start??0)+300000-1);
  return start !== null && observed !== null &&
    observed >= start + 10000 && observed <= start + 22000 && observed < end &&
    independentFeatures(row?.shadowFacts) !== null;
}
function official(row) {
  const start = finite(row?.roundStartMs), end = finite(row?.roundEndMs);
  return (row?.actual === 'UP' || row?.actual === 'DOWN') &&
    row.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
    Number.isFinite(start) && Number.isFinite(end) &&
    Number.isFinite(finite(row?.settledAt)) && Number(row.settledAt) > end;
}
function modelProbability(weights,x) {
  if (!Array.isArray(weights) || !x || weights.length !== x.length+1) return null;
  let z=weights[0];
  for(let j=0;j<x.length;j++) z+=weights[j+1]*x[j];
  return sigmoid(clip(z,-25,25));
}
export function independentAdaptiveProbability(model,facts) {
  const x=independentFeatures(facts);
  if(!x||!model)return null;
  const global=modelProbability(model.weights,x);
  if(!Number.isFinite(global))return null;
  const regime=independentMarketRegime(facts);
  const expert=modelProbability(model.regimeWeights?.[regime],x);
  const mix=Number(model.regimeBlend)||0;
  return Number.isFinite(expert) && mix>0
    ? (1-mix)*global+mix*expert : global;
}
// Direction is a *total* binary decision for every valid market snapshot.
// No score/margin/quality-based abstention is permitted in this candidate.
// Missing or invalid features are separately diagnosed as DATA_GAP and count
// against full coverage; never fabricate an official forward prediction.
export function chooseIndependentDirection(probability) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  return probability >= 0.5 ? 'UP' : 'DOWN';
}
function summarizeOutcomes(decisions) {
  const hits=decisions.filter(x=>x.decision===x.actual).length;
  return {samples:decisions.length,hits,misses:decisions.length-hits,
    accuracy:decisions.length?Number((hits/decisions.length).toFixed(4)):null};
}
function fitLogistic(training,l2,halfLife,focusRegime=null) {
  const w=Array(FEATURE_KEYS.length+1).fill(0);
  for(let epoch=0;epoch<200;epoch++){
    const g=Array(w.length).fill(0);let sum=0;
    for(let i=0;i<training.length;i++){
      const s=training[i],weight=Math.pow(0.5,(training.length-1-i)/halfLife) *
        (focusRegime===null||s.regime===focusRegime?1:0.3);
      const pred=modelProbability(w,s.x),error=(pred-s.y)*weight;
      g[0]+=error;for(let j=0;j<s.x.length;j++)g[j+1]+=error*s.x[j];
      sum+=weight;
    }
    const lr=0.12/Math.sqrt(1+epoch/150);
    w[0]-=lr*g[0]/sum;
    for(let j=1;j<w.length;j++)w[j]-=lr*(g[j]/sum+l2*w[j]);
  }
  return w;
}
function rankValidation(validation,profile) {
  const outcomes=validation.map(r=>({
    decision:chooseIndependentDirection(independentAdaptiveProbability(profile,r.facts)),
    actual:r.actual,
  }));
  const decided=outcomes.filter(x=>x.decision==='UP'||x.decision==='DOWN');
  return {...summarizeOutcomes(decided),
    rounds:validation.length,
    coverage:Number((decided.length/validation.length).toFixed(4)),
  };
}
export function trainIndependentModel(rows,now,opts={}) {
  const minSamples=opts.minSamples??INDEPENDENT_TARGET.trainingSamples;
  const sorted=Array.from(rows).filter(r=>official(r)&&validLiveObservation(r)&&Number(r.settledAt)<now &&
    Number(r.roundStartMs)<Math.floor(now/300000)*300000
  ).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs)).slice(-900);
  if(sorted.length<minSamples)return {ok:false,reason:'INSUFFICIENT_OFFICIAL_FROZEN_TRAINING_SAMPLES',
    samples:sorted.length,minSamples};
  const sample=sorted.map(r=>({x:independentFeatures(r.shadowFacts),
    facts:r.shadowFacts,regime:independentMarketRegime(r.shadowFacts),
    y:r.actual==='UP'?1:0,actual:r.actual,round:r.roundStartMs}));
  const validateN=Math.max(80,Math.floor(sample.length*0.2));
  const train=sample.slice(0,sample.length-validateN-2);
  const validation=sample.slice(-validateN);
  const trials=[];
  // Search both learning horizon and regularization. No test label is used
  // for the decision in its own round; the fixed chronological holdout only
  // chooses which frozen model will face *future* official outcomes.
  for(const window of [320,600,900]){
    const recentTrain=train.slice(-window);
    if(recentTrain.length<240)continue;
    for(const l2 of [0.025,0.12]){
      for(const halfLife of [60,180]){
        const weights=fitLogistic(recentTrain,l2,halfLife);
        const profile={weights,regimeWeights:null,regimeBlend:0};
        const metrics=rankValidation(validation,profile);
        if(metrics.coverage===1) trials.push({
          ...profile,l2,halfLife,window:recentTrain.length,metrics,
          pass:metrics.accuracy!==null&&metrics.accuracy>INDEPENDENT_TARGET.accuracy,
        });
      }
    }
  }
  if(!trials.length) return {ok:false,reason:'VALIDATION_DATA_GAP_BLOCKED_FULL_COVERAGE'};
  trials.sort((a,b)=>(b.metrics.accuracy??-1)-(a.metrics.accuracy??-1)||
    a.window-b.window||a.l2-b.l2);
  // Regime experts are weighted toward current matching market conditions.
  // Reject the regime blend unless it outperforms its global baseline
  // *on exactly the same embargoed, chronological validation window*.
  const bestGlobal=trials[0];
  const expertTrain=train.slice(-bestGlobal.window);
  const regimeWeights={
    TREND:fitLogistic(expertTrain,bestGlobal.l2,bestGlobal.halfLife,'TREND'),
    RANGE:fitLogistic(expertTrain,bestGlobal.l2,bestGlobal.halfLife,'RANGE'),
  };
  for(const mix of [0.30,0.60]){
    const profile={weights:bestGlobal.weights,regimeWeights,regimeBlend:mix};
    const metrics=rankValidation(validation,profile);
    if(metrics.coverage===1 && metrics.accuracy>(bestGlobal.metrics.accuracy+0.005))trials.push({
      ...profile,l2:bestGlobal.l2,halfLife:bestGlobal.halfLife,
      window:bestGlobal.window,metrics,
      pass:metrics.accuracy>INDEPENDENT_TARGET.accuracy,
    });
  }
  // Validation picks a fixed policy; future results are exclusively measured
  // against frozen, newly arriving official resolutions.
  trials.sort((a,b)=>Number(b.pass)-Number(a.pass) ||
    (b.metrics.accuracy??-1)-(a.metrics.accuracy??-1) ||
    b.metrics.coverage-a.metrics.coverage ||
    a.window-b.window || a.l2-b.l2);
  const best=trials[0],trainedAt=Math.floor(now);
  return {ok:true, model:{
    version:INDEPENDENT_DIRECTION_VERSION+'_'+trainedAt,
    trainedAt,
    trainingEndRound:sample[train.length-1].round,
    validationStartRound:validation[0].round,
    validationEndRound:validation.at(-1).round,
    trainingSamples:train.length,
    validationSamples:validation.length,
    trainingDataEndsBefore:Math.floor(now/300000)*300000,
    startRoundMs:(Math.floor(now/300000)+1)*300000,
    weights:best.weights,
    regimeWeights:best.regimeWeights||null,
    regimeBlend:best.regimeBlend||0,
    selectedTrainingWindow:best.window,
    l2:best.l2,halfLife:best.halfLife,
    validation:{...best.metrics,qualified:best.pass},
    target:INDEPENDENT_TARGET,
    featureKeys:FEATURE_KEYS,
    independentOfBaseDirection:true,
    productionEffect:'NONE_SHADOW_ONLY',
  }};
}
export function freezeIndependentModel(row,model){
  if(!row||!model||!validLiveObservation(row))return null;
  if(Number(row.roundStartMs)<Number(model.startRoundMs))return null;
  if(Number(row.shadowObservedAt)<=Number(model.trainedAt))return null;
  const probability=independentAdaptiveProbability(model,row.shadowFacts);
  if(!Number.isFinite(probability))return null;
  const decision=chooseIndependentDirection(probability);
  if (decision !== 'UP' && decision !== 'DOWN') return null;
  return {modelVersion:model.version,trainedAt:model.trainedAt,
    roundStartMs:row.roundStartMs,observedAt:row.shadowObservedAt,
    predictionSource:'INDEPENDENT_MARKET_FEATURES',
    direction:decision,probability:Number(probability.toFixed(6)),
    marketRegime:independentMarketRegime(row.shadowFacts),
    regimeBlend:model.regimeBlend||0,
    productionEffect:'NONE_SHADOW_ONLY',
    // This field contains the frozen feature values, never the official label.
    featureVector:independentFeatures(row.shadowFacts)};
}
export function independentForwardStats(rows,model) {
  const target=INDEPENDENT_TARGET;
  if(!model)return {status:'WAITING_FOR_TRAINING',target,modelVersion:null,
    forwardRounds:0,decidedRounds:0,hits:0,misses:0,accuracy:null,coverage:null};
  const settled=Array.from(rows).filter(r=>official(r) &&
    Number(r.roundStartMs)>=Number(model.startRoundMs)
  ).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const decided=settled.map(r=>{
    const frozen=r.independentDirectionShadow;
    const observed=Number(frozen?.observedAt);
    const start=Number(r.roundStartMs);
    const valid=frozen?.modelVersion===model.version &&
      Number(frozen?.trainedAt)===Number(model.trainedAt) &&
      observed>Number(model.trainedAt) &&
      observed>=start+10000 && observed<=start+22000 &&
      Number(r.shadowObservedAt)===observed;
    return {actual:r.actual,decision:valid?frozen.direction:'WAIT'};
  })
    .filter(x=>x.decision==='UP'||x.decision==='DOWN');
  const sums=summarizeOutcomes(decided);
  const dir=direction=>summarizeOutcomes(decided.filter(x=>x.decision===direction));
  const coverage=settled.length?Number((decided.length/settled.length).toFixed(4)):null;
  // Track incremental directions in true V3 WAIT rounds separately: this is
  // observational only and cannot influence a frozen independent decision.
  const noBaseSettled=settled.filter(r=>r.prediction!=='UP'&&r.prediction!=='DOWN');
  const noBaseDecided=noBaseSettled.map(r=>({actual:r.actual,
    direction:r.independentDirectionShadow?.modelVersion===model.version &&
      Number(r.independentDirectionShadow?.trainedAt)===Number(model.trainedAt) &&
      Number(r.independentDirectionShadow?.observedAt)===Number(r.shadowObservedAt) &&
      Number(r.shadowObservedAt)>=Number(r.roundStartMs)+10000 &&
      Number(r.shadowObservedAt)<=Number(r.roundStartMs)+22000 &&
      Number(r.shadowObservedAt)>Number(model.trainedAt) ?
        r.independentDirectionShadow.direction:'WAIT'}))
    .filter(x=>x.direction==='UP'||x.direction==='DOWN')
    .map(x=>({decision:x.direction,actual:x.actual}));
  const noBaseSummary=summarizeOutcomes(noBaseDecided);
  const noBase={settledRounds:noBaseSettled.length,decidedRounds:noBaseDecided.length,
    hits:noBaseSummary.hits,misses:noBaseSummary.misses,accuracy:noBaseSummary.accuracy,
    coverage:noBaseSettled.length?Number((noBaseDecided.length/noBaseSettled.length).toFixed(4)):null};
  const recent=summarizeOutcomes(decided.slice(-target.recentDecisions));
  const recent40=summarizeOutcomes(decided.slice(-40));
  const rolling200=summarizeOutcomes(decided.slice(-target.longWindow));
  const up=dir('UP'),down=dir('DOWN');
  const dataGapRounds=settled.filter(r=>{
    const x=r.independentDirectionShadow;
    return !(x?.modelVersion===model.version &&
      Number(x?.trainedAt)===Number(model.trainedAt) &&
      Number(x?.observedAt)>Number(model.trainedAt) &&
      Number(x?.observedAt)>=Number(r.roundStartMs)+10000 &&
      Number(x?.observedAt)<=Number(r.roundStartMs)+22000 &&
      Number(x?.observedAt)===Number(r.shadowObservedAt) &&
      (x?.direction==='UP'||x?.direction==='DOWN'));
  }).map(r=>Number(r.roundStartMs));
  let status='STRICT_FORWARD_COLLECTING';
  if(settled.length>=target.minForwardRounds){
    if(sums.accuracy>=target.accuracy && coverage===1 &&
      recent.samples>=target.recentDecisions && recent.accuracy>=target.accuracy &&
      recent40.samples===40 && recent40.accuracy>=target.accuracy &&
      rolling200.samples>=target.longWindow && rolling200.accuracy>=target.accuracy &&
      up.samples>=15 && down.samples>=15 &&
      up.accuracy>=target.accuracy && down.accuracy>=target.accuracy)
      status='QUALIFIED_75_100_LONG_TERM_REVIEW';
    else status='FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED';
  }
  return {version:INDEPENDENT_DIRECTION_VERSION,modelVersion:model.version,
    status,productionEffect:'NONE_SHADOW_ONLY',
    independentOfBaseDirection:true,target,forwardRounds:settled.length,
    decidedRounds:decided.length,hits:sums.hits,misses:sums.misses,
    accuracy:sums.accuracy,coverage,
    noDirectionRounds:settled.length-decided.length,
    dataGapCount:dataGapRounds.length,dataGapRecentRoundIds:dataGapRounds.slice(-10),
    recent100:recent,recent40,rolling200,up,down,noBase,
    validation:model.validation,trainedAt:model.trainedAt,startRoundMs:model.startRoundMs};
}
export function createIndependentDirectionShadow({file,log=()=>{},minTrainingSamples=320}={}){
  let state={schemaVersion:1,version:INDEPENDENT_DIRECTION_VERSION,model:null,
    priorModels:[],lastInsufficientAt:0};
  function save(){
    if(!file)return;
    try{fs.mkdirSync(file.slice(0,file.lastIndexOf('/'))||'.',{recursive:true});
      const temp=file+'.tmp-'+process.pid;
      fs.writeFileSync(temp,JSON.stringify(state));
      fs.renameSync(temp,file);
    }catch(e){log('independent_direction_save_error',{error:e.message});}
  }
  function load(){
    if(!file)return;
    try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      if(saved?.version===INDEPENDENT_DIRECTION_VERSION && saved?.schemaVersion===1 &&
        Array.isArray(saved.model?.weights) && saved.model.weights.length===FEATURE_KEYS.length+1)
        state=saved;
    }catch(e){if(e.code!=='ENOENT')log('independent_direction_load_error',{error:e.message});}
  }
  function trainIfNeeded(rounds,now=Date.now()){
    const stats=independentForwardStats(rounds,state.model);
    if(state.model && stats.status!=='FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED')return false;
    const trial=trainIndependentModel(rounds,now,{minSamples:minTrainingSamples});
    if(!trial.ok){
      if(now-state.lastInsufficientAt>3600000){
        state.lastInsufficientAt=now;log('independent_direction_train_not_ready',trial);
      }
      return false;
    }
    if(state.model && trial.model.trainingEndRound<=state.model.trainingEndRound)return false;
    if(state.model){
      state.priorModels=[{modelVersion:state.model.version,finalStats:stats},...state.priorModels].slice(0,5);
    }
    state.model=trial.model;save();
    log('independent_direction_model_trained',{
      modelVersion:state.model.version,
      trainingSamples:state.model.trainingSamples,
      validation:state.model.validation,
      startRoundMs:state.model.startRoundMs,
      independentOfBaseDirection:true,productionEffect:'NONE_SHADOW_ONLY',
    });
    return true;
  }
  function observe(row) {
    if(!state.model||row?.independentDirectionShadow) return false;
    const result=freezeIndependentModel(row,state.model);
    if(!result)return false;
    row.independentDirectionShadow=result;
    log('independent_direction_forward_frozen',{round:row.roundStartMs,
      modelVersion:result.modelVersion,direction:result.direction,
      probability:result.probability,observedAt:result.observedAt,
      productionEffect:'NONE_SHADOW_ONLY'});
    return true;
  }
  function stats(rounds) {
    return {...independentForwardStats(rounds,state.model),
      model:state.model?{
        version:state.model.version,trainedAt:state.model.trainedAt,
        startRoundMs:state.model.startRoundMs,
        trainingSamples:state.model.trainingSamples,
        validationSamples:state.model.validationSamples,
        validation:state.model.validation,
      }:null,
      priorModels:state.priorModels};
  }
  return {load,trainIfNeeded,observe,stats};
}
