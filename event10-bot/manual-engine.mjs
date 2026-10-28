// Manual EVENT10 analysis engine. Always no real Binance event-contract order endpoints.
import fs from "node:fs";
import path from "node:path";
import {tenMinuteWindow} from "./market-enrichment.mjs";
import {evaluatePureSignal,collectRuleFeatures,RULE_VERSION} from "./pure-signal.mjs";
import {confirmedPriceStructure} from "./price-structure.mjs";
export const HORIZON_MS = 600_000;
export const SOURCE = "BINANCE_BTC_PUBLIC_MARKET_PROXY_NOT_OFFICIAL_EVENT_INDEX";
const finite = Number.isFinite;
const round = (v,n=5)=>Number(v.toFixed(n));

export function checkedTick(data, now, maxAgeMs=6000) {
  if (data?.ok!==true || data?.readOnly!==true || data?.symbol!=="BTCUSDT" ||
      data?.latest?.marketFeedConnected===false) throw Error("UNVERIFIED_BTC_FEED");
  const price=Number(data?.latest?.lastPrice), at=Number(data?.latest?.eventMs);
  if (!finite(price)||price<=0||!Number.isSafeInteger(at)||at<=0||
      at>now+1000||now-at>maxAgeMs) throw Error("BTC_TICK_MISSING_OR_STALE");
  return {price,observedAt:at,observedAgeMs:now-at,source:SOURCE};
}
function candles(data, interval, ms, now) {
  const block=data.candles?.[interval];
  const source=Array.isArray(block)?block:
    (block?.rows||block?.items||block?.candles||[]);
  if (!Array.isArray(source))throw Error("MISSING_"+interval+"_CANDLES");
  return source.filter(v=>{
    const t=Number(v.startMs??v.openTime);
    return v.closed===true&&Number.isSafeInteger(t)&&t>0&&t+ms<=now&&
      ["open","high","low","close","volume"].every(k=>finite(Number(v[k]))&&Number(v[k])>=0)&&
      Number(v.close)>0&&Number(v.high)>=Number(v.low);
  }).map(v=>({t:Number(v.startMs??v.openTime),
    c:Number(v.close),h:Number(v.high),l:Number(v.low),v:Number(v.volume)}))
  .sort((a,b)=>a.t-b.t).slice(-120);
}
const rsi=(a,n=14)=>{
  const values=a.slice(-(n+1));let gain=0,loss=0;
  for(let i=1;i<values.length;i++){const d=values[i]-values[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}
  return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
};
const ema=(a,n)=>{
  let value=a.slice(0,n).reduce((x,y)=>x+y,0)/n;
  const k=2/(n+1);
  for(const v of a.slice(n))value=value+(v-value)*k;
  return value;
};
function macd(a){
  if(a.length<35)return null;
  const diffs=[];
  for(let i=25;i<a.length;i++)diffs.push(ema(a.slice(0,i+1),12)-ema(a.slice(0,i+1),26));
  if(diffs.length<9)return null;
  const line=diffs.at(-1),signal=ema(diffs,9);
  return {line:round(line,5),signal:round(signal,5),histogram:round(line-signal,5)};
}
function atr(rows,n=14){
  const last=rows.slice(-(n+1));let total=0;
  for(let i=1;i<last.length;i++){
    const cur=last[i],prev=last[i-1];
    total+=Math.max(cur.h-cur.l,Math.abs(cur.h-prev.c),Math.abs(cur.l-prev.c));
  }
  return round(total/n,3);
}
export function buildSnapshot(data, now) {
  const price=checkedTick(data,now);
  // All direction features must predate the frozen trusted reference tick.
  // The feed can contain a candle that closed after that tick.
  const one=candles(data,"1m",60000,price.observedAt);
  const five=candles(data,"5m",300000,price.observedAt);
  if(one.length<36||five.length<36)throw Error("NOT_ENOUGH_VERIFIED_CLOSED_CANDLES");
  if(now-one.at(-1).t>130000||now-five.at(-1).t>610000)
    throw Error("HISTORIC_INDICATORS_STALE");
  const c1=one.map(x=>x.c),c5=five.map(x=>x.c);
  const last20=one.slice(-20);
  const meanVolume=one.slice(-21,-1).reduce((a,b)=>a+b.v,0)/20;
  const highest=Math.max(...last20.map(x=>x.h)),lowest=Math.min(...last20.map(x=>x.l));
  return {...price,priceStructure:confirmedPriceStructure(one,price.price,price.observedAt,atr(one)),indicators:{
    rsi1m14:round(rsi(c1),2),rsi5m14:round(rsi(c5),2),
    macd1m:macd(c1),macd5m:macd(c5),
    atr1m14:atr(one),atr5m14:atr(five),
    ema1m9:round(ema(c1,9),2),ema1m21:round(ema(c1,21),2),
    ema5m9:round(ema(c5,9),2),ema5m21:round(ema(c5,21),2),
    momentum1m5Pct:round((c1.at(-1)/c1.at(-6)-1)*100),
    momentum5m15Pct:round((c5.at(-1)/c5.at(-4)-1)*100),
    volumeRatio1m:meanVolume>0?round(one.at(-1).v/meanVolume,3):null,
    rangeHigh1m20:highest,rangeLow1m20:lowest,
    location1m20:highest>lowest?round((price.price-lowest)/(highest-lowest),3):null,
    bars1m:one.length,bars5m:five.length,
    last1mCandleAt:one.at(-1).t,last5mCandleAt:five.at(-1).t
  }};
}
export function parseDirection(raw) {
  if(typeof raw!=="string"||raw.length>8000)throw Error("AI_RESPONSE_INVALID");
  let value;
  try{value=JSON.parse(raw);}catch{throw Error("AI_JSON_INVALID");}
  if(value?.direction!=="UP"&&value?.direction!=="DOWN")throw Error("AI_MUST_OUTPUT_UP_OR_DOWN");
  return {direction:value.direction,confidence:
    finite(value.confidence)&&value.confidence>=0&&value.confidence<=1?
      value.confidence:null,reason:String(value.reason||"").slice(0,300),
    upCase:String(value.upCase||"").slice(0,240),
    downCase:String(value.downCase||"").slice(0,240),
    decisiveEvidence:String(value.decisiveEvidence||"").slice(0,240),
    uncertainty:String(value.uncertainty||"").slice(0,240)};
}
export function scoreProxy(openPrice,closePrice,direction) {
  if(!finite(openPrice)||!finite(closePrice)||openPrice<=0||closePrice<=0||
    !["UP","DOWN"].includes(direction))throw Error("INVALID_PRICE_COMPARISON");
  const outcome=closePrice>openPrice?"UP":closePrice<openPrice?"DOWN":"FLAT";
  return {proxyOutcome:outcome,proxyHit:outcome==="FLAT"?null:outcome===direction,
    returnPct:round((closePrice/openPrice-1)*100,5)};
}
function load(file){
  try{const d=JSON.parse(fs.readFileSync(file,"utf8"));
    return Array.isArray(d)?d.filter(x=>x&&typeof x.id==="string"&&finite(x.openedAt)&&finite(x.expiresAt)).slice(-500):[]}
  catch(e){if(e.code==="ENOENT")return [];throw e;}
}
function store(file,records){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
  const tmp=file+"."+process.pid+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(records),{mode:0o600});
  fs.renameSync(tmp,file);
}
export function createEngine({env=process.env,clock=Date.now,fetcher=fetch}={}) {
  const feedUrl=String(env.EVENT10_READONLY_FEED||"http://127.0.0.1:13003/api/shadow-market-data");
  const streamUrl="http://127.0.0.1:13021/api/features";
  const file=String(env.EVENT10_STATE_FILE||"/var/lib/zl-event10/manual-sessions-v2.json");
  const history=load(file);
  for(const h of history)if(h.status==="ANALYZING"){
    h.status="FAILED";h.error="INTERRUPTED_DURING_AI_ANALYSIS";h.direction=null;
  }
  if(history.some(h=>h.error==="INTERRUPTED_DURING_AI_ANALYSIS"))store(file,history);
  let busyStart=false,busySettle=false,modelCalls=0,lastError=null;
  let lastRuleScan=0,lastCheck=null,inFlightStart=null;
  let lastCheckAt=0;
  let lastDataProbe=null;
  const persist=()=>store(file,history);
  const latest=()=>history.at(-1)||null;
  const stats=()=>{const decided=history.filter(x=>["UP","DOWN"].includes(x.direction));
    const settled=history.filter(x=>typeof x.proxyHit==="boolean");
    const hits=settled.filter(x=>x.proxyHit).length;
    return {total:history.length,validDirections:decided.length,
      proxySettled:settled.length,proxyHits:hits,proxyMisses:settled.length-hits,
      proxyAccuracyPct:settled.length?round(100*hits/settled.length,2):null,
      officialSettled:0,officialAccuracyPct:null};
  };
  const status=()=>{
    const h=latest();
    const current=history.filter(x=>x.decisionReviewVersion===RULE_VERSION);
    const settled=current.filter(x=>typeof x.proxyHit==="boolean");
    return {ok:true,bot:"EVENT10",mode:"PURE_RULES_AUTO_FIRST3M_PLUS_MANUAL",
      providerModel:"PURE_RULES_V1",configured:true,autoSignalEnabled:true,
      manualStartEnabled:true,autoTradingEnabled:false,executionAvailable:false,
      officialEventContractResultsAvailable:false,priceSource:SOURCE,
      horizonMs:HORIZON_MS,busyStart,busySettle,modelCalls:0,lastError,
      enrichmentVersion:"EVENT10_EMA_VOLUME_DEPTH_RSI_V1",
      decisionReviewVersion:RULE_VERSION,explanationLanguage:"zh-CN",
      thinkingMode:"disabled",reasoningEffort:null,
      lastReasoningObserved:null,lastReasoningTokenCount:null,
      lastFeatureCoverage:lastCheck?.featureAvailability||h?.featureAvailability||null,lastDataProbe,lastCheck,
      active:h&&["ANALYZING","PREDICTED"].includes(h.status)&&clock()<h.expiresAt?h:null,
      lastSession:h,stats:stats(),
      strategyStats:{total:current.length,proxySettled:settled.length,
        proxyHits:settled.filter(x=>x.proxyHit===true).length,
        proxyAccuracyPct:settled.length?round(100*settled.filter(x=>x.proxyHit===true).length/settled.length,2):null}};
  };
  const all=(limit=50)=>history.slice(-Math.max(1,Math.min(Number(limit)||50,200))).reverse();
  const readFeed=async()=>{
    const r=await fetcher(feedUrl,{signal:AbortSignal.timeout(2300),
      headers:{Accept:"application/json"}});
    if(!r.ok)throw Error("MARKET_SOURCE_HTTP_"+r.status);
    return r.json();
  };
  // One shared read-only market scan. A manual click during the scheduled
  // 12-second scan joins the very same result instead of returning a spurious
  // CLICK_ALREADY_PROCESSING error or duplicating a 10-minute prediction.
  async function start(id){
    if(!/^[A-Za-z0-9_-]{12,90}$/.test(String(id)))throw Error("INVALID_IDEMPOTENCY_KEY");
    const existing=history.find(x=>x.id===id);
    if(existing)return existing;
    if(inFlightStart)return inFlightStart;
    const active=history.findLast(x=>x.status==="PREDICTED"&&clock()<x.expiresAt);
    if(active)return active;
    const promise=capture(id);
    inFlightStart=promise;
    try{return await promise;}
    finally{if(inFlightStart===promise)inFlightStart=null;}
  }
  async function capture(id){
    if(busyStart)throw Error("INTERNAL_DUPLICATE_SCAN");
    if(history.some(x=>x.status==="ANALYZING"))throw Error("ANALYSIS_ALREADY_RUNNING");
    busyStart=true;
    const clickReceivedAt=clock();
    try{
      // Fetch the order book and aggressive trades BEFORE the reference-price tick;
      // reject market evidence newer than the frozen spot reference.
      const market=await collectRuleFeatures({fetcher,now:clock,timeoutMs:1200});
      let feed=await readFeed(),reference=buildSnapshot(feed,clock());
      const marketTimes=[market.features.orderBook?.observedAt,
        market.features.aggressiveFlow?.lastTradeAt].filter(Number.isFinite);
      const target=marketTimes.length?Math.max(...marketTimes):null;
      if(target!==null&&reference.observedAt<target&&target-reference.observedAt<=3500){
        for(let i=0;i<2&&reference.observedAt<target;i++){
          await new Promise(resolve=>setTimeout(resolve,120));
          const retry=await readFeed();
          const newer=buildSnapshot(retry,clock());
          if(newer.observedAt>reference.observedAt){feed=retry;reference=newer;}
        }
      }
      if(clock()-clickReceivedAt>5000)throw Error("SIGNAL_SNAPSHOT_TOO_SLOW");
      const availability={...market.availability};
      const filtered={};
      for(const [k,v] of Object.entries(market.features)){
        const observed=v.observedAt??v.lastTradeAt;
        if(!Number.isSafeInteger(observed)||observed>reference.observedAt||
            reference.observedAt-observed>5000)
          availability[k]={available:false,error:"SOURCE_NOT_ASOF_REFERENCE"};
        else filtered[k]=v;
      }
      const rule=evaluatePureSignal({feed,reference,
        orderBook:filtered.orderBook,aggressiveFlow:filtered.aggressiveFlow});
      lastCheck={id,checkedAt:clock(),checkLatencyMs:clock()-clickReceivedAt,openedAt:reference.observedAt,
        openPrice:reference.price,expiresAt:reference.observedAt+HORIZON_MS,
        ...rule,featureAvailability:availability};
      lastDataProbe={checkedAt:clock(),available:Object.keys(filtered).length,
        total:market.total,availability};
      if(!rule.direction)return lastCheck; // Missing ANY mandatory gate = no signal, no prediction record.
      const session={id,clickReceivedAt,openedAt:reference.observedAt,
        clickToCaptureMs:clock()-clickReceivedAt,expiresAt:reference.observedAt+HORIZON_MS,
        openPrice:reference.price,openAgeMs:reference.observedAgeMs,
        priceStructure:null,features:reference.indicators,
        rollingTenMinutes:tenMinuteWindow(feed,reference.observedAt),
        enrichment:{source:market.source,features:filtered,
          available:Object.keys(filtered).length,total:market.total},
        featureAvailability:availability,sourceWarnings:market.caveats,
        featureBundleVersion:RULE_VERSION,decisionReviewVersion:RULE_VERSION,
        decisionReview:null,compactEvidence:null,analysisArguments:null,
        source:SOURCE,status:"PREDICTED",direction:rule.direction,
        ruleChecks:rule,signalCycleStartMs:rule.cycleStartAt,
        model:"PURE_RULES_V1",attempts:0,confidence:null,reason:rule.reason,
        modelFinishedAt:clock(),modelLatencyMs:clock()-clickReceivedAt,
        thinkingRequested:false,reasoningEffort:null,
        reasoningObserved:null,reasoningTokenCount:null,
        closePrice:null,closeObservedAt:null,expirySampleLagMs:null,
        proxyOutcome:null,proxyHit:null,returnPct:null,
        officialEventOutcome:null,officialEventHit:null,
        realOrderPlaced:false,error:null};
      history.push(session);
      if(history.length>500)history.splice(0,history.length-500);
      persist();return session;
     }catch(e){
      // Market-data failures are NOT valid directions. Return a terminal
      // read-only DATA_ERROR result so the UI can stop its loading state.
      const error=String(e?.message||e).slice(0,160);
      lastError=error;
      lastCheck={id,checkedAt:clock(),checkLatencyMs:clock()-clickReceivedAt,openedAt:null,openPrice:null,
        status:"DATA_ERROR",signal:"NO_SIGNAL",direction:null,
        reason:"数据检查未完成："+error+"。本次未产生交易方向。",
        error,featureAvailability:lastDataProbe?.availability||null};
      return lastCheck;
    }
    finally{busyStart=false;}
  }
  async function tick(){
    if(busySettle||clock()-lastCheckAt<1100)return;
    lastCheckAt=clock();
    // Automatically scan only the first 3 minutes of each aligned UTC 10m block.
    // No forced direction, no exchange order; at most one accepted signal per block.
    const nowMs=clock(),cycle=nowMs-Math.floor(nowMs%HORIZON_MS);
    if(nowMs-cycle<180000&&nowMs-lastRuleScan>=12000&&!busyStart&&
        !history.some(x=>x.signalCycleStartMs===cycle&&x.direction)&&
        !history.some(x=>x.status==="PREDICTED"&&x.expiresAt>nowMs)){
      lastRuleScan=nowMs;
      void start("auto-rule-"+cycle).catch(e=>{
        lastError="AUTO_SCAN_"+String(e?.message||e).slice(0,100);
      });
    }
    const expiring=history.filter(h=>
      h.status==="PREDICTED" && h.proxyHit===null && h.proxyOutcome===null &&
      clock()>=h.expiresAt && !h.settlementStatus);
    if(!expiring.length)return;
    busySettle=true;
    try{
      const now=clock();
      for(const h of expiring){
        if(now>h.expiresAt+15000){
          h.settlementStatus="UNVERIFIABLE_PRICE_NEAR_EXPIRY";persist();
        }
      }
      const pending=expiring.filter(h=>!h.settlementStatus);
      if(!pending.length)return;
      const market=await readFeed();
      const observed=checkedTick(market,clock(),6000);
      for(const h of pending){
        if(observed.observedAt < h.expiresAt || observed.observedAt>h.expiresAt+15000)
          continue;
        const score=scoreProxy(h.openPrice,observed.price,h.direction);
        Object.assign(h,{closePrice:observed.price,
          closeObservedAt:observed.observedAt,
          expirySampleLagMs:observed.observedAt-h.expiresAt,
          settlementStatus:"PUBLIC_MARKET_PROXY_ONLY",
          ...score});persist();
      }
    }catch(e){lastError="SETTLE_"+String(e?.message||e).slice(0,120);}
    finally{busySettle=false;}
  }
  async function probe(){
    // Read-only diagnostics: no session creation and no DeepSeek/model API request.
    const d=await collectRuleFeatures({fetcher,now:clock});
    lastDataProbe={checkedAt:clock(),available:d.available,total:d.total,
      availability:d.availability};
    return {ok:true,...lastDataProbe,source:d.source,
      officialEventContractIndex:false,realOrderPlaced:false};
  }
  return {status,start,tick,probe,history:all};
}
