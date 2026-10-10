// Forward-only 15-second V3 no-base trials; only strict-forward-qualified directions may enter production.
export const V3_NO_BASE_15S_VERSION = 'V3_NO_BASE_15S_RESCUE_SHADOW_V1';
export const V3_NO_BASE_15S_START_MS = Date.parse('2026-10-10T10:00:00.000Z');
export const V3_NO_BASE_15S_FORWARD_TARGET = 60;
export const V3_NO_BASE_15S_CONFIGS = Object.freeze([
  {id:'PM_LEAN_03',mode:'pm'},
  {id:'BLENDED_04_PM_AGREE',mode:'blended'},
  {id:'CURRENT_03_PM_AGREE',mode:'current'},
  // New ex-ante independent confirmations, not relaxed production thresholds.
  {id:'PM_FLOW15_CURRENT_03',mode:'flow',currentMin:0.30,pmMin:0.03},
  {id:'PM_TREND_045_CURRENT_03',mode:'trend',currentMin:0.30,trendMin:0.45,pmMin:0.03},
  // Ex-ante 15s under-threshold directional trials: confirmation is mandatory.
  // Existing V3 0.60 production threshold remains completely unchanged.
  {id:'CURRENT_04_TREND_055_PM05',mode:'trend',currentMin:0.40,trendMin:0.55,pmMin:0.05},
  {id:'CURRENT_03_TREND_045_PM08',mode:'trend',currentMin:0.30,trendMin:0.45,pmMin:0.08},
  // New prospective-only pilots for V3 no-base/flat-price regimes.
  // Both need independent Binance prediction-market confirmation plus an
  // independently signed component; no relaxed live V3/V2 trading gate.
  {id:'PM_REGIME35_SUPPORT08',mode:'regime',regimeMin:0.35,pmMin:0.08},
  {id:'PM_CURRENT25_SUPPORT08',mode:'currentGuard',currentMin:0.25,pmMin:0.08},
  // Absorption-risk counterfactuals are separate prospective experiments.
  // They cannot bypass any feed/round-alignment checks, and must independently
  // pass the strict-forward 75% + per-side accuracy gates.
  {id:'ABS_PM_CURRENT15',mode:'absorptionCurrent',pmMin:0.08,currentMin:0.15,
    introducedAtMs:Date.parse('2026-10-10T11:50:00.000Z')},
  {id:'ABS_PM_REGIME35',mode:'absorptionRegime',pmMin:0.08,regimeMin:0.35,
    introducedAtMs:Date.parse('2026-10-10T11:50:00.000Z')},
]);
const finite=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
const dir=s=>s>0?'UP':s<0?'DOWN':'WAIT';
const stats=(rows,id)=> {
  const hit=rows.filter(r=>r.v3NoBase15sShadow.candidates[id].decision===r.actual).length;
  return {samples:rows.length,hits:hit,misses:rows.length-hit,
    accuracy:rows.length?Number((hit/rows.length).toFixed(4)):null};
};
export function freezeNoBase15s(row,facts,now=Date.now()){
  const start=finite(row?.roundStartMs);
  if(start===null||start<V3_NO_BASE_15S_START_MS||!facts||typeof facts!=='object')return null;
  const delay=now-start;
  // Freeze eligibility at 15s, not at settlement. No retroactive observations.
  if(delay<15000||delay>17000||now>=start+300000||row?.predictedAt!=null||
     row?.prediction==='UP'||row?.prediction==='DOWN')return null;
  const bookAge=finite(facts.predictionMarketBookAgeMs);
  const upMid=finite(facts.predictionMarketUpMid);
  const current=finite(facts.currentScore),score=finite(facts.liveScore);
  const trend=finite(facts.currentTrendScore),distance=finite(facts.distanceFromOpenBps);
  const regimeScore=finite(facts.regimeScore);
  const flow15=finite(facts.tradeCount15s);
  const depthAge=finite(facts.depthAgeMs);
  const streamLag=finite(facts.lastAggTradeAgeMs);
  const missing=[];
  if(facts.predictionMarketMappingReliable!==true)missing.push('UNRELIABLE_PM_MAPPING');
  if(facts.predictionMarketRoundAligned!==true)missing.push('PM_ROUND_NOT_ALIGNED');
  if(bookAge===null||bookAge>5000||bookAge<0)missing.push('PM_BOOK_STALE_OR_MISSING');
  if(upMid===null||upMid<0||upMid>1)missing.push('PM_MID_INVALID');
  if(facts.tradeStreamStalled===true)missing.push('TRADE_STREAM_STALLED');
  if(depthAge===null||depthAge>1500||depthAge<0)missing.push('DEPTH_STALE_OR_MISSING');
  if(streamLag===null||streamLag>12000||streamLag<0)missing.push('TRADE_STALE_OR_MISSING');
  if(flow15===null||flow15<8)missing.push('FLOW15_INSUFFICIENT');
  if(facts.absorptionRisk===true)missing.push('ABSORPTION_RISK');
  const fresh=missing.length===0;
  const pmSign=upMid!==null&&upMid>=0.53?1:upMid!==null&&upMid<=0.47?-1:0;
  const candidates={};
  for(const cfg of V3_NO_BASE_15S_CONFIGS){
    const absorptionPilot=cfg.mode==='absorptionCurrent'||cfg.mode==='absorptionRegime';
    // The original nine configurations retain their absorption gate.
    // Only these two independently scored pilots can exclude this ONE
    // risk warning from frozen counterfactual candidate formation.
    const reasons=absorptionPilot
      ? missing.filter(r=>r!=='ABSORPTION_RISK')
      : [...missing];
    let sign=0;
    if(absorptionPilot && facts.absorptionRisk!==true)reasons.push('NOT_ABSORPTION_SCENARIO');
    if(cfg.introducedAtMs && now<cfg.introducedAtMs)reasons.push('PILOT_NOT_STARTED');
    if(!pmSign)reasons.push('PM_NEUTRAL');
    else if(reasons.length===0){
      if(cfg.mode==='pm'){
        if(score===null||pmSign*score>=-0.25)sign=pmSign;
        else reasons.push('BLENDED_PM_CONFLICT');
      }else if(cfg.mode==='blended'){
        if(score!==null&&pmSign*score>=0.40)sign=pmSign;
        else reasons.push('BLENDED_BELOW_04_OR_CONFLICT');
      }else if(cfg.mode==='current'){
        if(current!==null&&pmSign*current>=0.30)sign=pmSign;
        else reasons.push('CURRENT_BELOW_03_OR_CONFLICT');
      }else if(cfg.mode==='flow'){
        if(current===null||pmSign*current<cfg.currentMin)reasons.push('CURRENT_BELOW_MIN_OR_CONFLICT');
        if(distance===null||pmSign*distance<0.5)reasons.push('ROUND_PRICE_NOT_ALIGNED');
        if(upMid===null||pmSign*(upMid-0.5)<cfg.pmMin)reasons.push('PM_SUPPORT_BELOW_MIN');
        const regime=String(facts.regimeDirection||'');
        if((regime==='UP'||regime==='DOWN')&&regime!==dir(pmSign)&&
          (finite(facts.regimeAgreement)??0)>=0.67)reasons.push('STRONG_REGIME_CONFLICT');
        if(reasons.length===0)sign=pmSign;
      }else if(cfg.mode==='regime'||cfg.mode==='currentGuard'){
        if(upMid===null||pmSign*(upMid-0.5)<cfg.pmMin)reasons.push('PM_SUPPORT_BELOW_MIN');
        if(facts.predictionMarketConflict===true)reasons.push('PM_STRONG_CONFLICT');
        if(cfg.mode==='regime' && (regimeScore===null||pmSign*regimeScore<cfg.regimeMin))
          reasons.push('REGIME_SCORE_BELOW_MIN_OR_CONFLICT');
        if(cfg.mode==='currentGuard' && (current===null||pmSign*current<cfg.currentMin))
          reasons.push('CURRENT_BELOW_MIN_OR_CONFLICT');
        if(cfg.mode==='currentGuard'){
          const regime=String(facts.regimeDirection||'');
          if((regime==='UP'||regime==='DOWN')&&regime!==dir(pmSign)&&
             (finite(facts.regimeAgreement)??0)>=0.67)reasons.push('STRONG_REGIME_CONFLICT');
        }
        if(reasons.length===0)sign=pmSign;
      }else if(absorptionPilot){
        if(upMid===null||pmSign*(upMid-0.5)<cfg.pmMin)
          reasons.push('ABS_PM_SUPPORT_BELOW_MIN');
        if(facts.predictionMarketConflict===true)
          reasons.push('ABS_PM_CONFLICT');
        if(flow15===null||flow15<16)
          reasons.push('ABS_FLOW15_INSUFFICIENT');
        if(cfg.mode==='absorptionCurrent' &&
           (current===null||pmSign*current<cfg.currentMin))
          reasons.push('ABS_CURRENT_BELOW_MIN_OR_CONFLICT');
        if(cfg.mode==='absorptionRegime' &&
           (regimeScore===null||pmSign*regimeScore<cfg.regimeMin))
          reasons.push('ABS_REGIME_BELOW_MIN_OR_CONFLICT');
        if(cfg.mode==='absorptionRegime' && current!==null && pmSign*current < -0.10)
          reasons.push('ABS_CURRENT_STRONG_CONFLICT');
        const regime=String(facts.regimeDirection||'');
        if(cfg.mode==='absorptionCurrent' &&
           (regime==='UP'||regime==='DOWN')&&regime!==dir(pmSign)&&
           (finite(facts.regimeAgreement)??0)>=0.67)
          reasons.push('ABS_STRONG_REGIME_CONFLICT');
        if(reasons.length===0)sign=pmSign;
      }else if(cfg.mode==='trend'){
        if(current===null||pmSign*current<cfg.currentMin)reasons.push('CURRENT_BELOW_MIN_OR_CONFLICT');
        if(trend===null||pmSign*trend<cfg.trendMin)reasons.push('TREND_BELOW_MIN_OR_CONFLICT');
        if(distance===null||pmSign*distance<0.5)reasons.push('ROUND_PRICE_NOT_ALIGNED');
        if(upMid===null||pmSign*(upMid-0.5)<cfg.pmMin)reasons.push('PM_SUPPORT_BELOW_MIN');
        const regime=String(facts.regimeDirection||'');
        if((regime==='UP'||regime==='DOWN')&&regime!==dir(pmSign)&&
          (finite(facts.regimeAgreement)??0)>=0.67)reasons.push('STRONG_REGIME_CONFLICT');
        if(reasons.length===0)sign=pmSign;
      }
    }
    candidates[cfg.id]={decision:dir(sign),qualified:sign!==0,reasons};
  }
  return {
    version:V3_NO_BASE_15S_VERSION,observedAt:now,round:start,observedDelayMs:delay,
    baseAbsentAtObservation:true,inputFrozenBeforeSettlement:true,
    productionEffect:'NONE_SHADOW_ONLY',
    facts:{upMid,currentScore:current,blendedScore:score,currentTrendScore:trend,regimeScore,
      distanceFromOpenBps:distance,flow15,predictionBookAgeMs:bookAge,
      sourceMarketTopicId:facts.predictionMarketTopicId??null,
      bookMappingReliable:facts.predictionMarketMappingReliable===true,
      bookRoundAligned:facts.predictionMarketRoundAligned===true,
      dataFresh:fresh,gateFailures:missing,
      absorptionRiskAtFreeze:facts.absorptionRisk===true},
    candidates,
  };
}
export function summarizeNoBase15s(rounds){
  const all=Array.from(rounds?.values?.()||[]);
  const settled=all.filter(r=>{
    const f=r?.v3NoBase15sShadow,start=finite(r?.roundStartMs),seen=finite(f?.observedAt);
    return start!==null&&start>=V3_NO_BASE_15S_START_MS&&
      (r.actual==='UP'||r.actual==='DOWN')&&
      f?.version===V3_NO_BASE_15S_VERSION&&f.baseAbsentAtObservation===true&&
      f.inputFrozenBeforeSettlement===true&&seen!==null&&
      seen-start>=15000&&seen-start<=17000&&seen<start+300000&&
      r.officialDirection===r.actual&&
      String(r.resolutionEvidence||'').startsWith('OFFICIAL_'+r.actual+':')&&
      String(r.resolutionEvidence||'').includes('STRICT_ROUND_ALIGNED_TOPIC');
  }).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const candidates=V3_NO_BASE_15S_CONFIGS.map(cfg=>{
    const decisions=settled.filter(r=>['UP','DOWN'].includes(r.v3NoBase15sShadow.candidates?.[cfg.id]?.decision));
    const total=stats(decisions,cfg.id),recent20=stats(decisions.slice(-20),cfg.id);
    const up=stats(decisions.filter(r=>r.v3NoBase15sShadow.candidates[cfg.id].decision==='UP'),cfg.id);
    const down=stats(decisions.filter(r=>r.v3NoBase15sShadow.candidates[cfg.id].decision==='DOWN'),cfg.id);
    const recent10=stats(decisions.slice(-10),cfg.id);
    const upRecent6=stats(decisions.filter(r=>r.v3NoBase15sShadow.candidates[cfg.id].decision==='UP').slice(-6),cfg.id);
    const downRecent6=stats(decisions.filter(r=>r.v3NoBase15sShadow.candidates[cfg.id].decision==='DOWN').slice(-6),cfg.id);
    let streak=0,maxConsecutiveMisses=0;
    for(const r of decisions){if(r.v3NoBase15sShadow.candidates[cfg.id].decision!==r.actual){streak++;maxConsecutiveMisses=Math.max(maxConsecutiveMisses,streak);}else streak=0;}
    const qualified=total.samples>=V3_NO_BASE_15S_FORWARD_TARGET&&total.accuracy>=0.75&&
      recent20.samples>=20&&recent20.accuracy>=0.75&&recent10.samples>=10&&recent10.accuracy>=0.70&&
      up.samples>=10&&down.samples>=10&&up.accuracy>=0.70&&down.accuracy>=0.70&&
      upRecent6.samples>=6&&downRecent6.samples>=6&&upRecent6.accuracy>=0.70&&downRecent6.accuracy>=0.70&&
      maxConsecutiveMisses<=2;
    return {candidateId:cfg.id,status:qualified?'ELIGIBLE_FOR_INDEPENDENT_REVIEW':
      total.samples<V3_NO_BASE_15S_FORWARD_TARGET?'COLLECTING':'FORWARD_COMPLETE_NOT_QUALIFIED',
      strictForwardSamples:total.samples,targetSamples:V3_NO_BASE_15S_FORWARD_TARGET,
      hits:total.hits,misses:total.misses,forwardAccuracy:total.accuracy,
      recent10,recent20,up,down,upRecent6,downRecent6,maxConsecutiveMisses,incrementalCoverage:settled.length?
        Number((total.samples/settled.length).toFixed(4)):null,
      productionEffect:'NONE_SHADOW_ONLY'};
  });
  const noBaseSettled=settled.length;
  const why={};
  for(const r of settled)for(const x of r.v3NoBase15sShadow.facts?.gateFailures||[])
    why[x]=(why[x]||0)+1;
  return {version:V3_NO_BASE_15S_VERSION,prospectiveStartMs:V3_NO_BASE_15S_START_MS,
    scope:'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S',
    observedNoBaseSettledRounds:noBaseSettled,
    inputQualityBlockers:why,productionEffect:'NONE_SHADOW_ONLY',
    autoProduction:false,candidates};
}
