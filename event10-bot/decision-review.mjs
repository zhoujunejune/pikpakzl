// Source-grounded evidence review; no learned weights, no orders or direction override.
export const REVIEW_VERSION="EVENT10_PRICE_SCOPE_REVERSAL_V4_20261024";
const val=n=>typeof n==="number"&&Number.isFinite(n)?n:null;
const sign=x=>x>0?"UP":x<0?"DOWN":"NEUTRAL";
export function buildDecisionReview(session){
 const f=session.features||{},e=session.enrichment?.features||{},quality=session.featureAvailability||{};
 const trend=[],checks=[],warnings=[];
 function add(label,signal,evidence,group="TREND"){
  const item={label,signal,evidence:String(evidence).slice(0,160),group};
  if(group==="TREND")trend.push(item);else checks.push(item);
 }
 function ema(name,a,b){
  if(val(a)===null||val(b)===null)return;
  add(name,sign(a-b),"EMA9="+a+", EMA21="+b);
 }
 ema("1m trend",f.ema1m9,f.ema1m21);
 ema("5m trend",f.ema5m9,f.ema5m21);
 const fifteen=e.fifteenMinute||{};
 ema("15m trend",fifteen.ema9,fifteen.ema21);
 for(const [name,value,description] of [
   ["5m price change",val(f.momentum1m5Pct),"1m-derived 5-bar momentum"],
   ["15m price change",val(f.momentum5m15Pct),"5m-derived 3-bar momentum"],
   ["45m price change",val(fifteen.moveLast45mPct),"15m Kline change"]]){
  if(value!==null)add(name,sign(value),description+" "+value+"%");
 }
 const t1=trend.find(x=>x.label==="1m trend")?.signal||"NEUTRAL";
 const t5=trend.find(x=>x.label==="5m trend")?.signal||"NEUTRAL";
 const t15=trend.find(x=>x.label==="15m trend")?.signal||"NEUTRAL";
 const higherAligned=t5!=="NEUTRAL"&&t5===t15?t5:"MIXED";
 const flow=e.aggressiveFlow||{};
 const flowBuy=val(flow.takerBuyFraction),flowDelta=val(flow.deltaNotionalUsd);
 const book=val(e.orderBook?.imbalanceTop20);
 const continuous=session.continuousTradeFlow?.windows||{};
 const primaryFlow=continuous["600s"]||continuous["300s"]||continuous["60s"]||null;
 const buyShare=val(primaryFlow?.buyFraction);
 if(flowBuy!==null&&flowDelta!==null){
   add("sampled aggressive volume",sign(flowDelta),"Limited aggTrades: taker-buy fraction="+flowBuy+", deltaUSD="+Math.round(flowDelta),"FLOW");
 }
 if(buyShare!==null){
   add("continuous verified taker flow",buyShare>.52?"UP":buyShare<.48?"DOWN":"NEUTRAL",
     "Verified "+primaryFlow.windowSeconds+"s event window, taker-buy share="+buyShare,"FLOW");
 }
 if(book!==null){
   add("top20 orderbook snapshot",book>.15?"UP":book<-.15?"DOWN":"NEUTRAL",
     "Top20 bid-ask notional imbalance="+book+" (cancellable quotes)","DEPTH");
 }
 const loc=val(f.location1m20),vol=val(f.volumeRatio1m);
 if(vol!==null&&vol>=4&&loc!==null&&loc>=.95)
   warnings.push("HIGH_VOLUME_RANGE_HIGH: high volume at/above range high; test breakout failure, not automatic UP");
 if(vol!==null&&vol>=4&&loc!==null&&loc<=.05)
   warnings.push("HIGH_VOLUME_RANGE_LOW: high volume near range low; test downside continuation, not automatic DOWN");
 // Aggressive BTCUSDT USD-M futures prints must be paired with
 // price movement from the SAME prints, never with the other proxy feed.
 const perpMove=flow.verifiedPriceResponse===true?val(flow.futuresPriceMovePct):null;
 if(flowDelta!==null&&perpMove!==null){
   if(flowDelta>0&&perpMove<-.02)
     warnings.push("POSSIBLE_BUY_ABSORPTION: futures taker buys dominate but SAME futures sample price declined; not proof of absorption");
   if(flowDelta<0&&perpMove>.02)
     warnings.push("POSSIBLE_SELL_ABSORPTION: futures taker sells dominate but SAME futures sample price rose; not proof of absorption");
 }else if(flowDelta!==null){
   warnings.push("FLOW_PRICE_RESPONSE_UNVERIFIED: no sufficient same-futures-price duration; do not infer absorption from the proxy reference price");
 }
 const rsi15=val(fifteen.rsi14);
 const shortTurnUp=(val(f.momentum1m5Pct)??-1)>0||
    (val(f.ema1m9)!==null&&val(f.ema1m21)!==null&&f.ema1m9>f.ema1m21);
 const shortTurnDown=(val(f.momentum1m5Pct)??1)<0||
    (val(f.ema1m9)!==null&&val(f.ema1m21)!==null&&f.ema1m9<f.ema1m21);
 if(rsi15!==null&&rsi15<=30){
   warnings.push("OVERSOLD_REVERSAL_RISK: 15m RSI indicates weak/oversold conditions; downside continuation is NOT automatic");
   if(shortTurnUp)warnings.push("OVERSOLD_SHORT_TERM_RECOVERY: shorter horizon has positive signs despite weak 15m RSI; evaluate reversal against continuation explicitly");
 }
 if(rsi15!==null&&rsi15>=70){
   warnings.push("OVERBOUGHT_PULLBACK_RISK: 15m RSI is elevated; upside continuation is NOT automatic");
   if(shortTurnDown)warnings.push("OVERBOUGHT_SHORT_TERM_WEAKENING: short-horizon weakness contrasts with elevated 15m RSI; test pullback hypothesis");
 }
 if(higherAligned!=="MIXED"&&flowDelta!==null&&((higherAligned==="UP"&&flowDelta<0)||(higherAligned==="DOWN"&&flowDelta>0)))
   warnings.push("HIGHER_TIMEFRAME_VS_FLOW_CONFLICT: distinguish reversal from countertrend aggressive trades");
 if(book!==null&&flowDelta!==null&&Math.abs(book)>.4&&((book<0&&flowDelta>0)||(book>0&&flowDelta<0)))
   warnings.push("ORDERBOOK_VS_FLOW_CONFLICT: aggressor volume opposing visible liquidity; possible absorption/spoofing");
 if(buyShare!==null&&flowBuy!==null&&((buyShare>.57&&flowBuy<.43)||(buyShare<.43&&flowBuy>.57)))
   warnings.push("FLOW_WINDOWS_DISAGREE: REST and continuous tape represent different horizons");
 const oi=val(e.openInterestChange?.change5mPct);
 if(oi!==null&&Math.abs(oi)>.1)
   add("OI change","NEUTRAL","5m open interest change="+oi+"%; not standalone direction","DERIVATIVES");
 for(const key of ["fifteenMinute","orderBook","aggressiveFlow","futuresIndex","openInterestChange","continuousAggTrade"])
  if(quality[key]?.available===false)warnings.push("MISSING_"+key.toUpperCase()+": "+String(quality[key].error||"UNVERIFIED").slice(0,60));
 if(trend.some(x=>x.signal==="UP")&&trend.some(x=>x.signal==="DOWN"))
   warnings.push("TIMEFRAME_TREND_CONFLICT: mixed up/down indicators; consider longer price action and uncertainty");
 if(!primaryFlow)warnings.push("NO_VERIFIED_CONTINUOUS_FLOW: REST sample cannot imply uninterrupted trading");
 const risk=warnings.filter(s=>/CONFLICT|ABSORPTION|MISSING_|NO_VERIFIED/.test(s)).length;
 return {version:REVIEW_VERSION,
   purpose:"Separate reference-price trend from USD-M futures tape. Stress-test oversold bounce AND continued selloff. No trained directional weights.",
   trend:trend.slice(0,8),independentChecks:checks.slice(0,6),
   timeframeSummary:{m1:t1,m5:t5,m15:t15,higherAligned,rsi15m:rsi15},
   priceScopes:{forecastReference:"BINANCE_BTC_PUBLIC_MARKET_PROXY_NOT_OFFICIAL_EVENT_INDEX",
     aggressiveTrades:"BINANCE_USDM_BTCUSDT_FUTURES_AGGTRADES",
     futuresPriceResponseVerified:flow.verifiedPriceResponse===true,
     futuresSamplePriceMovePct:perpMove,
     cannotCompareCrossMarketPricesDirectly:true},
   warnings:warnings.slice(0,16),
   riskOfOverconfidentDecision:risk>=3?"HIGH":risk>=1?"ELEVATED":"UNASSESSED",
   policy:"Assess UP and DOWN independently. No deterministic direction override, no calibrated probabilities and no training on three outcomes."};
}
