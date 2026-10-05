import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ENGINE_VERSION='RIVER_ARF_PREQUENTIAL_V4';

function atomicWrite(file,obj){
  const tmp=`${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp,JSON.stringify(obj),'utf8');
  fs.renameSync(tmp,file);
}

function runPython(args,input=null,timeoutMs=90000){
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['shadow-v4.py',...args],{cwd:new URL('.',import.meta.url).pathname});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('SHADOW_V4_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',d=>out+=String(d));
    child.stderr.on('data',d=>err+=String(d));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0) return reject(new Error(`SHADOW_V4_EXIT_${code}: ${err.slice(-1200)}`));
      const line=out.split(/\r?\n/).find(x=>x.startsWith('SHADOW_V4_RESULT='));
      if(!line) return reject(new Error('SHADOW_V4_NO_RESULT'));
      try{resolve(JSON.parse(line.slice('SHADOW_V4_RESULT='.length)));}
      catch(e){reject(new Error('SHADOW_V4_BAD_JSON: '+e.message));}
    });
    if(input!=null) child.stdin.end(JSON.stringify(input)); else child.stdin.end();
  });
}

export function createShadowV4Client({
  historyFile,
  dir,
  minSamples=300,
  forwardTarget=60,
  maxCandidates=4,
  trainEveryRounds=60,
  log=()=>{},
}={}){
  const registryFile=`${dir}/registry.json`;
  let state={schemaVersion:1,engineVersion:ENGINE_VERSION,lastAttemptRound:0,candidates:[]};
  let trainingBusy=false;
  const predicting=new Set();
  const learning=new Set();

  function save(){
    try{fs.mkdirSync(dir,{recursive:true});atomicWrite(registryFile,state);}
    catch(e){log('shadow_v4_save_failed',{error:e?.message||String(e)});}
  }

  function summaryOf(c){
    const settled=(c.observations||[]).filter(o=>(o.actual==='UP'||o.actual==='DOWN')&&Number.isFinite(Number(o.probability)));
    let hits=0,brier=0,streak=0,maxStreak=0;
    for(const o of settled){
      const p=Number(o.probability),pred=p>=0.5?'UP':'DOWN',y=o.actual==='UP'?1:0;
      if(pred===o.actual) streak=0; else {streak++;maxStreak=Math.max(maxStreak,streak);}
      hits+=pred===o.actual?1:0;brier+=(p-y)**2;
    }
    const n=settled.length,acc=n?hits/n:null,recent=settled.slice(-20);
    const recentHits=recent.filter(o=>(Number(o.probability)>=.5?'UP':'DOWN')===o.actual).length;
    let status=n<forwardTarget?'COLLECTING':'FORWARD_COMPLETE';
    if(n>=20&&acc<.65) status='RETIRED_LOW_ACCURACY';
    else if(n>=forwardTarget&&acc>=.70) status='FORWARD_70_MET';
    return {
      modelVersion:c.modelVersion,engineVersion:ENGINE_VERSION,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      trainedSamples:c.trainedSamples,selectedConfig:c.selectedConfig,outerHoldout:c.outerHoldout,
      forwardSamples:n,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-n),
      hits,misses:n-hits,forwardAccuracy:n?Number(acc.toFixed(4)):null,
      forwardBrier:n?Number((brier/n).toFixed(4)):null,
      recent20Accuracy:recent.length?Number((recentHits/recent.length).toFixed(4)):null,
      maxConsecutiveErrors:maxStreak,warnings:c.warnings||0,drifts:c.drifts||0,status
    };
  }

  function deleteRetiredCandidates(){
    const removed=[];
    state.candidates=state.candidates.filter(c=>{
      const s=summaryOf(c);
      if(!(s.forwardSamples>=20&&Number.isFinite(Number(s.forwardAccuracy))&&Number(s.forwardAccuracy)<.65)) return true;
      try{if(c.modelPath&&fs.existsSync(c.modelPath))fs.unlinkSync(c.modelPath);}catch{}
      removed.push({...s,modelPath:c.modelPath||null,reason:'STRICT_FORWARD_BELOW_65_AFTER_20'});
      return false;
    });
    if(removed.length){save();log('shadow_v4_retired_models_deleted',{count:removed.length,models:removed});}
    return removed;
  }

  function load(){
    try{
      fs.mkdirSync(dir,{recursive:true});
      const p=JSON.parse(fs.readFileSync(registryFile,'utf8'));
      if(p?.schemaVersion===1&&Array.isArray(p?.candidates)) state=p;
      state.engineVersion=ENGINE_VERSION;deleteRetiredCandidates();
      log('shadow_v4_registry_loaded',{candidates:state.candidates.length,lastAttemptRound:state.lastAttemptRound||0});
      return true;
    }catch(e){if(e?.code!=='ENOENT')log('shadow_v4_load_failed',{error:e?.message||String(e)});return false;}
  }

  async function maybeTrain(latestRound=0){
    const round=Number(latestRound||0);
    if(trainingBusy) return null;
    if(round>0&&Number(state.lastAttemptRound||0)>0&&round-Number(state.lastAttemptRound)<trainEveryRounds*300000) return null;
    trainingBusy=true;
    try{
      const r=await runPython(['train','--history',historyFile,'--out-dir',dir,'--min-samples',String(minSamples)],null,120000);
      if(round>0) state.lastAttemptRound=round; else if(r?.lastTrainRound) state.lastAttemptRound=Number(r.lastTrainRound);
      if(r?.status==='CANDIDATE_REGISTERED'&&r?.modelVersion&&r?.modelPath){
        state.candidates.push({
          modelVersion:r.modelVersion,trainedAt:r.trainedAt,lastTrainRound:r.lastTrainRound,trainedSamples:r.trainedSamples,
          modelPath:r.modelPath,selectedConfig:r.selectedConfig||null,selection:r.selection||null,outerHoldout:r.outerHoldout||null,
          observations:[],warnings:0,drifts:0
        });
        while(state.candidates.length>maxCandidates){
          const old=state.candidates.shift();
          try{if(old?.modelPath&&fs.existsSync(old.modelPath))fs.unlinkSync(old.modelPath);}catch{}
        }
        log('shadow_v4_candidate_registered',{modelVersion:r.modelVersion,trainedAt:r.trainedAt,selectedConfig:r.selectedConfig,outerHoldout:r.outerHoldout});
      }else if(r?.status==='REJECTED_BEFORE_FORWARD'){
        log('shadow_v4_candidate_rejected_before_forward',r);
      }else{
        log('shadow_v4_training_result',r||{});
      }
      save();return r;
    }catch(e){log('shadow_v4_training_failed',{error:e?.message||String(e)});return null;}
    finally{trainingBusy=false;}
  }

  async function observe(row,facts){
    const round=Number(row?.roundStartMs);
    if(!Number.isFinite(round)||!facts) return;
    for(const c of state.candidates){
      if(summaryOf(c).forwardSamples>=forwardTarget||round<=Number(c.lastTrainRound||0)) continue;
      if((c.observations||[]).some(o=>Number(o.roundStartMs)===round)) continue;
      const key=`${c.modelVersion}:${round}`;if(predicting.has(key))continue;predicting.add(key);
      try{
        const r=await runPython(['predict'],{modelPath:c.modelPath,facts},60000);
        if(r?.ok&&Number.isFinite(Number(r.probability))){
          c.observations.push({roundStartMs:round,observedAt:Number(row.shadowObservedAt||Date.now()),probability:Number(r.probability),actual:null,settledAt:null,learned:false});
          c.warnings=Number(r.warnings||0);c.drifts=Number(r.drifts||0);save();
          log('shadow_v4_prediction_ready',{modelVersion:c.modelVersion,round,probability:Number(r.probability),direction:Number(r.probability)>=.5?'UP':'DOWN',warnings:c.warnings,drifts:c.drifts});
        }
      }catch(e){log('shadow_v4_prediction_failed',{modelVersion:c.modelVersion,round,error:e?.message||String(e)});}
      finally{predicting.delete(key);}
    }
  }

  async function settle(row){
    const round=Number(row?.roundStartMs),actual=row?.actual;
    if(!Number.isFinite(round)||(actual!=='UP'&&actual!=='DOWN')) return;
    for(const c of state.candidates){
      const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);
      if(!o) continue;
      o.actual=actual;o.settledAt=Number(row.settledAt||Date.now());
      const key=`${c.modelVersion}:${round}`;
      if(!o.learned&&!learning.has(key)){
        learning.add(key);
        try{
          const r=await runPython(['learn'],{modelPath:c.modelPath,facts:row.shadowFacts,actual},60000);
          if(r?.ok){o.learned=true;c.warnings=Number(r.warnings||0);c.drifts=Number(r.drifts||0);}
        }catch(e){log('shadow_v4_learn_failed',{modelVersion:c.modelVersion,round,error:e?.message||String(e)});}
        finally{learning.delete(key);}
      }
      const s=summaryOf(c);
      if(s.forwardSamples===forwardTarget||s.forwardSamples%10===0) log('shadow_v4_forward_progress',s);
    }
    save();deleteRetiredCandidates();
  }

  function stats(){
    const candidates=state.candidates.map(summaryOf).sort((a,b)=>Number(b.trainedAt)-Number(a.trainedAt));
    return {ok:true,engineVersion:ENGINE_VERSION,trainingBusy,lastAttemptRound:state.lastAttemptRound||0,candidates,bestCompleted:candidates.filter(c=>c.forwardSamples>=forwardTarget).sort((a,b)=>(b.forwardAccuracy||0)-(a.forwardAccuracy||0))[0]||null};
  }

  return {load,save,maybeTrain,observe,settle,deleteRetiredCandidates,stats};
}
