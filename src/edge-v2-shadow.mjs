// Strict forward-only EDGE5 V2 challenger; never used for live orders.
// No cross-venue basis, no overlapping perp-return/basis features.
export const V2_INPUT_VERSION='EDGE5_BINANCE_SPOT_PM_BOOK_V2';
export const V2_FEATURE_NAMES=Object.freeze([
 'binance_spot_momentum','binance_spot_book_imbalance',
 'binance_aggressive_flow','binance_spot_realized_vol',
 'prediction_up_mid_logodds','prediction_book_depth_imbalance'
]);
const ROUND_MS=300000;
const valid=n=>typeof n==='number'&&Number.isFinite(n);
const clamp=(n,lo=-4,hi=4)=>Math.max(lo,Math.min(hi,n));
const dir=x=>x>=0?'UP':'DOWN';
const levels=xs=>xs.slice(0,5).reduce((s,x)=>s+Number(x?.[1]||0),0);
export function predictionSnapshot(payload,round,at){
 const f=payload?.signal?.facts,dc=payload?.dataIntegrity||{};
 const factsAt=Number(payload?.signal?.factsCalculatedAt);
 const age=Number(f?.predictionMarketBookAgeMs);
 const bid=Number(f?.predictionMarketUpBid),ask=Number(f?.predictionMarketUpAsk);
 const mid=Number(f?.predictionMarketUpMid);
 const bookAt=factsAt-age;
 if(payload?.ok!==true||!f||payload?.signal?.roundStartMs!==round||
    f.predictionMarketRound!==round||
    f.predictionMarketRoundAligned!==true||
    f.predictionMarketMappingReliable!==true||
    !['UP','DOWN'].includes(f.predictionMarketYesDirection)||
    dc.predictionOrderbookConnected!==true||
    dc.predictionOrderbookFresh!==true||
    !valid(factsAt)||factsAt>at+350||at-factsAt>2200||
    !valid(age)||age<0||age>1500||
    !valid(bookAt)||at-bookAt>2200||
    !valid(bid)||!valid(ask)||!valid(mid)||
    !(bid>0&&ask<1&&bid<ask)||
    mid<bid||mid>ask||
    !Number.isSafeInteger(Number(f.predictionMarketId))||
    !valid(Number(f.predictionMarketDepthImbalance5)))
  return null;
 return {round,at:bookAt,marketId:Number(f.predictionMarketId),
   upBid:bid,upAsk:ask,upMid:mid,
   yesDirection:f.predictionMarketYesDirection,
   // Bybit/PM binary outcome conversion already normalizes UP quotes. Raw
   // per-market book imbalance needs direction normalization separately.
   depthImbalance:Number(f.predictionMarketDepthImbalance5)};
}
export function v2Features(binance,trail,pm,at){
 const round=Math.floor(at/ROUND_MS)*ROUND_MS;
 if(pm?.round!==round||!valid(at)||binance?.venue!=='BINANCE'||
    !valid(binance.spotPrice)||binance.spotPrice<=0||
    !valid(binance.spotAt)||at-binance.spotAt>2500||
    binance.spotAt>at+300||!Array.isArray(trail))return null;
 const bids=binance.bids,asks=binance.asks;
 if(!Array.isArray(bids)||!Array.isArray(asks)||
    bids.length<5||asks.length<5)return null;
 const b=levels(bids),a=levels(asks);
 if(!(b>0&&a>0))return null;
 const recent=(binance.trades||[]).filter(x=>
    valid(Number(x.T))&&Number(x.q)>0&&at-Number(x.T)>=-300&&at-Number(x.T)<=4000);
 if(recent.length<3)return null;
 let buy=0,sell=0;
 for(const t of recent){
   if(t.m===false)buy+=Number(t.q);
   else if(t.m===true)sell+=Number(t.q);
 }
 if(!(buy+sell>0))return null;
 const history=trail.filter(x=>
   valid(x.at)&&at-x.at>=4000&&at-x.at<=20000&&
   valid(x.spotPrice)&&x.spotPrice>0&&x.venue==='BINANCE')
   .sort((x,y)=>x.at-y.at);
 if(history.length<2)return null;
 const old=history[0];
 const momentum=clamp(10000*Math.log(binance.spotPrice/old.spotPrice)/14);
 const imbalance=clamp(2*(b-a)/(b+a));
 const flow=clamp(2*(buy-sell)/(buy+sell));
 const prices=history.map(x=>x.spotPrice).concat(binance.spotPrice);
 const returns=prices.slice(1).map((x,i)=>Math.log(x/prices[i]));
 const mean=returns.reduce((u,v)=>u+v,0)/returns.length;
 const vol=clamp(10000*Math.sqrt(returns.reduce((u,v)=>u+(v-mean)**2,0)/returns.length)/8,0,4);
 const pmLogOdds=clamp(Math.log(pm.upMid/(1-pm.upMid))/3);
 const pmDepth=clamp((pm.yesDirection==='UP'?1:-1)*pm.depthImbalance*2);
 const values=[momentum,imbalance,flow,vol,pmLogOdds,pmDepth];
 if(values.some(x=>!valid(x)))return null;
 // Two frozen competing forecasts: pure PM implied direction and a balanced,
 // low-dimensional independent-feature blend. No trained advantage is claimed.
 const baselineDirection=dir(pmLogOdds);
 const blendScore=.50*pmLogOdds+.20*momentum+.12*imbalance+.12*flow+.06*pmDepth;
 return {round,at,marketAt:Math.min(pm.at,binance.spotAt),
   inputVersion:V2_INPUT_VERSION,venue:'BINANCE',
   pmMarketId:pm.marketId,values,baselineDirection,
   blendDirection:dir(blendScore),blendScore,pmUpMid:pm.upMid,
   calibrationReady:false,modelProbability:null};
}
export function v2Summary(rows){
 const eligible=rows.filter(r=>r?.features&&['UP','DOWN'].includes(r.actual));
 const group=(key)=>{
   const samples=eligible.length;
   const hits=eligible.filter(r=>r[key]===r.actual).length;
   return {samples,hits,misses:samples-hits,
     accuracy:samples?hits/samples:null};
 };
 return {observedRounds:rows.length,locked:rows.filter(r=>r.features).length,
  pending:rows.filter(r=>r.features&&!['UP','DOWN'].includes(r.actual)).length,
  pmOnly:group('pmDirection'),blend:group('blendDirection')};
}
