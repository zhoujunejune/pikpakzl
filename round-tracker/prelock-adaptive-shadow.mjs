import fs from 'node:fs';

const clip=(v,lo=-6,hi=6)=>Math.max(lo,Math.min(hi,Number(v)));
const sigmoid=z=>{
  if(z>=0){const e=Math.exp(-z);return 1/(1+e);}
  const e=Math.exp(z);return e/(1+e);
};

export function createPreLockAdaptiveShadow({
  file,
  version='PRELOCK_ADAPTIVE_SHADOW_V1',
  minTrainSamples=300,
  forwardTarget=60,
  targetAccuracy=0.72,
  minHoldoutPasses=12,
  log=()=>{},
}={}){
  let state={schemaVersion:1,model:null};

  function save(){
    if(!file)return;
    try{
      const tmp=file+'.tmp-'+process.pid;
      fs.writeFileSync(tmp,JSON.stringify(state),'utf8');
      fs.renameSync(tmp,file);
    }catch(e){
      log('prelock_adaptive_shadow_save_failed',{error:e?.message||String(e)});
    }
  }

  function load(){
    if(!file)return false;
    try{
      const p=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!p||typeof p!=='object')return false;
      state=p;
      log('prelock_adaptive_shadow_loaded',{
        modelVersion:state.model?.modelVersion??null,
        trainEndRound:state.model?.trainEndRound??null,
        confidenceThreshold:state.model?.confidenceThreshold??null,
      });
      return Boolean(state.model?.weights);
    }catch(e){
      if(e?.code!=='ENOENT')log('prelock_adaptive_shadow_load_failed',{error:e?.message||String(e)});
      return false;
    }
  }

  function rawVector(f){
    if(!f||typeof f!=='object')return null;
    const n=x=>Number.isFinite(Number(x))?Number(x):0;
    const upMid=Number.isFinite(Number(f.predictionMarketUpMid))?Number(f.predictionMarketUpMid):0.5;
    const align=String(f.alignment||'').toUpperCase();
    const regime=String(f.regimeDirection||'').toUpperCase();
    return [
      n(f.currentScore),
      n(f.liveScore),
      n(f.microScore),
      n(f.currentTrendScore),
      n(f.regimeScore),
      n(f.regimeAgreement),
      n(f.normalizedDistanceFromOpen),
      n(f.normalizedMomentum5s),
      n(f.normalizedMomentum15s),
      n(f.normalizedMomentum30s),
      n(f.normalizedMomentum60s),
      n(f.ofiNormalized5s),
      n(f.ofiNormalized60s),
      n(f.tradePressure5s),
      n(f.tradePressure15s),
      n(f.tradePressure60s),
      n(f.predictionMarketDepthImbalance5),
      (upMid-0.5)*2,
      align==='ALIGNED'?1:align==='COUNTERTREND'?-1:0,
      regime==='UP'?1:regime==='DOWN'?-1:0,
      String(f.volatilityRegime||'').toUpperCase()==='HIGH_VOL'?1:0,
      f.absorptionRisk===true?1:0,
      n(f.reversalScore),
      f.reversalStructureConfirmed===true?1:0,
      n(f.rangePosition180),
    ];
  }

  function fitScaler(samples){
    const d=samples[0].x.length;
    const mean=new Array(d).fill(0);
    const sd=new Array(d).fill(0);
    for(const s of samples)for(let j=0;j<d;j++)mean[j]+=s.x[j];
    for(let j=0;j<d;j++)mean[j]/=samples.length;
    for(const s of samples)for(let j=0;j<d;j++)sd[j]+=(s.x[j]-mean[j])**2;
    for(let j=0;j<d;j++)sd[j]=Math.sqrt(sd[j]/Math.max(1,samples.length-1))||1;
    return {mean,sd};
  }

  function transform(x,scaler){
    return x.map((v,j)=>clip((Number(v)-scaler.mean[j])/scaler.sd[j]));
  }

  function fit(samples){
    const d=samples[0].x.length;
    const w=new Array(d+1).fill(0);
    const lr=0.035,l2=0.04,epochs=420;
    for(let ep=0;ep<epochs;ep++){
      const g=new Array(d+1).fill(0);
      for(let i=0;i<samples.length;i++){
        const s=samples[i];
        let z=w[0];
        for(let j=0;j<d;j++)z+=w[j+1]*s.x[j];
        const p=sigmoid(z);
        const rec=0.65+0.35*((i+1)/samples.length);
        const err=(p-s.y)*rec;
        g[0]+=err;
        for(let j=0;j<d;j++)g[j+1]+=err*s.x[j];
      }
      w[0]-=lr*g[0]/samples.length;
      for(let j=1;j<w.length;j++)w[j]-=lr*(g[j]/samples.length+l2*w[j]);
    }
    return w;
  }

  function probability(model,facts){
    const raw=rawVector(facts);
    if(!raw||!model?.weights||!model?.scaler)return null;
    const x=transform(raw,model.scaler);
    let z=model.weights[0];
    for(let j=0;j<x.length;j++)z+=model.weights[j+1]*x[j];
    return sigmoid(z);
  }

  function directionFromP(p){
    return p>=0.5?'UP':'DOWN';
  }

  function confidenceFromP(p){
    return Math.max(p,1-p);
  }

  function safeAgainstMarket(direction,facts){
    if(facts?.absorptionRisk===true)return {ok:false,reason:'ABSORPTION_RISK'};
    const upMid=Number(facts?.predictionMarketUpMid);
    if(!Number.isFinite(upMid))return {ok:false,reason:'PREDICTION_MARKET_UNAVAILABLE'};
    if(direction==='UP'&&upMid<0.47)return {ok:false,reason:'PREDICTION_MARKET_CONFLICT'};
    if(direction==='DOWN'&&upMid>0.53)return {ok:false,reason:'PREDICTION_MARKET_CONFLICT'};
    return {ok:true,reason:null};
  }

  function buildSamples(rows){
    return (Array.isArray(rows)?rows:[])
      .filter(r=>(r?.actual==='UP'||r?.actual==='DOWN')&&r?.shadowFacts)
      .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs))
      .map(r=>{
        const x=rawVector(r.shadowFacts);
        if(!x)return null;
        return {
          round:Number(r.roundStartMs),
          x,
          y:r.actual==='UP'?1:0,
          baseWait:r.prediction!=='UP'&&r.prediction!=='DOWN',
          facts:r.shadowFacts,
        };
      }).filter(Boolean);
  }

  function selectThreshold(holdout,model){
    let best=null;
    for(let t=0.60;t<=0.92+1e-9;t+=0.01){
      const threshold=Number(t.toFixed(2));
      const candidates=[];
      for(const s of holdout){
        if(!s.baseWait)continue;
        const p=probability(model,s.facts);
        if(!Number.isFinite(p))continue;
        const dir=directionFromP(p);
        const safe=safeAgainstMarket(dir,s.facts);
        if(!safe.ok||confidenceFromP(p)<threshold)continue;
        candidates.push({hit:(dir==='UP'?1:0)===s.y});
      }
      const hits=candidates.filter(x=>x.hit).length;
      const n=candidates.length;
      const acc=n?hits/n:null;
      if(n<minHoldoutPasses||!Number.isFinite(acc)||acc<targetAccuracy)continue;
      if(!best||n>best.passed||(n===best.passed&&threshold<best.threshold)){
        best={threshold,passed:n,hits,accuracy:acc};
      }
    }
    return best;
  }

  function ensureModel(rows){
    if(state.model?.weights)return state.model;
    const samples=buildSamples(rows);
    if(samples.length<minTrainSamples){
      log('prelock_adaptive_shadow_collecting_training_data',{samples:samples.length,minTrainSamples});
      return null;
    }
    const holdoutN=Math.max(80,Math.min(180,Math.floor(samples.length*0.18)));
    const split=samples.length-holdoutN;
    if(split<minTrainSamples*0.7)return null;
    const trainRaw=samples.slice(0,split);
    const holdout=samples.slice(split);
    const scaler=fitScaler(trainRaw);
    const train=trainRaw.map(s=>({...s,x:transform(s.x,scaler)}));
    const weights=fit(train);
    const tempModel={weights,scaler};
    const selected=selectThreshold(holdout,tempModel);
    const threshold=selected?.threshold??0.82;

    let allCorrect=0,allN=0,waitPassed=0,waitHits=0,waitTotal=0;
    for(const s of holdout){
      const p=probability(tempModel,s.facts);
      if(!Number.isFinite(p))continue;
      const dir=directionFromP(p);
      allN++; if((dir==='UP'?1:0)===s.y)allCorrect++;
      if(s.baseWait){
        waitTotal++;
        const safe=safeAgainstMarket(dir,s.facts);
        if(safe.ok&&confidenceFromP(p)>=threshold){
          waitPassed++;
          if((dir==='UP'?1:0)===s.y)waitHits++;
        }
      }
    }

    const trainedAt=Date.now();
    state.model={
      version,
      modelVersion:version+'-'+trainedAt,
      trainedAt,
      trainEndRound:samples[samples.length-1]?.round??null,
      trainingSamples:train.length,
      holdoutSamples:holdout.length,
      weights,
      scaler,
      confidenceThreshold:threshold,
      thresholdSelection:selected?'WAIT_HOLDOUT_TARGET_ACCURACY':'SHADOW_DEFAULT_NO_SAFE_THRESHOLD',
      targetAccuracy,
      overallHoldoutAccuracy:allN?allCorrect/allN:null,
      waitHoldoutRounds:waitTotal,
      waitHoldoutPassed:waitPassed,
      waitHoldoutHits:waitHits,
      waitHoldoutAccuracy:waitPassed?waitHits/waitPassed:null,
      safety:{
        rejectAbsorption:true,
        requirePredictionMarket:true,
        predictionMarketConflictBand:0.03,
      },
    };
    save();
    log('prelock_adaptive_shadow_trained',{
      modelVersion:state.model.modelVersion,
      trainEndRound:state.model.trainEndRound,
      trainingSamples:state.model.trainingSamples,
      holdoutSamples:state.model.holdoutSamples,
      confidenceThreshold:state.model.confidenceThreshold,
      thresholdSelection:state.model.thresholdSelection,
      overallHoldoutAccuracy:state.model.overallHoldoutAccuracy,
      waitHoldoutRounds:state.model.waitHoldoutRounds,
      waitHoldoutPassed:state.model.waitHoldoutPassed,
      waitHoldoutAccuracy:state.model.waitHoldoutAccuracy,
      productionEffect:'NONE_SHADOW_ONLY',
    });
    return state.model;
  }

  function evaluate(row){
    const m=state.model;
    if(!m?.weights||!row?.shadowFacts)return null;
    const p=probability(m,row.shadowFacts);
    if(!Number.isFinite(p))return null;
    const direction=directionFromP(p);
    const confidence=confidenceFromP(p);
    const safe=safeAgainstMarket(direction,row.shadowFacts);
    const decision=safe.ok&&confidence>=m.confidenceThreshold?direction:'WAIT';
    const out={
      version,
      modelVersion:m.modelVersion,
      evaluatedAt:Date.now(),
      observationDelayMs:Number(row.shadowObservedAt||Date.now())-Number(row.roundStartMs),
      productionEffect:'NONE_SHADOW_ONLY',
      directionCandidate:direction,
      probabilityUp:Number(p.toFixed(4)),
      confidence:Number(confidence.toFixed(4)),
      threshold:m.confidenceThreshold,
      decision,
      safetyPass:safe.ok,
      waitReason:decision==='WAIT'?(safe.reason||'CONFIDENCE_BELOW_THRESHOLD'):null,
    };
    log('prelock_adaptive_shadow_evaluated',{
      round:row.roundStartMs,
      modelVersion:m.modelVersion,
      decision:out.decision,
      directionCandidate:out.directionCandidate,
      confidence:out.confidence,
      threshold:out.threshold,
      safetyPass:out.safetyPass,
      waitReason:out.waitReason,
      productionEffect:'NONE_SHADOW_ONLY',
    });
    return out;
  }

  function stats(rows){
    const m=state.model;
    if(!m?.weights)return {ok:true,version,status:'NO_MODEL',productionEffect:'NONE_SHADOW_ONLY',model:null};
    const settled=(Array.isArray(rows)?rows:[])
      .filter(r=>Number(r?.roundStartMs)>Number(m.trainEndRound||0)&&(r?.actual==='UP'||r?.actual==='DOWN'))
      .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
    const evaled=settled.filter(r=>r?.preLockAdaptiveShadow?.modelVersion===m.modelVersion);
    const decided=evaled.filter(r=>r.preLockAdaptiveShadow?.decision==='UP'||r.preLockAdaptiveShadow?.decision==='DOWN');
    const incremental=decided.filter(r=>r?.productionPrediction!=='UP'&&r?.productionPrediction!=='DOWN');
    const overlap=decided.filter(r=>r?.productionPrediction==='UP'||r?.productionPrediction==='DOWN');

    const sum=arr=>{
      const hits=arr.filter(r=>r.preLockAdaptiveShadow?.decision===r.actual).length;
      return {samples:arr.length,hits,misses:arr.length-hits,accuracy:arr.length?Number((hits/arr.length).toFixed(4)):null};
    };
    const d=sum(decided),inc=sum(incremental),ov=sum(overlap);
    return {
      ok:true,
      version,
      status:inc.samples>=forwardTarget?'FORWARD_COMPLETE':'FORWARD_COLLECTING',
      productionEffect:'NONE_SHADOW_ONLY',
      model:{
        modelVersion:m.modelVersion,
        trainedAt:m.trainedAt,
        trainEndRound:m.trainEndRound,
        trainingSamples:m.trainingSamples,
        holdoutSamples:m.holdoutSamples,
        confidenceThreshold:m.confidenceThreshold,
        thresholdSelection:m.thresholdSelection,
        targetAccuracy:m.targetAccuracy,
        overallHoldoutAccuracy:m.overallHoldoutAccuracy,
        waitHoldoutRounds:m.waitHoldoutRounds,
        waitHoldoutPassed:m.waitHoldoutPassed,
        waitHoldoutAccuracy:m.waitHoldoutAccuracy,
        safety:m.safety,
      },
      forwardTarget,
      settledForwardRounds:settled.length,
      evaluatedForwardRounds:evaled.length,
      allShadowDecisions:d,
      incrementalWaitRescues:inc,
      overlapWithProduction:ov,
      incrementalCoverage:settled.length?Number((inc.samples/settled.length).toFixed(4)):null,
      totalShadowCoverage:settled.length?Number((d.samples/settled.length).toFixed(4)):null,
      remainingIncrementalDecisions:Math.max(0,forwardTarget-inc.samples),
    };
  }

  function onSettled(row,rows){
    if(!state.model?.weights)return;
    if(row?.preLockAdaptiveShadow?.modelVersion!==state.model.modelVersion)return;
    if(row?.actual!=='UP'&&row?.actual!=='DOWN')return;
    const s=stats(rows);
    const n=Number(s.incrementalWaitRescues?.samples||0);
    if(n>0&&(n%5===0||n===forwardTarget)){
      log('prelock_adaptive_shadow_forward_progress',{
        modelVersion:state.model.modelVersion,
        incrementalSamples:n,
        targetSamples:forwardTarget,
        incrementalAccuracy:s.incrementalWaitRescues?.accuracy??null,
        incrementalCoverage:s.incrementalCoverage,
        allShadowSamples:s.allShadowDecisions?.samples??0,
        allShadowAccuracy:s.allShadowDecisions?.accuracy??null,
        overlapSamples:s.overlapWithProduction?.samples??0,
        remainingIncrementalDecisions:s.remainingIncrementalDecisions,
        productionEffect:'NONE_SHADOW_ONLY',
      });
    }
  }

  return {load,ensureModel,evaluate,stats,onSettled};
}
