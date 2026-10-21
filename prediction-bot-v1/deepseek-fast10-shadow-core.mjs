// DeepSeek FAST10 experimental analysis core, NOT connected to production orders.
// Target: warm on the previous round's last 120s; combine next-round opening price
// and available first ~8s ticks; one direction strictly before round+10s.
export const ROUND_MS=300000;
export const PREWARM_LOOKBACK_MS=120000;
export const LOCK_DEADLINE_MS=10000;
const isNum=x=>typeof x==='number'&&Number.isFinite(x);
const clip=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const side=x=>x==='UP'||x==='DOWN';
export const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const blank=(forRound)=>({forRound,prior:[],early:[],prewarm:null,signal:null,errors:[]});
export function newWindow(forRound){
 if(!Number.isSafeInteger(forRound)||forRound%ROUND_MS!==0)throw Error('ROUND_ID_REQUIRED');
 return blank(forRound);
}
export function normalizeMarket(raw,now){
 if(raw?.ok!==true||raw?.readOnly!==true||raw?.symbol!=='BTCUSDT')
  throw Error('UNTRUSTED_SPOT_MARKET');
 const q=raw.latest||{},at=Number(q.eventMs),r=Number(q.roundStartMs);
 const price=Number(q.lastPrice),open=Number(q.roundOpenPrice);
 if(!Number.isSafeInteger(at)||!Number.isSafeInteger(r)||r%ROUND_MS!==0||
    !isNum(price)||!isNum(open)||price<=0||open<=0||
    q.marketFeedConnected===false||at>now+1000||now-at>4000)
   throw Error('INVALID_OR_STALE_TICK');
 return {at,round:r,price,open,
   earlyElapsedMs:at-r,
   features:raw.candles?{has1m:Boolean(raw.candles['1m']),has5m:Boolean(raw.candles['5m'])}:null};
}
function pushUnique(rows,tick,max=140){
 if(rows.some(x=>x.at===tick.at))return false;
 if(rows.length&&tick.at<rows.at(-1).at)return false;
 rows.push({at:tick.at,price:tick.price,open:tick.open});
 if(rows.length>max)rows.splice(0,rows.length-max);
 return true;
}
export function observe(window,tick){
 if(window.signal)return false;
 const target=window.forRound;
 if(tick.round===target-ROUND_MS&&tick.at>=target-PREWARM_LOOKBACK_MS&&tick.at<target){
  return pushUnique(window.prior,tick);
 }
 if(tick.round===target&&tick.at>=target&&tick.at<target+LOCK_DEADLINE_MS){
  return pushUnique(window.early,tick,20);
 }
 return false;
}
export function parsePrewarm(text,forRound,at){
 if(!Number.isSafeInteger(at)||at>=forRound||at<forRound-PREWARM_LOOKBACK_MS)
  throw Error('PREWARM_MUST_BE_CAUSAL');
 let j;
 try{j=JSON.parse(String(text))}catch{throw Error('PREWARM_NON_JSON')}
 if(!side(j?.direction))throw Error('PREWARM_DIRECTION_REQUIRED');
 if(!isNum(j.confidence)||j.confidence<0||j.confidence>1)
  throw Error('PREWARM_CONFIDENCE_INVALID');
 return {forRound,createdAt:at,direction:j.direction,
    confidence:j.confidence,reason:String(j.reason||'').slice(0,120),
    source:'DEEPSEEK_PRE_ROUND'};
}
export function prewarmRequest(window,now,features){
 const target=window.forRound;
 if(now<target-PREWARM_LOOKBACK_MS||now>=target)
   throw Error('NOT_IN_PREWARM_PERIOD');
 if(window.prior.length<5||window.prior.at(-1).at-window.prior[0].at<20000)
   throw Error('PRIOR_SAMPLES_INSUFFICIENT');
 const latest=window.prior.at(-1);
 const priorWindow=window.prior.filter(x=>x.at>=target-PREWARM_LOOKBACK_MS);
 return {
  model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'high',
  max_tokens:600,response_format:{type:'json_object'},
  messages:[
   {role:'system',content:[
    'Estimate a PROVISIONAL BTCUSDT direction for the NEXT Binance five-minute prediction round.',
    'This is pre-round evidence only; the NEXT round opening price is not yet known.',
    'Use the trailing market snapshots and causal features. Never invent the next open price or future observations.',
    'Choose UP or DOWN as a provisional directional lean. Return JSON only:',
    '{"direction":"UP or DOWN","confidence":0.5,"reason":"brief explanation"}.',
    'Confidence is subjective, not a calibrated win probability.'
   ].join(' ')},
   {role:'user',content:JSON.stringify({
    targetRound:target,observedUntil:now,
    firstObservedAt:priorWindow[0].at,latestObservedAt:latest.at,
    priorTwoMinuteTicks:priorWindow.slice(-120),
    priorIndicators:features||null
   })}
  ]
 };
}
export function finalize(window,now){
 const target=window.forRound;
 if(window.signal)throw Error('ALREADY_LOCKED');
 if(now<target+6500||now>=target+LOCK_DEADLINE_MS)
   throw Error('OUTSIDE_FAST10_FINAL_WINDOW');
 const pre=window.prewarm;
 if(!pre||pre.forRound!==target||pre.createdAt>=target||!side(pre.direction))
   throw Error('VALID_DEEPSEEK_PREWARM_REQUIRED');
 const early=window.early,prior=window.prior;
 if(early.length<3||early.at(-1).at-early[0].at<3500)
   throw Error('INSUFFICIENT_NEW_ROUND_TICKS');
 const latest=early.at(-1);
 if(now-latest.at>2500||latest.at>now)
   throw Error('NEW_ROUND_TICK_STALE');
 if(prior.length<5||prior.at(-1).at-prior[0].at<20000)
   throw Error('INSUFFICIENT_PREVIOUS_ROUND_DATA');
 const opening=early[0].open;
 if(!early.every(x=>Math.abs(x.open/opening-1)<.00001))
   throw Error('ROUND_OPEN_PRICE_CHANGED');
 // Experiment-only heuristic. These weights MUST be forward-tested before
 // becoming a production order signal. No fabricated statistical calibration.
 const earlyBps=(latest.price/opening-1)*10000;
 const prevBps=(prior.at(-1).price/prior[0].price-1)*10000;
 const preScore=pre.direction==='UP'?1:-1;
 const score=0.35*preScore+0.55*clip(earlyBps/8,-1,1)+0.1*clip(prevBps/20,-1,1);
 const direction=score===0?pre.direction:score>0?'UP':'DOWN';
 const result={
  ok:true,mode:'SHADOW_NO_ORDERS',model:'DEEPSEEK_PREWARM_FAST10_SHADOW_V1',
  round:target,generatedAt:now,expiryAt:target+LOCK_DEADLINE_MS,
  latest:{round:target,status:'LOCKED',direction,lockedAt:now,marketAt:latest.at,
   reason:'Pre-round DeepSeek + new-round opening price and observed early BTC ticks',
   rawPrewarmDirection:pre.direction,
   priorSnapshots:prior.length,earlySnapshots:early.length,observedEarlySeconds:(latest.at-target)/1000,
   openPrice:opening,price:latest.price,fromOpenBps:Number(earlyBps.toFixed(3)),
   previousTwoMinuteBps:Number(prevBps.toFixed(3)),
   rawHybridScore:Number(score.toFixed(4)),
   scoreIsCalibratedProbability:false},
  orders:false,realOrderEnabled:false,productionIntegration:false
 };
 window.signal=result;
 return result;
}
export function stateInfo(window,now){
 return {ok:true,model:'DEEPSEEK_PREWARM_FAST10_SHADOW_V1',mode:'SHADOW_NO_ORDERS',
   currentRound:roundOf(now),targetRound:window.forRound,
   prewarmSnapshots:window.prior.length,earlySnapshots:window.early.length,
   prewarmAvailable:Boolean(window.prewarm),signal:window.signal,
   prewarmStartMs:window.forRound-PREWARM_LOOKBACK_MS,strictLockDeadlineMs:window.forRound+LOCK_DEADLINE_MS,
   reasonIfNoSignal:window.errors.at(-1)||null,orders:false,productionIntegration:false};
}
