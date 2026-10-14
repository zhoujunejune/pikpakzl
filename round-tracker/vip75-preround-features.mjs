// The 2026-10-10 VIP75 coefficients are immutable. This module changes only
// the causal input snapshot: take the preceding round's final 22-10 second
// window, then fill genuinely unavailable fields with valid current-round data.
// Never convert a missing live feature to zero to manufacture a prediction.
export const VIP75_PREVIOUS_ROUND_INPUT_VERSION = 'PRIOR_ROUND_TAIL_22_TO_10S_PLUS_60_TO_22S_BACKFILL_V2';
export const VIP75_RAW_INPUT_KEYS = Object.freeze([
  'regimeScore','currentScore','microScore','currentTrendScore',
  'normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
  'normalizedMomentum180s','normalizedMomentum300s',
  'tradePressure15s','tradePressure60s','ofiNormalized5s','ofiNormalized60s',
  'rangePosition180','predictionMarketUpMid','absorptionRisk',
  'liveScore','distanceFromOpenBps',
]);
const ROUND_MS = 300000;
const TAIL_BEGIN = 22000;
const TAIL_END = 10000;
const BACKFILL_BEGIN = 60000;

function usable(key,value) {
  if (key === 'absorptionRisk') return typeof value === 'boolean';
  if (value === null || value === undefined || value === '' ||
      typeof value === 'boolean') return false;
  const number = Number(value);
  return Number.isFinite(number) &&
    (key !== 'predictionMarketUpMid' || (number >= 0 && number <= 1));
}

export function createVip75PreviousRoundInputs() {
  // One small, bounded cache. No settlement, price after lock or future round is
  // allowed to enter the model. Restarting mid-window starts with an empty cache.
  let tail = null;
  function capture(live,at=Date.now()) {
    const round = Number(live?.round);
    if (!Number.isSafeInteger(round) || round <= 0 || round % ROUND_MS !== 0 ||
        !Number.isFinite(at) || Math.floor(at / ROUND_MS)*ROUND_MS !== round ||
        at < round + ROUND_MS - BACKFILL_BEGIN ||
        at > round + ROUND_MS - TAIL_END ||
        !live?.facts || typeof live.facts !== 'object' ||
        live.facts.dataFresh === false) return false;
    if (!tail || tail.sourceRound !== round) {
      tail = {sourceRound:round,targetRound:round+ROUND_MS,
        firstAt:at,lastAt:at,samples:0,tailSamples:0,backupSamples:0,
        values:{},backupValues:{}};
    }
    const preferred=at>=round+ROUND_MS-TAIL_BEGIN;
    tail.samples++;
    if(preferred)tail.tailSamples++;else tail.backupSamples++;
    tail.lastAt=at;
    const destination=preferred?tail.values:tail.backupValues;
    for (const key of VIP75_RAW_INPUT_KEYS) {
      const value=live.facts[key];
      if (usable(key,value)) {
        destination[key]={value:key==='absorptionRisk'?value:Number(value),at};
      }
    }
    return true;
  }
  function prepare(targetRound,currentFacts) {
    const previous = tail && tail.targetRound === Number(targetRound) ? tail : null;
    const current = currentFacts && typeof currentFacts === 'object' &&
      currentFacts.dataFresh !== false ? currentFacts : {};
    const facts = {};
    const missing = [], fromPrevious = [], fromCurrent = [], fromPreviousBackup = [];
    for (const key of VIP75_RAW_INPUT_KEYS) {
      // A prediction-market quote belongs to a particular contract. Prefer
      // this round's quote over the earlier contract's tail quote if available.
      const preferCurrent = key === 'predictionMarketUpMid';
      const old=previous?.values[key]?.value;
      const earlier=previous?.backupValues[key]?.value;
      const fresh=current[key];
      if (preferCurrent && usable(key,fresh)) {
        facts[key] = key==='absorptionRisk'?fresh:Number(fresh);
        fromCurrent.push(key);
      } else if (usable(key,old)) {
        facts[key]=old;
        fromPrevious.push(key);
      } else if (usable(key,earlier)) {
        // Only fall back to the preceding round's 60-22 second window when
        // this feature has no usable observation in the preferred 22-10s tail.
        facts[key]=earlier;
        fromPrevious.push(key);
        fromPreviousBackup.push(key);
      } else if (usable(key,fresh)) {
        facts[key]=key==='absorptionRisk'?fresh:Number(fresh);
        fromCurrent.push(key);
      } else {
        missing.push(key);
      }
    }
    return {
      facts,complete:missing.length===0,missing,fromPrevious,fromCurrent,
      fromPreviousBackup,
      sourceRound:previous?.sourceRound??null,
      sourceWindow:previous?[previous.sourceRound+ROUND_MS-TAIL_BEGIN,
        previous.sourceRound+ROUND_MS-TAIL_END]:null,
      backupWindow:previous?[previous.sourceRound+ROUND_MS-BACKFILL_BEGIN,
        previous.sourceRound+ROUND_MS-TAIL_BEGIN]:null,
      inputVersion:VIP75_PREVIOUS_ROUND_INPUT_VERSION,
      priorContractQuoteUsed:fromPrevious.includes('predictionMarketUpMid'),
    };
  }
  function report() {
    return tail?{sourceRound:tail.sourceRound,targetRound:tail.targetRound,
      samples:tail.samples,tailSamples:tail.tailSamples,
      backupSamples:tail.backupSamples,
      collectedKeys:Object.keys(tail.values).length,
      backupKeys:Object.keys(tail.backupValues).length,
      firstAt:tail.firstAt,lastAt:tail.lastAt,
      version:VIP75_PREVIOUS_ROUND_INPUT_VERSION}:
      {sourceRound:null,targetRound:null,samples:0,tailSamples:0,
        backupSamples:0,collectedKeys:0,backupKeys:0,
        version:VIP75_PREVIOUS_ROUND_INPUT_VERSION};
  }
  return {capture,prepare,report};
}
