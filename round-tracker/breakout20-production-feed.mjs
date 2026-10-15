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
  endpoint=BREAKOUT20_URL,intervalMs=300,timeoutMs=900,
}={}){
  let pending=false,stopped=false,interval=null,lastResult=null,lastError=null;
  let acceptedRound=null,lastAttemptMs=null;
  async function checkOnce(){
    if(stopped||pending)return null;
    const now=clock(),round=roundStart(now),elapsed=now-round;
    // Do not burn free-tier requests for the other ~292 seconds of each round.
    if(elapsed<5700||elapsed>=BREAKOUT20_DEADLINE_MS||acceptedRound===round)return null;
    pending=true;lastAttemptMs=now;
    try{
      const response=await fetcher(endpoint,{method:'GET',cache:'no-store',
        headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok)throw Error('SHADOW_HTTP_'+response.status);
      const body=await response.json();
      const tested=validateBreakout20Lock(body,{now:clock(),round});
      if(!tested.ok){lastError=tested.reason;return null;}
      if(acceptedRound===round)return null;
      acceptedRound=round;lastError=null;lastResult=tested;
      onDecision(tested);
      return tested;
    }catch(error){lastError=String(error?.message||error||'SHADOW_NETWORK_ERROR').slice(0,180);return null;}
    finally{pending=false;}
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
      latestRound:lastResult?.round??null,latestDirection:lastResult?.direction??null};}
  };
}
