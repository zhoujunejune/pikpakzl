// DeepSeek HTTP 402 means insufficient API balance. Protect the paper AI
// service from repeated paid-model retries until the next recovery probe.
// This never submits orders or uses fallback entry/exit signals.
export const DEFAULT_BILLING_RETRY_MS = 5 * 60 * 1000;
export function createAiBillingGate(retryMs=DEFAULT_BILLING_RETRY_MS){
  if(!Number.isSafeInteger(retryMs)||retryMs<1000)throw Error('INVALID_BILLING_RETRY_MS');
  let retryAt=0,lastHttp402At=0,http402Count=0,blockedCalls=0;
  return {
    noteHttpStatus(status,now=Date.now()){
      if(status!==402)return false;
      if(!Number.isFinite(now))throw Error('INVALID_BILLING_TIME');
      lastHttp402At=now;retryAt=now+retryMs;http402Count++;
      return true;
    },
    noteSuccess(now=Date.now()){
      if(!Number.isFinite(now))throw Error('INVALID_BILLING_TIME');
      retryAt=0;
    },
    canCall(now=Date.now()){
      const ok=Number.isFinite(now)&&now>=retryAt;
      if(!ok)blockedCalls++;
      return ok;
    },
    isBlocked(now=Date.now()){return Number.isFinite(now)&&now<retryAt;},
    snapshot(now=Date.now()){
      const blocked=Number.isFinite(now)&&now<retryAt;
      return {blocked,retryAt:blocked?retryAt:0,
        retryAfterMs:blocked?retryAt-now:0,
        lastHttp402At,http402Count,blockedCalls,
        diagnostic:blocked?'DEEPSEEK_API_INSUFFICIENT_BALANCE':'AVAILABLE_OR_PENDING_PROBE'};
    }
  };
}
