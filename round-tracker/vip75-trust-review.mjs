// A separate fail-closed quality review for user-pinned zl_new_vip75.
// The V2 quality check must evaluate the VIP75 direction against the same
// pre-settlement market snapshot, never reuse V3's unrelated base direction.
export const VIP75_TRUST_REVIEW_VERSION = 'VIP75_V2_TRUST_REVIEW_V1';
export const VIP75_MIN_RECENT_ACCURACY = 0.60;
export const VIP75_MIN_DIRECTION_ACCURACY = 0.60;
export const VIP75_MIN_RECENT_SAMPLES = 20;
export const VIP75_MIN_DIRECTION_SAMPLES = 15;

export function reviewVip75Signal({row, vip, v2Review, forwardStats, now}) {
  const reasons=[];
  const direction=vip?.direction;
  const facts=row?.shadowFacts;
  const start=Number(row?.roundStartMs);
  const observed=Number(vip?.generatedAt);
  if (!vip?.ready || (direction!=='UP' && direction!=='DOWN'))
    reasons.push('VIP75_NO_VALID_FROZEN_DIRECTION');
  if (!Number.isFinite(start) || !Number.isFinite(observed) ||
      !Number.isFinite(now) || observed < start + 10000 ||
      observed > start + 22000 || observed > now ||
      Number(row?.shadowObservedAt)!==observed ||
      row?.settledAt != null)
    reasons.push('VIP75_FROZEN_SNAPSHOT_INVALID');
  if (!facts || typeof facts!=='object')
    reasons.push('VIP75_MISSING_MARKET_FACTS');
  if (facts?.dataFresh===false)
    reasons.push('VIP75_STALE_MARKET_DATA');
  if (facts?.absorptionRisk===true)
    reasons.push('VIP75_ABSORPTION_RISK');
  const upMid=typeof facts?.predictionMarketUpMid==='number' ? facts.predictionMarketUpMid : NaN;
  if (!Number.isFinite(upMid) || upMid < 0 || upMid > 1)
    reasons.push('VIP75_MISSING_VALID_PREDICTION_MARKET_PRICE');
  const current=typeof facts?.currentScore==='number' ? facts.currentScore : NaN;
  if (!Number.isFinite(current))
    reasons.push('VIP75_MISSING_CURRENT_SCORE');
  if (Array.isArray(facts?.gateFailures) && facts.gateFailures.length>0)
    reasons.push('VIP75_INPUT_GATE_FAILURES');

  // Existing V2 quality gate is an independent audit of market support,
  // current-score strength, absorption, lock delay and recent V2 drift.
  // IMPORTANT: its input direction is the VIP75 direction (not V3).
  if (v2Review?.pass!==true || v2Review?.decision!==direction)
    reasons.push('VIP75_V2_MARKET_REVIEW_REJECTED');

  // A high-coverage model is NOT necessarily trustworthy: score live
  // strict-forward settlements separately, including the predicted side.
  const recent=forwardStats?.recent40;
  const byDir=direction==='UP' ? forwardStats?.up : forwardStats?.down;
  const recentN=Number(recent?.samples);
  const dirN=Number(byDir?.samples);
  if (!Number.isFinite(recentN) || recentN<VIP75_MIN_RECENT_SAMPLES ||
      !Number.isFinite(recent?.accuracy))
    reasons.push('VIP75_INSUFFICIENT_RECENT_OFFICIAL_FORWARD');
  else if (recent.accuracy<VIP75_MIN_RECENT_ACCURACY)
    reasons.push('VIP75_RECENT_FORWARD_ACCURACY_BELOW_60');
  if (!Number.isFinite(dirN) || dirN<VIP75_MIN_DIRECTION_SAMPLES ||
      !Number.isFinite(byDir?.accuracy))
    reasons.push('VIP75_INSUFFICIENT_DIRECTION_OFFICIAL_FORWARD');
  else if (byDir.accuracy<VIP75_MIN_DIRECTION_ACCURACY)
    reasons.push('VIP75_DIRECTION_FORWARD_ACCURACY_BELOW_60');

  return {
    version:VIP75_TRUST_REVIEW_VERSION,
    status:reasons.length?'REJECT':'PASS',
    pass:reasons.length===0,
    direction:direction==='UP'||direction==='DOWN'?direction:null,
    reasons,
    evaluatedAt:Number.isFinite(now)?now:null,
    preSettlementOnly:true,
    reviewer:'SELECTIVE_V2_INDEPENDENT_MARKET_AND_FORWARD_QUALITY',
    v2Quality:{
      pass:v2Review?.pass===true,
      reasons:Array.isArray(v2Review?.reasons)?[...v2Review.reasons]:['NO_V2_QUALITY_RESULT'],
      support:v2Review?.predictionSupport??null,
      currentScoreAbs:v2Review?.currentScoreAbs??null,
      directionalMode:v2Review?.directionalMode??null,
    },
    strictForward:{
      recent40:{samples:Number.isFinite(recentN)?recentN:0,accuracy:Number.isFinite(recent?.accuracy)?recent.accuracy:null},
      direction:{samples:Number.isFinite(dirN)?dirN:0,accuracy:Number.isFinite(byDir?.accuracy)?byDir.accuracy:null},
      thresholds:{recentAccuracy:VIP75_MIN_RECENT_ACCURACY,directionAccuracy:VIP75_MIN_DIRECTION_ACCURACY},
    },
  };
}
