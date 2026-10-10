// User-selected 15-second CURRENT + mapped Binance prediction-market confirmation.
// This is a live, unverified production fallback, NOT a 75%-qualified model.
// The retrospective cohort contained 9 hits from 11 observations; it is not a
// validated probability and must never be advertised as one.
export const USER_CURRENT_PM_VERSION = 'USER_CURRENT_PM_15S_V1';
export const USER_CURRENT_PM_SOURCE = 'USER_CURRENT_PM_15S_PRIMARY';
export const USER_CURRENT_PM_START_MS = Date.parse('2026-10-10T12:40:00.000Z');
export const USER_CURRENT_PM_MIN_SCORE = 0.25;
export const USER_CURRENT_PM_MIN_COMBINED = 0.0075;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDir = x => x === 'UP' || x === 'DOWN';
const roundMs = 300000;
const DELAY_MIN = 15000;
const DELAY_MAX = 17000;
const SIGNAL_DEADLINE = 20000;

export function freezeUserCurrentPm(row, facts, now=Date.now()) {
  if(!row || !facts || typeof facts!=='object' || !finite(now) ||
     !finite(row.roundStartMs) || row.roundStartMs < USER_CURRENT_PM_START_MS ||
     (now-row.roundStartMs)<DELAY_MIN || (now-row.roundStartMs)>DELAY_MAX ||
     validDir(row.productionPrediction) || row.actual==='UP' || row.actual==='DOWN' ||
     row.settledAt || now>=row.roundStartMs+roundMs) return null;
  const reasons=[];
  const bookAge=facts.predictionMarketBookAgeMs;
  const depthAge=facts.depthAgeMs;
  const tradeAge=facts.lastAggTradeAgeMs;
  const flow=facts.tradeCount15s;
  const score=facts.currentScore;
  const pm=facts.predictionMarketUpMid;
  if(facts.predictionMarketMappingReliable!==true)
    reasons.push('PM_MAPPING_NOT_VERIFIED');
  if(facts.predictionMarketRoundAligned!==true)
    reasons.push('PM_TOPIC_NOT_ROUND_ALIGNED');
  if(facts.predictionMarketTopicId===null || facts.predictionMarketTopicId===undefined ||
     String(facts.predictionMarketTopicId).trim()==='')
    reasons.push('PM_TOPIC_ID_MISSING');
  if(!finite(bookAge) || bookAge<0 || bookAge>5000)
    reasons.push('PM_BOOK_STALE_OR_MISSING');
  if(!finite(pm) || pm<0 || pm>1)
    reasons.push('PM_MID_MISSING_OR_INVALID');
  if(!finite(depthAge) || depthAge<0 || depthAge>1500)
    reasons.push('DEPTH_STALE_OR_MISSING');
  if(facts.tradeStreamStalled===true || !finite(tradeAge) ||
     tradeAge<0 || tradeAge>12000)
    reasons.push('AGGTRADE_STREAM_STALE');
  if(!finite(flow) || flow<8)
    reasons.push('TRADE_COUNT_TOO_LOW');
  if(!finite(score) || score < -1 || score>1)
    reasons.push('CURRENT_SCORE_INVALID');
  const side=finite(score) ? Math.sign(score) : 0;
  const pmMargin=(finite(pm) && side!==0) ? side*(pm-0.5) : null;
  const combined=pmMargin!==null && finite(score) ? Math.abs(score)*pmMargin : null;
  if(side===0 || Math.abs(score)<USER_CURRENT_PM_MIN_SCORE)
    reasons.push('CURRENT_SCORE_BELOW_0_25');
  if(pmMargin===null || pmMargin<=0)
    reasons.push('PM_DIRECTION_CONFLICT_OR_NEUTRAL');
  if(combined===null || combined<USER_CURRENT_PM_MIN_COMBINED)
    reasons.push('CURRENT_PM_COMBINED_BELOW_0_0075');
  // Absorption warnings are recorded, not silently discarded. The user
  // explicitly selected the empirical formula, which includes absorption rounds.
  const decision=reasons.length===0?(side>0?'UP':'DOWN'):'WAIT';
  return {
    version:USER_CURRENT_PM_VERSION,round:row.roundStartMs,
    observedAt:now,observedDelayMs:now-row.roundStartMs,
    inputFrozenBeforeSettlement:true,
    direction:decision,reasons,
    sourceMarketTopicId:facts.predictionMarketTopicId??null,
    facts:{
      score:finite(score)?score:null,
      predictionMarketUpMid:finite(pm)?pm:null,
      signedPmMargin:pmMargin,
      combinedScore:combined,
      bookAgeMs:finite(bookAge)?bookAge:null,
      depthAgeMs:finite(depthAge)?depthAge:null,
      tradeAgeMs:finite(tradeAge)?tradeAge:null,
      tradeCount15s:finite(flow)?flow:null,
      absorptionRisk:facts.absorptionRisk===true
    },
    provenance:'PRE_SETTLEMENT_IMMUTABLE',
    retrospectiveReference:{samples:11,hits:9,notForwardVerified:true}
  };
}

export function userCurrentPmFuse(rounds, currentRound) {
  const settled=Array.from(rounds?.values?.()||[])
    .filter(x=>x&&finite(x.roundStartMs)&&x.roundStartMs < currentRound &&
      x.productionSource===USER_CURRENT_PM_SOURCE &&
      (x.productionResult==='HIT'||x.productionResult==='MISS') &&
      (x.productionActual==='UP'||x.productionActual==='DOWN') &&
      x.officialDirection===x.productionActual &&
      String(x.resolutionEvidence||'').startsWith('OFFICIAL_'+x.productionActual+':') &&
      String(x.resolutionEvidence||'').includes('STRICT_ROUND_ALIGNED_TOPIC'))
    .sort((a,b)=>a.roundStartMs-b.roundStartMs);
  const recent5=settled.slice(-5);
  const recent10=settled.slice(-10);
  const ratio=a=>a.length?a.filter(x=>x.productionResult==='HIT').length/a.length:null;
  const last=settled.at(-1);
  const cooldownUntil=last?last.roundStartMs+6*roundMs:0;
  const missStreak=settled.length>=2 &&
    settled.at(-1).productionResult==='MISS' &&
    settled.at(-2).productionResult==='MISS';
  const weak5=recent5.length>=5&&ratio(recent5)<0.60;
  const weak10=recent10.length>=10&&ratio(recent10)<0.70;
  const cooling=(missStreak||weak5||weak10) && currentRound<=cooldownUntil;
  return {
    allowed:!cooling,
    reason:cooling?'RECENT_QUALITY_COOLDOWN':null,
    totalSamples:settled.length,
    last5Accuracy:ratio(recent5),
    last10Accuracy:ratio(recent10),
    missStreak:missStreak?2:0,
    cooldownUntilRound:cooling?cooldownUntil:null
  };
}

export function selectUserCurrentPm(row, rounds, now=Date.now()) {
  const reject=reason=>({allowed:false,reason,candidate:null,fuse:null});
  if(!row||!finite(now)||!finite(row.roundStartMs))return reject('INVALID_ROUND');
  if(validDir(row.productionPrediction)||row.actual==='UP'||row.actual==='DOWN'||row.settledAt)
    return reject('ROUND_ALREADY_LOCKED_OR_SETTLED');
  const start=row.roundStartMs;
  if(now-start<DELAY_MIN||now-start>SIGNAL_DEADLINE || now>=start+roundMs)
    return reject('OUTSIDE_LIVE_15S_RESCUE_WINDOW');
  const frozen=row.userCurrentPm15s;
  if(!frozen||frozen.version!==USER_CURRENT_PM_VERSION ||
     frozen.round!==start || !frozen.inputFrozenBeforeSettlement ||
     !finite(frozen.observedAt)||frozen.observedAt-start<DELAY_MIN ||
     frozen.observedAt-start>DELAY_MAX||frozen.observedAt>now ||
     !Array.isArray(frozen.reasons)||frozen.reasons.length!==0 ||
     !validDir(frozen.direction))
    return reject('NO_VERIFIED_FROZEN_CURRENT_PM_CANDIDATE');
  const f=frozen.facts||{};
  if(!finite(f.score)||Math.abs(f.score)<USER_CURRENT_PM_MIN_SCORE ||
     !finite(f.predictionMarketUpMid)||f.predictionMarketUpMid<0||f.predictionMarketUpMid>1 ||
     !finite(f.signedPmMargin)||f.signedPmMargin<=0 ||
     !finite(f.combinedScore)||f.combinedScore<USER_CURRENT_PM_MIN_COMBINED ||
     Math.sign(f.score)!==(frozen.direction==='UP'?1:-1)||
     !finite(f.bookAgeMs)||f.bookAgeMs<0||f.bookAgeMs>5000||
     !finite(f.depthAgeMs)||f.depthAgeMs<0||f.depthAgeMs>1500||
     !finite(f.tradeAgeMs)||f.tradeAgeMs<0||f.tradeAgeMs>12000||
     !finite(f.tradeCount15s)||f.tradeCount15s<8||
     !frozen.sourceMarketTopicId)
    return reject('FROZEN_QUALITY_RECHECK_FAILED');
  if(validDir(row.prediction)&&row.prediction!==frozen.direction)
    return reject('V3_BASE_DIRECTION_CONFLICT');
  const fuse=userCurrentPmFuse(rounds,start);
  if(!fuse.allowed)return {allowed:false,reason:fuse.reason,candidate:null,fuse};
  return {allowed:true,reason:null,fuse,candidate:{
    direction:frozen.direction,generatedAt:frozen.observedAt,
    score:f.score,topicId:frozen.sourceMarketTopicId,
    pmUpMid:f.predictionMarketUpMid,combinedScore:f.combinedScore,
    absorptionRisk:f.absorptionRisk===true
  }};
}
