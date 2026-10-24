// Manual EVENT10 analysis engine. Always no real Binance event-contract order endpoints.
import fs from "node:fs";
import path from "node:path";
import {collectPublicFeatures,tenMinuteWindow} from "./market-enrichment.mjs";
import {buildDecisionReview,REVIEW_VERSION} from "./decision-review.mjs";
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
  const one=candles(data,"1m",60000,now);
  const five=candles(data,"5m",300000,now);
  if(one.length<36||five.length<36)throw Error("NOT_ENOUGH_VERIFIED_CLOSED_CANDLES");
  if(now-one.at(-1).t>130000||now-five.at(-1).t>610000)
    throw Error("HISTORIC_INDICATORS_STALE");
  const c1=one.map(x=>x.c),c5=five.map(x=>x.c);
  const last20=one.slice(-20);
  const meanVolume=one.slice(-21,-1).reduce((a,b)=>a+b.v,0)/20;
  const highest=Math.max(...last20.map(x=>x.h)),lowest=Math.min(...last20.map(x=>x.l));
  return {...price,indicators:{
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
function prompt(session) {
  return {
    model:"deepseek-flash",response_format:{type:"json_object"},
    messages:[
      {role:"system",content:[
        "You are an evidence-critical, two-sided BTC market forecaster.",
        "Objective: will the SAME public BTC reference price be higher (UP)",
        "or lower (DOWN) exactly 600 seconds after the provided manual capture?",
        "A valid response MUST choose exactly UP or DOWN. NEVER WAIT or neutral.",
        "Perform the following competing-hypothesis evaluation internally:",
        "1) Read 1m / 5m / 15m closed-candle price action and rolling 10m context.",
        "Distinguish trend continuation vs reversal and avoid double-counting",
        "EMA, MACD, RSI and momentum as independent confirmations.",
        "2) Separate aggression from PRICE RESPONSE. A large net taker-buy delta",
        "or breakout alone does NOT prove price will rise. When buying dominates",
        "but price remains below EMAs, momentum is down, or ask liquidity is heavy,",
        "explicitly evaluate liquidity absorption or failed breakout possibilities.",
        "Symmetrically evaluate sell pressure against resilient/rising prices.",
        "3) Compare stronger timeframes with short intraminute moves. A countertrend",
        "signal needs independently persuasive price-response evidence; do not",
        "assume the market will bounce because price seems low.",
        "4) Check the orderbook is a cancellable point-in-time sample and REST",
        "aggTrades can cover less than a full 2 minutes. Prefer verified continuous",
        "60s/300s/600s flow where available; do not count REST and continuous",
        "overlapping prints as separate independent evidence.",
        "5) Explicitly consider 15m/5m trend vs flow disagreement, volume spikes",
        "at range extremes, OI change limitations, source staleness and missing data.",
        "Do NOT make high-certainty claims merely from a bullish or bearish",
        "majority of correlated indicators. Do NOT have a blanket UP/DOWN bias.",
        "Evaluate an UP scenario AND a DOWN scenario, identify the strongest",
        "disconfirming observation for each, then choose the more supported side.",
        "Output JSON only: direction UP|DOWN, confidence numeric 0..1 (subjective",
        "uncalibrated judgment, NOT proven win probability), upCase, downCase,",
        "decisiveEvidence, uncertainty, reason. Keep each text field concise.",
        "If evidence is mixed you MUST still pick UP or DOWN and explicitly name",
        "the conflict and uncertainty; do not fake data or ignore opposing evidence.",
        "Only use observations at/before frozen reference timestamp; never infer",
        "real Binance Event Contract official settlement or a placed order.",
        "Historical examples of 3 rounds are far too few to learn fixed trading",
        "weights or a reversal rule. No retrospective outcome leaks into this call."
      ].join(" ")},
      {role:"user",content:JSON.stringify({
        purpose:"PREDICT_10_MIN_AFTER_MANUAL_CAPTURE",
        capturedAt:session.openedAt,expiresAt:session.expiresAt,
        referencePrice:session.openPrice,marketSource:SOURCE,
        observedAt:session.openedAt,features:session.features,
        rollingLastTenClosedMinutes:session.rollingTenMinutes,
        enrichedBinancePublicData:session.enrichment,
        continuousAggTradeFlow:session.continuousTradeFlow||null,
        decisionQualityChecklist:session.decisionReview,
        featureAvailability:session.featureAvailability,
        sourceWarnings:session.sourceWarnings
      })}
    ]
  };
}
export function createEngine({env=process.env,clock=Date.now,fetcher=fetch}={}) {
  const key=String(env.DEEPSEEK_API_KEY||"");
  const model=String(env.EVENT10_DEEPSEEK_MODEL||env.DEEPSEEK_MODEL||"deepseek-flash");
  const endpoint=String(env.DEEPSEEK_API_URL||"https://api.deepseek.com/chat/completions");
  const feedUrl=String(env.EVENT10_READONLY_FEED||"http://127.0.0.1:13003/api/shadow-market-data");
  const streamUrl="http://127.0.0.1:13021/api/features";
  const file=String(env.EVENT10_STATE_FILE||"/var/lib/zl-event10/manual-sessions-v2.json");
  const history=load(file);
  for(const h of history)if(h.status==="ANALYZING"){
    h.status="FAILED";h.error="INTERRUPTED_DURING_AI_ANALYSIS";h.direction=null;
  }
  if(history.some(h=>h.error==="INTERRUPTED_DURING_AI_ANALYSIS"))store(file,history);
  let busyStart=false,busySettle=false,modelCalls=0,lastError=null;
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
    return {ok:true,bot:"EVENT10",mode:"MANUAL_BUTTON_OPEN_10MIN",
      providerModel:model,configured:!!key,autoSignalEnabled:false,
      manualStartEnabled:!!key,autoTradingEnabled:false,executionAvailable:false,
      officialEventContractResultsAvailable:false,priceSource:SOURCE,
      horizonMs:HORIZON_MS,busyStart,busySettle,modelCalls,lastError,
      enrichmentVersion:"EVENT10_PUBLIC_USDM_V2",
      decisionReviewVersion:REVIEW_VERSION,
      lastFeatureCoverage:h?.featureAvailability||null,lastDataProbe,
      active:h&&["ANALYZING","PREDICTED","FAILED"].includes(h.status)&&clock()<h.expiresAt?h:null,
      lastSession:h,stats:stats()};
  };
  const all=(limit=50)=>history.slice(-Math.max(1,Math.min(Number(limit)||50,200))).reverse();
  const readFeed=async()=>{
    const r=await fetcher(feedUrl,{signal:AbortSignal.timeout(4500),
      headers:{Accept:"application/json"}});
    if(!r.ok)throw Error("MARKET_SOURCE_HTTP_"+r.status);
    return r.json();
  };
  async function analyze(session){
    const started=clock();
    let error=null;
    for(let i=1;i<=4;i++){
      session.attempts=i;persist();
      try{
        const payload=prompt(session);payload.model=model;
        const r=await fetcher(endpoint,{method:"POST",signal:AbortSignal.timeout(28000),
          headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
          body:JSON.stringify(payload)});
        modelCalls++;
        if(!r.ok)throw Error("DEEPSEEK_HTTP_"+r.status);
        const body=await r.json();
        if(body?.choices?.[0]?.finish_reason==="length")throw Error("AI_RESPONSE_TRUNCATED");
        const parsed=parseDirection(body?.choices?.[0]?.message?.content);
        session.direction=parsed.direction;
        session.confidence=parsed.confidence;
        session.reason=parsed.reason;
        session.analysisArguments={upCase:parsed.upCase,downCase:parsed.downCase,
          decisiveEvidence:parsed.decisiveEvidence,uncertainty:parsed.uncertainty};
        session.modelFinishedAt=clock();
        session.modelLatencyMs=clock()-started;
        session.status="PREDICTED";session.error=null;
        persist();return;
      }catch(e){error=String(e?.message||e).slice(0,160);}
    }
    session.status="FAILED";session.error="NO_VALID_DEEPSEEK_DIRECTION: "+error;
    session.modelFinishedAt=clock();session.direction=null;
    persist();
  }
  async function start(id){
    if(!/^[A-Za-z0-9_-]{12,90}$/.test(String(id)))throw Error("INVALID_IDEMPOTENCY_KEY");
    const existing=history.find(x=>x.id===id);
    if(existing)return existing;
    if(!key)throw Error("DEEPSEEK_NOT_CONFIGURED");
    if(busyStart)throw Error("CLICK_ALREADY_PROCESSING");
    if(history.some(x=>x.status==="ANALYZING"))throw Error("ANALYSIS_ALREADY_RUNNING");
    if(history.some(x=>clock()<x.expiresAt && ["ANALYZING","PREDICTED","FAILED"].includes(x.status)))
      throw Error("TEN_MINUTE_SESSION_ALREADY_ACTIVE");
    busyStart=true;
    const clickReceivedAt=clock();
    try{
      // Collect optional public USD-M features BEFORE freezing the reference tick.
      // This avoids using future information after the claimed entry reference time.
      const optional=await collectPublicFeatures({fetcher,now:clock});
      // Freeze a trustworthy reference tick AFTER public REST snapshots.
      // A tick lagging a just-observed order book can invalidate otherwise-real
      // depth data. Retry the trusted existing feed briefly; NEVER change
      // an exchange timestamp or use events newer than the reference tick.
      const receivedAt=clock();
      let feed=await readFeed();
      let snapshot=buildSnapshot(feed,clock());
      const observedTimes=Object.values(optional.features)
        .map(v=>v?.observedAt??v?.latestTradeAt??v?.latestClosedAt??null)
        .filter(Number.isFinite);
      const target=observedTimes.length?Math.max(...observedTimes):null;
      if(target!==null&&target>snapshot.observedAt&&
         target-snapshot.observedAt<=3500){
        for(let attempt=0;attempt<6&&snapshot.observedAt<target;attempt++){
          await new Promise(resolve=>setTimeout(resolve,350));
          const retryFeed=await readFeed();
          const newer=buildSnapshot(retryFeed,clock());
          if(newer.observedAt>snapshot.observedAt){
            feed=retryFeed;snapshot=newer;
          }
        }
      }
      const rollingTenMinutes=tenMinuteWindow(feed,clock());
      const availability={...optional.availability};
      // Query stream history AS OF the frozen reference tick. The live stream
      // naturally runs ahead of a slightly delayed spot-price proxy tick.
      // Compare historical windows instead of wrongly rejecting fresh live
      // data for being a few milliseconds newer than that reference.
      let continuous=null,continuousError="COLLECTOR_UNAVAILABLE";
      try{
        const cr=await fetcher(streamUrl+"?asof="+snapshot.observedAt,{
          signal:AbortSignal.timeout(1800),headers:{Accept:"application/json"}});
        if(!cr.ok)throw Error("COLLECTOR_HTTP_"+cr.status);
        const cj=await cr.json();
        if(cj?.ok===true&&cj?.source==="BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET"&&
           cj.asOf===snapshot.observedAt)continuous=cj;
        else throw Error("COLLECTOR_ASOF_NOT_VERIFIED");
      }catch(e){continuousError=String(e?.message||e).slice(0,80)}
      let continuousTradeFlow=null;
      if(continuous){
        const windows={};
        for(const [name,w] of Object.entries(continuous.windows||{})){
          if(w.complete===true&&w.to!==null&&w.to<=snapshot.observedAt&&
              w.lastStreamReceiveAgeMs!==null&&w.lastStreamReceiveAgeMs<=5000)
            windows[name]=w;
        }
        if(Object.keys(windows).length){
          continuousTradeFlow={source:continuous.source,asOf:continuous.asOf,
            windows,missingAggregateIds:continuous.missingAggregateIds,
            gapCount:continuous.gapCount,reconnectCount:continuous.reconnectCount};
          availability.continuousAggTrade={available:true,windows:Object.keys(windows)};
        }else{
          const issues=Object.entries(continuous.windows||{})
            .map(([name,w])=>name+":"+(w.issues||[]).join(","));
          availability.continuousAggTrade={available:false,
            error:"INCOMPLETE_OR_UNFRESH_STREAM_WINDOW",
            reasons:issues.slice(0,3)};
        }
      }else availability.continuousAggTrade={available:false,error:continuousError};
      const filtered={};
      for(const [section,value] of Object.entries(optional.features)){
        const observed=value.observedAt??value.latestTradeAt??value.latestClosedAt??null;
        if(observed!==null&&observed>snapshot.observedAt){
          availability[section]={available:false,error:"NEWER_THAN_REFERENCE_TICK"};
        }else filtered[section]=value;
      }
      const enriched={source:optional.source,features:filtered,
        available:Object.keys(filtered).length,total:optional.total};
      lastDataProbe={checkedAt:clock(),available:enriched.available,total:enriched.total,
        availability};
      // Signal and reference price are frozen from ONE verified tick near the click.
      if(clock()-receivedAt>7000)throw Error("CAPTURE_REQUEST_TOO_SLOW");
      const session={id,clickReceivedAt,openedAt:snapshot.observedAt,
        clickToCaptureMs:clock()-clickReceivedAt,
        expiresAt:snapshot.observedAt+HORIZON_MS,openPrice:snapshot.price,
        openAgeMs:snapshot.observedAgeMs,features:snapshot.indicators,
        rollingTenMinutes,enrichment:enriched,continuousTradeFlow,featureAvailability:availability,
        sourceWarnings:optional.caveats,
        featureBundleVersion:"EVENT10_PUBLIC_USDM_V2",
        decisionReviewVersion:REVIEW_VERSION,decisionReview:null,analysisArguments:null,
        source:SOURCE,status:"ANALYZING",direction:null,
        model,attempts:0,confidence:null,reason:null,modelFinishedAt:null,
        closePrice:null,closeObservedAt:null,expirySampleLagMs:null,
        proxyOutcome:null,proxyHit:null,returnPct:null,
        officialEventOutcome:null,officialEventHit:null,
        realOrderPlaced:false,error:null};
      session.decisionReview=buildDecisionReview(session);
      history.push(session);
      if(history.length>500)history.splice(0,history.length-500);
      persist();
      void analyze(session).catch(e=>{
        session.status="FAILED";session.direction=null;
        session.error="UNEXPECTED_MODEL_FAILURE: "+String(e?.message||e).slice(0,120);
        try{persist();}catch{}
      });
      return session;
    }catch(e){lastError=String(e?.message||e).slice(0,160);throw e;}
    finally{busyStart=false;}
  }
  async function tick(){
    if(busySettle||clock()-lastCheckAt<1100)return;
    lastCheckAt=clock();
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
    const d=await collectPublicFeatures({fetcher,now:clock});
    lastDataProbe={checkedAt:clock(),available:d.available,total:d.total,
      availability:d.availability};
    return {ok:true,...lastDataProbe,source:d.source,
      officialEventContractIndex:false,realOrderPlaced:false};
  }
  return {status,start,tick,probe,history:all};
}
