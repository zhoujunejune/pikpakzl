// Forward-only VIP75 win-rate accounting by frozen model + actual input cohort.
// No historical row is relabeled after the fact: old production rows with no
// recorded input-version remain explicitly UNKNOWN, never counted in V2.
export const VIP75_UNKNOWN_INPUT_VERSION='LEGACY_INPUT_VERSION_UNRECORDED';
const isDirection=d=>d==='UP'||d==='DOWN';
const opposite=d=>d==='UP'?'DOWN':'UP';
const pct=(n,d)=>d?Number((100*n/d).toFixed(2)):null;

export function summarizeVip75VersionedStats(records,{
    modelVersion,currentInputVersion,modelName='zl_new_vip75'}={}) {
  const groups=new Map();
  const all=Array.from(records||[])
    .filter(r=>r?.productionModel===modelName && r.productionModelVersion)
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  for(const row of all){
    const trained=row.productionModelVersion===modelVersion &&
      row.productionFallbackUsed!==true;
    const inputVersion=typeof row.productionInputVersion==='string' &&
      row.productionInputVersion.trim()?row.productionInputVersion:
      VIP75_UNKNOWN_INPUT_VERSION;
    const id=JSON.stringify([row.productionModelVersion,inputVersion]);
    if(!groups.has(id))groups.set(id,{
      modelVersion:row.productionModelVersion,inputVersion,
      trainedPrediction:trained,
      signalRounds:0,settledRounds:0,unsettledRounds:0,
      officialSampleCount:0,originalHits:0,inverseHits:0,
      firstRound:null,lastRound:null,
      historicalInputVersionUnverified:inputVersion===VIP75_UNKNOWN_INPUT_VERSION,
      up:{samples:0,hits:0},down:{samples:0,hits:0},
      previousRoundFeaturesTotal:0,currentRoundFeaturesTotal:0,
      backupFeaturesTotal:0,featureCountSamples:0,
    });
    const c=groups.get(id);
    c.signalRounds++;
    const round=Number(row.roundStartMs);
    if(Number.isFinite(round)){
      if(c.firstRound===null)c.firstRound=round;
      c.lastRound=round;
    }
    if(Number.isInteger(row.productionPreviousRoundFeatureCount) &&
       Number.isInteger(row.productionCurrentRoundFeatureCount)){
      c.previousRoundFeaturesTotal+=row.productionPreviousRoundFeatureCount;
      c.currentRoundFeaturesTotal+=row.productionCurrentRoundFeatureCount;
      c.backupFeaturesTotal+=Number(row.productionPreviousBackupFeatureCount||0);
      c.featureCountSamples++;
    }
    const official=row.productionActual;
    if(!isDirection(official)){c.unsettledRounds++;continue;}
    c.settledRounds++;
    if(!trained||!isDirection(row.productionPrediction))continue;
    c.officialSampleCount++;
    const original=row.productionPrediction;
    if(original===official)c.originalHits++;
    if(opposite(original)===official)c.inverseHits++;
    const section=original==='UP'?c.up:c.down;
    section.samples++;
    if(original===official)section.hits++;
  }
  const cohorts=Array.from(groups.values()).map(x=>({
    ...x,
    originalMisses:x.officialSampleCount-x.originalHits,
    inverseMisses:x.officialSampleCount-x.inverseHits,
    originalAccuracyPct:pct(x.originalHits,x.officialSampleCount),
    inverseTheoreticalAccuracyPct:pct(x.inverseHits,x.officialSampleCount),
    up:{...x.up,accuracyPct:pct(x.up.hits,x.up.samples)},
    down:{...x.down,accuracyPct:pct(x.down.hits,x.down.samples)},
    averagePreviousRoundFeatures:x.featureCountSamples?
      Number((x.previousRoundFeaturesTotal/x.featureCountSamples).toFixed(2)):null,
    averageCurrentRoundFeatures:x.featureCountSamples?
      Number((x.currentRoundFeaturesTotal/x.featureCountSamples).toFixed(2)):null,
    averageOlderBackupFeatures:x.featureCountSamples?
      Number((x.backupFeaturesTotal/x.featureCountSamples).toFixed(2)):null,
  }));
  const current=cohorts.find(x=>x.modelVersion===modelVersion&&
    x.inputVersion===currentInputVersion)||null;
  return {
    modelName,modelVersion,currentInputVersion,current:current||{
      modelVersion,inputVersion:currentInputVersion,signalRounds:0,
      settledRounds:0,officialSampleCount:0,originalHits:0,
      originalMisses:0,inverseHits:0,inverseMisses:0,
      originalAccuracyPct:null,inverseTheoreticalAccuracyPct:null,
    },
    cohorts,
    cohortCount:cohorts.length,
    calculation:'FROZEN_ORIGINAL_DIRECTION_VS_OFFICIAL_UP_DOWN',
    inverseCalculation:'HYPOTHETICAL_FLIPPED_DIRECTION_VS_OFFICIAL_NOT_EXECUTED_ORDER_PNL',
    legacyWarning:'UNRECORDED_INPUT_VERSIONS_ARE_NOT_BACKFILLED',
    officialSettlementWarning:'REQUIRES_INDEPENDENT_VERIFICATION_OF_SETTLEMENT_SOURCE',
  };
}
