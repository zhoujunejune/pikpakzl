// Pure, conservative Binance Prediction SELL order-finality classifier.
// Never resubmit on transient, missing, conflicting or partly filled states.
// Response documented fields include orderId, side, status, filledShareQty,
// filledUsdtAmount, and fillPercentage (NOT necessarily tokenId/quoteId).
const STALE=new Set(['FAILED','REJECTED','CANCELLED','CANCELED','EXPIRED']);
const FILLED=new Set(['FILLED','SUCCESS','COMPLETED','COMPLETE','CLOSED']);
const PENDING=new Set(['OPEN','OPENING','PENDING','SUBMITTED','PROCESSING','ACCEPTED','NEW','PARTIAL','PARTIALLY_FILLED']);
const norm=x=>String(x??'').trim().toUpperCase();
export function classifySubmittedRiskSellOrder(order,expectedOrderId){
  if(!order||!expectedOrderId||String(order.orderId??'')!==String(expectedOrderId)||
     norm(order.side??order.tradeSide)!=='SELL')return 'NOT_EXACT_ORDER';
  const status=norm(order.status??order.orderStatus);
  const fillNames=['filledShareQty','filledShares','filledQuantity','executedQty',
    'filledUsdtAmount','fillPercentage'];
  const known=fillNames
    .filter(k=>order[k]!==undefined&&order[k]!==null&&order[k]!=='')
    .map(k=>Number(order[k]));
  // Invalid or conflicting reported fill values cannot establish a zero fill.
  if(known.some(x=>!Number.isFinite(x)||x<0))return 'UNVERIFIED';
  if(known.some(x=>x>0)){
    // Binance might report FAILED after partial fill: never blindly re-sell.
    if(STALE.has(status)||PENDING.has(status))return 'PARTIAL_OR_CONFLICT_BLOCK';
    if(FILLED.has(status))return 'FILLED';
    return 'UNVERIFIED';
  }
  if(STALE.has(status))return known.length?'FAILED_EXPLICIT_ZERO':'UNVERIFIED';
  if(FILLED.has(status))return status==='FILLED'?'FILLED':'UNVERIFIED';
  if(PENDING.has(status))return 'PENDING';
  return 'UNVERIFIED';
}
export function safeToRetryUnfilledSubmitted({
  historyResult,activeResult,orderId,originalShares,currentShares
}={}){
  if(!historyResult?.ok||!activeResult?.ok||!orderId||
    !Number.isFinite(Number(originalShares))||
    !Number.isFinite(Number(currentShares))||
    Number(originalShares)<=0||Number(currentShares)!==Number(originalShares))
    return false;
  const history=Array.isArray(historyResult.data?.orders)?historyResult.data.orders:[];
  const active=Array.isArray(activeResult.data?.orders)?activeResult.data.orders:[];
  const matchedHistory=history.filter(x=>String(x?.orderId??'')===String(orderId));
  const matchedActive=active.filter(x=>String(x?.orderId??'')===String(orderId));
  if(matchedHistory.length!==1)return false;
  if(classifySubmittedRiskSellOrder(matchedHistory[0],orderId)!=='FAILED_EXPLICIT_ZERO')
    return false;
  // Active list may lag, but never send while active/pending or a partial fill
  // of the identical order is reported by Binance.
  if(matchedActive.some(x=>classifySubmittedRiskSellOrder(x,orderId)!=='FAILED_EXPLICIT_ZERO'))
    return false;
  return true;
}
