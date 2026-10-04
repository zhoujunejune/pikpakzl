import fs from 'node:fs';

const FEATURE_KEYS = [
  'regimeScore',
  'currentScore',
  'microScore',
  'currentTrendScore',
  'normalizedMomentum15s',
  'normalizedMomentum30s',
  'normalizedMomentum60s',
  'normalizedMomentum180s',
  'normalizedMomentum300s',
  'tradePressure15s',
  'tradePressure60s',
  'ofiNormalized5s',
  'rangePosition180',
  'predictionMarketUpMidCentered',
  'absorptionRisk',
  'predictionMarketMissing',
  'absCurrentScore',
  'absRegimeScore',
  'absTrendScore',
  'predictionMarketStrength',
  'currentMidAgreement',
  'trendMidAgreement',
  'ofiPressureInteraction',
  'momentumAgreement60x300',
  'shortLongMomentumGap',
  'pressureImbalance',
  'rangeExtremity',
  'absorptionCurrentInteraction',
];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
const logit = p => Math.log(clamp(p, 1e-5, 1 - 1e-5) / (1 - clamp(p, 1e-5, 1 - 1e-5)));
const ENGINE_VERSION = 'ROLLING_GBDT_REGIME_PROGRESSIVE_V2_2';

function vectorize(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const upMid = Number(facts.predictionMarketUpMid);
  const regime = Number(facts.regimeScore);
  const current = Number(facts.currentScore);
  const micro = Number(facts.microScore);
  const trend = Number(facts.currentTrendScore);
  const m15 = Number(facts.normalizedMomentum15s);
  const m30 = Number(facts.normalizedMomentum30s);
  const m60 = Number(facts.normalizedMomentum60s);
  const m180 = Number(facts.normalizedMomentum180s);
  const m300 = Number(facts.normalizedMomentum300s);
  const p15 = Number(facts.tradePressure15s);
  const p60 = Number(facts.tradePressure60s);
  const ofi = Number(facts.ofiNormalized5s);
  const range = Number(facts.rangePosition180);
  const core = [regime,current,micro,trend,m15,m30,m60,m180,m300,p15,p60,ofi,range];
  if (!core.every(Number.isFinite)) return null;

  const bookAgeMs = Number(facts.predictionMarketBookAgeMs);
  const predictionMarketValid =
    facts.predictionMarketMappingReliable === true &&
    facts.predictionMarketRoundAligned === true &&
    Number.isFinite(bookAgeMs) &&
    bookAgeMs >= 0 &&
    bookAgeMs <= 5000 &&
    Number.isFinite(upMid);
  const midCentered = predictionMarketValid ? (upMid - 0.5) * 2 : 0;
  const predictionMarketMissing = predictionMarketValid ? 0 : 1;
  const absorption = facts.absorptionRisk ? 1 : 0;

  return [
    regime, current, micro, trend, m15, m30, m60, m180, m300, p15, p60, ofi, range,
    midCentered, absorption, predictionMarketMissing,
    Math.abs(current),
    Math.abs(regime),
    Math.abs(trend),
    Math.abs(midCentered),
    current * midCentered,
    trend * midCentered,
    ofi * p60,
    m60 * m300,
    m15 - m300,
    p15 - p60,
    Math.abs(range),
    absorption * Math.abs(current),
  ].map(v => clamp(v, -3, 3));
}

function regimeOf(facts) {
  const regime = Number(facts?.regimeScore || 0);
  const trend = Number(facts?.currentTrendScore || 0);
  const m60 = Math.abs(Number(facts?.normalizedMomentum60s || 0));
  const m300 = Math.abs(Number(facts?.normalizedMomentum300s || 0));
  const pressure = Math.abs(Number(facts?.tradePressure60s || 0));
  const strength = 0.55 * Math.abs(regime) + 0.45 * Math.abs(trend);
  if (m60 + m300 + pressure >= 2.2) return 'HIGH_VOL';
  if (strength >= 0.75 && regime + trend >= 0.6) return 'TREND_UP';
  if (strength >= 0.75 && regime + trend <= -0.6) return 'TREND_DOWN';
  return 'NEUTRAL';
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const p = clamp(q, 0, 1) * (sorted.length - 1);
  const a = Math.floor(p), b = Math.ceil(p);
  if (a === b) return sorted[a];
  return sorted[a] + (sorted[b] - sorted[a]) * (p - a);
}

function featureThresholds(samples) {
  const out = [];
  for (let j = 0; j < FEATURE_KEYS.length; j += 1) {
    const values = samples.map(s => s.x[j]).filter(Number.isFinite).sort((a,b) => a-b);
    const ts = [0.15,0.30,0.45,0.60,0.75,0.90]
      .map(q => Number(quantile(values, q).toFixed(6)));
    out.push([...new Set(ts)]);
  }
  return out;
}

function trainBoost(samples, config = {}) {
  if (!samples.length) return null;
  const rounds = Math.max(8, Number(config.rounds || 28));
  const eta = clamp(Number(config.eta || 0.12), 0.02, 0.4);
  const halfLife = Math.max(40, Number(config.halfLife || Math.max(80, samples.length * 0.45)));
  const prevalence = (samples.reduce((s,x) => s + x.y, 0) + 2) / (samples.length + 4);
  const bias = logit(prevalence);
  const scores = new Array(samples.length).fill(bias);
  const weights = samples.map((_,i) => Math.pow(0.5, (samples.length - 1 - i) / halfLife));
  const thresholds = featureThresholds(samples);
  const trees = [];
  const importance = new Array(FEATURE_KEYS.length).fill(0);

  for (let t = 0; t < rounds; t += 1) {
    const residual = samples.map((s,i) => s.y - sigmoid(scores[i]));
    let best = null;
    for (let j = 0; j < FEATURE_KEYS.length; j += 1) {
      for (const threshold of thresholds[j]) {
        let lw=0,rw=0,lr=0,rr=0;
        for (let i=0;i<samples.length;i+=1) {
          const w=weights[i], e=residual[i];
          if (samples[i].x[j] <= threshold) { lw += w; lr += w*e; }
          else { rw += w; rr += w*e; }
        }
        if (lw < 3 || rw < 3) continue;
        const lv = lr/lw, rv = rr/rw;
        let gain=0;
        for (let i=0;i<samples.length;i+=1) {
          const pred = samples[i].x[j] <= threshold ? lv : rv;
          gain += weights[i] * (2*residual[i]*pred - pred*pred);
        }
        if (!best || gain > best.gain) best={feature:j,threshold,left:lv,right:rv,gain};
      }
    }
    if (!best || !Number.isFinite(best.gain) || best.gain <= 1e-8) break;
    const tree={feature:best.feature,threshold:best.threshold,left:best.left*eta,right:best.right*eta,gain:best.gain};
    trees.push(tree);
    importance[best.feature] += Math.max(0,best.gain);
    for(let i=0;i<samples.length;i+=1) scores[i] += samples[i].x[tree.feature] <= tree.threshold ? tree.left : tree.right;
  }
  return {bias,trees,importance,eta,halfLife};
}

function rawBoost(model, x) {
  let z=Number(model?.bias || 0);
  for (const tree of model?.trees || []) z += x[tree.feature] <= tree.threshold ? tree.left : tree.right;
  return z;
}

function trainEnsemble(samples, config) {
  const base=trainBoost(samples, config);
  if (!base) return null;
  const regimes={};
  for (const name of ['TREND_UP','TREND_DOWN','HIGH_VOL','NEUTRAL']) {
    const subset=samples.filter(s=>s.regime===name);
    if (subset.length < 70) continue;
    regimes[name]=trainBoost(subset,{...config,rounds:Math.max(10,Math.round(Number(config.rounds||28)*0.65))});
  }
  return {base,regimes};
}

function predictEnsemble(model, sample) {
  const baseP=sigmoid(rawBoost(model.base,sample.x));
  const expert=model.regimes?.[sample.regime];
  if (!expert) return baseP;
  const expertP=sigmoid(rawBoost(expert,sample.x));
  return clamp(0.38*baseP + 0.62*expertP, 0.001, 0.999);
}

function optimizeThreshold(preds) {
  if (!Array.isArray(preds) || preds.length < 30) return 0.5;
  let best={threshold:0.5,score:-Infinity};
  for(let k=44;k<=56;k+=1){
    const threshold=k/100;
    let hit=0;
    for(const x of preds) hit += ((x.p>=threshold?1:0)===x.y)?1:0;
    const acc=hit/preds.length;
    const penalty=Math.abs(threshold-0.5)*0.03;
    const score=acc-penalty;
    if(score>best.score+1e-12) best={threshold,score};
  }
  return best.threshold;
}

function evaluatePreds(preds, threshold) {
  let hit=0,brier=0;
  for(const x of preds){
    hit += ((x.p>=threshold?1:0)===x.y)?1:0;
    brier += (x.p-x.y)**2;
  }
  return {accuracy:preds.length?hit/preds.length:null,brier:preds.length?brier/preds.length:null};
}

function walkForward(samples, config) {
  const validSize=40, folds=3, embargo=2;
  const firstValid=samples.length-validSize*folds;
  if(firstValid<180) return null;
  const historyPreds=[];
  const windows=[];
  for(let fold=0;fold<folds;fold+=1){
    const start=firstValid+fold*validSize;
    const trainEnd=Math.max(0,start-embargo);
    const trainStart=Math.max(0,trainEnd-config.windowSize);
    const train=samples.slice(trainStart,trainEnd);
    const valid=samples.slice(start,start+validSize);
    if(train.length<180 || valid.length<30) return null;
    const model=trainEnsemble(train,config);
    if(!model) return null;
    const preds=valid.map(s=>({p:predictEnsemble(model,s),y:s.y}));
    const threshold=optimizeThreshold(historyPreds);
    const metric=evaluatePreds(preds,threshold);
    const prevalence=(train.reduce((z,x)=>z+x.y,0)+2)/(train.length+4);
    const baselineClass=prevalence>=0.5?1:0;
    const baselineAccuracy=valid.filter(s=>s.y===baselineClass).length/valid.length;
    const baselineBrier=valid.reduce((z,s)=>z+(prevalence-s.y)**2,0)/valid.length;
    windows.push({
      trainSamples:train.length,validationSamples:valid.length,
      validationStartRound:valid[0]?.roundStartMs??null,
      validationEndRound:valid.at(-1)?.roundStartMs??null,
      threshold,accuracy:metric.accuracy,brier:metric.brier,baselineAccuracy,baselineBrier,
    });
    historyPreds.push(...preds);
  }
  const avg=key=>windows.reduce((z,x)=>z+Number(x[key]||0),0)/windows.length;
  const accuracy=avg('accuracy'), brier=avg('brier');
  const baselineAccuracy=avg('baselineAccuracy'), baselineBrier=avg('baselineBrier');
  const minAccuracy=Math.min(...windows.map(x=>x.accuracy));
  const recentAccuracy=windows.at(-1).accuracy;
  const finalThreshold=optimizeThreshold(historyPreds);
  const score=accuracy*0.35+recentAccuracy*0.45+minAccuracy*0.20-Math.max(0,brier-baselineBrier)*0.25;
  return {windows,accuracy,brier,baselineAccuracy,baselineBrier,minAccuracy,recentAccuracy,threshold:finalThreshold,score};
}

function evaluateOuterHoldout(samples, config, threshold) {
  const validSize = 40;
  const embargo = 2;
  if (!Array.isArray(samples) || samples.length < 222) return null;
  const start = samples.length - validSize;
  const trainEnd = Math.max(0, start - embargo);
  const trainStart = Math.max(0, trainEnd - config.windowSize);
  const train = samples.slice(trainStart, trainEnd);
  const valid = samples.slice(start);
  if (train.length < 180 || valid.length !== validSize) return null;
  const model = trainEnsemble(train, config);
  if (!model) return null;
  const preds = valid.map(s => ({ p: predictEnsemble(model, s), y: s.y }));
  const metric = evaluatePreds(preds, threshold);
  const prevalence = (train.reduce((z,x)=>z+x.y,0)+2)/(train.length+4);
  const baselineClass = prevalence >= 0.5 ? 1 : 0;
  const baselineAccuracy = valid.filter(s => s.y === baselineClass).length / valid.length;
  const baselineBrier = valid.reduce((z,s)=>z+(prevalence-s.y)**2,0)/valid.length;
  return {
    trainSamples: train.length,
    validationSamples: valid.length,
    validationStartRound: valid[0]?.roundStartMs ?? null,
    validationEndRound: valid.at(-1)?.roundStartMs ?? null,
    threshold,
    accuracy: metric.accuracy,
    brier: metric.brier,
    baselineAccuracy,
    baselineBrier,
  };
}

function topImportance(model) {
  const agg=new Array(FEATURE_KEYS.length).fill(0);
  const add=m=>{ if(!m?.importance)return; m.importance.forEach((v,i)=>agg[i]+=Number(v||0)); };
  add(model?.base); Object.values(model?.regimes||{}).forEach(add);
  const total=agg.reduce((a,b)=>a+b,0)||1;
  return agg.map((gain,i)=>({feature:FEATURE_KEYS[i],gain:Number(gain.toFixed(6)),share:Number((gain/total).toFixed(4))}))
    .sort((a,b)=>b.gain-a.gain).slice(0,8);
}

export function createShadowV2Engine({file,minSamples=300,forwardTarget=60,maxCandidates=10,log=()=>{}}={}) {
  let state={schemaVersion:1,lastTrainRound:0,candidates:[]};

  function save(){
    if(!file)return;
    try{const tmp=`${file}.tmp-${process.pid}`;fs.writeFileSync(tmp,JSON.stringify(state),'utf8');fs.renameSync(tmp,file);}
    catch(e){log('shadow_v2_save_failed',{error:e?.message||String(e)});}
  }
  function load(){
    if(!file)return false;
    try{
      const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
      if(parsed?.schemaVersion!==1||!Array.isArray(parsed?.candidates))return false;
      state=parsed;
      deleteRetiredCandidates();
      log('shadow_v2_registry_loaded',{candidates:state.candidates.length,lastTrainRound:state.lastTrainRound||0});
      return true;
    }catch(e){if(e?.code!=='ENOENT')log('shadow_v2_load_failed',{error:e?.message||String(e)});return false;}
  }
  function makeSamples(rows){
    return rows.map(r=>{
      const roundStartMs = Number(r?.roundStartMs);
      const observedAt = Number(r?.shadowObservedAt);
      const observedDelayMs = observedAt - roundStartMs;
      const strictOfficialLabel =
        r?.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
        String(r?.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC');
      if (!Number.isFinite(roundStartMs) || !Number.isFinite(observedAt)) return null;
      if (observedDelayMs < 8000 || observedDelayMs > 20000) return null;
      if (!strictOfficialLabel) return null;
      const x=vectorize(r?.shadowFacts);
      const y=r?.actual==='UP'?1:r?.actual==='DOWN'?0:null;
      return x&&y!==null?{
        x,y,regime:regimeOf(r.shadowFacts),facts:r.shadowFacts,roundStartMs,observedAt,observedDelayMs
      }:null;
    }).filter(Boolean).sort((a,b)=>a.roundStartMs-b.roundStartMs);
  }
  function candidateSummary(c){
    const settled=(c.observations||[]).filter(x=>(x.actual==='UP'||x.actual==='DOWN')&&Number.isFinite(Number(x.probability)));
    let hit=0,brier=0,streak=0,maxErrors=0;
    for(const x of settled){const y=x.actual==='UP'?1:0;const pred=Number(x.probability)>=Number(c.threshold??0.5)?1:0; if(pred===y)streak=0;else{streak++;maxErrors=Math.max(maxErrors,streak);} hit+=pred===y?1:0;brier+=(Number(x.probability)-y)**2;}
    const recent20=settled.slice(-20); let rh=0; for(const x of recent20){const y=x.actual==='UP'?1:0;rh+=((Number(x.probability)>=Number(c.threshold??0.5)?1:0)===y)?1:0;}
    return {
      modelVersion:c.modelVersion,engineVersion:c.engineVersion||c.trainingMethod,trainingMethod:c.trainingMethod,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      windowSize:c.windowSize,threshold:c.threshold,validationAccuracy:c.validationAccuracy,validationBrier:c.validationBrier,
      baselineAccuracy:c.baselineAccuracy,outerHoldoutAccuracy:c.outerHoldoutAccuracy ?? c.validationAccuracy,
      outerHoldoutBaselineAccuracy:c.outerHoldoutBaselineAccuracy ?? c.baselineAccuracy,
      innerWalkForwardAccuracy:c.innerWalkForwardAccuracy ?? null,
      walkForwardMinAccuracy:c.walkForwardMinAccuracy,walkForwardRecentAccuracy:c.walkForwardRecentAccuracy,
      forwardSamples:settled.length,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-settled.length),
      hits:hit,misses:settled.length-hit,forwardAccuracy:settled.length?Number((hit/settled.length).toFixed(4)):null,
      forwardBrier:settled.length?Number((brier/settled.length).toFixed(4)):null,recent20Accuracy:recent20.length?Number((rh/recent20.length).toFixed(4)):null,
      maxConsecutiveErrors:maxErrors,topFeatures:c.topFeatures||[],
      status:(c.engineVersion||c.trainingMethod)!==ENGINE_VERSION
        ? 'QUARANTINED_LEGACY_PIPELINE'
        : settled.length<forwardTarget
          ? 'COLLECTING'
          : (hit/settled.length>=0.70?'FORWARD_70_MET':'FORWARD_COMPLETE'),
    };
  }
  function deleteRetiredCandidates(){
    const removed=[];
    state.candidates = state.candidates.filter(c=>{
      const s=candidateSummary(c);
      const legacy=(c.engineVersion||c.trainingMethod)!==ENGINE_VERSION;
      const retired=s.forwardSamples>=forwardTarget && Number.isFinite(Number(s.forwardAccuracy)) && Number(s.forwardAccuracy)<0.60;
      if(legacy||retired){
        removed.push({
          modelVersion:c.modelVersion,
          engineVersion:c.engineVersion||c.trainingMethod||null,
          forwardSamples:s.forwardSamples,
          forwardAccuracy:s.forwardAccuracy,
          reason:legacy?'LEGACY_PIPELINE':'STRICT_FORWARD_BELOW_60',
        });
        return false;
      }
      return true;
    });
    if(removed.length){
      save();
      log('shadow_v2_retired_models_deleted',{count:removed.length,models:removed});
    }
    return removed;
  }

  function prune(){
    while(state.candidates.length>maxCandidates){
      let idx=state.candidates.findIndex(c=>candidateSummary(c).forwardSamples>=forwardTarget);
      if(idx<0)idx=0;state.candidates.splice(idx,1);
    }
  }
  function maybeTrain(rows){
    const samples=makeSamples(rows);
    if(samples.length<minSamples)return null;
    const latest=samples.at(-1)?.roundStartMs||0;
    const latestEngineVersion=state.candidates.at(-1)?.engineVersion||null;
    if(state.lastTrainRound && latestEngineVersion===ENGINE_VERSION && latest-state.lastTrainRound<20*300000)return null;

    const outerSize=40;
    const tuningSamples=samples.slice(0, -outerSize);
    if(tuningSamples.length<220)return null;
    const windows=[300,450,600,900].filter(w=>tuningSamples.length>=w);
    const configs=[];
    for(const windowSize of windows){
      configs.push({windowSize,rounds:24,eta:0.10,halfLife:Math.max(80,Math.round(windowSize*0.45))});
      configs.push({windowSize,rounds:34,eta:0.08,halfLife:Math.max(80,Math.round(windowSize*0.32))});
    }

    let best=null;
    for(const config of configs){
      const wf=walkForward(tuningSamples,config);
      if(!wf)continue;
      if(!best||wf.score>best.wf.score)best={config,wf};
    }
    state.lastTrainRound=latest;
    if(!best){save();return null;}

    const outer=evaluateOuterHoldout(samples,best.config,best.wf.threshold);
    if(!outer){save();return null;}
    const recentInnerBaseline=Number(best.wf.windows.at(-1)?.baselineAccuracy ?? 0);
    const gateReasons=[];
    if(!(outer.accuracy>=outer.baselineAccuracy+0.02)) gateReasons.push('OUTER_ACCURACY_NOT_ABOVE_BASELINE_2PP');
    if(!(outer.brier<=outer.baselineBrier)) gateReasons.push('OUTER_BRIER_WORSE_THAN_BASELINE');
    if(!(outer.accuracy>=0.55)) gateReasons.push('OUTER_ACCURACY_BELOW_55');
    if(!(best.wf.minAccuracy>=0.50)) gateReasons.push('INNER_MIN_FOLD_BELOW_50');
    if(!(best.wf.recentAccuracy>=recentInnerBaseline)) gateReasons.push('INNER_RECENT_BELOW_BASELINE');

    if(gateReasons.length){
      log('shadow_v2_candidate_rejected_before_forward',{
        engineVersion:ENGINE_VERSION,
        lastTrainRound:latest,
        windowSize:best.config.windowSize,
        threshold:Number(best.wf.threshold.toFixed(2)),
        innerWalkForwardAccuracy:Number(best.wf.accuracy.toFixed(4)),
        innerWalkForwardRecentAccuracy:Number(best.wf.recentAccuracy.toFixed(4)),
        innerWalkForwardMinAccuracy:Number(best.wf.minAccuracy.toFixed(4)),
        outerHoldoutAccuracy:Number(outer.accuracy.toFixed(4)),
        outerHoldoutBaselineAccuracy:Number(outer.baselineAccuracy.toFixed(4)),
        outerHoldoutBrier:Number(outer.brier.toFixed(4)),
        outerHoldoutBaselineBrier:Number(outer.baselineBrier.toFixed(4)),
        reasons:gateReasons,
      });
      save();
      return null;
    }

    const train=samples.slice(-best.config.windowSize);
    const model=trainEnsemble(train,best.config);
    if(!model){save();return null;}
    const trainedAt=Date.now();
    const candidate={
      modelVersion:`shadow-v2-gbdt-${trainedAt}`,engineVersion:ENGINE_VERSION,trainedAt,lastTrainRound:latest,trainingMethod:ENGINE_VERSION,
      windowSize:best.config.windowSize,config:best.config,threshold:Number(best.wf.threshold.toFixed(2)),model,
      validationAccuracy:Number(outer.accuracy.toFixed(4)),validationBrier:Number(outer.brier.toFixed(4)),
      baselineAccuracy:Number(outer.baselineAccuracy.toFixed(4)),baselineBrier:Number(outer.baselineBrier.toFixed(4)),
      outerHoldoutAccuracy:Number(outer.accuracy.toFixed(4)),outerHoldoutBaselineAccuracy:Number(outer.baselineAccuracy.toFixed(4)),
      outerHoldoutBrier:Number(outer.brier.toFixed(4)),outerHoldoutBaselineBrier:Number(outer.baselineBrier.toFixed(4)),
      innerWalkForwardAccuracy:Number(best.wf.accuracy.toFixed(4)),
      walkForwardMinAccuracy:Number(best.wf.minAccuracy.toFixed(4)),walkForwardRecentAccuracy:Number(best.wf.recentAccuracy.toFixed(4)),
      walkForwardWindows:best.wf.windows,outerHoldout:outer,topFeatures:topImportance(model),observations:[],
    };
    state.candidates.push(candidate);prune();save();
    log('shadow_v2_model_trained',{
      modelVersion:candidate.modelVersion,trainingMethod:candidate.trainingMethod,windowSize:candidate.windowSize,threshold:candidate.threshold,
      trainedSamples:train.length,validationSamples:outer.validationSamples,
      validationAccuracy:candidate.validationAccuracy,validationBrier:candidate.validationBrier,baselineAccuracy:candidate.baselineAccuracy,
      innerWalkForwardAccuracy:candidate.innerWalkForwardAccuracy,
      walkForwardMinAccuracy:candidate.walkForwardMinAccuracy,walkForwardRecentAccuracy:candidate.walkForwardRecentAccuracy,
      topFeatures:candidate.topFeatures,
    });
    log('shadow_v2_candidate_registered',{modelVersion:candidate.modelVersion,targetSamples:forwardTarget,candidates:state.candidates.length});
    return candidateSummary(candidate);
  }
  function observe(row,facts){
    const round=Number(row?.roundStartMs);
    const observedAt=Number(row?.shadowObservedAt);
    const observedDelayMs=observedAt-round;
    if(!Number.isFinite(round)||!facts||!Number.isFinite(observedAt))return;
    if(observedDelayMs<8000||observedDelayMs>20000){
      log('shadow_v2_observation_rejected_timing',{round,observedAt,observedDelayMs,minDelayMs:8000,maxDelayMs:20000});
      return;
    }
    const x=vectorize(facts); if(!x)return;
    const sample={x,regime:regimeOf(facts)}; let changed=false;
    for(const c of state.candidates){
      if((c.engineVersion||c.trainingMethod)!==ENGINE_VERSION)continue;
      const s=candidateSummary(c);
      if(s.forwardSamples>=forwardTarget)continue;
      if(round<Number(c.trainedAt||0))continue;
      if((c.observations||[]).some(o=>Number(o.roundStartMs)===round))continue;
      const p=predictEnsemble(c.model,sample);
      c.observations.push({roundStartMs:round,observedAt,observedDelayMs,probability:Number(p.toFixed(6)),actual:null,settledAt:null});
      changed=true;
    }
    if(changed)save();
  }
  function settle(row){
    if(row?.actual!=='UP'&&row?.actual!=='DOWN')return;
    const round=Number(row.roundStartMs);let changed=false;
    for(const c of state.candidates){
      if((c.engineVersion||c.trainingMethod)!==ENGINE_VERSION)continue;
      const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);
      if(!o)continue;
      const before=o.actual;
      if(before===row.actual)continue;
      o.actual=row.actual;o.settledAt=Number(row.settledAt)||Date.now();changed=true;
      if(before==='UP'||before==='DOWN'){
        log('shadow_v2_official_label_corrected',{modelVersion:c.modelVersion,round,from:before,to:row.actual});
      }
      const s=candidateSummary(c);
      if(s.forwardSamples===forwardTarget||s.forwardSamples%10===0)log('shadow_v2_forward_progress',s);
    }
    if(changed){
      save();
      deleteRetiredCandidates();
    }
  }

  function invalidateRounds(roundIds){
    const keys=new Set(Array.from(roundIds||[]).map(x=>String(Number(x))));
    if(!keys.size)return 0;
    let reset=0;
    for(const c of state.candidates){
      for(const o of c.observations||[]){
        if(!keys.has(String(Number(o.roundStartMs))))continue;
        if(o.actual==='UP'||o.actual==='DOWN'){
          o.actual=null;o.settledAt=null;reset+=1;
        }
      }
    }
    if(reset)save();
    if(reset)log('shadow_v2_labels_invalidated',{rounds:keys.size,observationsReset:reset});
    return reset;
  }
  function stats(){
    const candidates=state.candidates.map(candidateSummary).sort((a,b)=>Number(b.trainedAt)-Number(a.trainedAt));
    const completed=candidates.filter(x=>x.engineVersion===ENGINE_VERSION&&x.forwardSamples>=forwardTarget).sort((a,b)=>(b.forwardAccuracy??-1)-(a.forwardAccuracy??-1));
    return {ok:true,schemaVersion:1,trainingMethod:ENGINE_VERSION,productionEffect:'NONE_SHADOW_ONLY',lastTrainRound:state.lastTrainRound||0,candidates,bestCompleted:completed[0]||null};
  }
  return {load,save,maybeTrain,observe,settle,invalidateRounds,deleteRetiredCandidates,stats};
}
