import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ENGINE_VERSION='MAPIE_RIVER_ARF_SELECTIVE_V7';

function atomicWrite(file,obj){
  const tmp=`${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp,JSON.stringify(obj),'utf8');
  fs.renameSync(tmp,file);
}

function runPython(args,input=null,timeoutMs=120000){
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['shadow-v7.py',...args],{cwd:new URL('.',import.meta.url).pathname});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('SHADOW_V7_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',d=>out+=String(d));
    child.stderr.on('data',d=>err+=String(d));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(new Error(`SHADOW_V7_EXIT_${code}: ${err.slice(-1800)}`));
      const line=out.split(/\r?\n/).find(x=>x.startsWith('SHADOW_V7_RESULT='));
      if(!line)return reject(new Error('SHADOW_V7_NO_RESULT: '+err.slice(-1200)));
      try{resolve(JSON.parse(line.slice('SHADOW_V7_RESULT='.length)));}
      catch(e){reject(new Error('SHADOW_V7_BAD_JSON: '+e.message));}
    });
    if(input!=null)child.stdin.end(JSON.stringify(input));else child.stdin.end();
  });
}

export function createShadowV7Client({
  historyFile,dir,minSamples=300,forwardTarget=60,maxCandidates=4,trainEveryRounds=60,log=()=>{},
}={}){
  const registryFile=`${dir}/registry.json`;
  let state={schemaVersion:1,engineVersion:ENGINE_VERSION,lastAttemptRound:0,candidates:[]};
  let trainingBusy=false;
  const predicting=new Set(),learning=new Set();

  function save(){
    try{fs.mkdirSync(dir,{recursive:true});atomicWrite(registryFile,state);}
    catch(e){log('shadow_v7_save_failed',{error:e?.message||String(e)});}
  }

  function summaryOf(c){
    const settled=(c.observations||[]).filter(o=>(o.actual==='UP'||o.actual==='DOWN')&&Number.isFinite(Number(o.probability)));
    const decided=settled.filter(o=>o.direction==='UP'||o.direction==='DOWN');
    let hits=0,streak=0,maxStreak=0;
    for(const o of decided){
      if(o.direction===o.actual){hits++;streak=0;}else{streak++;maxStreak=Math.max(maxStreak,streak);}
    }
    const rounds=settled.length,n=decided.length,acc=n?hits/n:null,coverage=rounds?n/rounds:null;
    const recent=decided.slice(-20),recentHits=recent.filter(o=>o.direction===o.actual).length;
    const up=decided.filter(o=>o.direction==='UP'),down=decided.filter(o=>o.direction==='DOWN');
    const upHits=up.filter(o=>o.actual==='UP').length,downHits=down.filter(o=>o.actual==='DOWN').length;
    let status='COLLECTING';
    if(n>=20&&Number.isFinite(acc)&&acc<.65)status='RETIRED_LOW_ACCURACY';
    else if(rounds>=40&&Number.isFinite(coverage)&&coverage<.20)status='RETIRED_LOW_COVERAGE';
    else if(n>=forwardTarget&&acc>=.70&&coverage>=.25)status='FORWARD_70_MET';
    else if(n>=forwardTarget)status='FORWARD_COMPLETE';
    return {
      modelVersion:c.modelVersion,engineVersion:ENGINE_VERSION,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      trainedSamples:c.trainedSamples,selectedConfig:c.selectedConfig||null,thresholds:c.thresholds||null,
      calibration:c.calibration||null,outerHoldout:c.outerHoldout||null,
      forwardRounds:rounds,forwardSamples:n,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-n),
      hits,misses:n-hits,forwardAccuracy:n?Number(acc.toFixed(4)):null,
      coverage:rounds?Number(coverage.toFixed(4)):null,waitRounds:rounds-n,
      recent20Accuracy:recent.length?Number((recentHits/recent.length).toFixed(4)):null,
      upDecisions:up.length,upPrecision:up.length?Number((upHits/up.length).toFixed(4)):null,
      downDecisions:down.length,downPrecision:down.length?Number((downHits/down.length).toFixed(4)):null,
      maxConsecutiveErrors:maxStreak,warnings:c.warnings||0,drifts:c.drifts||0,status
    };
  }

  function deleteRetiredCandidates(){
    const removed=[];
    state.candidates=state.candidates.filter(c=>{
      const s=summaryOf(c);
      const lowAccuracy=s.forwardSamples>=20&&Number.isFinite(Number(s.forwardAccuracy))&&Number(s.forwardAccuracy)<.65;
      const lowCoverage=s.forwardRounds>=40&&Number.isFinite(Number(s.coverage))&&Number(s.coverage)<.20;
      if(!lowAccuracy&&!lowCoverage)return true;
      try{if(c.modelPath&&fs.existsSync(c.modelPath))fs.unlinkSync(c.modelPath);}catch{}
      removed.push({...s,modelPath:c.modelPath||null,reason:lowAccuracy?'STRICT_FORWARD_BELOW_65_AFTER_20_DECISIONS':'STRICT_FORWARD_COVERAGE_BELOW_20_AFTER_40_ROUNDS'});
      return false;
    });
    if(removed.length){save();log('shadow_v7_retired_models_deleted',{count:removed.length,models:removed});}
    return removed;
  }

  function load(){
    try{
      fs.mkdirSync(dir,{recursive:true});
      const p=JSON.parse(fs.readFileSync(registryFile,'utf8'));
      if(p?.schemaVersion===1&&Array.isArray(p?.candidates))state=p;
      state.engineVersion=ENGINE_VERSION;deleteRetiredCandidates();
      log('shadow_v7_registry_loaded',{candidates:state.candidates.length,lastAttemptRound:state.lastAttemptRound||0});
      return true;
    }catch(e){if(e?.code!=='ENOENT')log('shadow_v7_load_failed',{error:e?.message||String(e)});return false;}
  }

  async function maybeTrain(latestRound=0){
    const round=Number(latestRound||0);
    if(trainingBusy)return null;
    if(round>0&&Number(state.lastAttemptRound||0)>0&&round-Number(state.lastAttemptRound)<trainEveryRounds*300000)return null;
    trainingBusy=true;
    try{
      const r=await runPython(['train','--history',historyFile,'--out-dir',dir,'--min-samples',String(minSamples)],null,180000);
      if(round>0)state.lastAttemptRound=round;else if(r?.lastTrainRound)state.lastAttemptRound=Number(r.lastTrainRound);
      if(r?.status==='CANDIDATE_REGISTERED'&&r?.modelVersion&&r?.modelPath){
        state.candidates.push({
          modelVersion:r.modelVersion,trainedAt:r.trainedAt,lastTrainRound:r.lastTrainRound,trainedSamples:r.trainedSamples,
          modelPath:r.modelPath,selectedConfig:r.selectedConfig||null,thresholds:r.thresholds||null,
          calibration:r.calibration||null,outerHoldout:r.outerHoldout||null,observations:[],warnings:0,drifts:0
        });
        while(state.candidates.length>maxCandidates){
          const old=state.candidates.shift();
          try{if(old?.modelPath&&fs.existsSync(old.modelPath))fs.unlinkSync(old.modelPath);}catch{}
        }
        log('shadow_v7_candidate_registered',{
          modelVersion:r.modelVersion,trainedAt:r.trainedAt,thresholds:r.thresholds,
          outerHoldout:r.outerHoldout,selectedConfig:r.selectedConfig
        });
      }else if(r?.status==='REJECTED_BEFORE_FORWARD'){
        log('shadow_v7_candidate_rejected_before_forward',r);
      }else log('shadow_v7_training_result',r||{});
      save();return r;
    }catch(e){log('shadow_v7_training_failed',{error:e?.message||String(e)});return null;}
    finally{trainingBusy=false;}
  }

  async function observe(row,facts){
    const round=Number(row?.roundStartMs);
    if(!Number.isFinite(round)||!facts)return;
    for(const c of state.candidates){
      if(round<=Number(c.lastTrainRound||0))continue;
      if((c.observations||[]).some(o=>Number(o.roundStartMs)===round))continue;
      const key=`${c.modelVersion}:${round}`;if(predicting.has(key))continue;predicting.add(key);
      try{
        const r=await runPython(['predict'],{modelPath:c.modelPath,facts},60000);
        if(r?.ok&&Number.isFinite(Number(r.probability))){
          const direction=['UP','DOWN','WAIT'].includes(r.direction)?r.direction:'WAIT';
          c.observations.push({
            roundStartMs:round,observedAt:Number(row.shadowObservedAt||Date.now()),
            probability:Number(r.probability),direction,actual:null,settledAt:null,learned:false
          });
          c.warnings=Number(r.warnings||0);c.drifts=Number(r.drifts||0);save();
          log('shadow_v7_prediction_ready',{
            modelVersion:c.modelVersion,round,probability:Number(r.probability),direction,
            lowerThreshold:Number(r.lowerThreshold),upperThreshold:Number(r.upperThreshold),
            warnings:c.warnings,drifts:c.drifts
          });
        }
      }catch(e){log('shadow_v7_prediction_failed',{modelVersion:c.modelVersion,round,error:e?.message||String(e)});}
      finally{predicting.delete(key);}
    }
  }

  async function settle(row){
    const round=Number(row?.roundStartMs),actual=row?.actual;
    if(!Number.isFinite(round)||(actual!=='UP'&&actual!=='DOWN'))return;
    for(const c of [...state.candidates]){
      const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);
      if(!o)continue;
      o.actual=actual;o.settledAt=Number(row.settledAt||Date.now());
      const key=`${c.modelVersion}:${round}`;
      if(!o.learned&&!learning.has(key)){
        learning.add(key);
        try{
          const r=await runPython(['learn'],{modelPath:c.modelPath,facts:row.shadowFacts,actual},60000);
          if(r?.ok){o.learned=true;c.warnings=Number(r.warnings||0);c.drifts=Number(r.drifts||0);}
        }catch(e){log('shadow_v7_learn_failed',{modelVersion:c.modelVersion,round,error:e?.message||String(e)});}
        finally{learning.delete(key);}
      }
      const s=summaryOf(c);
      if(s.forwardSamples>0&&s.forwardSamples%10===0)log('shadow_v7_forward_progress',s);
      else if(s.forwardRounds>0&&s.forwardRounds%20===0)log('shadow_v7_forward_progress',s);
    }
    save();deleteRetiredCandidates();
  }

  function stats(){
    const candidates=state.candidates.map(summaryOf).sort((a,b)=>Number(b.trainedAt)-Number(a.trainedAt));
    return {
      ok:true,engineVersion:ENGINE_VERSION,
      library:'MAPIE.BinaryClassificationController+river.ARFClassifier',
      productionEffect:'NONE_SHADOW_ONLY',trainingBusy,lastAttemptRound:state.lastAttemptRound||0,
      candidates,
      bestCompleted:candidates.filter(c=>c.forwardSamples>=forwardTarget&&c.coverage>=.25)
        .sort((a,b)=>(b.forwardAccuracy||0)-(a.forwardAccuracy||0))[0]||null
    };
  }

  return {load,save,maybeTrain,observe,settle,deleteRetiredCandidates,stats};
}
