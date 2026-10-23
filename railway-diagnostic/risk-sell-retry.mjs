// Small pure helpers for safe Binance Prediction TP/SL SELL retries.
// Clear API rejects can retry only after a fresh quote and another threshold
// evaluation. HTTP 5xx / timeout are UNKNOWN, never treated as rejected.
export function nextDefiniteRetry(previous={}, now=Date.now(), minMs=2500, maxMs=10000) {
  const failures=Math.min(1000,Math.max(0,Number(previous.failures)||0)+1);
  const delayMs=Math.min(maxMs,minMs*Math.pow(2,Math.min(2,failures-1)));
  return {failures,delayMs,lastAttemptAt:now,retryAt:now+delayMs};
}

export function isDefiniteRetryReady(state={},now=Date.now(),minMs=2500) {
  if(state.inFlight||state.submitted||state.statusUnknown)return false;
  if(!state.error)return true;
  const after=Number.isFinite(state.retryAt)?state.retryAt:Number(state.lastAttemptAt||0)+minMs;
  return now>=after;
}

const REJECTED=new Set(['FAILED','REJECTED','CANCELLED','CANCELED','EXPIRED']);
const SUCCESS_OR_PENDING=new Set(['FILLED','SUCCESS','COMPLETED','COMPLETE','PARTIALLY_FILLED',
 'PARTIAL','PENDING','OPEN','NEW','PROCESSING','SUBMITTED','ACCEPTED']);

const normalized=x=>String(x??'').trim().toUpperCase();

export function reconcileExactUnknownOrder(order,{quoteId,tokenId}={}) {
  if(!order||!quoteId||!tokenId)return 'UNVERIFIED';
  // Never infer identity from round/topic/direction alone. Exact quote+token
  // identity must be returned by Binance before clearing UNKNOWN.
  if(String(order.quoteId??'')!==String(quoteId)||
     String(order.tokenId??'')!==String(tokenId)||
     normalized(order.side)!=='SELL')return 'UNVERIFIED';
  const status=normalized(order.status??order.orderStatus);
  if(SUCCESS_OR_PENDING.has(status))return 'ORDER_OBSERVED_DO_NOT_RETRY';
  if(!REJECTED.has(status))return 'UNVERIFIED';
  // CANCELLED with a partial fill is not safe to blindly submit again.
  // Only an explicitly zero filled quantity qualifies as unfilled.
  const filled=order.filledShares??order.filledQuantity??order.executedQty??order.filledAmount;
  if(filled===null||filled===undefined||filled===''||
     !Number.isFinite(Number(filled))||Number(filled)!==0)return 'UNVERIFIED';
  return 'REJECTED_NO_FILL_CAN_REEVALUATE';
}
