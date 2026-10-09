// Prospective, read-only 12s/15s lock-timing trial. Does NOT influence live V3/V2/Edge or orders.
export const VERSION = 'LOCK_TIMING_12_15_FORWARD_SHADOW_V1';
export const START_MS = Date.parse('2026-10-09T10:00:00.000Z');
export const WINDOWS = Object.freeze({
  t12: { startMs:12000, endMs:14500, currentMin:0.60, trendMin:0.60, blendedMin:0.30, pmMin:0.10 },
  t15: { startMs:15000, endMs:17500, currentMin:0.50, trendMin:0.55, blendedMin:0.25, pmMin:0.08 },
});
const finite = v => v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const ratio = (a,b) => b ? Number((a/b).toFixed(4)) : null;
const direction = v => v > 0 ? 'UP' : v < 0 ? 'DOWN' : 'WAIT';
const metric = rows => {
  const hits=rows.filter(x=>x.decision===x.actual).length;
  return { samples:rows.length,hits,misses:rows.length-hits,accuracy:ratio(hits,rows.length) };
};
function classify(f, cfg, sourceAt, now) {
  const reasons=[];
  if (!f || typeof f!=='object') return {decision:'WAIT',reasons:['MISSING_FACTS'],dataFresh:false};
  const current=finite(f.currentScore),trend=finite(f.currentTrendScore);
  const blend=finite(f.liveScore),distance=finite(f.distanceFromOpenBps);
  const mid=finite(f.predictionMarketUpMid),bookAge=finite(f.predictionMarketBookAgeMs);
  const depthAge=finite(f.depthAgeMs),tradeAge=finite(f.lastAggTradeAgeMs);
  const flow=finite(f.tradeCount15s);
  const sign=distance!=null&&distance>0?1:distance!=null&&distance<0?-1:0;
  if (!sign) reasons.push('NO_PRICE_SIDE');
  if (sourceAt==null||sourceAt>now||now-sourceAt>2500) reasons.push('STALE_OR_FUTURE_SOURCE');
  if (f.predictionMarketMappingReliable!==true||f.predictionMarketRoundAligned!==true)
    reasons.push('UNRELIABLE_OR_UNALIGNED_PM');
  if (mid==null||mid<0||mid>1||bookAge==null||bookAge<0||bookAge>5000)
    reasons.push('INVALID_OR_STALE_PM');
  if (depthAge==null||depthAge<0||depthAge>1500) reasons.push('STALE_DEPTH');
  if (tradeAge==null||tradeAge<0||tradeAge>12000||f.tradeStreamStalled===true)
    reasons.push('STALE_TRADES');
  if (flow==null||flow<12) reasons.push('INSUFFICIENT_15S_TRADES');
  if (f.absorptionRisk===true) reasons.push('ABSORPTION_RISK');
  if (sign!==0) {
    if (current==null||sign*current<cfg.currentMin) reasons.push('CURRENT_SCORE_LOW_OR_CONFLICT');
    if (trend==null||sign*trend<cfg.trendMin) reasons.push('TREND_LOW_OR_CONFLICT');
    if (blend==null||sign*blend<cfg.blendedMin) reasons.push('BLENDED_SCORE_LOW_OR_CONFLICT');
    if (distance==null||sign*distance<0.5) reasons.push('PRICE_MOVEMENT_LOW');
    if (mid==null||sign*(mid-0.5)<cfg.pmMin) reasons.push('PM_SUPPORT_LOW_OR_CONFLICT');
    const regime=String(f.regimeDirection||'');
    if ((regime==='UP'||regime==='DOWN')&&regime!==direction(sign)&&
        (finite(f.regimeAgreement)??0)>=0.67) reasons.push('STRONG_REGIME_CONFLICT');
  }
  return { decision:reasons.length===0?direction(sign):'WAIT', reasons,
    dataFresh:!reasons.some(r=>r.startsWith('STALE')||r.startsWith('INVALID')||
      r==='MISSING_FACTS'||r==='UNRELIABLE_OR_UNALIGNED_PM') };
}
export function freezeLockTimingSnapshot(row,live,now=Date.now()) {
  const start=finite(row?.roundStartMs);
  if (start==null||start<START_MS||!live||finite(live.round)!==start||now>=start+300000)
    return null;
  const elapsed=now-start;
  const window=Object.keys(WINDOWS).find(id=>
    elapsed>=WINDOWS[id].startMs&&elapsed<WINDOWS[id].endMs &&
    !row?.lockTimingForward?.[id]);
  if (!window) return null;
  const cfg=WINDOWS[window];
  const alreadyLocked=live.status==='LOCKED'||
    ['UP','DOWN'].includes(row.prediction)||row.predictedAt!=null;
  const sourceAt=finite(live.generatedAt);
  const outcome=alreadyLocked ?
    {decision:'WAIT',reasons:['V3_ALREADY_LOCKED'],dataFresh:null} :
    classify(live.facts,cfg,sourceAt,now);
  const snapshot={
    version:VERSION,round:start,window,observedAt:now,sourceAt,
    delayMs:elapsed,sourceStatus:alreadyLocked?'LOCKED':'WAIT',
    decision:outcome.decision,reasons:outcome.reasons,dataFresh:outcome.dataFresh,
    prospective:true,productionEffect:'NONE_SHADOW_ONLY',
    // Preserve only necessary values from the time of observation, never from settlement.
    observedCurrentScore:finite(live.facts?.currentScore),
    observedPredictionMarketUpMid:finite(live.facts?.predictionMarketUpMid),
  };
  return {window,snapshot};
}
function accepted(row,window) {
  const f=row?.lockTimingForward?.[window],start=finite(row?.roundStartMs);
  const cfg=WINDOWS[window];
  return Boolean(cfg&&f?.version===VERSION&&f?.window===window&&
    f?.round===start&&f?.prospective===true&&f?.productionEffect==='NONE_SHADOW_ONLY'&&
    f?.sourceStatus==='WAIT'&&['UP','DOWN'].includes(f?.decision)&&
    finite(f.observedAt)!=null&&finite(f.sourceAt)!=null&&
    f.observedAt-start>=cfg.startMs&&f.observedAt-start<cfg.endMs&&
    f.sourceAt<=f.observedAt&&f.observedAt-f.sourceAt<=2500&&
    f.observedAt<start+300000);
}
export function summarizeLockTimingForward(rounds) {
  const settled=Array.from(rounds?.values?.()||[]).filter(r=>
    Number(r.roundStartMs)>=START_MS&&
    (r.actual==='UP'||r.actual==='DOWN')&&r.officialDirection===r.actual&&
    String(r.resolutionEvidence||'').startsWith('OFFICIAL_'+r.actual+':')&&
    String(r.resolutionEvidence||'').includes('STRICT_ROUND_ALIGNED_TOPIC')
  ).sort((a,b)=>a.roundStartMs-b.roundStartMs);
  const make=(id)=>settled.filter(r=>accepted(r,id)).map(r=>({
    round:r.roundStartMs,decision:r.lockTimingForward[id].decision,actual:r.actual,
    productionPrediction:r.productionPrediction,rawPrediction:r.prediction,
    rawPredictedAt:r.predictedAt,observedAt:r.lockTimingForward[id].observedAt,
  }));
  const t12=make('t12'),t15=make('t15');
  const priority=new Map();
  for (const x of [...t12,...t15]) if(!priority.has(x.round))priority.set(x.round,x);
  const summarize=(rows)=>{
    const recent20=rows.slice(-20),recent10=rows.slice(-10);
    const extra=rows.filter(x=>!['UP','DOWN'].includes(x.productionPrediction));
    const up=rows.filter(x=>x.decision==='UP'),down=rows.filter(x=>x.decision==='DOWN');
    const all=metric(rows),u=metric(up),d=metric(down),r20=metric(recent20),r10=metric(recent10);
    const qualifies=all.samples>=60&&all.accuracy>=0.75&&recent20.length>=20&&r20.accuracy>=0.75&&
      recent10.length>=10&&r10.accuracy>=0.7&&up.length>=10&&down.length>=10&&
      u.accuracy>=0.70&&d.accuracy>=0.70;
    return { ...all, recent20:r20,recent10:r10,up:u,down:d,incrementalOverProduction:metric(extra),
      qualifiedForIndependentReview:qualifies,
      status:qualifies?'ELIGIBLE_FOR_INDEPENDENT_REVIEW':
        all.samples<60?'COLLECTING':'NOT_QUALIFIED',
      coverageOverSettled:ratio(rows.length,settled.length),
      incrementalCoverageOverSettled:ratio(extra.length,settled.length),
      rawV3LockedLater:rows.filter(x=>['UP','DOWN'].includes(x.rawPrediction)&&
        Number(x.rawPredictedAt)>x.observedAt).length
    };
  };
  const p=[...priority.values()].sort((x,y)=>x.round-y.round);
  const counts={};
  for(const id of Object.keys(WINDOWS)){
    const seen=settled.map(r=>r.lockTimingForward?.[id]).filter(x=>x?.version===VERSION);
    counts[id]={observed:seen.length,alreadyLocked:seen.filter(x=>x.sourceStatus==='LOCKED').length,
      noSignal:seen.filter(x=>x.decision==='WAIT'&&x.sourceStatus==='WAIT').length};
  }
  return {version:VERSION,scope:'PROSPECTIVE_OFFICIAL_SETTLED_STRICT_FORWARD_LOCK_TIMING',
    observedOfficialSettledRounds:settled.length,windows:counts,
    early12:summarize(t12),early15:summarize(t15),priority12Then15:summarize(p),
    comparison:{productionSignalAndRiskRulesChanged:false,productionLockWindowChanged:false,
      observe20sRescueSeparately:true},
    productionEffect:'NONE_SHADOW_ONLY',autoProduction:false};
}