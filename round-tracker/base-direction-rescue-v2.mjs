const VERSION = 'BASE_DIRECTION_RESCUE_V2_EXACT20';
const DEFAULT_START_MS = 1791431100000;
const CANDIDATES = [
  { id:'CONSENSUS_3_OF_3', mode:'CONSENSUS_3_OF_3' },
  { id:'CONSENSUS_2_OF_3_ML70', mode:'CONSENSUS_2_OF_3_ML70' },
];

function finite(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function dirOf(v,minAbs=0){
  const n=finite(v); if(n==null || Math.abs(n)<minAbs) return null;
  return n>0?'UP':'DOWN';
}
function majority(values){
  const xs=values.filter(x=>x==='UP'||x==='DOWN');
  const up=xs.filter(x=>x==='UP').length, down=xs.filter(x=>x==='DOWN').length;
  return {direction:up>down?'UP':down>up?'DOWN':null,up,down,nonNull:xs.length};
}
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function sigmoid(z){ return z>=0 ? 1/(1+Math.exp(-z)) : Math.exp(z)/(1+Math.exp(z)); }

const FEATURE_KEYS=[
  'regimeScore','currentScore','microScore','currentTrendScore',
  'normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
  'tradePressure15s','tradePressure60s','ofiNormalized5s','rangePosition180',
  'predictionMarketUpMidCentered','absorptionRisk','liveScore','distanceFromOpenBps'
];

function vector(f){
  if(!f||typeof f!=='object') return null;
  const upMid=finite(f.predictionMarketUpMid);
  const vals=[
    finite(f.regimeScore),finite(f.currentScore),finite(f.microScore),finite(f.currentTrendScore),
    finite(f.normalizedMomentum15s),finite(f.normalizedMomentum30s),finite(f.normalizedMomentum60s),
    finite(f.tradePressure15s),finite(f.tradePressure60s),finite(f.ofiNormalized5s),finite(f.rangePosition180),
    upMid==null?0:(upMid-0.5)*2,f.absorptionRisk?1:0,finite(f.liveScore),finite(f.distanceFromOpenBps)==null?0:finite(f.distanceFromOpenBps)/5
  ].map(v=>clamp(v==null?0:v,-3,3));
  return vals;
}

function fitLogistic(samples,{lr=0.04,l2=0.04,epochs=260,halfLife=100}={}){
  const w=new Array(FEATURE_KEYS.length+1).fill(0);
  for(let epoch=0;epoch<epochs;epoch++){
    const g=new Array(w.length).fill(0); let tw=0;
    for(let i=0;i<samples.length;i++){
      const s=samples[i], age=samples.length-1-i, sw=Math.pow(0.5,age/halfLife);
      let z=w[0]; for(let j=0;j<s.x.length;j++) z+=w[j+1]*s.x[j];
      const e=sigmoid(z)-s.y; g[0]+=sw*e;
      for(let j=0;j<s.x.length;j++) g[j+1]+=sw*e*s.x[j];
      tw+=sw;
    }
    const d=tw||1; w[0]-=lr*g[0]/d;
    for(let j=1;j<w.length;j++) w[j]-=lr*(g[j]/d+l2*w[j]);
  }
  return w;
}
function predict(weights,x){
  if(!weights||!x) return null;
  let z=weights[0]; for(let j=0;j<x.length;j++) z+=weights[j+1]*x[j];
  return sigmoid(z);
}
function metric(weights,samples){
  if(!samples.length) return {samples:0,accuracy:null,brier:null};
  let h=0,b=0;
  for(const s of samples){ const p=predict(weights,s.x); h+=((p>=0.5?1:0)===s.y)?1:0; b+=(p-s.y)**2; }
  return {samples:samples.length,accuracy:h/samples.length,brier:b/samples.length};
}

function compactFacts(f){
  if(!f||typeof f!=='object') return null;
  const keys=[
    'regimeScore','regimeDirection','regimeAgreement','currentScore','liveScore','distanceFromOpenBps',
    'microScore','currentTrendScore','normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
    'tradePressure15s','tradePressure60s','ofiNormalized5s','rangePosition180','predictionMarketUpMid','absorptionRisk'
  ];
  return Object.fromEntries(keys.map(k=>[k,f[k]??null]));
}

function voteBundle(f){
  const current=dirOf(f?.currentScore,0.60);
  const live=dirOf(f?.liveScore,0.12);
  const distance=dirOf(f?.distanceFromOpenBps,0.75);
  const priceM=majority([current,live,distance]);
  const price=priceM.nonNull>=2 && Math.max(priceM.up,priceM.down)>=2 ? priceM.direction : null;

  const trend=dirOf(f?.currentTrendScore,0.55);
  const micro=dirOf(f?.microScore,0.08);
  const mom30=dirOf(f?.normalizedMomentum30s,0.04);
  const momentumM=majority([trend,micro,mom30]);
  const momentum=momentumM.nonNull>=2 && Math.max(momentumM.up,momentumM.down)>=2 ? momentumM.direction : null;

  const upMid=finite(f?.predictionMarketUpMid);
  const market=upMid==null?null:upMid>=0.55?'UP':upMid<=0.45?'DOWN':null;
  const regimeDir=String(f?.regimeDirection||'').toUpperCase();
  const regimeAgreement=finite(f?.regimeAgreement);
  const regime=(regimeAgreement!=null&&regimeAgreement>=0.67&&(regimeDir==='UP'||regimeDir==='DOWN'))?regimeDir:null;
  let regimeMarket=null;
  if(market&&regime) regimeMarket=market===regime?market:null;
  else regimeMarket=market||regime;

  return {
    price,momentum,regimeMarket,
    components:{current,live,distance,trend,micro,mom30,market,regime,regimeAgreement,upMid}
  };
}

function hardConflict(f,direction){
  if(direction!=='UP'&&direction!=='DOWN') return null;
  if(f?.absorptionRisk===true) return 'ABSORPTION_RISK';
  const upMid=finite(f?.predictionMarketUpMid);
  if(direction==='UP'&&upMid!=null&&upMid<=0.42) return 'STRONG_PREDICTION_MARKET_CONFLICT';
  if(direction==='DOWN'&&upMid!=null&&upMid>=0.58) return 'STRONG_PREDICTION_MARKET_CONFLICT';
  const r=String(f?.regimeDirection||'').toUpperCase(), a=finite(f?.regimeAgreement);
  if(a!=null&&a>=0.75&&((direction==='UP'&&r==='DOWN')||(direction==='DOWN'&&r==='UP'))) return 'STRONG_REGIME_CONFLICT';
  return null;
}

function streakStats(decided,getDecision){
  let max=0,cur=0;
  for(const r of decided){
    const miss=getDecision(r)!==r.actual;
    if(miss){cur++;max=Math.max(max,cur);}else cur=0;
  }
  return {maxConsecutiveErrors:max,currentMissStreak:cur};
}

export function createBaseDirectionRescueV2({
  rounds,startMs=DEFAULT_START_MS,targetSamples=60,retireMinSamples=20,retireAccuracy=0.65,
  reviewAccuracy=0.75,recentMinAccuracy=0.70,directionMinAccuracy=0.70,log=()=>{}
}={}){
  function rowsArray(){ return Array.from(rounds?.values?.()||[]); }

  function exact20TrainingSamples(beforeRound){
    const out=[]; let v2Exact20=0,legacyExact20=0;
    for(const r of rowsArray().sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs))){
      const round=Number(r.roundStartMs); if(!Number.isFinite(round)||round>=beforeRound) continue;
      if(r.actual!=='UP'&&r.actual!=='DOWN') continue;
      // Eligibility is defined by the real 18-22s snapshot. A direction
      // frozen later in the round must not retroactively erase this sample.
      let facts=null, delay=null, source=null;
      if(r?.baseDirectionRescueV2?.features){
        facts=r.baseDirectionRescueV2.features; delay=finite(r.baseDirectionRescueV2.observedDelayMs); source='V2_EXACT20'; v2Exact20++;
      }else if(r?.noBaseSpecialistFacts){
        facts=r.noBaseSpecialistFacts;
        const at=finite(r.noBaseSpecialistObservedAt); delay=at==null?null:at-round;
        if(delay!=null&&delay>=18000&&delay<=22000){source='LEGACY_EXACT20';legacyExact20++;}else facts=null;
      }
      if(!facts||delay==null||delay<18000||delay>22000) continue;
      const x=vector(facts); if(!x) continue;
      out.push({x,y:r.actual==='UP'?1:0,roundStartMs:round,source});
    }
    return {samples:out,sourceMix:{v2Exact20,legacyExact20}};
  }

  function mlSnapshot(round,facts){
    const {samples,sourceMix}=exact20TrainingSamples(round);
    const minTotal=60,holdoutN=20;
    if(samples.length<minTotal) return {
      ready:false,validated:false,trainingSamples:samples.length,requiredSamples:minTotal,
      probability:null,direction:null,threshold:0.70,sourceMix,validation:null
    };
    const train=samples.slice(0,-holdoutN),holdout=samples.slice(-holdoutN);
    const validationWeights=fitLogistic(train);
    const validation=metric(validationWeights,holdout);
    const validated=validation.samples>=20&&Number(validation.accuracy)>=0.65;
    const weights=validated?fitLogistic(samples):null;
    const probability=weights?predict(weights,vector(facts)):null;
    const direction=probability==null?null:probability>=0.70?'UP':probability<=0.30?'DOWN':null;
    return {
      ready:true,validated,trainingSamples:samples.length,requiredSamples:minTotal,
      probability:probability==null?null:Number(probability.toFixed(4)),direction,threshold:0.70,sourceMix,
      validation:{samples:validation.samples,accuracy:validation.accuracy==null?null:Number(validation.accuracy.toFixed(4)),brier:validation.brier==null?null:Number(validation.brier.toFixed(4))}
    };
  }

  function candidateSummary(id){
    const observed=rowsArray().filter(r=>
      Number(r.roundStartMs)>=startMs&&(r.actual==='UP'||r.actual==='DOWN')&&
      r?.baseDirectionRescueV2?.version===VERSION
    ).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
    const decided=observed.filter(r=>{
      const d=r?.baseDirectionRescueV2?.candidates?.[id]?.decision;
      return d==='UP'||d==='DOWN';
    });
    const getD=r=>r.baseDirectionRescueV2.candidates[id].decision;
    const hits=decided.filter(r=>getD(r)===r.actual).length;
    const recent10=decided.slice(-10),recent20=decided.slice(-20);
    const calc=a=>a.length?Number((a.filter(r=>getD(r)===r.actual).length/a.length).toFixed(4)):null;
    const byDir=dir=>{
      const a=decided.filter(r=>getD(r)===dir),h=a.filter(r=>r.actual===dir).length;
      return {samples:a.length,hits:h,misses:a.length-h,accuracy:a.length?Number((h/a.length).toFixed(4)):null};
    };
    const accuracy=decided.length?hits/decided.length:null;
    const st=streakStats(decided,getD);
    let status='FORWARD_COLLECTING';
    if(decided.length>=retireMinSamples&&Number.isFinite(accuracy)&&accuracy<retireAccuracy) status='RETIRED_LOW_ACCURACY';
    else if(
      decided.length>=targetSamples&&accuracy>=reviewAccuracy&&recent20.length>=20&&calc(recent20)>=recentMinAccuracy&&
      byDir('UP').samples>=5&&byDir('DOWN').samples>=5&&
      (byDir('UP').accuracy??0)>=directionMinAccuracy&&(byDir('DOWN').accuracy??0)>=directionMinAccuracy&&
      st.maxConsecutiveErrors<=2
    ) status='QUALIFIED_FOR_REVIEW_SHADOW_ONLY';
    else if(decided.length>=targetSamples) status='FORWARD_COMPLETE';
    const r20=calc(recent20);
    return {
      candidateId:id,status,active:status!=='RETIRED_LOW_ACCURACY',productionEffect:'NONE_SHADOW_ONLY',
      strictForwardSamples:decided.length,targetSamples,remainingSamples:Math.max(0,targetSamples-decided.length),
      hits,misses:decided.length-hits,forwardAccuracy:accuracy==null?null:Number(accuracy.toFixed(4)),
      recent10Accuracy:calc(recent10),recent20Accuracy:r20,
      up:byDir('UP'),down:byDir('DOWN'),
      incrementalCoverage:observed.length?Number((decided.length/observed.length).toFixed(4)):null,
      waitShare:observed.length?Number((1-decided.length/observed.length).toFixed(4)):null,
      maxConsecutiveErrors:st.maxConsecutiveErrors,currentMissStreak:st.currentMissStreak,
      driftAlert:recent20.length>=10&&r20!=null&&r20<0.65,
    };
  }

  function summary(){
    const observed=rowsArray().filter(r=>
      Number(r.roundStartMs)>=startMs&&(r.actual==='UP'||r.actual==='DOWN')&&
      r?.baseDirectionRescueV2?.version===VERSION
    ).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
    const candidates=CANDIDATES.map(c=>candidateSummary(c.id));
    const active=candidates.filter(c=>c.active).sort((a,b)=>
      Number(b.forwardAccuracy??-1)-Number(a.forwardAccuracy??-1)||Number(b.strictForwardSamples)-Number(a.strictForwardSamples)
    );
    return {
      ok:true,version:VERSION,startMs,productionEffect:'NONE_SHADOW_ONLY',autoPromotionEnabled:false,
      exact20WindowMs:[18000,22000],observedSettledNoBaseRounds:observed.length,
      gates:{retireMinSamples,retireAccuracy,targetSamples,reviewAccuracy,recentMinAccuracy,directionMinAccuracy,maxConsecutiveErrors:2},
      candidates,leader:active[0]||null,
      qualifiedForReview:candidates.filter(c=>c.status==='QUALIFIED_FOR_REVIEW_SHADOW_ONLY'),
    };
  }

  function evaluate(row,facts,observedAt=Date.now()){
    const round=Number(row?.roundStartMs),delay=Number(observedAt)-round;
    if(!Number.isFinite(round)||!facts||delay<18000||delay>22000) return null;
    if(row?.prediction==='UP'||row?.prediction==='DOWN') return null;
    const retired=new Set(summary().candidates.filter(c=>!c.active).map(c=>c.candidateId));
    const votes=voteBundle(facts),m=majority([votes.price,votes.momentum,votes.regimeMarket]);
    const ml=mlSnapshot(round,facts);
    const candidates={};

    for(const cfg of CANDIDATES){
      let direction=null,reasons=[];
      if(retired.has(cfg.id)) reasons.push('RETIRED_LOW_ACCURACY');
      else if(facts?.absorptionRisk===true) reasons.push('ABSORPTION_RISK');
      else if(cfg.mode==='CONSENSUS_3_OF_3'){
        if(m.nonNull===3&&Math.max(m.up,m.down)===3) direction=m.direction;
        else reasons.push('NEEDS_UNANIMOUS_3_OF_3');
      }else{
        if(m.nonNull<2||Math.max(m.up,m.down)<2) reasons.push('NEEDS_2_OF_3_CONSENSUS');
        else if(m.up>0&&m.down>0) reasons.push('VOTE_CONFLICT');
        else if(!ml.validated) reasons.push('ML_NOT_VALIDATED');
        else if(ml.direction!==m.direction) reasons.push('ML_NOT_CONFIRMING');
        else direction=m.direction;
      }
      const conflict=direction?hardConflict(facts,direction):null;
      if(conflict){reasons.push(conflict);direction=null;}
      candidates[cfg.id]={
        candidateId:cfg.id,mode:cfg.mode,decision:direction||'WAIT',reasons,
        productionEffect:'NONE_SHADOW_ONLY',
      };
    }

    const snapshot={
      version:VERSION,evaluatedAt:Date.now(),observedAt:Number(observedAt),observedDelayMs:delay,
      productionEffect:'NONE_SHADOW_ONLY',features:compactFacts(facts),votes,ml,candidates,
    };
    log('base_direction_rescue_v2_shadow_evaluated',{
      round,observedDelayMs:delay,votes:{price:votes.price,momentum:votes.momentum,regimeMarket:votes.regimeMarket},
      ml:{validated:ml.validated,trainingSamples:ml.trainingSamples,probability:ml.probability,direction:ml.direction},
      decisions:Object.fromEntries(Object.entries(candidates).map(([k,v])=>[k,v.decision])),
      productionEffect:'NONE_SHADOW_ONLY'
    });
    return snapshot;
  }

  return {version:VERSION,evaluate,stats:summary};
}
