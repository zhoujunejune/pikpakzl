// 120-second prior-round DeepSeek analysis plus evidence-only current-round decisions before +40s.
// Never submit orders or invent future market data.
export const ROUND_MS=300000;
export const COLLECT_MS=120000;
export const DEADLINE_MS=40000;
export const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const number=x=>typeof x==='number'&&Number.isFinite(x);
const side=x=>x==='UP'||x==='DOWN';
export function makeWindow(round){
 if(!Number.isSafeInteger(round)||round%ROUND_MS!==0)throw Error('INVALID_ROUND');
 return {round,prior:[],early:[],passes:[],final:null,terminal:null,
  skips:[],provisionalWait:null,modelCalls:0,attemptedPasses:[],lastModelError:null};
}
export function marketTick(data,now){
 if(data?.ok!==true||data?.readOnly!==true||data?.symbol!=='BTCUSDT')throw Error('UNTRUSTED_MARKET');
 const q=data.latest||{};
 const at=Number(q.eventMs),round=Number(q.roundStartMs);
 const price=Number(q.lastPrice),open=Number(q.roundOpenPrice);
 if(!Number.isSafeInteger(at)||!Number.isSafeInteger(round)||round%ROUND_MS||
   !(price>0)||!(open>0)||q.marketFeedConnected===false||
   at>now+1000||now-at>4000)throw Error('STALE_OR_INVALID_MARKET');
 return {at,round,price,open};
}
export function collect(w,tick){
 if(w.final||w.terminal)return false;
 if(tick.round===w.round-ROUND_MS&&tick.at>=w.round-COLLECT_MS&&tick.at<w.round){
   if(w.prior.at(-1)?.at>=tick.at)return false;
   w.prior.push(tick);if(w.prior.length>150)w.prior.shift();return true;
 }
 if(tick.round===w.round&&tick.at>=w.round&&tick.at<w.round+DEADLINE_MS){
   if(w.early.at(-1)?.at>=tick.at)return false;
   w.early.push(tick);if(w.early.length>55)w.early.shift();return true;
 }
 return false;
}
export function decodeAnalysis(raw,round,asOf,pass){
 if(!['initial','review','current'].includes(pass)||!Number.isSafeInteger(asOf)||
    (pass==='current'?(asOf<round||asOf>=round+DEADLINE_MS):(asOf>=round||asOf<round-COLLECT_MS)))throw Error('NONCAUSAL_ANALYSIS');
 let j;try{j=JSON.parse(String(raw))}catch{throw Error('NON_JSON_LLM_OUTPUT')}
 if(!['UP','DOWN','WAIT'].includes(j?.direction))throw Error('INVALID_DIRECTION');
 const confidence=Number(j.confidence);
 if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw Error('INVALID_CONFIDENCE');
 return {pass,round,at:asOf,direction:j.direction,confidence,
   continueAnalysis:j.continueAnalysis===true,
   reason:String(j.reason||'').slice(0,250),
   risk:String(j.risk||'').slice(0,120),
   reasonToWait:String(j.reasonToWait||'').slice(0,150)};
}
export function historyPolicy(feedback={}){
 // Only verified, mature samples affect selective abstention. Do not
 // treat empirical hit rates as calibrated future probabilities.
 const size=Number(feedback?.samples)||0;
 const minDir=side('UP')?['UP','DOWN']:[]; // stable two-direction enumeration
 const confidencePenalty={UP:0,DOWN:0};
 for(const dir of minDir){
  const count=Number(feedback?.[dir==='UP'?'upSamples':'downSamples']);
  const acc=Number(feedback?.[dir==='UP'?'upHistoricalAccuracy':'downHistoricalAccuracy']);
  if(size>=50&&count>=30&&Number.isFinite(acc)&&acc<.46)
   confidencePenalty[dir]=.10;
 }
 return {confidencePenalty,adapted:size>=50,
   basis:'Official-settled historical performance only; no LLM weight fine-tuning'};
}
export function analysisRequest(w,pass,now,features,feedback={}){
 if(now<w.round-COLLECT_MS||now>=w.round+DEADLINE_MS||
    (pass!=='current'&&now>=w.round)||(pass==='current'&&now<w.round))throw Error('ANALYSIS_OUTSIDE_PRIOR_ROUND');
 if(w.prior.length<5||w.prior.at(-1).at-w.prior[0].at<20000)
  throw Error('INSUFFICIENT_PRE_ROUND_SAMPLES');
 const last=w.prior.at(-1);
 const latest=w.passes.at(-1)||null;
 const feedbackSafe=feedback&&typeof feedback==='object'?feedback:{};
 return {
  model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'high',
  max_tokens:4096,response_format:{type:'json_object'},
  messages:[
   {role:'system',content:[
    'You are a professional evidence-based BTCUSDT 5m prediction analyst.',
    'Analyse the BTC Prediction 5m target round using real observed causal evidence; current phase includes actual round open and early ticks.',
    'Before the round starts the official opening price is UNKNOWN; in the current phase use only observed prices and verified evidence. Never invent future prices or official settlement.',
    'Binance Prediction can settle against CHAINLINK. If officialPredictionReference is present, its officialStartPrice is the VERIFIED CURRENT-ROUND Chainlink reference START price, not a live Chainlink quote. Spot lastPrice and its ticks come from BINANCE SPOT; never falsely label spot prices as Chainlink. Assess the spot-vs-official-start difference with this source distinction. If absent, do not infer a missing Chainlink reference or pretend to know oracle price.',
    'Learn from older OFFICIALLY settled comparable cases; explain repeated failure patterns but beware small samples and overfitting.',
    'If indicators.quantSecondOpinion is available, use it as an UNTRAINED deterministic candle-and-momentum cross-check. It is NOT LightGBM, not a separate trained trading AI, not calibrated probability, and not an order signal. Compare it critically with observed current-round evidence; explicitly consider why its bias could be wrong. It must never override fresh DeepSeek reasoning or force a trade.',
    'Choose indicators, historical examples and analytic methods independently based on their relevance; none is mandatory.',
    'You may revise earlier opinions when new credible evidence supports doing so; do not reverse without evidence.',
    'For the CURRENT round, rank UP and DOWN using verified live opening price, tick trend, volatility and the most pertinent causal indicators. If one direction has meaningfully stronger support, make that best-effort UP/DOWN call even when prediction confidence is modest. Do not demand statistical proof from only 15–40 seconds of observations.',
    'Do not default to WAIT just because short-term BTC outcomes are uncertain. WAIT is appropriate when live data are stale or unusable, the new-round open is missing, directional evidence is genuinely indistinguishable or mutually contradictory, or there is no honest basis for preferring either side. Never invent a directional edge to increase trade volume.',
    'Any actionable UP/DOWN requires a fresh genuine DeepSeek review after new-round +15 seconds; a prior-round direction never authorizes a trade. In your JSON reason explain which observed evidence favored the chosen direction over the opposite side, and in risk disclose that accuracy is not verified.',
    'Never invent market data or future prices. If the supplied market data cannot be interpreted, do not manufacture an analysis.',
    'Return compact JSON {"direction":"UP","confidence":0.51,"continueAnalysis":false,"reason":"actual evidence","risk":"uncertainty or basis gap","reasonToWait":""}. Choose continueAnalysis=true only if more fresh market observations could improve the decision before the deadline.',
    'Confidence is SUBJECTIVE, not a calibrated win probability; a directional prediction is NOT an instruction to trade or proof of positive expected value.'
   ].join(' ')},
   {role:'user',content:JSON.stringify({
    targetRound:w.round,phase:pass,observedThrough:pass==='current'?(w.early.at(-1)?.at??last.at):last.at,
    firstSampleAt:w.prior[0].at,
    priorTwoMinuteTicks:w.prior.slice(-120),
    currentRoundTicks:pass==='current'?w.early.slice(-25):[],
    decisionDeadlineMs:w.round+DEADLINE_MS,
    indicators:features,
    officialPredictionReference:pass==='current'?(features?.officialReference||null):null,
    officialLiveChainlinkQuote:null,
    priorModelAnalysis:latest,
    verifiedHistoricalExperience:feedbackSafe,
    preferActionableDirectionalRanking:pass==='current',
    requireDirectionalForecast:false,
    technicalFailureMustNotBeGuessed:true
   })}
  ]
 };
}
export function registerAnalysis(w,decision){
 if(decision.round!==w.round||!['initial','review','current'].includes(decision.pass)||
   (decision.pass==='current'?(decision.at<w.round||decision.at>=w.round+DEADLINE_MS):decision.at>=w.round))throw Error('ANALYSIS_ROUND_INCORRECT');
 if(decision.pass!=='current'&&w.passes.some(x=>x.pass===decision.pass))throw Error('DUPLICATE_PASS');
 w.passes.push(decision);return decision;
}
export function closeExpiredWindow(w,now){
 if(w.final||w.terminal||now<w.round+DEADLINE_MS)return false;
 const reason=w.provisionalWait||w.skips.at(-1)||w.lastModelError||'NO_CONFIRMED_SIGNAL';
 w.terminal={round:w.round,status:'WAIT',direction:'WAIT',
  reason:'DEADLINE_40S_EXPIRED',detail:reason,at:w.round+DEADLINE_MS,
  signalGenerated:false,orders:false};
 return true;
}
function recordWait(w,reason,now){
 // A temporary WAIT is not a final decision. Continue observing real ticks
 // until the strict 25-second cutoff, without emitting an order signal.
 w.provisionalWait=reason;
 if(w.skips.at(-1)!==reason)w.skips.push(reason);
 return {ok:false,skip:true,provisional:true,round:w.round,
  direction:'WAIT',reason,deadline:w.round+DEADLINE_MS};
}
export function finalize(w,now,feedback={}){
 if(w.final)throw Error('ALREADY_LOCKED'); 
 if(w.terminal)return {ok:false,skip:true,round:w.round,direction:'WAIT',reason:w.terminal.reason};
 if(now<w.round+15000||now>=w.round+DEADLINE_MS)throw Error('NOT_IN_15_TO_40S_LOCK_WINDOW');
 const prior=w.prior,early=w.early;
 if(prior.length<5||prior.at(-1).at-prior[0].at<20000)
  throw Error('MISSING_LAST_120S');
 if(early.length<1)
  throw Error('EARLY_TICK_COVERAGE_MISSING');
 const latest=early.at(-1);
 if(now-latest.at>2500||latest.at>now)throw Error('NEW_ROUND_PRICE_STALE');
 const open=latest.open;
 if(Math.max(...early.map(x=>Math.abs(x.open/open-1)))>.003)
  throw Error('INCOHERENT_OPEN_PRICE');
 const first=w.passes.find(x=>x.pass==='initial');
 const review=w.passes.find(x=>x.pass==='review');
 const current=w.passes.filter(x=>x.pass==='current').at(-1);
 // Prefer the fresher valid DeepSeek analysis; if a legacy/errant review
 // chooses WAIT, retain the earlier genuine directional forecast instead.
 // Never fabricate a direction when BOTH model passes are unusable.
 // A prior-round forecast may help reasoning but can NEVER authorize a trade.
 // Require a genuine fresh DeepSeek response based on this round after +15s.
 if(!current||current.at<w.round+15000||current.at>=w.round+DEADLINE_MS)
   return recordWait(w,'NO_VALID_CURRENT_ROUND_DEEPSEEK_REVIEW',now);
 if(current.direction==='WAIT')return recordWait(w,'DEEPSEEK_CHOSE_WAIT',now);
 const chosen=current;
 if(!side(chosen.direction))return recordWait(w,'NO_ACTIONABLE_LLM_DIRECTION',now);
 const fromOpenBps=(latest.price/open-1)*10000;
 const priorBps=(prior.at(-1).price/prior[0].price-1)*10000;
 // DeepSeek alone decides the direction. No program-side market vote or reversal.
 const tentative=chosen.direction;
 const composite=chosen.confidence; // subjective, not a calibrated probability
 // Past verified outcomes inform the model, but software cannot override its opinion.
 const policy={basis:'INFORMATION_ONLY_NO_PROGRAM_DECISION_RULE'};
 const uncertainty='DEEPSEEK_AUTONOMOUS_UNCALIBRATED';
 // Real price and historical data inform DeepSeek but never override its decision.
 const result={ok:true,model:'DEEPSEEK_ADAPTIVE15_EXPERIENCE_V1',
  mode:'SHADOW_SIGNAL_ONLY',round:w.round,generatedAt:now,
  expiryAt:w.round+DEADLINE_MS,orders:false,productionIntegration:false,
  latest:{round:w.round,status:'LOCKED',direction:tentative,lockedAt:now,
   directionalPolicy:'DEEPSEEK_ONLY_WITH_VOLUNTARY_WAIT',uncertainty,
   marketAt:latest.at,openPrice:open,price:latest.price,
   fromOpenBps:Number(fromOpenBps.toFixed(3)),
   lastTwoMinuteBps:Number(priorBps.toFixed(3)),
   firstAnalysis:first?.direction||null,reviewAnalysis:review?.direction||null,
   currentAnalysis:current?.direction||null,selectedAnalysis:chosen.pass,modelConfidence:chosen.confidence,
   confidenceIsCalibrated:false,policy,hybridScore:Number(composite.toFixed(4)),
   historicalPenaltyAppliedAsBlock:false,
   reason:chosen.reason,aiVerified:true,analysisPhase:'current',
   analysisAt:chosen.at,earlySamples:early.length,priorSamples:prior.length}};
 w.provisionalWait=null;
 w.final=result;return result;
}
export function windowStatus(w,now){
 return {targetRound:w.round,prewarmBegin:w.round-COLLECT_MS,
  firstAnalysis:w.passes.find(x=>x.pass==='initial')?.direction||null,
  revisedAnalysis:w.passes.find(x=>x.pass==='review')?.direction||null,
  currentAnalysis:w.passes.filter(x=>x.pass==='current').at(-1)?.direction||null,
  priorSamples:w.prior.length,earlySamples:w.early.length,modelCalls:w.modelCalls,
  skipCount:w.skips.length,lastSkip:w.skips.at(-1)||null,
  provisionalWait:w.provisionalWait,
  deadline:w.round+DEADLINE_MS,signal:w.final,
  status:w.final?'LOCKED':w.terminal?'WAIT':now>=w.round+DEADLINE_MS?'WAIT':'ANALYZING',
  terminal:w.terminal,
  missed:now>=w.round+DEADLINE_MS&&!w.final};
}
