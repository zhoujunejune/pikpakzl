// Strict forward statistics for frozen VIP75. The trained model ID and
// observation/input version are distinct. Legacy rounds whose provenance was
// never durably recorded must NEVER be retroactively assigned a newer version.
export const VIP75_LEGACY_UNKNOWN_INPUT = 'UNATTRIBUTED_LEGACY_INPUT';

function validDirection(s) { return s==='UP'||s==='DOWN'; }
function percent(a,b) {return b?Number((100*a/b).toFixed(2)):null;}
function summarize(rows,calendar) {
  const signals=rows.filter(r=>validDirection(r.productionPrediction) &&
    r.productionFallbackUsed!==true);
  // Official Binance Prediction resolutions only; exclude unverified
  // K-line/proxy labels from *both* original and hypothetical inverse metrics.
  const settled=signals.filter(r=>validDirection(r.productionActual) &&
    r.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION');
  const hits=settled.filter(r=>r.productionPrediction===r.productionActual).length;
  const misses=settled.length-hits;
  const signalRounds=signals.length;
  const startRound=signals.length?Math.min(...signals.map(r=>Number(r.roundStartMs))):null;
  const settledEligible=calendar.filter(r=>validDirection(r.productionActual) &&
    r.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION').length;
  return {
    startRound,signalRounds,settledRounds:settled.length,hits,misses,
    accuracyPct:percent(hits,settled.length),
    originalDirection:{hits,misses,accuracyPct:percent(hits,settled.length)},
    // This is a hypothetical inverted prediction, not an exchange-fill or PnL
    // statistic. Actual order results must be obtained from trade-control.
    hypotheticalInverseDirection:{hits:misses,misses:hits,
      accuracyPct:percent(misses,settled.length),isActualOrderWinRate:false},
    eligibleSettledRounds:settledEligible,
    coveragePct:percent(settled.length,settledEligible),
    officialResolutionOnly:true,
    actualExecutedOrderWinRatePct:null,
  };
}

export function vip75StatsByInputVersion(rows,modelVersion,currentInputVersion) {
  const all=Array.from(rows).filter(r=>r.productionModel==='zl_new_vip75' &&
    (r.productionModelVersion===modelVersion ||
     r.productionModelVersion===modelVersion+':NO_INFORMATION'))
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const authentic=all.filter(r=>r.productionModelVersion===modelVersion &&
    r.productionFallbackUsed!==true);
  const versions=new Map();
  for(const r of authentic) {
    const key=typeof r.productionInputVersion==='string' &&
      r.productionInputVersion.trim()?r.productionInputVersion:VIP75_LEGACY_UNKNOWN_INPUT;
    if(!versions.has(key))versions.set(key,[]);
    versions.get(key).push(r);
  }
  const versionMetrics={};
  for(const [version,items] of versions) {
    const start=Number(items[0].roundStartMs);
    // For an older cohort, calendar coverage cannot be isolated after the
    // first later-version lock: distinguish it from prediction win rate.
    const nextVersionStart=authentic.find(r=>Number(r.roundStartMs)>start &&
      (r.productionInputVersion||VIP75_LEGACY_UNKNOWN_INPUT)!==version)?.roundStartMs;
    const until=nextVersionStart==null?Infinity:Number(nextVersionStart);
    const calendar=all.filter(r=>Number(r.roundStartMs)>=start &&
      Number(r.roundStartMs)<until);
    versionMetrics[version]={
      inputVersion:version,
      modelVersion,attributed:version!==VIP75_LEGACY_UNKNOWN_INPUT,
      ...summarize(items,calendar),
      coverageDenominatorNote:'RECORDED_MODEL_ROUNDS_ONLY_NO_UNSIGNALED_ROUND_BACKFILL',
    };
  }
  const current=versionMetrics[currentInputVersion]||{
    inputVersion:currentInputVersion,modelVersion,attributed:true,
    ...summarize([],[]),coverageDenominatorNote:'NO_CURRENT_VERSION_SIGNAL_YET',
  };
  const historicalCombined=summarize(authentic,all);
  const oldParityFallbacks=all.filter(r=>r.productionFallbackUsed===true).length;
  return {
    id:'zl_new_vip75',version:modelVersion,
    inputVersion:currentInputVersion,
    statsScope:'CURRENT_EXACT_INPUT_VERSION_ONLY',
    ...current,
    byInputVersion:versionMetrics,
    unknownLegacyInputVersion:VIP75_LEGACY_UNKNOWN_INPUT,
    historicalCombined:{
      ...historicalCombined,
      warning:'MIXED_INPUT_VERSIONS_HISTORICAL_NOT_CURRENT_WIN_RATE',
      legacyNoInformationDirections:oldParityFallbacks,
    },
    noInformationRounds:oldParityFallbacks,
    winRateNote:'ORIGINAL_AND_HYPOTHETICAL_INVERSE_OFFICIAL_ONLY; NOT_ACTUAL_EXECUTED_ORDER_PNL',
    eligibleForAutoTrading:true,accuracyGuaranteed:false,
  };
}
