// Training-free numerical second opinion for DeepSeek on BTC 5m prediction.
// Not LightGBM; not a pretrained AI; not a calibrated probability or a trade signal.
// Uses only fully closed Binance 1m/5m candles and a timely, real current-round
// Chainlink START reference where available. No order API, I/O or randomness.
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const fmt=n=>Number(n.toFixed(4));
const BASE_CANDLE_MS=60000;
const roundOf=t=>Math.floor(t/300000)*300000;
function closedCandles(section,now,minuteMs){
 const input=Array.isArray(section)?section:
   Array.isArray(section?.rows)?section.rows:[];
 const rows=input.filter(x=>{
  const t=Number(x?.startMs??x?.openTime);
  const e=Number(x?.endMs??(t+minuteMs-1));
  const c=Number(x?.close);
  return Number.isSafeInteger(t)&&Number.isSafeInteger(e)&&e<=now&&
    x.closed===true&&c>0&&Number.isFinite(c)&&e>=t;
 }).map(x=>({t:Number(x.startMs??x.openTime),c:Number(x.close)}));
 rows.sort((a,b)=>a.t-b.t);
 const unique=[];
 for(const row of rows)if(!unique.length||row.t>unique.at(-1).t)unique.push(row);
 return unique.slice(-80);
}
function returns(a){
 const out=[];for(let i=1;i<a.length;i++)out.push(Math.log(a[i].c/a[i-1].c)*10000);return out;
}
const average=v=>v.reduce((a,b)=>a+b,0)/(v.length||1);
export function quantSecondOpinion(feed,now=Date.now(),official=null){
 if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=='BTCUSDT')
  return {available:false,reason:'UNTRUSTED_BTC_FEED'};
 const live=feed.latest||{},at=Number(live.eventMs),round=Number(live.roundStartMs);
 const currentPrice=Number(live.lastPrice),spotOpen=Number(live.roundOpenPrice);
 if(!Number.isSafeInteger(at)||!Number.isSafeInteger(round)||round!==roundOf(now)||
    now-at>4000||at>now+1000||!(currentPrice>0)||!(spotOpen>0))
  return {available:false,reason:'MARKET_STALE_OR_ROUND_MISMATCH'};
 const m1=closedCandles(feed.candles?.['1m'],now,BASE_CANDLE_MS);
 const m5=closedCandles(feed.candles?.['5m'],now,300000);
 if(m1.length<24||m5.length<12||m1.at(-1).t<now-240000||
    m5.at(-1).t<now-900000)
  return {available:false,reason:'INSUFFICIENT_CLOSED_CANDLE_HISTORY'};
 // Avoid falsely treating missing 1m candles as contiguous 1m returns.
 const last20=m1.slice(-20);
 if(last20.some((x,i)=>i&&x.t-last20[i-1].t!==BASE_CANDLE_MS))
  return {available:false,reason:'ONE_MINUTE_BAR_GAP'};
 const closes=m1.slice(-24);
 const rets=returns(closes);
 const latest5=rets.slice(-5);
 const volatility=Math.sqrt(average(rets.slice(-20).map(v=>(v-average(rets.slice(-20)))**2)));
 const move3=Math.log(closes.at(-1).c/closes.at(-4).c)*10000;
 const move8=Math.log(closes.at(-1).c/closes.at(-9).c)*10000;
 const isValidOfficial=official?.ok===true&&
   official.roundStartMs===round&&official.priceFeedProvider==='CHAINLINK'&&
   official.priceFeedSymbol==='BTCUSDT'&&
   official.officialPriceObservedAt<=now&&official.officialPriceObservedAt>=round&&
   Number(official.officialStartPrice)>0&&
   official.officialLivePriceAvailable===false;
 const reference=isValidOfficial?Number(official.officialStartPrice):spotOpen;
 const fromRef=Math.log(currentPrice/reference)*10000;
 const score=0.34*move3+0.26*move8+0.4*fromRef;
 const threshold=Math.max(2.5,0.27*volatility);
 const bias=Math.abs(score)<threshold?'NEUTRAL':score>0?'UP':'DOWN';
 const evidenceStrength=Math.abs(score)/Math.max(threshold,0.0001);
 return {
  available:true,model:'ZERO_TRAIN_CLOSED_CANDLE_MOMENTUM_V1',
  type:'UNTRAINED_DETERMINISTIC_QUANT_STATISTIC_NOT_AI',
  roundStartMs:round,observedAt:at,barCount1m:m1.length,
  barCount5m:m5.length,bias,
  scoreBpsUncalibrated:fmt(score),noiseThresholdBps:fmt(threshold),
  evidenceStrengthRatioUncalibrated:fmt(Math.min(evidenceStrength,99)),
  threeMinuteMomentumBps:fmt(move3),eightMinuteMomentumBps:fmt(move8),
  oneMinuteVolatilityBps:fmt(volatility),spotPriceFromReferenceBps:fmt(fromRef),
  referenceType:isValidOfficial?'CHAINLINK_OFFICIAL_START_VS_SPOT_NOW':'BINANCE_SPOT_OPEN_VS_SPOT_NOW',
  noOracleLiveQuote:true,
  note:'Independent formula summary only, NOT a trained trading AI, NOT a win probability, NOT an order signal. DeepSeek must validate or reject it using actual observed evidence.'
 };
}
