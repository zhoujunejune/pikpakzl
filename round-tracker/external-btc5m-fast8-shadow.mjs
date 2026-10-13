// BTC 5m microstructure research candidates; original lightweight JS adaptation
// of public *ideas* (not downloaded trained weights or validated win-rate claims).
// References: https://github.com/HorseDev77/bitcoin_price_up_down_prediction_5minute
//             https://github.com/yashvaidya42/BTC-microstructure-signal-detection
// Both external works trade selectively / target different inputs; this pure
// read-only shadow does NOT reproduce their reported accuracies or orders.
export const EXTERNAL_RESEARCH_VERSION = 'EXTERNAL_BTC5M_MICROSTRUCTURE_FAST8_V1';
export const EXTERNAL_RESEARCH_IDS = Object.freeze([
  'FLOW_BOOK_PROXY_V1',
  'MEAN_REVERSION_FLOW_PROXY_V1',
  'REGIME_SWITCH_PROXY_V1',
]);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a=-1, b=1) => Math.min(b, Math.max(a, v));
const normalized = (facts,key,scale=1) => finite(facts?.[key]) ? clamp(facts[key] / scale) : null;
const weighted = parts => {
  let n = 0, total = 0, available = 0;
  for (const [value,weight] of parts) {
    if (value === null) continue;
    n += weight * value;
    total += Math.abs(weight);
    available++;
  }
  return { score: total ? n / total : 0, available };
};
function side(score,baselineDirection) {
  if (score > 0) return 'UP';
  if (score < 0) return 'DOWN';
  return baselineDirection === 'DOWN' ? 'DOWN' : 'UP';
}
// Frozen, pre-settlement snapshots ONLY. Using normalized trade pressure as
// a CVD proxy and OFI as an order-book imbalance proxy; historical OI and
// VWAP are unavailable, so no "replication" of third-party results is claimed.
export function externalResearchDirections(facts={},{
  baselineDirection='UP',snapshotAvailable=false,
  dataQuality=[],sourceAt=null
}={}) {
  const current = normalized(facts,'currentScore');
  const trend = normalized(facts,'currentTrendScore');
  const micro = normalized(facts,'microScore');
  const regime = normalized(facts,'regimeScore');
  const momentum60 = normalized(facts,'normalizedMomentum60s');
  const momentum180 = normalized(facts,'normalizedMomentum180s');
  const momentum300 = normalized(facts,'normalizedMomentum300s');
  const pressure15 = normalized(facts,'tradePressure15s');
  const pressure60 = normalized(facts,'tradePressure60s');
  const ofi = normalized(facts,'ofiNormalized5s');
  const openDistance = normalized(facts,'distanceFromOpenBps',10);
  const mid = finite(facts.predictionMarketUpMid)
    ? clamp((facts.predictionMarketUpMid-0.5)*2) : null;
  const range = finite(facts.rangePosition180)
    ? clamp((facts.rangePosition180-0.5)*2) : null;

  // Microstructure continuation (trade-flow and real depth, not RSI-only).
  const flow = weighted([
    [ofi,0.27],[pressure15,0.17],[pressure60,0.16],[micro,0.09],
    [current,0.10],[trend,0.08],[regime,0.05],
    [momentum60,0.05],[mid,0.03],
  ]);
  // Mean reversion with order-flow confirmation and BTC position vs round open.
  // This is a research *proxy*, not the pretrained third-party XGBoost model.
  const revert = weighted([
    [momentum60,-0.20],[momentum180,-0.12],[momentum300,-0.06],
    [openDistance,-0.18],[range,-0.08],
    [ofi,0.13],[pressure15,0.12],[pressure60,0.06],[micro,0.05],
  ]);
  const trending = trend !== null && regime !== null &&
    Math.abs(trend) >= 0.55 && Math.abs(regime) >= 0.25 &&
    trend * regime > 0;
  const mixed = trending ? flow : revert;
  const dataProblems = Array.isArray(dataQuality) ? [...dataQuality] : ['UNKNOWN_DATA_QUALITY'];
  const validInput = snapshotAvailable === true && Number.isFinite(sourceAt) &&
    !dataProblems.some(x => x === 'NO_FRESH_SNAPSHOT' ||
      x === 'DEPTH_MISSING_OR_STALE' || x === 'TRADES_MISSING_OR_STALE');
  const insufficient = flow.available < 4 || revert.available < 4;
  const mode = trending ? 'TREND' : 'NON_TREND';
  const predictions = Object.fromEntries([
    ['FLOW_BOOK_PROXY_V1',flow],['MEAN_REVERSION_FLOW_PROXY_V1',revert],
    ['REGIME_SWITCH_PROXY_V1',mixed]
  ].map(([id,entry]) => {
    const fallback = !snapshotAvailable || entry.available < 4 || entry.score === 0;
    return [id,{direction:side(entry.score,baselineDirection),
      strength:entry.available >= 4 ? Number(Math.abs(entry.score).toFixed(6)) : null,
      // Strength is NOT a calibrated win probability.
      evidence: fallback ? 'BASELINE_OR_NO_INFO_FALLBACK'
        : validInput ? 'FROZEN_MICROSTRUCTURE_INPUT' : 'DEGRADED_MICROSTRUCTURE_INPUT',
      featureCount:entry.available,
      fallback,
    }];
  }));
  return {version:EXTERNAL_RESEARCH_VERSION,
    productionEffect:'NONE_SHADOW_ONLY',executionEligible:false,autoPromotion:false,
    predictedHorizonMs:300000,nominalDeadlineMs:8000,
    sourceAt:Number.isFinite(sourceAt)?sourceAt:null,
    fullQuality:validInput && !insufficient,
    regime:mode,dataQuality:dataProblems,
    predictions};
}
