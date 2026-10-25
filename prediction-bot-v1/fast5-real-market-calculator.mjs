// Local real-time BTC 5m direction calculation. No AI API, no model training,
// no network calls, no Binance order API, no exchange credentials.
// A fast observation is not a proven positive-expectancy trading strategy.
export const FAST_MODEL_ID='FAST5_SPOT_MOMENTUM_V1';
export const ROUND_MS=300000;
export const EARLIEST_SIGNAL_MS=4000;
export const SIGNAL_END_MS=12000;
const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const bps=(price,ref)=>10000*Math.log(price/ref);
const fix=n=>Number(n.toFixed(5));

function priorOneMinuteCloses(market,now){
 const source=market?.candles?.['1m']?.rows;
 if(!Array.isArray(source))return [];
 const closed=source.filter(c=>
  c?.closed===true&&Number.isSafeInteger(c?.startMs)&&
  Number.isSafeInteger(c?.endMs)&&c.endMs===c.startMs+59999&&
  c.endMs<now&&finite(c.close)&&c.close>0
 ).slice(-6);
 if(closed.length<5)return [];
 for(let i=1;i<closed.length;i++)
  if(closed[i].startMs-closed[i-1].startMs!==60000)return [];
 if(now-closed.at(-1).endMs>90000)return [];
 return closed.map(c=>({at:c.startMs,close:c.close}));
}
export function createFast5Calculator({now=()=>Date.now()}={}){
 let activeRound=null,samples=[],locked=null,latestError=null;
 let lastSampleAt=0,lastObservationAt=null;
 function update(market){
  const at=now(),round=roundOf(at),elapsed=at-round;
  if(activeRound!==round){
   activeRound=round;samples=[];locked=null;latestError=null;lastSampleAt=0;
  }
  if(locked)return {ok:true,locked:true,signal:locked};
  if(elapsed>=SIGNAL_END_MS)return {ok:false,reason:'ROUND_SIGNAL_WINDOW_EXPIRED',signal:null};
  const live=market?.latest||{};
  const eventAt=live.eventMs,price=live.lastPrice,spotOpen=live.roundOpenPrice;
  if(market?.ok!==true||market?.readOnly!==true||market?.symbol!=='BTCUSDT'||
     live.marketFeedConnected!==true||live.roundStartMs!==round||
     !Number.isSafeInteger(eventAt)||eventAt<round||eventAt>at+250||at-eventAt>1200||
     !finite(price)||price<=0||!finite(spotOpen)||spotOpen<=0){
   latestError='STALE_OR_UNTRUSTED_MARKET';return {ok:false,reason:latestError,signal:null};
  }
  if(eventAt>lastSampleAt){
   // Bounded in-memory real tick evidence; never replay an old or future tick.
   samples.push({at:eventAt,price});samples=samples.slice(-30);
   lastSampleAt=eventAt;lastObservationAt=eventAt;
  }
  if(elapsed<EARLIEST_SIGNAL_MS)return {ok:true,locked:false,reason:'COLLECTING_FRESH_TICKS',samples:samples.length,signal:null};
  if(samples.length<4||samples.at(-1).at-samples[0].at<2500){
   return {ok:true,locked:false,reason:'INSUFFICIENT_TICK_SPAN',samples:samples.length,signal:null};
  }
  const closed=priorOneMinuteCloses(market,at);
  if(closed.length<5)return {ok:true,locked:false,reason:'INSUFFICIENT_REAL_CLOSED_CANDLES',signal:null};
  // Never read current forming 1-minute candle. Historical momentum is context,
  // not a probability, and cannot force a direction when microticks disagree.
  const prior3Bps=bps(closed.at(-1).close,closed.at(-4).close);
  const tickBps=bps(samples.at(-1).price,samples[0].price);
  const fromSpotOpenBps=bps(price,spotOpen);
  // Require the most recent half of the tick window to agree with total momentum.
  const mid=samples[Math.floor(samples.length/2)];
  const recentBps=bps(samples.at(-1).price,mid.price);
  const pTick=Math.sign(tickBps),pRecent=Math.sign(recentBps);
  const direction=pTick>0?'UP':'DOWN';
  // A small nonzero buffer avoids quantization noise; no ungrounded win rate.
  const coherent=pTick!==0&&pTick===pRecent&&
    Math.abs(tickBps)>=0.30&&Math.abs(recentBps)>=0.12&&
    Math.sign(fromSpotOpenBps)===pTick;
  const mixed=prior3Bps!==0&&Math.sign(prior3Bps)!==pTick;
  if(!coherent||mixed){
   latestError=mixed?'CONFLICT_WITH_REAL_CLOSED_1M_TREND':'NO_RELIABLE_MICRO_MOMENTUM';
   return {ok:true,locked:false,reason:latestError,samples:samples.length,signal:null};
  }
  locked={
   ok:true,model:FAST_MODEL_ID,round,direction,status:'LOCKED',
   lockedAt:at,marketAt:eventAt,readOnly:true,orders:false,
   productionIntegration:false,source:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
   decisionMethod:'CAUSAL_REAL_TICK_PLUS_CLOSED_1M_MOMENTUM',
   scoreBps:fix(tickBps),recentMomentumBps:fix(recentBps),
   fromSpotOpenBps:fix(fromSpotOpenBps),prior3MinuteBps:fix(prior3Bps),
   samples:samples.length,analysisCalls:0,requiresDeepSeek:false,
   confidence:null,confidenceIsCalibrated:false,
   officialOracleLiveQuoteUsed:false,
   note:'Untrained spot momentum is not a verified advantage over a Chainlink-settled 5-minute outcome.'
  };
  return {ok:true,locked:true,signal:locked};
 }
 function status(){
  return {ok:true,model:FAST_MODEL_ID,round:activeRound,locked:Boolean(locked),
   latest:locked,latestError,observedSamples:samples.length,
   lastObservationAt,requiresDeepSeek:false,orders:false,
   productionIntegration:false};
 }
 return {update,status};
}
