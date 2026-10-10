import fs from 'node:fs';

export const INDEPENDENT_DIRECTION_VERSION = 'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3';
// Public model name. Keep immutable trained version IDs and persisted v3 storage
// unchanged so a rename cannot erase strict-forward predictions or retrain.
export const INDEPENDENT_DIRECTION_NAME = 'zl_new_vip75';
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
  minChallengerGain:0.015,
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
    if(recentTrain.length<Math.min(240,Math.max(40,Math.floor(minSamples*0.3))))continue;
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
    name:INDEPENDENT_DIRECTION_NAME,
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
  return {modelName:INDEPENDENT_DIRECTION_NAME,modelVersion:model.version,trainedAt:model.trainedAt,
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
  if(!model)return {name:INDEPENDENT_DIRECTION_NAME,status:'WAITING_FOR_TRAINING',target,modelVersion:null,
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
  return {name:INDEPENDENT_DIRECTION_NAME,version:INDEPENDENT_DIRECTION_VERSION,modelVersion:model.version,
    status,productionEffect:'NONE_SHADOW_ONLY',
    independentOfBaseDirection:true,target,forwardRounds:settled.length,
    decidedRounds:decided.length,hits:sums.hits,misses:sums.misses,
    accuracy:sums.accuracy,coverage,
    noDirectionRounds:settled.length-decided.length,
    dataGapCount:dataGapRounds.length,dataGapRecentRoundIds:dataGapRounds.slice(-10),
    recent100:recent,recent40,rolling200,up,down,noBase,
    validation:model.validation,trainedAt:model.trainedAt,startRoundMs:model.startRoundMs};
}
// Long-term live evaluation spans automatic model changes; never reset the
// denominator when a model is retrained. A single immutable frozen prediction
// per official round is auditable against the model scheduled at that moment.
export function independentAdaptiveProgramStats(rows,modelLineage,archivedOfficialLedger=[]) {
  const target=INDEPENDENT_TARGET;
  const lineage=Array.from(modelLineage||[]).filter(m=>
    m?.version && Number.isFinite(Number(m.trainedAt)) &&
    Number.isFinite(Number(m.startRoundMs))
  ).sort((a,b)=>Number(a.startRoundMs)-Number(b.startRoundMs));
  const empty={name:INDEPENDENT_DIRECTION_NAME,modelName:INDEPENDENT_DIRECTION_NAME,
    version:INDEPENDENT_DIRECTION_VERSION,
    productionEffect:'NONE_SHADOW_ONLY',forwardRounds:0,decidedRounds:0,
    accuracy:null,coverage:null,status:'STRICT_FORWARD_COLLECTING',
    target,modelTransitions:Math.max(0,lineage.length-1)};
  if(!lineage.length)return {...empty,status:'WAITING_FOR_TRAINING'};
  // The live ring buffer may evict old rows: an immutable official-only
  // compact ledger preserves *lifetime* strict-forward denominators.
  const all=new Map();
  for(const r of archivedOfficialLedger){
    if(official(r)) all.set(Number(r.roundStartMs),r);
  }
  for(const r of rows){
    if(official(r) && !all.has(Number(r.roundStartMs)))
      all.set(Number(r.roundStartMs),r);
  }
  const rounds=Array.from(all.values()).filter(r=>
    Number(r.roundStartMs)>=Number(lineage[0].startRoundMs))
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const snapshots=rounds.map(r=>{
    let scheduled=null;
    for(const m of lineage){
      if(Number(m.startRoundMs)<=Number(r.roundStartMs))scheduled=m;
      else break;
    }
    const f=r.independentDirectionShadow;
    const observed=Number(f?.observedAt),start=Number(r.roundStartMs);
    const valid=scheduled && f?.modelVersion===scheduled.version &&
      Number(f?.trainedAt)===Number(scheduled.trainedAt) &&
      Number(f?.roundStartMs)===start &&
      observed>Number(scheduled.trainedAt) &&
      observed>=start+10000 && observed<=start+22000 &&
      Number(r.shadowObservedAt)===observed &&
      (f?.direction==='UP'||f?.direction==='DOWN');
    return {round:start,actual:r.actual,
      direction:valid?f.direction:null,
      regime:valid?(f.marketRegime||'UNKNOWN'):null,
      reason:valid?null:!f?'NO_FROZEN_DIRECTION':'FROZEN_VERSION_OR_TIME_INVALID',
    };
  });
  const predictions=snapshots.filter(x=>x.direction);
  const outcome=predictions.map(x=>({decision:x.direction,actual:x.actual}));
  const summary=summarizeOutcomes(outcome);
  const rolling=n=>summarizeOutcomes(outcome.slice(-n));
  const byDir=d=>summarizeOutcomes(outcome.filter(x=>x.decision===d));
  const byRegime=d=>summarizeOutcomes(predictions
    .filter(x=>x.regime===d).map(x=>({decision:x.direction,actual:x.actual})));
  const coverage=rounds.length?Number((predictions.length/rounds.length).toFixed(4)):null;
  const recent40=rolling(40),recent100=rolling(100),recent200=rolling(200);
  const up=byDir('UP'),down=byDir('DOWN');
  const trend=byRegime('TREND'),range=byRegime('RANGE');
  const dataGaps=snapshots.filter(x=>!x.direction);
  const regimeQualified=trend.samples>=20&&range.samples>=20 &&
    trend.accuracy>target.accuracy&&range.accuracy>target.accuracy;
  const qualified=rounds.length>=target.minForwardRounds &&
    predictions.length===rounds.length &&
    summary.accuracy>target.accuracy &&
    recent40.samples===40&&recent40.accuracy>target.accuracy &&
    recent100.samples===100&&recent100.accuracy>target.accuracy &&
    recent200.samples===200&&recent200.accuracy>target.accuracy &&
    up.samples>=15&&down.samples>=15 &&
    up.accuracy>target.accuracy&&down.accuracy>target.accuracy &&
    regimeQualified;
  const recentDrift=recent40.samples>=ADAPTIVE_POLICY.driftMinSamples &&
    recent40.accuracy<ADAPTIVE_POLICY.driftAccuracy;
  return {...empty,
    status:qualified?'QUALIFIED_75_100_LONG_TERM_REVIEW':
      rounds.length>=target.minForwardRounds?'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED':'STRICT_FORWARD_COLLECTING',
    promotionEligibleForReview:qualified,productionAutoPromotion:false,
    forwardRounds:rounds.length,decidedRounds:predictions.length,
    hits:summary.hits,misses:summary.misses,accuracy:summary.accuracy,
    coverage,noDirectionRounds:dataGaps.length,
    dataGapRecentRoundIds:dataGaps.slice(-10).map(x=>x.round),
    recent40,recent100,rolling200:recent200,
    up,down,trend,range,regimeQualified,recentDrift,
    modelTransitions:Math.max(0,lineage.length-1),
    forwardStartRoundMs:lineage[0].startRoundMs,
    frozenOutcomeScope:'ALL_V3_ADAPTIVE_MODELS_PRE_SETTLEMENT',
  };
}

export function createIndependentDirectionShadow({file,log=()=>{},minTrainingSamples=320}={}){
  let state={schemaVersion:3,version:INDEPENDENT_DIRECTION_VERSION,model:null,
    priorModels:[],modelLineage:[],officialForwardLedger:[],
    lastAttemptSettledRoundMs:0,
    lastAdaptationReason:null,adaptationAttempts:0,modelSwitches:0,lastInsufficientAt:0,
    challenger:null};
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
      if(saved?.version===INDEPENDENT_DIRECTION_VERSION && saved?.schemaVersion===3 &&
        Array.isArray(saved.model?.weights) && saved.model.weights.length===FEATURE_KEYS.length+1 &&
        Array.isArray(saved.modelLineage) &&
        Array.isArray(saved.officialForwardLedger))
        state=saved;
    }catch(e){if(e.code!=='ENOENT')log('independent_direction_load_error',{error:e.message});}
  }
  function settle(row){
    if(!official(row)||!state.modelLineage.length||
      Number(row.roundStartMs)<Number(state.modelLineage[0].startRoundMs))return false;
    const frozen=row.independentDirectionShadow;
    const minimal={
      roundStartMs:Number(row.roundStartMs),
      roundEndMs:Number(row.roundEndMs),
      actual:row.actual,actualSource:row.actualSource,settledAt:Number(row.settledAt),
      shadowObservedAt:row.shadowObservedAt??null,
      independentChallengerShadow:row.independentChallengerShadow?{
        modelVersion:row.independentChallengerShadow.modelVersion,
        trainedAt:row.independentChallengerShadow.trainedAt,
        roundStartMs:row.independentChallengerShadow.roundStartMs,
        observedAt:row.independentChallengerShadow.observedAt,
        direction:row.independentChallengerShadow.direction,
        marketRegime:row.independentChallengerShadow.marketRegime,
      }:null,
      independentDirectionShadow:frozen?{
        modelVersion:frozen.modelVersion,trainedAt:frozen.trainedAt,
        roundStartMs:frozen.roundStartMs,observedAt:frozen.observedAt,
        direction:frozen.direction,marketRegime:frozen.marketRegime,
      }:null,
    };
    const existing=state.officialForwardLedger.findIndex(r=>r.roundStartMs===minimal.roundStartMs);
    if(existing!==-1){
      const old=state.officialForwardLedger[existing];
      if(old.actual===minimal.actual)return false;
      state.officialForwardLedger[existing]={...old,actual:minimal.actual,
        actualSource:minimal.actualSource,settledAt:minimal.settledAt};
      log('independent_direction_official_correction',{round:minimal.roundStartMs,
        previous:old.actual,official:minimal.actual});
    }else{
      state.officialForwardLedger.push(minimal);
    }
    save();
    return true;
  }
  function reconcileHistory(rounds){
    let n=0;
    for(const row of rounds)if(settle(row))n++;
    if(n)log('independent_direction_ledger_reconciled',{addedOrCorrected:n});
    return n;
  }
  function trainIfNeeded(rounds,now=Date.now()){
    const rows=Array.from(rounds);
    const officialSettled=rows.filter(r=>official(r) &&
      Number(r.settledAt)<now &&
      Number(r.roundStartMs)<Math.floor(now/300000)*300000)
      .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
    const last=officialSettled.at(-1)?.roundStartMs||0;
    if(!last)return false;
    const report=independentAdaptiveProgramStats(rows,state.modelLineage,state.officialForwardLedger);
    const lastAttempt=Number(state.lastAttemptSettledRoundMs)||0;
    const additionalRounds=lastAttempt?Math.floor((last-lastAttempt)/300000):9999;
    const drift=Boolean(state.model && report.recentDrift);
    if(state.model && additionalRounds<(drift?8:ADAPTIVE_POLICY.retrainEverySettledRounds))return false;
    state.lastAttemptSettledRoundMs=last;
    state.adaptationAttempts++;
    const trial=trainIndependentModel(rows,now,{minSamples:minTrainingSamples});
    if(!trial.ok){
      if(now-state.lastInsufficientAt>3600000){
        state.lastInsufficientAt=now;log('independent_direction_train_not_ready',trial);
      }
      save();return false;
    }
    if(state.model&&trial.model.trainingEndRound<=state.model.trainingEndRound){
      save();return false;
    }
    const priorAccuracy=Number(state.model?.validation?.accuracy);
    const challengerAccuracy=Number(trial.model.validation?.accuracy);
    // Drift triggers training, never an unconditional promotion. A challenger
    // must beat the incumbent on the chronological holdout before switching.
    const improve=!state.model ||
      (Number.isFinite(challengerAccuracy) && Number.isFinite(priorAccuracy) &&
      challengerAccuracy>=priorAccuracy+ADAPTIVE_POLICY.minChallengerGain);
    const reason=!state.model?'INITIAL_MODEL':drift?'FORWARD_DRIFT':
      improve?'HOLDOUT_IMPROVEMENT':'NO_VALIDATION_IMPROVEMENT';
    state.lastAdaptationReason=reason;
    log('independent_direction_adaptation_review',{
      modelName:INDEPENDENT_DIRECTION_NAME,at:now,reason,drift,additionalRounds,
      priorModel:state.model?.version||null,
      priorHoldoutAccuracy:state.model?.validation?.accuracy??null,
      challengerHoldoutAccuracy:trial.model.validation.accuracy,
      challengerWindow:trial.model.selectedTrainingWindow,
      challengerRegimeBlend:trial.model.regimeBlend,
      switchAllowed:improve,productionEffect:'NONE_SHADOW_ONLY'
    });
    if(!improve){save();return false;}
    // Candidate is shadow-only until an independently settled same-input
    // forward comparison is available. Validation alone never promotes.
    if(state.model){
      state.challenger=trial.model;
      save();
      log('independent_direction_challenger_staged',{
        modelVersion:trial.model.version,incumbent:state.model.version,
        validation:trial.model.validation,forwardPromotionBlocked:true,
        productionEffect:'NONE_SHADOW_ONLY'});
      return false;
    }
    if(state.model){
      state.priorModels=[{
        modelVersion:state.model.version,
        finalStats:independentForwardStats(rows,state.model),
      },...state.priorModels].slice(0,10);
      state.modelSwitches++;
    }
    // Keep the incumbent for the remainder of this round. New models are
    // staged for the next round; observe() selects the scheduled version.
    state.activePreviousModel=state.model;
    state.model=trial.model;
    state.modelLineage.push({
      version:trial.model.version,
      trainedAt:trial.model.trainedAt,
      startRoundMs:trial.model.startRoundMs,
    });
    // Never prune model lineage: otherwise historical losses could vanish from
    // the lifetime ledger after enough automatic retraining events.
    save();
    log('independent_direction_model_trained',{
      modelName:INDEPENDENT_DIRECTION_NAME,modelVersion:state.model.version,reason,
      trainingSamples:state.model.trainingSamples,
      validation:state.model.validation,
      startRoundMs:state.model.startRoundMs,
      selectedTrainingWindow:state.model.selectedTrainingWindow,
      halfLife:state.model.halfLife,l2:state.model.l2,
      regimeBlend:state.model.regimeBlend,
      forwardProgram:report,
      independentOfBaseDirection:true,productionEffect:'NONE_SHADOW_ONLY',
    });
    return true;
  }
  function observe(row) {
    if(!state.model||row?.independentDirectionShadow) return false;
    const scheduled=state.modelLineage.filter(m=>Number(m.startRoundMs)<=Number(row.roundStartMs)).at(-1);
    const active=scheduled?.version===state.model.version ? state.model :
      state.activePreviousModel?.version===scheduled?.version ? state.activePreviousModel : null;
    const result=freezeIndependentModel(row,active);
    if(!result)return false;
    row.independentDirectionShadow=result;
    // Freeze the candidate on exactly the same pre-settlement snapshot.
    // No retrospective scoring or mutation of the incumbent freeze.
    if(state.challenger && !row.independentChallengerShadow &&
      Number(row.roundStartMs)>=Number(state.challenger.startRoundMs)){
      const challenger=freezeIndependentModel(row,state.challenger);
      if(challenger){
        row.independentChallengerShadow=challenger;
        log('independent_direction_challenger_forward_frozen',{
          round:row.roundStartMs,modelVersion:challenger.modelVersion,
          direction:challenger.direction,observedAt:challenger.observedAt,
          productionEffect:'NONE_SHADOW_ONLY'});
      }
    }
    log('independent_direction_forward_frozen',{round:row.roundStartMs,
      modelName:INDEPENDENT_DIRECTION_NAME,modelVersion:result.modelVersion,direction:result.direction,
      probability:result.probability,observedAt:result.observedAt,
      productionEffect:'NONE_SHADOW_ONLY'});
    return true;
  }
  function stats(rounds) {
    const all=Array.from(rounds);
    const ledger=state.officialForwardLedger;
    const candidate=state.challenger;
    const paired=candidate?ledger.filter(r=>{
      const a=r.independentDirectionShadow,b=r.independentChallengerShadow;
      return b?.modelVersion===candidate.version &&
        Number(b.observedAt)===Number(a?.observedAt) &&
        Number(b.observedAt)===Number(r.shadowObservedAt) &&
        Number(b.observedAt)>=Number(r.roundStartMs)+10000 &&
        Number(b.observedAt)<=Number(r.roundStartMs)+22000 &&
        Number(b.observedAt)<Number(r.roundEndMs) &&
        (a?.direction==='UP'||a?.direction==='DOWN') &&
        (b.direction==='UP'||b.direction==='DOWN');
    }):[];
    const challengerForward={modelVersion:candidate?.version??null,
      pairedOfficialRounds:paired.length,
      incumbent:summarizeOutcomes(paired.map(r=>({decision:r.independentDirectionShadow.direction,actual:r.actual}))),
      challenger:summarizeOutcomes(paired.map(r=>({decision:r.independentChallengerShadow.direction,actual:r.actual}))),
      promotionAllowed:false,
      reason:'FORWARD_COMPARISON_OBSERVATION_ONLY_NO_AUTOMATIC_PROMOTION'};
    return {...independentAdaptiveProgramStats(all,state.modelLineage,state.officialForwardLedger),
      name:INDEPENDENT_DIRECTION_NAME,
      modelName:INDEPENDENT_DIRECTION_NAME,
      challengerForward,
      currentModelForward:independentForwardStats(all,state.model),
      activeLearning:{enabled:true,policy:ADAPTIVE_POLICY,
        adaptationAttempts:state.adaptationAttempts,
        modelSwitches:state.modelSwitches,
        officialLedgerRows:state.officialForwardLedger.length,
        lastAttemptSettledRoundMs:state.lastAttemptSettledRoundMs,
        lastReason:state.lastAdaptationReason},
      model:state.model?{
        name:INDEPENDENT_DIRECTION_NAME,
        version:state.model.version,trainedAt:state.model.trainedAt,
        startRoundMs:state.model.startRoundMs,
        trainingSamples:state.model.trainingSamples,
        validationSamples:state.model.validationSamples,
        selectedTrainingWindow:state.model.selectedTrainingWindow,
        regimeBlend:state.model.regimeBlend,
        l2:state.model.l2,halfLife:state.model.halfLife,
        validation:state.model.validation,
      }:null,
      priorModels:state.priorModels};
  }
  return {load,trainIfNeeded,observe,settle,reconcileHistory,stats};
}
