import http from 'node:http';

const PORT=Number(process.env.PORT||3000);
const ORIGIN=String(process.env.SHADOW_STATS_ORIGIN||'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/,'');
const TIMEOUT_MS=Math.max(1000,Number(process.env.OBSERVER_TIMEOUT_MS||5000));

function safePct(x){const n=Number(x);return Number.isFinite(n)?Number((n*100).toFixed(2)):null}
function windowStats(rows,n){
  const a=rows.slice(-n);
  let hits=0,brier=0,bn=0,up=0,down=0,streak=0,maxErr=0;
  for(const x of a){
    const p=Number(x.probability);
    const pred=x.prediction||x.direction||(Number.isFinite(p)?(p>=0.5?'UP':'DOWN'):null);
    const actual=x.actual;
    if(pred==='UP')up++; else if(pred==='DOWN')down++;
    if((pred==='UP'||pred==='DOWN')&&(actual==='UP'||actual==='DOWN')){
      if(pred===actual){hits++;streak=0}else{streak++;maxErr=Math.max(maxErr,streak)}
      if(Number.isFinite(p)){const y=actual==='UP'?1:0;brier+=(p-y)**2;bn++}
    }
  }
  return {samples:a.length,hits,misses:a.length-hits,accuracy:a.length?Number((hits/a.length).toFixed(4)):null,accuracyPct:a.length?Number((hits/a.length*100).toFixed(2)):null,brier:bn?Number((brier/bn).toFixed(4)):null,upPredictions:up,downPredictions:down,maxConsecutiveErrors:maxErr};
}
async function getJson(path){
  const r=await fetch(ORIGIN+path,{headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(TIMEOUT_MS)});
  const t=await r.text(); if(!r.ok)throw new Error(path+' HTTP_'+r.status);
  const j=JSON.parse(t); return j;
}
function normalizeCandidate(c){
  const rr=Array.isArray(c?.recentResults)?c.recentResults:[];
  return {
    role:'TRAINING_CANDIDATE',
    modelId:c?.modelVersion??null,
    trainedAt:c?.trainedAt??null,
    forwardSamples:c?.forwardSamples??0,
    hits:c?.hits??null,
    misses:c?.misses??null,
    forwardAccuracy:c?.forwardAccuracy??null,
    forwardAccuracyPct:safePct(c?.forwardAccuracy),
    forwardBrier:c?.forwardBrier??null,
    validationAccuracy:c?.validationAccuracy??null,
    validationAccuracyPct:safePct(c?.validationAccuracy),
    validationBrier:c?.validationBrier??null,
    baselineAccuracy:c?.baselineAccuracy??null,
    baselineBrier:c?.baselineBrier??null,
    upPredictions:c?.upPredictions??null,
    downPredictions:c?.downPredictions??null,
    maxConsecutiveErrors:c?.maxConsecutiveErrors??null,
    status:c?.status??null,
    targetSamples:c?.targetSamples??60,
    remainingSamples:c?.remainingSamples??null,
    windows:{last10:windowStats(rr,10),last20:windowStats(rr,20),last40:null,last60:null},
    windowsNote:rr.length<40?'source currently exposes only recent 20 candidate observations; 40/60 unavailable without changing training service':'',
    recentResults:rr
  };
}
async function snapshot(){
  const [s,p]=await Promise.all([getJson('/api/shadow-stats'),getJson('/api/production-signal')]);
  const sh=s?.shadow||{};
  const prod=sh?.frozenCandidate||null;
  const productionModelId=prod?.modelVersion??p?.shadowModelVersion??p?.modelVersion??null;
  const productionTrainedAt=prod?.trainedAt??null;
  const prodRows=(Array.isArray(s?.records)?s.records:[]).filter(r=>{
    if(!(r?.actual==='UP'||r?.actual==='DOWN'))return false;
    if(productionTrainedAt!=null && Number(r?.shadowCandidateTrainedAt)!==Number(productionTrainedAt))return false;
    return Number.isFinite(Number(r?.shadowCandidateProbability));
  }).map(r=>({roundStartMs:r.roundStartMs,probability:Number(r.shadowCandidateProbability),prediction:Number(r.shadowCandidateProbability)>=0.5?'UP':'DOWN',actual:r.actual}));
  const fc=prod?.forwardComparison||sh?.forwardComparison||{};
  const production={
    role:'PRODUCTION_SHADOW',
    modelId:productionModelId,
    trainedAt:productionTrainedAt,
    productionApproved:Boolean(prod),
    signalSourceModelId:p?.shadowModelVersion??p?.modelVersion??productionModelId,
    signalSourceMatchesProduction:(p?.shadowModelVersion??p?.modelVersion??productionModelId)===productionModelId,
    forwardSamples:fc?.shadowN??prodRows.length,
    forwardAccuracy:fc?.shadowAccuracy??null,
    forwardAccuracyPct:safePct(fc?.shadowAccuracy),
    forwardBrier:fc?.shadowBrier??null,
    validationAccuracy:prod?.validation?.validationAccuracy??null,
    validationAccuracyPct:safePct(prod?.validation?.validationAccuracy),
    validationBrier:prod?.validation?.validationBrier??null,
    baselineAccuracy:prod?.validation?.baselineAccuracy??null,
    baselineBrier:prod?.validation?.baselineBrier??null,
    windows:{last10:windowStats(prodRows,10),last20:windowStats(prodRows,20),last40:windowStats(prodRows,40),last60:windowStats(prodRows,60)},
  };
  const candidates=(sh?.shadowForwardCandidates||[]).map(normalizeCandidate).filter(c=>c.modelId!==production.modelId);
  const latestTraining={
    role:'BACKGROUND_TRAINING',
    status:sh?.status??null,
    latestModelId:sh?.modelVersion??null,
    trainedAt:sh?.trainedAt??null,
    trainedSamples:sh?.trainedSamples??null,
    validationSamples:sh?.validationSamples??null,
    validationAccuracy:sh?.validationAccuracy??null,
    validationBrier:sh?.validationBrier??null,
    baselineAccuracy:sh?.baselineAccuracy??null,
    baselineBrier:sh?.baselineBrier??null,
    candidateCount:candidates.length
  };
  return {ok:true,observerMode:'READ_ONLY',generatedAt:Date.now(),sourceOrigin:ORIGIN,productionShadow:production,trainingStatus:latestTraining,shadowForwardCandidates:candidates,rawHealth:s?.health??null};
}
function send(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(obj))}
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&u.pathname==='/healthz')return send(res,200,{ok:true,mode:'READ_ONLY_OBSERVER'});
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/snapshot'||u.pathname==='/api/shadow-monitor')){
    try{return send(res,200,await snapshot())}catch(e){return send(res,502,{ok:false,mode:'READ_ONLY_OBSERVER',error:e?.message||String(e)})}
  }
  return send(res,404,{ok:false,error:'Not found'});
}).listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({event:'shadow_observer_started',mode:'READ_ONLY',origin:ORIGIN,port:PORT})));
