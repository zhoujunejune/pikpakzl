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
];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
const logit = p => Math.log(clamp(p, 1e-5, 1 - 1e-5) / (1 - clamp(p, 1e-5, 1 - 1e-5)));

function vectorize(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const upMid = Number(facts.predictionMarketUpMid);
  return [
    Number(facts.regimeScore),
    Number(facts.currentScore),
    Number(facts.microScore),
    Number(facts.currentTrendScore),
    Number(facts.normalizedMomentum15s),
    Number(facts.normalizedMomentum30s),
    Number(facts.normalizedMomentum60s),
    Number(facts.normalizedMomentum180s),
    Number(facts.normalizedMomentum300s),
    Number(facts.tradePressure15s),
    Number(facts.tradePressure60s),
    Number(facts.ofiNormalized5s),
    Number(facts.rangePosition180),
    Number.isFinite(upMid) ? (upMid - 0.5) * 2 : 0,
    facts.absorptionRisk ? 1 : 0,
  ].map(v => Number.isFinite(v) ? clamp(v, -3, 3) : 0);
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
      state=parsed; log('shadow_v2_registry_loaded',{candidates:state.candidates.length,lastTrainRound:state.lastTrainRound||0}); return true;
    }catch(e){if(e?.code!=='ENOENT')log('shadow_v2_load_failed',{error:e?.message||String(e)});return false;}
  }
  function makeSamples(rows){
    return rows.map(r=>{
      const x=vectorize(r?.shadowFacts); const y=r?.actual==='UP'?1:r?.actual==='DOWN'?0:null;
      return x&&y!==null?{x,y,regime:regimeOf(r.shadowFacts),facts:r.shadowFacts,roundStartMs:Number(r.roundStartMs)}:null;
    }).filter(Boolean).sort((a,b)=>a.roundStartMs-b.roundStartMs);
  }
  function candidateSummary(c){
    const settled=(c.observations||[]).filter(x=>(x.actual==='UP'||x.actual==='DOWN')&&Number.isFinite(Number(x.probability)));
    let hit=0,brier=0,streak=0,maxErrors=0;
    for(const x of settled){const y=x.actual==='UP'?1:0;const pred=Number(x.probability)>=Number(c.threshold??0.5)?1:0; if(pred===y)streak=0;else{streak++;maxErrors=Math.max(maxErrors,streak);} hit+=pred===y?1:0;brier+=(Number(x.probability)-y)**2;}
    const recent20=settled.slice(-20); let rh=0; for(const x of recent20){const y=x.actual==='UP'?1:0;rh+=((Number(x.probability)>=Number(c.threshold??0.5)?1:0)===y)?1:0;}
    return {
      modelVersion:c.modelVersion,trainingMethod:c.trainingMethod,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      windowSize:c.windowSize,threshold:c.threshold,validationAccuracy:c.validationAccuracy,validationBrier:c.validationBrier,
      baselineAccuracy:c.baselineAccuracy,walkForwardMinAccuracy:c.walkForwardMinAccuracy,walkForwardRecentAccuracy:c.walkForwardRecentAccuracy,
      forwardSamples:settled.length,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-settled.length),
      hits:hit,misses:settled.length-hit,forwardAccuracy:settled.length?Number((hit/settled.length).toFixed(4)):null,
      forwardBrier:settled.length?Number((brier/settled.length).toFixed(4)):null,recent20Accuracy:recent20.length?Number((rh/recent20.length).toFixed(4)):null,
      maxConsecutiveErrors:maxErrors,topFeatures:c.topFeatures||[],status:settled.length<forwardTarget?'COLLECTING':(hit/settled.length>=0.70?'FORWARD_70_MET':'FORWARD_COMPLETE'),
    };
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
    if(state.lastTrainRound && latest-state.lastTrainRound<20*300000)return null;
    const windows=[300,600,900].filter(w=>samples.length>=Math.min(w,300));
    const configs=[];
    for(const windowSize of windows){
      configs.push({windowSize,rounds:24,eta:0.10,halfLife:Math.max(80,Math.round(windowSize*0.45))});
      configs.push({windowSize,rounds:34,eta:0.08,halfLife:Math.max(80,Math.round(windowSize*0.32))});
    }
    let best=null;
    for(const config of configs){const wf=walkForward(samples,config);if(!wf)continue;if(!best||wf.score>best.wf.score)best={config,wf};}
    state.lastTrainRound=latest;
    if(!best){save();return null;}
    const train=samples.slice(-best.config.windowSize);
    const model=trainEnsemble(train,best.config);
    if(!model){save();return null;}
    const trainedAt=Date.now();
    const candidate={
      modelVersion:`shadow-v2-gbdt-${trainedAt}`,trainedAt,lastTrainRound:latest,trainingMethod:'ROLLING_GBDT_REGIME_PROGRESSIVE_V2',
      windowSize:best.config.windowSize,config:best.config,threshold:Number(best.wf.threshold.toFixed(2)),model,
      validationAccuracy:Number(best.wf.accuracy.toFixed(4)),validationBrier:Number(best.wf.brier.toFixed(4)),
      baselineAccuracy:Number(best.wf.baselineAccuracy.toFixed(4)),baselineBrier:Number(best.wf.baselineBrier.toFixed(4)),
      walkForwardMinAccuracy:Number(best.wf.minAccuracy.toFixed(4)),walkForwardRecentAccuracy:Number(best.wf.recentAccuracy.toFixed(4)),
      walkForwardWindows:best.wf.windows,topFeatures:topImportance(model),observations:[],
    };
    state.candidates.push(candidate);prune();save();
    log('shadow_v2_model_trained',{
      modelVersion:candidate.modelVersion,trainingMethod:candidate.trainingMethod,windowSize:candidate.windowSize,threshold:candidate.threshold,
      trainedSamples:train.length,validationSamples:best.wf.windows.reduce((z,x)=>z+x.validationSamples,0),
      validationAccuracy:candidate.validationAccuracy,validationBrier:candidate.validationBrier,baselineAccuracy:candidate.baselineAccuracy,
      walkForwardMinAccuracy:candidate.walkForwardMinAccuracy,walkForwardRecentAccuracy:candidate.walkForwardRecentAccuracy,
      topFeatures:candidate.topFeatures,
    });
    log('shadow_v2_candidate_registered',{modelVersion:candidate.modelVersion,targetSamples:forwardTarget,candidates:state.candidates.length});
    return candidateSummary(candidate);
  }
  function observe(row,facts){
    const round=Number(row?.roundStartMs); if(!Number.isFinite(round)||!facts)return;
    const x=vectorize(facts); if(!x)return; const sample={x,regime:regimeOf(facts)}; let changed=false;
    for(const c of state.candidates){const s=candidateSummary(c);if(s.forwardSamples>=forwardTarget)continue;if(round<Number(c.trainedAt||0))continue;if((c.observations||[]).some(o=>Number(o.roundStartMs)===round))continue;const p=predictEnsemble(c.model,sample);c.observations.push({roundStartMs:round,observedAt:Date.now(),probability:Number(p.toFixed(6)),actual:null,settledAt:null});changed=true;}
    if(changed)save();
  }
  function settle(row){
    if(row?.actual!=='UP'&&row?.actual!=='DOWN')return;const round=Number(row.roundStartMs);let changed=false;
    for(const c of state.candidates){const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);if(!o||o.actual)continue;o.actual=row.actual;o.settledAt=Date.now();changed=true;const s=candidateSummary(c);if(s.forwardSamples===forwardTarget||s.forwardSamples%10===0)log('shadow_v2_forward_progress',s);}
    if(changed)save();
  }
  function stats(){
    const candidates=state.candidates.map(candidateSummary).sort((a,b)=>Number(b.trainedAt)-Number(a.trainedAt));
    const completed=candidates.filter(x=>x.forwardSamples>=forwardTarget).sort((a,b)=>(b.forwardAccuracy??-1)-(a.forwardAccuracy??-1));
    return {ok:true,schemaVersion:1,trainingMethod:'ROLLING_GBDT_REGIME_PROGRESSIVE_V2',productionEffect:'NONE_SHADOW_ONLY',lastTrainRound:state.lastTrainRound||0,candidates,bestCompleted:completed[0]||null};
  }
  return {load,save,maybeTrain,observe,settle,stats};
}
