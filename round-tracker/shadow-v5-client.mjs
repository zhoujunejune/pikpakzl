import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ENGINE_VERSION='AEON_MINIROCKET_SEQUENCE_V5';

function atomicWrite(file,obj){
  const tmp=`${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp,JSON.stringify(obj),'utf8');
  fs.renameSync(tmp,file);
}

function runPython(args,input=null,timeoutMs=120000){
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['shadow-v5.py',...args],{cwd:new URL('.',import.meta.url).pathname});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('SHADOW_V5_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',d=>out+=String(d));
    child.stderr.on('data',d=>err+=String(d));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0) return reject(new Error(`SHADOW_V5_EXIT_${code}: ${err.slice(-1800)}`));
      const line=out.split(/\r?\n/).find(x=>x.startsWith('SHADOW_V5_RESULT='));
      if(!line) return reject(new Error('SHADOW_V5_NO_RESULT: '+err.slice(-1200)));
      try{resolve(JSON.parse(line.slice('SHADOW_V5_RESULT='.length)));}
      catch(e){reject(new Error('SHADOW_V5_BAD_JSON: '+e.message));}
    });
    if(input!=null) child.stdin.end(JSON.stringify(input)); else child.stdin.end();
  });
}

export function createShadowV5Client({
  historyFile,dir,minSamples=300,forwardTarget=60,maxCandidates=4,trainEveryRounds=60,log=()=>{},
}={}){
  const registryFile=`${dir}/registry.json`;
  let state={schemaVersion:1,engineVersion:ENGINE_VERSION,lastAttemptRound:0,candidates:[]};
  let trainingBusy=false;
  const predicting=new Set();

  function save(){
    try{fs.mkdirSync(dir,{recursive:true});atomicWrite(registryFile,state);}
    catch(e){log('shadow_v5_save_failed',{error:e?.message||String(e)});}
  }

  function summaryOf(c){
    const settled=(c.observations||[]).filter(o=>(o.actual==='UP'||o.actual==='DOWN')&&Number.isFinite(Number(o.probability)));
    let hits=0,brier=0,streak=0,maxStreak=0;
    for(const o of settled){
      const p=Number(o.probability),t=Number(c.threshold??0.5),pred=p>=t?'UP':'DOWN',y=o.actual==='UP'?1:0;
      if(pred===o.actual)streak=0;else{streak++;maxStreak=Math.max(maxStreak,streak);}
      hits+=pred===o.actual?1:0;brier+=(p-y)**2;
    }
    const n=settled.length,acc=n?hits/n:null,recent=settled.slice(-20);
    const recentHits=recent.filter(o=>(Number(o.probability)>=Number(c.threshold??0.5)?'UP':'DOWN')===o.actual).length;
    let status=n<forwardTarget?'COLLECTING':'FORWARD_COMPLETE';
    if(n>=20&&acc<.65)status='RETIRED_LOW_ACCURACY';
    else if(n>=forwardTarget&&acc>=.70)status='FORWARD_70_MET';
    return {
      modelVersion:c.modelVersion,engineVersion:ENGINE_VERSION,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      trainedSamples:c.trainedSamples,contextRounds:c.contextRounds,C:c.C,threshold:c.threshold,
      validation:c.validation||null,outerHoldout:c.outerHoldout||null,
      forwardSamples:n,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-n),
      hits,misses:n-hits,forwardAccuracy:n?Number(acc.toFixed(4)):null,
      forwardBrier:n?Number((brier/n).toFixed(4)):null,
      recent20Accuracy:recent.length?Number((recentHits/recent.length).toFixed(4)):null,
      maxConsecutiveErrors:maxStreak,status
    };
  }

  function deleteRetiredCandidates(){
    const removed=[];
    state.candidates=state.candidates.filter(c=>{
      const s=summaryOf(c);
      if(!(s.forwardSamples>=20&&Number.isFinite(Number(s.forwardAccuracy))&&Number(s.forwardAccuracy)<.65))return true;
      try{if(c.modelPath&&fs.existsSync(c.modelPath))fs.unlinkSync(c.modelPath);}catch{}
      removed.push({...s,modelPath:c.modelPath||null,reason:'STRICT_FORWARD_BELOW_65_AFTER_20'});
      return false;
    });
    if(removed.length){save();log('shadow_v5_retired_models_deleted',{count:removed.length,models:removed});}
    return removed;
  }

  function load(){
    try{
      fs.mkdirSync(dir,{recursive:true});
      const p=JSON.parse(fs.readFileSync(registryFile,'utf8'));
      if(p?.schemaVersion===1&&Array.isArray(p?.candidates))state=p;
      state.engineVersion=ENGINE_VERSION;deleteRetiredCandidates();
      log('shadow_v5_registry_loaded',{candidates:state.candidates.length,lastAttemptRound:state.lastAttemptRound||0});
      return true;
    }catch(e){if(e?.code!=='ENOENT')log('shadow_v5_load_failed',{error:e?.message||String(e)});return false;}
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
          modelPath:r.modelPath,contextRounds:r.contextRounds,C:r.C,threshold:r.threshold,
          validation:r.validation||null,outerHoldout:r.outerHoldout||null,observations:[]
        });
        while(state.candidates.length>maxCandidates){
          const old=state.candidates.shift();try{if(old?.modelPath&&fs.existsSync(old.modelPath))fs.unlinkSync(old.modelPath);}catch{}
        }
        log('shadow_v5_candidate_registered',{modelVersion:r.modelVersion,trainedAt:r.trainedAt,contextRounds:r.contextRounds,C:r.C,threshold:r.threshold,outerHoldout:r.outerHoldout});
      }else if(r?.status==='REJECTED_BEFORE_FORWARD'){
        log('shadow_v5_candidate_rejected_before_forward',r);
      }else log('shadow_v5_training_result',r||{});
      save();return r;
    }catch(e){log('shadow_v5_training_failed',{error:e?.message||String(e)});return null;}
    finally{trainingBusy=false;}
  }

  async function observe(row){
    const round=Number(row?.roundStartMs);
    if(!Number.isFinite(round))return;
    for(const c of state.candidates){
      if(summaryOf(c).forwardSamples>=forwardTarget||round<=Number(c.lastTrainRound||0))continue;
      if((c.observations||[]).some(o=>Number(o.roundStartMs)===round))continue;
      const key=`${c.modelVersion}:${round}`;if(predicting.has(key))continue;predicting.add(key);
      try{
        const r=await runPython(['predict','--history',historyFile],{modelPath:c.modelPath,roundStartMs:round},90000);
        if(r?.ok&&Number.isFinite(Number(r.probability))){
          c.observations.push({roundStartMs:round,observedAt:Number(row.shadowObservedAt||Date.now()),probability:Number(r.probability),actual:null,settledAt:null});
          save();
          log('shadow_v5_prediction_ready',{modelVersion:c.modelVersion,round,probability:Number(r.probability),threshold:Number(c.threshold??0.5),direction:Number(r.probability)>=Number(c.threshold??0.5)?'UP':'DOWN',contextRounds:c.contextRounds});
        }
      }catch(e){log('shadow_v5_prediction_failed',{modelVersion:c.modelVersion,round,error:e?.message||String(e)});}
      finally{predicting.delete(key);}
    }
  }

  function settle(row){
    const round=Number(row?.roundStartMs),actual=row?.actual;
    if(!Number.isFinite(round)||(actual!=='UP'&&actual!=='DOWN'))return;
    for(const c of state.candidates){
      const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);
      if(!o)continue;o.actual=actual;o.settledAt=Number(row.settledAt||Date.now());
      const s=summaryOf(c);
      if(s.forwardSamples===forwardTarget||s.forwardSamples%10===0)log('shadow_v5_forward_progress',s);
    }
    save();deleteRetiredCandidates();
  }

  function stats(){
    const candidates=state.candidates.map(summaryOf).sort((a,b)=>Number(b.trainedAt)-Number(a.trainedAt));
    return {ok:true,engineVersion:ENGINE_VERSION,library:'aeon.MiniRocket',trainingBusy,lastAttemptRound:state.lastAttemptRound||0,candidates,bestCompleted:candidates.filter(c=>c.forwardSamples>=forwardTarget).sort((a,b)=>(b.forwardAccuracy||0)-(a.forwardAccuracy||0))[0]||null};
  }
  return {load,save,maybeTrain,observe,settle,deleteRetiredCandidates,stats};
}
