// FAST5 / PREWARM120-OPEN1 V2. Compute in the final 120 s of the prior 5m
// round. Direction is available at 0.1-1 s when a fresh opening tick arrives.
// Validated 120-second prewarm can lock without a fresh current-round spot tick.
// It is explicitly tagged PREWARM_ONLY; execution still needs a real exchange quote.
export const FAST_MODEL_ID='FAST5_SPOT_MOMENTUM_V1';
export const STRATEGY_VERSION='FAST5_PREWARM120_OPEN1_V3';
export const ROUND_MS=300000,PREWARM_MS=120000;
export const EARLIEST_SIGNAL_MS=100,SIGNAL_END_MS=1000;
const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const bps=(p,ref)=>10000*Math.log(p/ref);
const fix=x=>Number(x.toFixed(5));
const sign=x=>x>0?1:x<0?-1:0;
const direction=s=>s<0?'DOWN':'UP';

// Complete 1m candles in the preceding 120 seconds, including proper
// time alignment. Never read the candle currently forming.
function closedPrewarm(market,nextRound){
 const rows=market?.candles?.['1m']?.rows;
 if(!Array.isArray(rows))return null;
 const a=rows.find(x=>x?.startMs===nextRound-120000&&x.closed===true&&
   x.endMs===x.startMs+59999&&finite(x.open)&&x.open>0&&finite(x.close)&&x.close>0);
 const b=rows.find(x=>x?.startMs===nextRound-60000&&x.closed===true&&
   x.endMs===x.startMs+59999&&finite(x.close)&&x.close>0&&finite(x.open)&&x.open>0);
 if(!a||!b)return null;
 return {source:'CLOSED_1M_120S',first:a.open,last:b.close,
   momentumBps:fix(bps(b.close,a.open)),samples:2,spanMs:120000};
}
export function createFast5Calculator({now=()=>Date.now()}={}){
 let activeRound=null,locked=null,latestError=null;
 let lastObservationAt=null,lastValidMarketAt=null;
 let priceTicks=[],prewarm=null,provisionalDirection=null,provisionalReason=null;
 function rememberTick(market,at){
  const x=market?.latest||{},event=x.eventMs;
  if(market?.ok!==true||market?.readOnly!==true||market?.symbol!=='BTCUSDT'||
     x.marketFeedConnected!==true||!Number.isSafeInteger(event)||
     event>at+250||at-event>900||!finite(x.lastPrice)||x.lastPrice<=0)
    return false;
  if(event>(priceTicks.at(-1)?.at||0)){
    priceTicks.push({at:event,price:x.lastPrice});
    priceTicks=priceTicks.filter(y=>y.at>=at-125000).slice(-1800);
  }
  lastObservationAt=event;lastValidMarketAt=at;return true;
 }
 function getPrewarm(market,round){
  const ticks=priceTicks.filter(x=>x.at>=round-120000&&x.at<round);
  // Use real observed prices if there is nearly the full prior 120s,
  // otherwise use exact, closed one-minute candles.
  if(ticks.length>=5&&ticks.at(-1).at-ticks[0].at>=105000&&
     round-ticks.at(-1).at<2500){
    const a=ticks[0],b=ticks.at(-1);
    return {source:'PREVIOUS_120S_REAL_TICKS',first:a.price,last:b.price,
      momentumBps:fix(bps(b.price,a.price)),samples:ticks.length,
      spanMs:b.at-a.at};
  }
  return closedPrewarm(market,round);
 }
 function update(market){
  const at=now(),round=roundOf(at),elapsed=at-round;
  const rawValid=rememberTick(market,at);
  if(activeRound!==round){
   activeRound=round;locked=null;latestError=null;
   prewarm=null;provisionalDirection=null;provisionalReason=null;
  }
  // During the last 120 seconds of this round, already collect and
  // calculate context for the following round.
  if(elapsed>=ROUND_MS-PREWARM_MS){
   const upcoming=getPrewarm(market,round+ROUND_MS);
   if(upcoming)prewarm=upcoming;
  }
  if(locked)return {ok:true,locked:true,signal:locked};
  if(elapsed<EARLIEST_SIGNAL_MS)return {ok:true,locked:false,
    reason:'BEFORE_100MS_DECISION',signal:null};
  // At the boundary the last 120s belong to the *preceding* round.
  // Recalculate from those observations / closed candles, not current minute.
  const prior=getPrewarm(market,round);
  if(prior)prewarm=prior;
  const momentum=prewarm?.momentumBps;
  if(!prewarm){
   latestError='NO_VERIFIED_PREVIOUS_120S_DATA';
   return {ok:true,locked:false,reason:latestError,signal:null};
  }
  const priorSign=sign(momentum);
  provisionalDirection=direction(priorSign);
  provisionalReason=priorSign===0?'FLAT_PREWARM_TIE':'PREWARM_DIRECTION';
  const live=market?.latest||{};
  const event=live.eventMs,price=live.lastPrice,open=live.roundOpenPrice;
  const currentOk=rawValid&&live.roundStartMs===round&&
    Number.isSafeInteger(event)&&event>=round&&event<=at&&
    at-event<=500&&finite(price)&&price>0&&finite(open)&&open>0;
  // The collector can publish the current round marker before its first fresh tick.
  // Accept this authentic prior tick only as a PREWARM_ONLY source, never
  // mislabel it as a current-round opening-price comparison.
  const prewarmOnly=!currentOk&&market?.ok===true&&market?.readOnly===true&&
    market?.symbol==='BTCUSDT'&&live.marketFeedConnected===true&&
    live.roundStartMs===round&&Number.isSafeInteger(event)&&
    event>=round-3000&&event<=at+250&&at-event<=3000&&
    finite(price)&&price>0&&prewarm.spanMs>=105000&&
    Number.isSafeInteger(prewarm.samples)&&prewarm.samples>=2;
  if(!currentOk&&!prewarmOnly){
   latestError='NO_RECENT_MARKET_OR_120S_PREWARM';
   return {ok:true,locked:false,reason:latestError,
     provisionalDirection,signal:null};
  }
  const delta=currentOk?fix(bps(price,open)):0,trendSign=sign(delta);
  const sourceReason=prewarmOnly?'PREWARM120_ONLY_VERIFIED_PRIOR_DATA':
    trendSign===0?'PREWARM120_TIEBREAK':'CURRENT_OPEN_PRICE_DELTA';
  const dir=direction(trendSign||priorSign);
  if(elapsed>SIGNAL_END_MS){
   latestError='OPEN_1S_DEADLINE_MISSED';
   return {ok:true,locked:false,reason:latestError,
     provisionalDirection:dir,signal:null};
  }
  locked={
   ok:true,model:FAST_MODEL_ID,strategyVersion:STRATEGY_VERSION,
   round,direction:dir,status:'LOCKED',lockedAt:at,marketAt:event,
   readOnly:true,orders:false,productionIntegration:false,
   source:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
   decisionMethod:prewarmOnly?'PREWARM120_PRIOR_TICK_DIRECTION_1S':
    'PREWARM120_REAL_TICKS_OR_CLOSED_1M_PLUS_ROUND_OPEN_1S',
   prewarmSource:prewarm.source,prewarmMomentumBps:momentum,
   prewarmSamples:prewarm.samples,prewarmSpanMs:prewarm.spanMs,
   roundOpenPrice:currentOk?open:null,openingObservedPrice:currentOk?price:null,
   currentRoundQuoteVerified:currentOk,prewarmOnly,
   fromSpotOpenBps:currentOk?delta:null,
   fromPriorTickAgeMs:prewarmOnly?at-event:null,
   scoreBps:fix(Math.abs(delta)>0?delta:momentum),
   signalReason:sourceReason,weakTie:delta===0&&priorSign===0,
   requiresDeepSeek:false,analysisCalls:0,samples:1,
   confidence:null,confidenceIsCalibrated:false,
   officialOracleLiveQuoteUsed:false,
   note:prewarmOnly?'PREWARM_ONLY: no verified current-round spot price; direction is prior 120s momentum, not the opening price and not a proven edge.':'Opening spot price compared with current BTC spot, not Binance Prediction settlement oracle.'
  };
  latestError=null;
  return {ok:true,locked:true,signal:locked};
 }
 function status(){
  return {ok:true,model:FAST_MODEL_ID,strategyVersion:STRATEGY_VERSION,
   round:activeRound,locked:!!locked,latest:locked,latestError,
   prewarmReady:!!prewarm,prewarm,provisionalDirection,provisionalReason,
   observedSamples:priceTicks.filter(x=>x.at>=activeRound&&x.at<activeRound+ROUND_MS).length,
   prewarmTickCount:priceTicks.filter(x=>activeRound!=null&&x.at>=activeRound-120000&&x.at<activeRound).length,
   lastObservationAt,lastValidMarketAt,
   requiresDeepSeek:false,orders:false,productionIntegration:false};
 }
 return {update,status};
}
