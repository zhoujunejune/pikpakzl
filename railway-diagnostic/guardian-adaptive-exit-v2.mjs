// GUARDIAN V2: read-only, causal SELL-quote exit comparator.
// No Binance API, no order submission, no production trading switches.
export const GUARDIAN_ADAPTIVE_V2='ZL_GUARDIAN_ADAPTIVE_EXIT_SHADOW_V2';
export const GUARDIAN_MODEL='ZL_GUARDIAN_5M_V1';
const ROUND_MS=300000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const INVALID=reason=>({ok:false,triggered:false,reason});
const median=values=>{
 const sorted=[...values].sort((a,b)=>a-b);
 const mid=Math.floor(sorted.length/2);
 return sorted.length ? (sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2) : null;
};

export function executableNetValue(q) {
 if(!q||q.source!=='BINANCE_PREDICTION_SELL_QUOTE'||q.side!=='SELL'||
    typeof q.quoteId!=='string'||!q.quoteId||!positive(q.amountOut)||
    !finite(q.feeAmount)||q.feeAmount<0||
    !finite(q.slippageBufferAmount)||q.slippageBufferAmount<0||
    !Number.isSafeInteger(q.at)||!Number.isSafeInteger(q.expireAt)||
    q.expireAt<=q.at+250)return null;
 const net=q.amountOut-q.feeAmount-q.slippageBufferAmount;
 return finite(net)&&net>=0?net:null;
}

// Strictly additive: V1 remains the live policy. V2 never emits exchange orders.
// A hypothetical exit is NOT proof of actual fill or net profit.
export function adaptiveExitV2({model,round,tokenId,orderId,cost,quotes,now}={}) {
 if(model!==GUARDIAN_MODEL||typeof tokenId!=='string'||!tokenId||
    typeof orderId!=='string'||!orderId||
    !Number.isSafeInteger(round)||round%ROUND_MS!==0||
    !Number.isSafeInteger(now)||now<round||now>=round+ROUND_MS||!positive(cost))
  return INVALID('INVALID_GUARDIAN_POSITION');
 if(!Array.isArray(quotes)||!quotes.length||quotes.length>1800)
  return INVALID('SELL_QUOTE_HISTORY_REQUIRED');
 let lastAt=-1, lastQuoteId=null;
 const rows=[];
 for(const q of quotes) {
  if(q?.tokenId!==tokenId||q?.round!==round||!Number.isSafeInteger(q?.at)||
     q.at<=lastAt||q.at<round||q.at>now||
     (lastQuoteId&&q.quoteId===lastQuoteId))
    return INVALID('NON_CAUSAL_OR_CROSS_POSITION_QUOTE');
  const net=executableNetValue(q);
  if(net===null)return INVALID('UNVERIFIED_SELL_QUOTE_OR_COSTS');
  rows.push({at:q.at,net,quoteId:q.quoteId,expireAt:q.expireAt});
  lastAt=q.at;lastQuoteId=q.quoteId;
 }
 const latest=rows[rows.length-1];
 if(now-latest.at>2500||latest.expireAt-now<=250)
  return INVALID('SELL_QUOTE_STALE_OR_EXPIRED');
 const current=latest.net,peak=Math.max(...rows.map(q=>q.net));
 const pnl=(current-cost)/cost;
 const remainingMs=round+ROUND_MS-now;
 if(current<=cost*0.90)
  return {ok:true,triggered:true,kind:'STOP_LOSS',reason:'V2_HARD_LOSS_CAP',
    current,peak,pnl,remainingMs,stopFloor:cost*.90,adaptive:false};
 const recent=rows.filter(q=>now-q.at<=20000).slice(-60);
 const enough=recent.length>=8 && recent[recent.length-1].at-recent[0].at>=5000;
 let volatility=null,stopLossPct=.10,trailGivebackPct=.04;
 if(enough){
  const jumps=[];
  for(let i=1;i<recent.length;i++) {
   const dt=recent[i].at-recent[i-1].at;
   if(dt>=250&&dt<=4000)jumps.push(Math.abs(recent[i].net-recent[i-1].net)/cost);
  }
  if(jumps.length>=6){
   volatility=median(jumps);
   stopLossPct=volatility<=.003 ? .06 : volatility<=.01 ? .08 : .10;
   trailGivebackPct=volatility<=.003 ? .025 : volatility<=.01 ? .04 : .05;
  }
 }
 const adaptive=volatility!==null;
 if(adaptive&&remainingMs<=45000)stopLossPct=Math.min(stopLossPct,.08);
 if(adaptive&&remainingMs<=25000)stopLossPct=Math.min(stopLossPct,.06);
 const stopFloor=cost*(1-stopLossPct);
 const out={ok:true,triggered:false,kind:null,reason:'V2_HOLD',
   current,peak,pnl,remainingMs,adaptive,volatility,stopFloor,
   trailGivebackPct,historySamples:recent.length};
 if(current<=stopFloor)
  return {...out,triggered:true,kind:'STOP_LOSS',reason:'V2_ADAPTIVE_STOP'};
 const trailFloor=peak>=cost*1.08?Math.max(cost,peak-cost*trailGivebackPct):null;
 if(trailFloor!==null&&current<=trailFloor)
  return {...out,triggered:true,kind:'TAKE_PROFIT',reason:'V2_ADAPTIVE_TRAIL',trailFloor};
 if(remainingMs<12000&&current<cost)
  return {...out,triggered:true,kind:'STOP_LOSS',reason:'V2_NEAR_SETTLEMENT_LOSS'};
 return {...out,trailFloor,reason:adaptive?'V2_HOLD':'V2_INSUFFICIENT_HISTORY_FALLBACK'};
}

// Compare only same-time observed SELL quote proxies; not actual fill profit.
export function compareQuoteReplay(position){
 const {model,round,tokenId,orderId,cost,quotes}=position||{};
 if(model!==GUARDIAN_MODEL||!Number.isSafeInteger(round)||!Array.isArray(quotes)||
    !positive(cost)||!tokenId||!orderId)
  return {ok:false,reason:'INVALID_GUARDIAN_REPLAY'};
 let baseline=null,adaptive=null,peak=0,valid=0;
 for(let i=0;i<quotes.length;i++){
  const q=quotes[i],now=q?.at;
  const result=adaptiveExitV2({model,round,tokenId,orderId,cost,
    quotes:quotes.slice(0,i+1),now});
  if(!result.ok)return {ok:false,reason:result.reason};
  valid++;peak=Math.max(peak,result.current);
  const current=result.current;
  const remainingMs=round+ROUND_MS-now;
  if(!baseline){
   let reason=null;
   if(current<=cost*.90)reason='V1_HARD_STOP';
   else if(peak>=cost*1.08&&peak-current>=cost*.04)reason='V1_TRAIL';
   else if(remainingMs<12000&&current<cost)reason='V1_NEAR_SETTLEMENT_LOSS';
   if(reason)baseline={reason,at:now,quoteNet:current,quoteProxyPnl:current-cost};
  }
  if(!adaptive&&result.triggered)
   adaptive={reason:result.reason,at:now,quoteNet:current,quoteProxyPnl:current-cost};
 }
 return {ok:true,observations:valid,baseline,adaptive,
   bothExit:Boolean(baseline&&adaptive),
   proxyDifferenceBothExits:baseline&&adaptive?
     adaptive.quoteProxyPnl-baseline.quoteProxyPnl:null,
   settledTradePnl:null,actualFillVerified:false};
}
