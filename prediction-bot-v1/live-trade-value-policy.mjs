// Live Binance Prediction trade/no-trade decision based on independently settled
// empirical performance and real executable quote. Never use LLM subjective confidence.
// No API requests or order submissions occur in this pure module.
export const MIN_PRIOR_SIDE_RESULTS=40;
export const MIN_EXPECTED_EDGE=0.015;
export const COST_BUFFER=0.02;
const side=x=>x==='UP'||x==='DOWN';
function wilsonLower(hits,total,z=1.2815515655446004){
 const p=hits/total,z2=z*z;
 return (p+z2/(2*total)-z*Math.sqrt(p*(1-p)/total+z2/(4*total*total)))/(1+z2/total);
}
const no=(code,info={})=>({decision:'NO_TRADE',reason:code,valid:false,...info});
export function decideLiveTradeValue({
 learning,originalDirection,orderDirection,quoteChance,sourceOk=true
}={}){
 if(!sourceOk||!learning||typeof learning!=='object')
  return no('OFFICIAL_EXPERIENCE_UNAVAILABLE');
 if(!side(originalDirection)||!side(orderDirection))
  return no('DIRECTION_UNVERIFIED');
 if(typeof quoteChance!=='number'||!Number.isFinite(quoteChance)||
   quoteChance<=0||quoteChance>=1)
  return no('EXECUTABLE_QUOTE_INVALID');
 const counts=learning.upDown?.[originalDirection];
 const n=counts?.samples,h=counts?.hits;
 if(!Number.isSafeInteger(n)||!Number.isSafeInteger(h)||n<MIN_PRIOR_SIDE_RESULTS||h<0||h>n)
  return no('INSUFFICIENT_OFFICIAL_SAMPLES',{samples:Number.isInteger(n)?n:0,
   required:MIN_PRIOR_SIDE_RESULTS});
 const matching=originalDirection===orderDirection;
 // If the user explicitly inverted directions, losing original forecasts would win.
 const wins=matching?h:n-h;
 const lowerBound=wilsonLower(wins,n);
 const adjustedBreakEven=quoteChance+COST_BUFFER;
 const conservativeEdge=lowerBound-adjustedBreakEven;
 const data={samples:n,hits:wins,estimatedWinRate:Number((wins/n).toFixed(5)),
   conservativeWinRate:Number(lowerBound.toFixed(5)),
   quoteChance:Number(quoteChance.toFixed(5)),
   assumedCostBuffer:COST_BUFFER,
   conservativeNetEdge:Number(conservativeEdge.toFixed(5)),
   minEdge:MIN_EXPECTED_EDGE,originalDirection,orderDirection,
   probabilityNotCalibrated:true,winRateSource:'OFFICIAL_SETTLEMENT_RECENT_DIRECTION_STATS'};
 if(conservativeEdge<MIN_EXPECTED_EDGE)
  return no('QUOTE_PRICE_NOT_WORTH_RISK',data);
 return {decision:'TRADE',reason:'POSITIVE_CONSERVATIVE_HISTORICAL_QUOTE_MARGIN',valid:true,...data};
}
