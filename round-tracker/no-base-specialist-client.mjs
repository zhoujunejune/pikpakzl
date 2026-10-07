import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE_VERSION='NO_BASE_SPECIALIST_AUTOML_V1';
const PYTHON=process.env.NO_BASE_SPECIALIST_PYTHON||'python3';
const SCRIPT=fileURLToPath(new URL('./no-base-specialist.py',import.meta.url));

function atomicWrite(file,value){
  const tmp=`${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp,JSON.stringify(value),'utf8'); fs.renameSync(tmp,file);
}
function runPython(args,input=null,timeoutMs=240000){
  return new Promise((resolve,reject)=>{
    const child=spawn(PYTHON,[SCRIPT,...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1'}});
    let stdout='',stderr='',done=false;
    const timer=setTimeout(()=>{if(done)return;child.kill('SIGKILL');reject(new Error('NO_BASE_SPECIALIST_PYTHON_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',d=>stdout+=d.toString()); child.stderr.on('data',d=>stderr+=d.toString());
    child.on('error',err=>{if(done)return;done=true;clearTimeout(timer);reject(err);});
    child.on('close',code=>{
      if(done)return;done=true;clearTimeout(timer);
      const line=stdout.split(/\r?\n/).reverse().find(x=>x.startsWith('NO_BASE_SPECIALIST_RESULT='));
      if(code!==0||!line)return reject(new Error(`NO_BASE_SPECIALIST_PYTHON_FAILED code=${code} stderr=${stderr.slice(-2000)} stdout=${stdout.slice(-1000)}`));
      try{resolve(JSON.parse(line.slice('NO_BASE_SPECIALIST_RESULT='.length)));}
      catch(e){reject(new Error(`NO_BASE_SPECIALIST_BAD_JSON: ${e.message}`));}
    });
    if(input!=null)child.stdin.end(JSON.stringify(input));else child.stdin.end();
  });
}

export function createNoBaseSpecialistClient({
  historyFile,dir,minSamples=120,forwardTarget=60,maxCandidates=6,trainEveryRounds=20,trainTimeBudget=60,log=()=>{},
}={}){
  const registryFile=`${dir}/registry.json`;
  let state={schemaVersion:1,engineVersion:ENGINE_VERSION,lastAttemptRound:0,candidates:[]};
  let trainingBusy=false; const predictingRounds=new Set();

  function save(){try{fs.mkdirSync(dir,{recursive:true});atomicWrite(registryFile,state);}catch(e){log('no_base_specialist_save_failed',{error:e?.message||String(e)});}}
  function load(){try{fs.mkdirSync(dir,{recursive:true});const x=JSON.parse(fs.readFileSync(registryFile,'utf8'));if(x?.schemaVersion===1&&Array.isArray(x?.candidates))state=x;state.engineVersion=ENGINE_VERSION;deleteRetiredCandidates();log('no_base_specialist_registry_loaded',{candidates:state.candidates.length,lastAttemptRound:state.lastAttemptRound||0});return true;}catch(e){if(e?.code!=='ENOENT')log('no_base_specialist_load_failed',{error:e?.message||String(e)});return false;}}
  const decidedFor=(c,o)=>{const p=Number(o?.probability),t=Number(c?.confidenceThreshold??0.75);if(!Number.isFinite(p))return null;if(p>=t)return'UP';if(p<=1-t)return'DOWN';return null;};
  function summaryOf(c){
    const observed=(c.observations||[]).filter(o=>!o.excludedReason&&(o.actual==='UP'||o.actual==='DOWN')&&Number.isFinite(Number(o.probability)));
    const decided=observed.filter(o=>decidedFor(c,o));
    let hits=0,streak=0,maxStreak=0;
    for(const o of decided){const ok=decidedFor(c,o)===o.actual;if(ok){hits++;streak=0;}else{streak++;maxStreak=Math.max(maxStreak,streak);}}
    const recent20=decided.slice(-20);const recentHits=recent20.filter(o=>decidedFor(c,o)===o.actual).length;
    const n=decided.length,acc=n?hits/n:null,coverage=observed.length?n/observed.length:null;
    let status=n<forwardTarget?'COLLECTING':'FORWARD_COMPLETE';
    if(n>=forwardTarget&&acc>=0.70&&recent20.length>=20&&recentHits/recent20.length>=0.70)status='QUALIFIED_FOR_REVIEW';
    else if(n>=20&&acc<0.65)status='RETIRED_LOW_ACCURACY';
    return {
      modelVersion:c.modelVersion,engineVersion:c.engineVersion,trainedAt:c.trainedAt,lastTrainRound:c.lastTrainRound,
      trainedSamples:c.trainedSamples,windowSize:c.windowSize,estimator:c.bestEstimator,
      confidenceThreshold:c.confidenceThreshold,outerHoldout:c.outerHoldout||null,sourceMix:c.sourceMix||null,
      observedStrictForward:observed.length,strictForwardSamples:n,targetSamples:forwardTarget,remainingSamples:Math.max(0,forwardTarget-n),
      hits,misses:n-hits,forwardAccuracy:n?Number(acc.toFixed(4)):null,recent20Accuracy:recent20.length?Number((recentHits/recent20.length).toFixed(4)):null,
      incrementalCoverage:Number.isFinite(coverage)?Number(coverage.toFixed(4)):null,maxConsecutiveErrors:maxStreak,status,
    };
  }
  function deleteRetiredCandidates(){
    const removed=[];state.candidates=state.candidates.filter(c=>{const s=summaryOf(c);if(s.status!=='RETIRED_LOW_ACCURACY')return true;
      try{if(c.modelPath&&fs.existsSync(c.modelPath))fs.unlinkSync(c.modelPath);}catch{}
      removed.push({modelVersion:c.modelVersion,strictForwardSamples:s.strictForwardSamples,forwardAccuracy:s.forwardAccuracy,reason:'STRICT_FORWARD_BELOW_65_AFTER_20'});return false;});
    if(removed.length){save();log('no_base_specialist_retired_models_deleted',{count:removed.length,models:removed});}return removed;
  }
  function prune(){while(state.candidates.length>maxCandidates){const [r]=state.candidates.splice(0,1);try{if(r?.modelPath&&fs.existsSync(r.modelPath))fs.unlinkSync(r.modelPath);}catch{}log('no_base_specialist_candidate_pruned',{modelVersion:r?.modelVersion||null});}}
  async function maybeTrain(latestRound=0){
    const round=Number(latestRound||0);if(trainingBusy)return null;
    if(round>0&&Number(state.lastAttemptRound||0)>0&&round-Number(state.lastAttemptRound)<trainEveryRounds*300000)return null;
    if(!fs.existsSync(historyFile))return null;trainingBusy=true;
    try{
      const result=await runPython(['train','--history',historyFile,'--out-dir',dir,'--min-samples',String(minSamples),'--time-budget',String(trainTimeBudget)],null,Math.max(300000,trainTimeBudget*6000));
      if(Number.isFinite(Number(result?.lastTrainRound)))state.lastAttemptRound=Number(result.lastTrainRound);
      if(result?.status==='CANDIDATE_REGISTERED'&&result?.modelVersion&&result?.modelPath&&!state.candidates.some(c=>c.modelVersion===result.modelVersion)){
        state.candidates.push({...result,observations:[],registeredAt:Date.now()});prune();
        log('no_base_specialist_candidate_registered',{modelVersion:result.modelVersion,estimator:result.bestEstimator,confidenceThreshold:result.confidenceThreshold,
          outerHoldout:result.outerHoldout,sourceMix:result.sourceMix,trainedSamples:result.trainedSamples,targetSamples:forwardTarget,productionEffect:'NONE_SHADOW_ONLY'});
      }else if(result?.status==='REJECTED_BEFORE_FORWARD'){
        log('no_base_specialist_candidate_rejected_before_forward',{lastTrainRound:result.lastTrainRound,bestEstimator:result.bestEstimator,
          confidenceThreshold:result.confidenceThreshold,innerValidation:result.innerValidation,outerHoldout:result.outerHoldout,sourceMix:result.sourceMix,reasons:result.reasons||[]});
      }else log('no_base_specialist_training_result',result||{});
      save();return result;
    }catch(e){log('no_base_specialist_training_failed',{error:e?.message||String(e)});return null;}finally{trainingBusy=false;}
  }
  async function observe(row,facts,observedAt=Date.now()){
    const round=Number(row?.roundStartMs),at=Number(observedAt),delay=at-round;
    if(!Number.isFinite(round)||!Number.isFinite(at)||!facts||delay<18000||delay>22000)return;
    if(row?.prediction==='UP'||row?.prediction==='DOWN')return;
    if(predictingRounds.has(round))return;
    const active=state.candidates.filter(c=>{const s=summaryOf(c);return s.strictForwardSamples<forwardTarget&&round>Number(c.lastTrainRound||0)&&!(c.observations||[]).some(o=>Number(o.roundStartMs)===round);});
    if(!active.length)return;predictingRounds.add(round);
    try{
      const result=await runPython(['predict'],{facts,delayMs:delay,models:active.map(c=>({modelVersion:c.modelVersion,modelPath:c.modelPath}))},60000);
      let changed=false;
      for(const pred of result?.predictions||[]){const c=state.candidates.find(x=>x.modelVersion===pred.modelVersion);if(!c||!Number.isFinite(Number(pred.probability)))continue;
        c.observations||=[];if(c.observations.some(o=>Number(o.roundStartMs)===round))continue;
        const p=Number(pred.probability),decision=p>=Number(c.confidenceThreshold)?'UP':p<=1-Number(c.confidenceThreshold)?'DOWN':'WAIT';
        c.observations.push({roundStartMs:round,observedAt:at,observedDelayMs:delay,probability:p,decision,actual:null,settledAt:null});changed=true;
        log('no_base_specialist_prediction_ready',{round,modelVersion:c.modelVersion,probability:Number(p.toFixed(6)),confidenceThreshold:c.confidenceThreshold,decision,productionEffect:'NONE_SHADOW_ONLY'});
      }
      if(changed)save();
    }catch(e){log('no_base_specialist_prediction_failed',{round,error:e?.message||String(e)});}finally{predictingRounds.delete(round);}
  }
  function settle(row){
    if(row?.actual!=='UP'&&row?.actual!=='DOWN')return;const round=Number(row.roundStartMs);let changed=false;
    for(const c of state.candidates){const o=(c.observations||[]).find(x=>Number(x.roundStartMs)===round);if(!o)continue;
      if(row?.prediction==='UP'||row?.prediction==='DOWN'){
        if(o.excludedReason!=='BASE_DIRECTION_LATER_AVAILABLE'){o.excludedReason='BASE_DIRECTION_LATER_AVAILABLE';o.actual=row.actual;o.settledAt=Number(row.settledAt)||Date.now();changed=true;}
        continue;
      }
      if(o.actual===row.actual)continue;o.actual=row.actual;o.settledAt=Number(row.settledAt)||Date.now();changed=true;
      const s=summaryOf(c);if((s.strictForwardSamples>0&&s.strictForwardSamples%5===0)||s.strictForwardSamples===forwardTarget)log('no_base_specialist_forward_progress',s);}
    if(changed){save();deleteRetiredCandidates();}
  }
  function stats(){
    const candidates=state.candidates.map(summaryOf).sort((a,b)=>Number(b.trainedAt||0)-Number(a.trainedAt||0));
    const qualified=candidates.filter(x=>x.status==='QUALIFIED_FOR_REVIEW').sort((a,b)=>Number(b.incrementalCoverage||0)-Number(a.incrementalCoverage||0)||Number(b.forwardAccuracy||0)-Number(a.forwardAccuracy||0));
    return {ok:true,engineVersion:ENGINE_VERSION,productionEffect:'NONE_SHADOW_ONLY',trainingBusy,lastAttemptRound:state.lastAttemptRound||0,
      target:{strictForwardAccuracy:0.70,recent20Accuracy:0.70,strictForwardDecisions:forwardTarget},candidates,bestQualified:qualified[0]||null};
  }
  return{load,save,maybeTrain,observe,settle,deleteRetiredCandidates,stats};
}
