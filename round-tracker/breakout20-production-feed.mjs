// Breakout20 production direction adapter. This is NOT a trade/order client.
// The only network input is the independently frozen public Cloudflare shadow status.
export const BREAKOUT20_MODE='BREAKOUT20_FAST8';
export const BREAKOUT20_MODEL='BREAKOUT20_RSI_MACD_RANGE_V1';
export const BREAKOUT20_SOURCE='SELECTIVE_V2_FAST8_PRIMARY'; // Keep existing side-specific order-direction policy.
export const BREAKOUT20_URL='https://breakout20-shadow.zl528094-3ba.workers.dev/status';
export const BREAKOUT20_DEADLINE_MS=8000;
const ROUND_MS=300000;
const roundStart=ms=>Math.floor(ms/ROUND_MS)*ROUND_MS;
const isSafeMs=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;

export function validateBreakout20Lock(body,{now=Date.now(),round=roundStart(now)}={}){
  if(!body || body.name!=='突破20%即可' ||
     body.readOnly!==true || body.orders!==false || body.productionIntegration!==false ||
     body.version!==BREAKOUT20_MODEL) return {ok:false,reason:'UNTRUSTED_SHADOW_PAYLOAD'};
  const row=body.latest;
  if(!row||row.t!==round)return {ok:false,reason:'CURRENT_ROUND_NOT_LOCKED'};
  if(row.status!=='LOCKED' || (row.direction!=='UP'&&row.direction!=='DOWN'))
    return {ok:false,reason:'SHADOW_NOT_LOCKED'};
  if(!isSafeMs(row.lockedAt)||row.lockedAt<round||row.lockedAt>=round+BREAKOUT20_DEADLINE_MS)
    return {ok:false,reason:'SHADOW_LOCK_TIME_INVALID'};
  if(!isSafeMs(now)||now<round||now>=round+BREAKOUT20_DEADLINE_MS)
    return {ok:false,reason:'PRODUCTION_EIGHT_SECOND_DEADLINE_EXPIRED'};
  if(row.lockedAt>now+350)return {ok:false,reason:'CLOCK_SKEW_OR_FUTURE_SHADOW_LOCK'};
  if(body.timed?.lastGoodDataAt==null||Number(body.timed.lastGoodDataAt)<round ||
     Number(body.timed.lastGoodDataAt)>now+350)
    return {ok:false,reason:'SHADOW_MARKET_NOT_FRESH'};
  return {ok:true,round,direction:row.direction,lockedAt:row.lockedAt,
    delayMs:row.lockedAt-round,model:BREAKOUT20_MODEL,source:BREAKOUT20_SOURCE};
}

export function createBreakout20ProductionFeed({
  fetcher=globalThis.fetch,clock=Date.now,onDecision=()=>{},
  endpoint=BREAKOUT20_URL,intervalMs=160,timeoutMs=1800,
  retrySpacingMs=300,maxPending=2,
}={}){
  let pendingCount=0,stopped=false,interval=null,lastResult=null,lastError=null;
  let acceptedRound=null,lastAttemptMs=null,lastAttemptRound=null,attemptsThisRound=0;
  let lastFailure=null;
  async function checkOnce(){
    if(stopped||pendingCount>=maxPending)return null;
    const now=clock(),round=roundStart(now),elapsed=now-round;
    // Keep all network requests close to this round's 8-second deadline.
    // Two staggered GETs tolerate one slow edge connection without extending the deadline.
    if(elapsed<5700||elapsed>=BREAKOUT20_DEADLINE_MS||acceptedRound===round)return null;
    if(lastAttemptRound===round && now-lastAttemptMs<retrySpacingMs)return null;
    if(lastAttemptRound!==round)attemptsThisRound=0;
    lastAttemptRound=round;lastAttemptMs=now;attemptsThisRound++;
    pendingCount++;
    const budgetMs=Math.min(timeoutMs,Math.max(100,round+BREAKOUT20_DEADLINE_MS-now-75));
    try{
      const response=await fetcher(endpoint,{method:'GET',cache:'no-store',
        headers:{accept:'application/json'},signal:AbortSignal.timeout(budgetMs)});
      if(!response.ok)throw Error('SHADOW_HTTP_'+response.status);
      const body=await response.json();
      const tested=validateBreakout20Lock(body,{now:clock(),round});
      if(!tested.ok){
        if(acceptedRound!==round)lastError=tested.reason;
        return null;
      }
      if(acceptedRound===round)return null;
      acceptedRound=round;lastError=null;lastFailure=null;lastResult=tested;
      onDecision(tested);
      return tested;
    }catch(error){
      if(acceptedRound!==round){
        const message=String(error?.message||error||'SHADOW_NETWORK_ERROR').slice(0,180);
        lastError=message;
        lastFailure={at:clock(),round,name:String(error?.name||'Error'),
          causeCode:String(error?.cause?.code||''),message,budgetMs};
        console.log(JSON.stringify({event:'breakout20_readonly_feed_failure',
          round,elapsedMs:clock()-round,errorName:lastFailure.name,
          errorCode:lastFailure.causeCode,message,budgetMs,
          pendingRequests:pendingCount,attemptsThisRound}));
      }
      return null;
    }finally{
      pendingCount--;
    }
  }
  return {
    start(){if(interval||stopped)return;interval=setInterval(()=>{void checkOnce();},intervalMs);interval.unref?.();void checkOnce();},
    stop(){stopped=true;if(interval)clearInterval(interval);interval=null;},
    checkOnce,
    latestFor(round,now=clock()){
      return lastResult?.round===round && now>=round&&now<round+BREAKOUT20_DEADLINE_MS
        ?lastResult:null;
    },
    report(){return {enabled:!stopped,acceptedRound,lastAttemptMs,lastError,
      pendingRequests:pendingCount,attemptsThisRound,lastFailure,
      latestRound:lastResult?.round??null,latestDirection:lastResult?.direction??null};}
  };
}
