// Read-only, forward-only official Binance Prediction settlement statistics.
// This module cannot emit orders, signals, or modify settlements.
export const OFFICIAL_BREAKOUT20_MODEL='BREAKOUT20_RSI_MACD_RANGE_V1';
export const OFFICIAL_RESOLUTION_SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const valid=v=>v==='UP'||v==='DOWN';
function tally(items){
  const hits=items.filter(x=>x.direction===x.actual).length;
  return {samples:items.length,hits,accuracy:items.length?hits/items.length:null};
}
export function summarizeBreakout20Official(rows,{
  officialFromRow,
  model=OFFICIAL_BREAKOUT20_MODEL,
  maxRecent=50,
  retentionLimit=null,
}={}){
  if(typeof officialFromRow!=='function')throw new TypeError('officialFromRow required');
  const input=Array.from(rows||[]);
  const selected=input.filter(r=>
    r?.productionModel===model&&r?.productionModelVersion===model&&
    Number.isSafeInteger(Number(r?.roundStartMs))&&
    valid(r?.productionPrediction)&&
    Number.isFinite(Number(r?.productionGeneratedAt))&&
    Number(r.productionGeneratedAt)>=Number(r.roundStartMs)&&
    Number(r.productionGeneratedAt)<Number(r.roundStartMs)+8000)
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const normalized=selected.map(r=>{
    const actual=officialFromRow(r);
    const verified=valid(actual)?actual:null;
    return {
      t:Number(r.roundStartMs),direction:r.productionPrediction,
      actual:verified,status:verified?'SETTLED':'PENDING',
      result:verified?(r.productionPrediction===verified?'HIT':'MISS'):'PENDING',
      lockedAt:Number(r.productionGeneratedAt),
      delayMs:Number(r.productionGeneratedAt)-Number(r.roundStartMs),
      settlementSource:verified?OFFICIAL_RESOLUTION_SOURCE:null,
      resolutionEvidence:verified?String(r.resolutionEvidence||'OFFICIAL_PERSISTED_DIRECTION').slice(0,240):null,
    };
  });
  const settled=normalized.filter(x=>valid(x.actual));
  const up=settled.filter(x=>x.direction==='UP'),down=settled.filter(x=>x.direction==='DOWN');
  return {
    ok:true,model,displayName:'突破20%即可',
    source:OFFICIAL_RESOLUTION_SOURCE,
    statsScope:'CURRENT_MODEL_VERSION_PRODUCTION_LOCKS_ONLY',
    historicalArchiveIncluded:false,
    retentionLimit:Number.isInteger(retentionLimit)?retentionLimit:null,
    retentionMayLimitTotal:Number.isInteger(retentionLimit)&&input.length>=retentionLimit,
    generatedAt:Date.now(),
    results:{
      rounds:normalized.length,locked:normalized.length,pending:normalized.length-settled.length,
      overall:tally(settled),up:tally(up),down:tally(down),
      recent20:tally(settled.slice(-20)),recent100:tally(settled.slice(-100))
    },
    latest:normalized.at(-1)||null,
    recent:normalized.slice(-Math.min(100,Math.max(1,maxRecent))).reverse()
  };
}
