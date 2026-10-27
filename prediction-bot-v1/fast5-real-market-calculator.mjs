// FAST5 multiscale bull/bear trend V7; independent of DeepSeek and orders.
// Before every 5m boundary, continuously cache true Binance spot ticks.
// At round open, calculate momentum immediately from real cached ticks /
// completed candles. The decision window is 0..2 seconds, no late lock.
// Missing market evidence or a mathematically flat trend -> WAIT, never fake.
export const FAST_MODEL_ID='FAST5_SPOT_MOMENTUM_V1';
export const STRATEGY_VERSION='FAST5_BULL_BEAR_TREND_2S_V7';
export const TREND_VERSION='MULTISCALE_15S_120S_15M_REAL_MARKET_V1';
export const ROUND_MS=300000,PREWARM_MS=120000;
export const EARLIEST_SIGNAL_MS=0,SIGNAL_END_MS=2000;
const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const num=x=>typeof x==='number'&&Number.isFinite(x);
const bps=(a,b)=>10000*Math.log(a/b);
const fix=x=>Math.round(x*100000)/100000;
const good=x=>num(x)&&x>0;
const dir=x=>x<0?'DOWN':'UP';
function exactClosed(market,start){
 const rows=market?.candles?.['1m']?.rows;
 return Array.isArray(rows)?rows.find(x=>x?.startMs===start&&
  x.endMs===start+59999&&x.closed===true&&good(x.open)&&good(x.close)):null;
}
export function calculateTrendContext(market,round,ticks=[]){
 const a=exactClosed(market,round-120000);
 const b=exactClosed(market,round-60000);
 const c=exactClosed(market,round-180000);
 // Prefer fresh, observed previous-round ticks. Genuine completed candle
 // evidence is a fallback when a process has just restarted.
 const prior=ticks.filter(x=>x.at>=round-120000&&x.at<round);
 let prewarm=null;
 if(prior.length>=3&&prior.at(-1).at-prior[0].at>=25000&&
    round-prior.at(-1).at<=2500){
  prewarm={source:'REAL_TICKS_PREVIOUS_120S',momentumBps:fix(bps(prior.at(-1).price,prior[0].price)),
   samples:prior.length,spanMs:prior.at(-1).at-prior[0].at};
 }else if(a&&b){
  prewarm={source:'CLOSED_1M_PREVIOUS_120S',momentumBps:fix(bps(b.close,a.open)),
    samples:2,spanMs:120000};
 }
 const recent=prior.filter(x=>x.at>=round-20000);
 let shortBps=null;
 if(recent.length>=2&&recent.at(-1).at-recent[0].at>=600){
  shortBps=fix(bps(recent.at(-1).price,recent[0].price));
 }else if(b){
  // The most recent completed 1m candle is an independently verified
  // short-trend fallback, not an invented live tick.
  shortBps=fix(bps(b.close,b.open));
 }
 // Longer context is optional; it must never suppress an available
 // bullish/bearish signal just because 15m net movement > 5bps.
 let longBps=null;
 const longStart=exactClosed(market,round-900000);
 if(longStart){
  let complete=true;
  for(let i=15;i>=1;i--)if(!exactClosed(market,round-i*60000)){complete=false;break}
  if(complete)longBps=fix(bps(b.close,longStart.open));
 }
 if(!prewarm&&shortBps===null)return null;
 return {prewarm,shortBps,longBps,
   mediumBps:prewarm?prewarm.momentumBps:(c&&b?fix(bps(b.close,c.open)):shortBps)};
}
export function createFast5Calculator({now=()=>Date.now()}={}){
 let activeRound=null,locked=null,latestError=null,priceTicks=[];
 let lastObservationAt=null,lastValidMarketAt=null,prewarm=null;
 let provisionalDirection=null,provisionalReason=null,lastTrend=null;
 function collect(market,at){
  const q=market?.latest||{},event=q.eventMs;
  if(market?.ok!==true||market?.readOnly!==true||market?.symbol!=='BTCUSDT'||
     q.marketFeedConnected!==true||!Number.isSafeInteger(event)||event>at||
     at-event>1300||!good(q.lastPrice))return false;
  if(event>(priceTicks.at(-1)?.at||0)){
   priceTicks.push({at:event,price:q.lastPrice});
   // 150 sec genuine event-time history, including previous round.
   priceTicks=priceTicks.filter(x=>x.at>=at-150000).slice(-2200);
  }
  lastObservationAt=event;lastValidMarketAt=at;return true;
 }
 function update(market){
  const at=now(),round=roundOf(at),elapsed=at-round;
  const validTick=collect(market,at);
  if(activeRound!==round){
   activeRound=round;locked=null;latestError=null;
   prewarm=null;provisionalDirection=null;provisionalReason=null;lastTrend=null;
  }
  // Precompute during the preceding two minutes; no 15m regime gate.
  if(elapsed>=ROUND_MS-PREWARM_MS){
   const upcoming=calculateTrendContext(market,round+ROUND_MS,priceTicks);
   if(upcoming)prewarm=upcoming.prewarm;
  }
  if(locked)return {ok:true,locked:true,signal:locked};
  if(elapsed>=SIGNAL_END_MS){
   latestError='OPEN_2S_DEADLINE_MISSED';
   provisionalDirection=null;provisionalReason='ROUND_WAIT_AFTER_2S';
   return {ok:true,locked:false,reason:latestError,signal:null};
  }
  const trend=calculateTrendContext(market,round,priceTicks);
  if(trend)lastTrend=trend;
  if(!trend){
   latestError='NO_VERIFIED_TREND_HISTORY';
   return {ok:true,locked:false,reason:latestError,signal:null};
  }
  prewarm=trend.prewarm;
  const q=market?.latest||{},event=q.eventMs;
  const authenticated=validTick&&q.roundStartMs===round&&
    Number.isSafeInteger(event)&&event>=round-1300&&event<=at&&
    at-event<=1300;
  if(!authenticated){
   latestError='NO_RECENT_BINANCE_SPOT_EVENT';
   return {ok:true,locked:false,reason:latestError,signal:null};
  }
  const current=event>=round&&good(q.roundOpenPrice)&&
   at-event<=800;
  const openingBps=current?fix(bps(q.lastPrice,q.roundOpenPrice)):null;
  // Weight true recent momentum most heavily, then 2-minute trend.
  // The signed trend determines UP/DOWN; no artificial volatility threshold.
  const short=trend.shortBps;
  const medium=trend.mediumBps;
  const long=trend.longBps;
  const inputs=[
   [short,0.46],[medium,0.34],[long,0.12],
   [openingBps,0.08]
  ].filter(([v])=>num(v));
  const weight=inputs.reduce((v,x)=>v+x[1],0);
  const score=weight?fix(inputs.reduce((v,x)=>v+x[0]*x[1],0)/weight):0;
  if(!num(score)||score===0){
   latestError='FLAT_OR_UNDETERMINED_BULL_BEAR_TREND';
   return {ok:true,locked:false,reason:latestError,signal:null};
  }
  const direction=dir(score);
  provisionalDirection=direction;provisionalReason='VERIFIED_MULTISCALE_TREND';
  const last=trend.prewarm||{source:'RECENT_CLOSED_1M_TREND',
   samples:1,spanMs:60000,momentumBps:trend.mediumBps};
  locked={
   ok:true,model:FAST_MODEL_ID,strategyVersion:STRATEGY_VERSION,round,
   status:'LOCKED',direction,lockedAt:at,marketAt:event,
   trendVersion:TREND_VERSION,trendDirection:direction,trendScoreBps:score,
   trendShortBps:short,trendMediumBps:medium,trendLongBps:long,
   trendOpeningBps:openingBps,
   prewarmSource:last.source,prewarmMomentumBps:last.momentumBps,
   prewarmSamples:last.samples,prewarmSpanMs:last.spanMs,
   prewarmOnly:!current,currentRoundQuoteVerified:current,
   roundOpenPrice:current?q.roundOpenPrice:null,
   openingObservedPrice:current?q.lastPrice:null,
   fromSpotOpenBps:openingBps,
   source:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
   decisionMethod:'MULTISCALE_15S_120S_15M_REAL_MARKET_V1',
   signalReason:'WEIGHTED_SIGNED_REAL_SPOT_TREND',
   scoreBps:score,confidence:null,confidenceIsCalibrated:false,
   officialOracleLiveQuoteUsed:false,
   readOnly:true,orders:false,productionIntegration:false,
   requiresDeepSeek:false,analysisCalls:0,samples:1,
   note:'Fast real BTCUSDT spot trend, not guaranteed prediction market edge. Binance Prediction settlement may use a different source.'
  };
  latestError=null;
  return {ok:true,locked:true,signal:locked};
 }
 function status(){
  return {ok:true,model:FAST_MODEL_ID,strategyVersion:STRATEGY_VERSION,
   round:activeRound,locked:!!locked,latest:locked,latestError,
   prewarmReady:!!prewarm,prewarm,provisionalDirection,provisionalReason,
   trendVersion:TREND_VERSION,
   lastTrend,observedSamples:priceTicks.filter(x=>x.at>=activeRound&&
    x.at<activeRound+ROUND_MS).length,
   prewarmTickCount:priceTicks.filter(x=>activeRound!=null&&
    x.at>=activeRound-120000&&x.at<activeRound).length,
   lastObservationAt,lastValidMarketAt,
   requiresDeepSeek:false,orders:false,productionIntegration:false};
 }
 return {update,status};
}
