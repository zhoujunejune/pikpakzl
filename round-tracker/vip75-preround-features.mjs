// The immutable frozen VIP75 weights are never retrained in this module.
// Market observations are continuous across 5-minute settlement boundaries;
// collect a larger preceding-round reserve (120-22s to close) and prioritize
// the original final 22-10s segment. Never invent any missing value.
export const VIP75_PREVIOUS_ROUND_INPUT_VERSION = 'PRIOR_ROUND_TAIL_22_TO_10S_RESERVE120_STRICT_V2';
export const VIP75_RAW_INPUT_KEYS = Object.freeze([
  'regimeScore','currentScore','microScore','currentTrendScore',
  'normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
  'normalizedMomentum180s','normalizedMomentum300s',
  'tradePressure15s','tradePressure60s','ofiNormalized5s','ofiNormalized60s',
  'rangePosition180','predictionMarketUpMid','absorptionRisk',
  'liveScore','distanceFromOpenBps',
]);
const ROUND_MS = 300000;
const TAIL_BEGIN = 22000, TAIL_END = 10000;
const RESERVE_BEGIN = 120000;

function usable(key,value) {
  if (key === 'absorptionRisk') return typeof value === 'boolean';
  if (value === null || value === undefined || value === '' ||
      typeof value === 'boolean') return false;
  const number = Number(value);
  return Number.isFinite(number) &&
    (key !== 'predictionMarketUpMid' || (number >= 0 && number <= 1));
}

export function createVip75PreviousRoundInputs() {
  // Bounded in-memory cache for a SINGLE preceding round. No settlement
  // labels, future observations or observations from earlier rounds enter it.
  let tail = null;
  function capture(live,at=Date.now()) {
    const round = Number(live?.round);
    if (!Number.isSafeInteger(round) || round <= 0 || round % ROUND_MS !== 0 ||
        !Number.isFinite(at) || Math.floor(at / ROUND_MS)*ROUND_MS !== round ||
        at < round + ROUND_MS - RESERVE_BEGIN ||
        at > round + ROUND_MS - TAIL_END ||
        !live?.facts || typeof live.facts !== 'object' ||
        live.facts.dataFresh === false) return false;
    if (!tail || tail.sourceRound !== round) {
      tail = {sourceRound:round,targetRound:round+ROUND_MS,
        firstAt:null,lastAt:null,samples:0,
        reserveSamples:0,values:{},reserveValues:{}};
    }
    const isPrimary=at>=round+ROUND_MS-TAIL_BEGIN;
    if (isPrimary) {
      tail.samples++;
      tail.firstAt ??= at;
      tail.lastAt = at;
    } else {
      tail.reserveSamples++;
    }
    for (const key of VIP75_RAW_INPUT_KEYS) {
      const value=live.facts[key];
      if (!usable(key,value)) continue;
      const record={value:key==='absorptionRisk'?value:Number(value),at};
      const dest=isPrimary?tail.values:tail.reserveValues;
      // Do not replace a newer real sample with delayed/stale delivery.
      if(!dest[key] || dest[key].at<=at) dest[key]=record;
    }
    return true;
  }
  function prepare(targetRound,currentFacts) {
    const previous = tail && tail.targetRound === Number(targetRound) ? tail : null;
    const current = currentFacts && typeof currentFacts === 'object' ? currentFacts : {};
    const facts = {};
    const missing = [], fromPrevious = [], fromCurrent = [], fromEarlierPrevious = [];
    for (const key of VIP75_RAW_INPUT_KEYS) {
      const old = previous?.values[key]?.value;
      const reserve = previous?.reserveValues[key]?.value;
      const fresh = current[key];
      // Prediction-market midquote refers to a contract, not continuous BTC
      // spot data. Old-contract quotes must NEVER substitute for new quotes.
      if (key === 'predictionMarketUpMid') {
        if (usable(key,fresh)) {
          facts[key] = Number(fresh); fromCurrent.push(key);
        } else missing.push(key);
      } else if (usable(key,old)) {
        facts[key] = old; fromPrevious.push(key);
      } else if (usable(key,reserve)) {
        facts[key] = reserve;
        fromPrevious.push(key);fromEarlierPrevious.push(key);
      } else if (usable(key,fresh)) {
        facts[key] = key==='absorptionRisk'?fresh:Number(fresh);
        fromCurrent.push(key);
      } else missing.push(key);
    }
    return {
      facts,complete:missing.length===0,missing,
      fromPrevious,fromEarlierPrevious,fromCurrent,
      sourceRound:previous?.sourceRound??null,
      sourceWindow:previous?[previous.sourceRound+ROUND_MS-TAIL_BEGIN,
        previous.sourceRound+ROUND_MS-TAIL_END]:null,
      reserveWindow:previous?[previous.sourceRound+ROUND_MS-RESERVE_BEGIN,
        previous.sourceRound+ROUND_MS-TAIL_BEGIN]:null,
      inputVersion:VIP75_PREVIOUS_ROUND_INPUT_VERSION,
      priorContractQuoteUsed:false,
    };
  }
  function report() {
    return tail?{
      sourceRound:tail.sourceRound,targetRound:tail.targetRound,
      samples:tail.samples,reserveSamples:tail.reserveSamples,
      collectedKeys:Object.keys(tail.values).length,
      reserveCollectedKeys:Object.keys(tail.reserveValues).length,
      firstAt:tail.firstAt,lastAt:tail.lastAt,
      version:VIP75_PREVIOUS_ROUND_INPUT_VERSION,
    }:{
      sourceRound:null,targetRound:null,samples:0,reserveSamples:0,
      collectedKeys:0,reserveCollectedKeys:0,
      version:VIP75_PREVIOUS_ROUND_INPUT_VERSION,
    };
  }
  return {capture,prepare,report};
}
