// Manual EVENT10 analysis engine. Always no real Binance event-contract order endpoints.
import fs from "node:fs";
import path from "node:path";
import {tenMinuteWindow} from "./market-enrichment.mjs";
import {evaluatePureSignal,collectRuleFeatures,RULE_VERSION} from "./pure-signal.mjs";
import {confirmedPriceStructure} from "./price-structure.mjs";
import {collectIndependentSpotCandles} from "./readonly-candles.mjs";

export const HORIZON_MS = 600_000;
export const MIN_SIGNAL_GAP_MS = 0;
export const MAX_SIGNALS_PER_10M = 3;
export const SIGNAL_WINDOW_MS = 600_000;
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
    return Array.isArray(d)?d.filter(x=>x&&typeof x.id==="string"&&finite(x.openedAt)&&finite(x.expiresAt)):[]}
  catch(e){if(e.code==="ENOENT")return [];throw e;}
}
function store(file,records){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
  const tmp=file+"."+process.pid+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(records),{mode:0o600});
  fs.renameSync(tmp,file);
}

// Dedicated append-only ledger for EVERY accepted V1 UP/DOWN signal.
// The legacy session state is bounded for execution/runtime size, but this
// independent ledger is never trimmed and preserves older signals and outcomes.
function slimSignal(h) {
  const evidence=h.ruleChecks?.evidence||{};
  return {
    id:h.id,strategyVersion:h.decisionReviewVersion,model:h.model||"PURE_RULES_V1",
    trigger:String(h.id).startsWith("auto-")?"AUTO":"MANUAL",
    aiDirection:h.aiReview?.status==="AI_REVIEWED"?h.aiReview.direction:null,
    baseDirection:h.aiReview?.baseDirection??h.direction,
    aiStatus:h.aiReview?.status??"NOT_REQUESTED",
    aiModel:h.aiReview?.model??null,aiConfidence:h.aiReview?.confidence??null,
    aiReason:h.aiReview?.reason??null,aiLatencyMs:h.aiReview?.latencyMs??null,
    aiLessonsCount:h.aiReview?.lessonsCount??0,
    aiAnalysisCompleted:h.aiReview?.analysisCompleted===true,
    aiAttempts:h.aiReview?.attempts??0,
    aiReasoningEffort:h.aiReview?.reasoningEffort??null,
    aiReasoningObserved:h.aiReview?.reasoningObserved??false,
    openedAt:h.openedAt,expiresAt:h.expiresAt,
    referencePriceObservedAt:h.referencePriceObservedAt??null,
    referenceBasis:h.referenceBasis??null,
    horizonMs:Number.isFinite(h.openedAt)&&Number.isFinite(h.expiresAt)?h.expiresAt-h.openedAt:null,
    direction:h.direction,openPrice:h.openPrice,
    signalId:h.id,eventTag:h.ruleChecks?.eventTag??h.eventTag??null,
    signalQuality:h.ruleChecks?.quality??h.signalQuality??null,
    change3mPct:h.ruleChecks?.change3mPct??h.change3mPct??null,requestId:h.id,
    twoMinuteBarAt:evidence.timeframes?.["2m"]?.lastClosedAt??null,
    trendScore:evidence.trendScore??null,
    trendDecisionReason:evidence.trendDecisionReason??null,
    liveIndexDelta:evidence.liveIndexDelta??null,
    shortTermDirection:evidence.shortTermDirection??null,
    volumeRatio:Number.isFinite(evidence.volumeRatio)?evidence.volumeRatio:null,
    rsi14:Number.isFinite(evidence.rsi14)?evidence.rsi14:null,
    leadPct:Number.isFinite(evidence.signedLeadPct)?Math.abs(evidence.signedLeadPct):null,
    retracementRatioPct:Number.isFinite(evidence.leadingAmount)&&evidence.leadingAmount>0?
      round(100*(h.direction==="UP"?evidence.pullbackPrice:evidence.reboundPrice)/
        evidence.leadingAmount,2):null,
    checks:h.ruleChecks?.conditions||null,
    closePrice:h.closePrice??null,closeObservedAt:h.closeObservedAt??null,
    expirySampleLagMs:h.expirySampleLagMs??null,
    proxyHit:typeof h.proxyHit==="boolean"?h.proxyHit:null,
    proxyOutcome:h.proxyOutcome??null,
    settlementStatus:h.settlementStatus??null,
    status:h.status,realOrderPlaced:false
  };
}
function openSignalLedger(file,sessionHistory) {
  const all=new Map();
  if(fs.existsSync(file)){
    const lines=fs.readFileSync(file,"utf8").split("\n");
    for(let i=0;i<lines.length;i++){
      const line=lines[i].trim();
      if(!line)continue;
      let event;
      try{event=JSON.parse(line)}
      catch{throw Error("EVENT10_SIGNAL_LEDGER_CORRUPTED_LINE_"+(i+1));}
      if(event?.kind==="SIGNAL"&&event.signal?.id&&
         ["UP","DOWN"].includes(event.signal.direction)){
        all.set(event.signal.id,event.signal);
      }else if(event?.kind==="SETTLEMENT"&&all.has(event.id)){
        const prior=all.get(event.id);
        all.set(event.id,{...prior,...event.result});
      }
    }
  }
  const append=event=>{
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
    fs.appendFileSync(file,JSON.stringify(event)+"\n",{encoding:"utf8",mode:0o600,flag:"a"});
  };
  // Restore rule signals already saved in existing session history before
  // ledger introduction, including any previously settled outcomes.
  for(const h of sessionHistory){
    if(h.decisionReviewVersion!==RULE_VERSION||
       !["UP","DOWN"].includes(h.direction)||all.has(h.id))continue;
    const signal=slimSignal(h);
    append({kind:"SIGNAL",signal});
    all.set(h.id,signal);
  }
  function add(h){
    if(all.has(h.id))return all.get(h.id);
    const signal=slimSignal(h);
    append({kind:"SIGNAL",signal});
    all.set(h.id,signal);
    return signal;
  }
  function settle(h){
    const existing=all.get(h.id);
    if(!existing)return;
    const result={
      closePrice:h.closePrice??null,closeObservedAt:h.closeObservedAt??null,
      proxyHit:typeof h.proxyHit==="boolean"?h.proxyHit:null,
      proxyOutcome:h.proxyOutcome??null,expirySampleLagMs:h.expirySampleLagMs??null,
      settlementStatus:h.settlementStatus??null,status:h.status
    };
    if(existing.settlementStatus===result.settlementStatus&&
       existing.closeObservedAt===result.closeObservedAt)return;
    append({kind:"SETTLEMENT",id:h.id,result});
    all.set(h.id,{...existing,...result});
  }
  function list(limit=25,offset=0){
    const take=Math.max(1,Math.min(100,Number(limit)||25));
    const skip=Math.max(0,Math.min(1000000,Number(offset)||0));
    const ordered=Array.from(all.values()).filter(x=>x.strategyVersion===RULE_VERSION)
      .sort((a,b)=>b.openedAt-a.openedAt||b.id.localeCompare(a.id));
    const settled=ordered.filter(x=>typeof x.proxyHit==="boolean");
    const hits=settled.filter(x=>x.proxyHit===true).length;
    const byTier={};
    for(const tier of ['STRICT_RESEARCH','STANDARD_RESEARCH']){
      const rows=ordered.filter(x=>x.signalQuality===tier);
      const done=rows.filter(x=>typeof x.proxyHit==='boolean');
      const wins=done.filter(x=>x.proxyHit===true).length;
      byTier[tier]={total:rows.length,settled:done.length,hits:wins,misses:done.length-wins,
        accuracyPct:done.length?round(wins*100/done.length,2):null};
    }
    const percentage=n=>n.length?round(n.filter(x=>x.proxyHit===true).length*100/n.length,2):null;
    return {ok:true,version:RULE_VERSION,
      total:ordered.length,limit:take,offset:skip,records:ordered.slice(skip,skip+take),
      stats:{total:ordered.length,validDirections:ordered.length,
        proxySettled:settled.length,proxyHits:hits,proxyMisses:settled.length-hits,
        proxyAccuracyPct:settled.length?round(hits*100/settled.length,2):null,
        last5Pct:percentage(settled.slice(0,5)),
        last10Pct:percentage(settled.slice(0,10)),byTier},
      officialEventContractResultsAvailable:false,autoTradingEnabled:false};
  }
  return {all,add,settle,list};
}

export function createEngine({env=process.env,clock=Date.now,fetcher=fetch}={}) {
  const feedUrl=String(env.EVENT10_READONLY_FEED||"http://127.0.0.1:13003/api/shadow-market-data");
  // Stream collector is not a gate of this strategy.
  const file=String(env.EVENT10_STATE_FILE||"/var/lib/zl-event10/manual-sessions-v2.json");
  const persistedSessions=load(file);
  const ledgerFile=String(env.EVENT10_SIGNAL_LOG_FILE||path.join(path.dirname(file),"rule-signals-v1.ndjson"));
  const signalLedger=openSignalLedger(ledgerFile,persistedSessions);
  const auditFile=String(env.EVENT10_SCAN_AUDIT_FILE||path.join(path.dirname(file),"rule-scan-audit-v16.json"));
  let scanAudit=[];
  try{const rows=JSON.parse(fs.readFileSync(auditFile,"utf8"));
    if(Array.isArray(rows))scanAudit=rows.filter(x=>Number.isFinite(x?.at)&&typeof x?.id==="string").slice(-3000);
  }catch(e){if(e.code!=="ENOENT")throw e;}
  function registerScan(id,at,rule){
    const side=Number(rule?.change3mPct)<0?"DOWN":"UP";
    const checks=rule?.direction?{}:(side==="UP"?rule?.standardUpChecks:rule?.standardDownChecks)||{};
    const fails=Object.entries(checks).filter(([,ok])=>ok===false).map(([gate])=>gate);
    const rec={id,at,source:id.startsWith("auto-")?"AUTO":"MANUAL",direction:rule?.direction||null,
      tier:rule?.direction?rule.quality:null,tag:rule?.eventTag||rule?.status||"DATA_ERROR",fails,
      dataError:rule?.status==="DATA_ERROR"};
    const ix=scanAudit.findIndex(x=>x.id===id);
    if(ix>=0)scanAudit[ix]=rec;else scanAudit.push(rec);
    scanAudit=scanAudit.filter(x=>x.at>=at-86400000).slice(-3000);
    try{store(auditFile,scanAudit)}catch(err){lastError="SCAN_AUDIT_WRITE_"+String(err?.message||err).slice(0,100);}
  }
  function scanSummary(){
    const aggregate=rows=>{
      const byReason={};let strict=0,standard=0,none=0,errors=0;
      for(const x of rows){
        if(x.tier==="STRICT_RESEARCH")strict++;
        else if(x.tier==="STANDARD_RESEARCH")standard++;
        else{if(x.dataError)errors++;else none++;
          if(x.fails.length){for(const k of x.fails)byReason[k]=(byReason[k]||0)+1;}
          else byReason[x.tag]=(byReason[x.tag]||0)+1;}
      }
      return {checks:rows.length,strictSignals:strict,standardSignals:standard,
        noSignal:none,dataErrors:errors,byReason};
    };
    return {lastHour:aggregate(scanAudit.filter(x=>x.at>=clock()-3600000&&x.at<=clock()+1000)),
      last24Hours:aggregate(scanAudit),lastScanAt:scanAudit.at(-1)?.at??null,
      note:"V27每12秒分析EMA加速度与均线距衰竭，已结算同向失败后重新确认；保留六周期趋势、远近区间及10分钟3条上限。"};
  }

  // Only pending/last 500 full sessions remain hot; the signal ledger retains all.
  const history=persistedSessions.slice(-500);
  for(const h of history)if(h.status==="ANALYZING"){
    h.status="FAILED";h.error="INTERRUPTED_DURING_AI_ANALYSIS";h.direction=null;
  }
  if(history.some(h=>h.error==="INTERRUPTED_DURING_AI_ANALYSIS"))store(file,history);
  let busyStart=false,busySettle=false,lastError=null;
  // Rule-only engine: no AI service, API call, inference, or AI required gate.
  // Historical AI records are retained for already issued T+600 settlements.
  let previousIndexSnapshot=null; // refreshed every scan, even when published-signal quota is full
  let candleCache=null,candleCacheAt=0,candleCacheMinute=-1;
  const aiStats={calls:0,reviewed:0,fallbacks:0,rejected:0,lastStatus:"DISABLED",lastAt:null};
  const aiConfigured=false,aiModel=null,aiInProgress=null;
  let lastDataError=null,lastDataErrorAt=null,lastSuccessfulScanAt=null;
  let lastCheck=null,inFlightStart=null;
  let lastCheckAt=0,lastAutoCheckAt=null;
  const autoAttempts=new Map();
  let lastDataProbe=null;
  const persist=()=>store(file,history);
  // Historical sessions are kept only for outstanding legacy proxy settlement;
  // the live API and current strategy dashboard expose only the active version.
  const latest=()=>history.filter(x=>x.decisionReviewVersion===RULE_VERSION).at(-1)||null;
  const stats=()=>({...signalLedger.list(1,0).stats,
    officialSettled:0,officialAccuracyPct:null});
  const status=()=>{
    const h=latest();
    const ledgerStats=signalLedger.list(1,0).stats;
    return {ok:true,bot:"EVENT10", mode:"EMA_DECAY_REENTRY_V27_12S_TRIPLE_SIGNAL_TPLUS600_PROXY_ONLY",
      providerModel:"PURE_SIGNAL_V27_EMA_DECAY_REENTRY",aiMandatory:false,
      aiReviewConfigured:false,aiReviewModel:null,aiLearningMode:"DISABLED",
      aiReviewStats:{...aiStats},aiInProgress:null,
      aiLearningProfile:null,
      configured:true,autoSignalEnabled:true,
      manualStartEnabled:true,autoTradingEnabled:false,executionAvailable:false,
      officialEventContractResultsAvailable:false,
      priceSource:"BINANCE_USDM_SIGNAL_CAPTURED_INDEX_TPLUS600_PROXY_NOT_ORDER_STRIKE",
      horizonMs:HORIZON_MS,minSignalGapMs:MIN_SIGNAL_GAP_MS,
       maxSignalsPerTenMinutes:MAX_SIGNALS_PER_10M,
       rollingSignalWindowMs:SIGNAL_WINDOW_MS,livePriceUsedForDirection:true,
       overlappingObservationsAllowed:true,activeSignalCount:history.filter(x=>
         x.decisionReviewVersion===RULE_VERSION&&x.status==="PREDICTED"&&
         !x.settlementStatus&&clock()<x.expiresAt).length,
       busyStart,busySettle,modelCalls:aiStats.calls,lastError,
       lastDataError,lastDataErrorAt,lastSuccessfulScanAt,scanDiagnostics:scanSummary(),
      enrichmentVersion:"EVENT10_EMA_DECAY_REENTRY_10M_V27",
       autoIntervalMs:12_000,lastAutoCheckAt,
       nextAutoCheckAt:(Math.floor(clock()/12_000)+1)*12_000,
      multiTimeframeIntervals:["1m","2m","5m","10m","15m","30m"],
      minDuplicateSameDirectionMs:120000,
      requiresNewCompleted2mBarForRepeat:true,
      maxSignalsPerTenMinutes:MAX_SIGNALS_PER_10M,
      lastTimeframeAnalysis:lastCheck?.evidence?.timeframes||null,
      lastTrendScore:lastCheck?.evidence?.trendScore??null,
      decisionReviewVersion:RULE_VERSION,explanationLanguage:"zh-CN",
      thinkingMode:"disabled",reasoningEffort:null,
      lastReasoningObserved:null,lastReasoningTokenCount:null,
      lastFeatureCoverage:lastCheck?.featureAvailability||h?.featureAvailability||null,lastDataProbe,lastCheck,
      active:h&&["ANALYZING","PREDICTED"].includes(h.status)&&clock()<h.expiresAt?h:null,
      lastSession:h,stats:stats(),
      strategyStats:{total:ledgerStats.total,proxySettled:ledgerStats.proxySettled,
        proxyHits:ledgerStats.proxyHits,proxyAccuracyPct:ledgerStats.proxyAccuracyPct}};
  };
  const all=(limit=50)=>history.filter(x=>x.decisionReviewVersion===RULE_VERSION)
    .slice(-Math.max(1,Math.min(Number(limit)||50,200))).reverse();
  const readFeed=async()=>{
    // Closed candles change at minute boundaries. Cache at most 24 seconds,
    // and ALWAYS re-fetch fresh Binance futures index on every 12s scan.
    const n=clock(),minute=Math.floor(n/60000);
    if(candleCache&&candleCacheMinute===minute&&n-candleCacheAt<24000)
      return candleCache;
    let data=null;
    try{
      const r=await fetcher(feedUrl,{signal:AbortSignal.timeout(500),
        headers:{Accept:"application/json"}});
      if(r.ok){
        const value=await r.json();
        // Older shadow feeds only carry 1m/5m; use the independent source
        // when 15m/30m history is missing.
        if(value?.ok===true&&value?.readOnly===true&&value?.symbol==="BTCUSDT"&&
           value?.latest?.marketFeedConnected!==false&&
           value?.candles?.["15m"]&&value?.candles?.["30m"])
          data=value;
      }
    }catch{}
    if(!data)data=await collectIndependentSpotCandles({fetcher,now:clock,timeoutMs:2400});
    candleCache=data;candleCacheAt=clock();candleCacheMinute=Math.floor(candleCacheAt/60000);
    return data;
  };
  // One shared read-only market scan. A manual click during the scheduled
  // 12-second scan joins the very same result instead of returning a spurious
  // CLICK_ALREADY_PROCESSING error or duplicating a 10-minute prediction.
  async function start(id){
    if(!/^[A-Za-z0-9_-]{12,90}$/.test(String(id)))throw Error("INVALID_IDEMPOTENCY_KEY");
    const existing=history.find(x=>x.id===id);
    if(existing)return existing;
    if(signalLedger.all.has(id))return signalLedger.all.get(id);
    if(inFlightStart)throw Error("ANALYSIS_ALREADY_RUNNING");
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
      // All source data must be known BEFORE the actual decision time.
      // Binance spot last-trade tick may be earlier than a fresh futures
      // orderbook snapshot; that does NOT make this already-received depth
      // future data. The decision clock, not the last spot TRADE time,
      // defines the information cutoff.
      const [market,feed]=await Promise.all([
        collectRuleFeatures({fetcher,now:clock,timeoutMs:1200}),readFeed()
      ]);
      const decisionAt=clock();
      if(decisionAt-clickReceivedAt>5000)throw Error("SIGNAL_SNAPSHOT_TOO_SLOW");
      const availability={...market.availability},filtered={};
      for(const [k,v] of Object.entries(market.features)){
        const observed=v.observedAt;
        const maxAge=k==="indexQuote"?5000:5000;
        if(!Number.isSafeInteger(observed)||observed>decisionAt||
            decisionAt-observed>maxAge||
            !Number.isSafeInteger(v.receivedAt)||v.receivedAt>decisionAt)
          availability[k]={available:false,error:"SOURCE_OUTSIDE_DECISION_WINDOW"};
        else filtered[k]=v;
      }
      const reference={observedAt:decisionAt};
      const rule=evaluatePureSignal({feed,reference,
        indexSnapshot:filtered.indexQuote,previousIndexSnapshot,
        trigger:id.startsWith("auto-")?"AUTO":"MANUAL"});
      previousIndexSnapshot=filtered.indexQuote;
      // Clear stale-feed error after BOTH latest closed bars and the index
      // quote have passed the fresh-data validation in evaluatePureSignal.
      lastSuccessfulScanAt=clock();lastError=null;
      // Only publication cap: maximum three genuine multi-timeframe directions in ANY rolling
      // ten minutes, covering manual/auto and persisted previous-version signals.
      const recentSignals=Array.from(signalLedger.all.values()).filter(h=>
        ["UP","DOWN"].includes(h.direction)&&Number.isFinite(h.openedAt)&&
        h.openedAt<=decisionAt&&h.openedAt>decisionAt-SIGNAL_WINDOW_MS);
      if(rule.direction&&recentSignals.length>=MAX_SIGNALS_PER_10M){
        rule.direction=null;rule.signal="NO_SIGNAL";rule.status="NO_SIGNAL";
        rule.quality="CAP_REACHED";rule.eventTag="V21_ROLLING_10M_CAP";
        rule.reason="滚动10分钟已有3条有效方向；后台继续分析实时指数价，额度释放后立即恢复。";
        rule.evidence.recentTenMinuteSignals=recentSignals.length;
      }
      // V23 de-duplicate highly correlated bets. A real new same-side signal
      // needs a new completed 2-minute bar and >=120s since the previous one,
      // not just another 12-second API snapshot. Uses the persistent ledger,
      // so app restarts and manual clicks cannot evade these checks.
      if(rule.direction){
        const same=recentSignals.filter(h=>h.direction===rule.direction)
          .sort((a,b)=>b.openedAt-a.openedAt)[0];
        const currentBar=rule.evidence?.timeframes?.["2m"]?.lastClosedAt;
        const previousBar=same?.twoMinuteBarAt??same?.ruleChecks?.evidence?.timeframes?.["2m"]?.lastClosedAt;
        const repeated=!!same&&(
          decisionAt-same.openedAt<120000||
          (Number.isFinite(currentBar)&&Number.isFinite(previousBar)&&currentBar<=previousBar));
        if(repeated){
          rule.direction=null;rule.signal="NO_SIGNAL";rule.status="NO_SIGNAL";
          rule.quality="NO_SIGNAL";rule.eventTag="V23_DUPLICATE_TREND";
          rule.reason="同向信号与上一条行情高度重合；仍每12秒分析，等待至少120秒和新收盘2分钟K线。";
          rule.evidence.duplicateOf=same.id;rule.evidence.nextEligibleAt=same.openedAt+120000;
        }
      }
      // V27 isolated proxy-outcome guard: following a confirmed 600s
      // same-side MISS, demand a fresh independent 2m candle and renewed
      // EMA9/21 directional momentum before repeating within six minutes.
      // Never read unexpired/pending outcomes; never block the opposite side.
      if(rule.direction){
        const latestResolvedSame=Array.from(signalLedger.all.values())
          .filter(h=>h.direction===rule.direction&&
            (h.proxyHit===true||h.proxyHit===false)&&
            Number.isFinite(h.closeObservedAt)&&h.closeObservedAt<=decisionAt&&
            h.closeObservedAt>decisionAt-360000)
          .sort((a,b)=>b.closeObservedAt-a.closeObservedAt)[0];
        if(latestResolvedSame?.proxyHit===false){
          const d=rule.direction==="UP"?1:-1;
          const e=rule.evidence?.emaEntry||{};
          const pa=rule.evidence?.spotPriceAction;
          const bar=rule.evidence?.timeframes?.["2m"]?.lastClosedAt;
          const oldBar=latestResolvedSame?.ruleChecks?.evidence?.timeframes?.["2m"]?.lastClosedAt;
          const renewed=Number.isFinite(pa?.threeMinuteBps)&&
            d*pa.threeMinuteBps>=5&&
            e["1m"]?.direction===rule.direction&&e["2m"]?.direction===rule.direction&&
            d*e["1m"]?.spreadChangeBps>=0.25&&
            d*e["2m"]?.ema9SlopeBps>=0.3&&
            Number.isFinite(bar)&&Number.isFinite(oldBar)&&bar>oldBar;
          if(!renewed){
            rule.direction=null;rule.signal="NO_SIGNAL";rule.status="NO_SIGNAL";
            rule.quality="NO_SIGNAL";rule.eventTag="V27_PREVIOUS_LOSS_REENTRY_WAIT";
            rule.reason="同方向最近一次600秒代理结算未命中，等待新2分钟K线与EMA动量重新确认；不会限制反方向信号。";
            rule.evidence.previousMissId=latestResolvedSame.id;
            rule.evidence.previousMissSettledAt=latestResolvedSame.closeObservedAt;
          }
        }
      }
      // A sudden 12-second flip is noise unless the live index has moved
      // enough from the prior lock price. Opposite directions remain allowed.
      if(rule.direction){
        const prior=recentSignals.slice().sort((a,b)=>b.openedAt-a.openedAt)[0];
        const quote=Number(filtered.indexQuote?.price);
        const differenceBps=prior&&Number.isFinite(prior.openPrice)&&prior.openPrice>0?
          Math.abs(quote/prior.openPrice-1)*10000:null;
        if(prior&&prior.direction!==rule.direction&&decisionAt-prior.openedAt<60000&&
          (differenceBps===null||differenceBps<3)){
          rule.direction=null;rule.signal="NO_SIGNAL";rule.status="NO_SIGNAL";
          rule.quality="NO_SIGNAL";rule.eventTag="V23_UNCONFIRMED_QUICK_FLIP";
          rule.reason="距离上一条反向信号太近且指数变化不足3bps，避免短线噪声反复改方向。";
          rule.evidence.previousSignalId=prior.id;
        }
      }
      // V23 validated multi-timeframe direction plus fresh index; no AI or orders.
      // Use the same fresh index quote at rule evaluation time; the full
      // 600-second proxy verification window begins when the signal is recorded.
      const aiReview=null;
      const publishAt=decisionAt;
      const publishIndex=filtered.indexQuote;
      if(rule.direction){
        rule.eventTag="V27_RULE_"+rule.direction;
        rule.evidence.indicatorSnapshotAt=decisionAt;
        rule.evidence.finalPublishedAt=publishAt;
        rule.evidence.liveIndexPrice=publishIndex.price;
        rule.evidence.referenceSource=publishIndex.source;
      }
      const signalExpiry=publishAt+HORIZON_MS;
      const openingIndex=null;
      const liveIndex=rule.direction?publishIndex?.price??null:filtered.indexQuote?.price??null;
      lastCheck={id,checkedAt:clock(),checkLatencyMs:clock()-clickReceivedAt,
        openedAt:rule.direction?publishAt:null,
        referencePriceObservedAt:(rule.direction?publishIndex:filtered.indexQuote)?.observedAt??null,
        openAgeMs:(rule.direction?publishIndex:filtered.indexQuote)?.observedAt!=null?
          publishAt-(rule.direction?publishIndex:filtered.indexQuote).observedAt:null,
        openPrice:rule.direction?liveIndex:null,cycleOpenIndexPrice:openingIndex,
        liveIndexPrice:liveIndex,expiresAt:rule.direction?signalExpiry:null,
        ...rule,aiReview,featureAvailability:availability};
      lastDataProbe={checkedAt:clock(),available:Object.keys(filtered).length,
        total:market.total,availability};
      if(!rule.direction){registerScan(id,clock(),rule);return lastCheck;}
      const session={id,clickReceivedAt,openedAt:publishAt,
        clickToCaptureMs:clock()-clickReceivedAt,expiresAt:signalExpiry,
        openPrice:liveIndex,cycleOpenIndexPrice:openingIndex,liveIndexPrice:liveIndex,
        referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
        openAgeMs:publishIndex?publishAt-publishIndex.observedAt:null,
        referencePriceObservedAt:publishIndex?.observedAt??null,
        modelInputAt:decisionAt,
        priceStructure:rule.evidence?.entryHorizons||null,features:rule.evidence,
        rollingTenMinutes:null,
        enrichment:{source:market.source,features:filtered,
          available:Object.keys(filtered).length,total:market.total},
        featureAvailability:availability,sourceWarnings:market.caveats,
        featureBundleVersion:RULE_VERSION,decisionReviewVersion:RULE_VERSION,strategyVersion:RULE_VERSION,
        decisionReview:null,compactEvidence:null,analysisArguments:null,
        source:"BINANCE_USDM_INDEX_SIGNAL_CAPTURE_TPLUS600_NOT_ORDER_STRIKE",
        status:"PREDICTED",direction:rule.direction,
        ruleChecks:rule,eventTag:rule.eventTag,signalQuality:rule.quality,change3mPct:rule.change3mPct,
         signalCycleStartMs:rule.cycleStartAt,
        model:"PURE_SIGNAL_V27_EMA_DECAY_REENTRY",
        aiReview:null,attempts:0,confidence:null,reason:rule.reason,
        modelFinishedAt:clock(),modelLatencyMs:clock()-clickReceivedAt,
        thinkingRequested:false,reasoningEffort:null,
        reasoningObserved:false,reasoningTokenCount:null,
        closePrice:null,closeObservedAt:null,expirySampleLagMs:null,
        proxyOutcome:null,proxyHit:null,returnPct:null,
        officialEventOutcome:null,officialEventHit:null,
        realOrderPlaced:false,error:null};
            // Append to independent audit trail before acknowledging this valid direction.
      signalLedger.add(session);
      history.push(session);
      if(history.length>500)history.splice(0,history.length-500);
      persist();registerScan(id,clock(),rule);return session;
     }catch(e){
      // Market-data failures are NOT valid directions. Return a terminal
      // read-only DATA_ERROR result so the UI can stop its loading state.
      const error=String(e?.message||e).slice(0,160);
      lastError=error;lastDataError=error;lastDataErrorAt=clock();
      lastCheck={id,checkedAt:clock(),checkLatencyMs:clock()-clickReceivedAt,openedAt:null,openPrice:null,
        status:"DATA_ERROR",signal:"NO_SIGNAL",direction:null,
        reason:"数据检查未完成："+error+"。本次未产生交易方向。",
        error,featureAvailability:lastDataProbe?.availability||null};
      registerScan(id,clock(),lastCheck);return lastCheck;
    }
    finally{busyStart=false;}
  }
  async function tick(){
    if(busySettle||clock()-lastCheckAt<1100)return;
    lastCheckAt=clock();
    // Re-examine fresh BTC index price every 12s, with a unique slot ID.
    // No fixed time gap; the rolling 10m cap is the only publication limiter.
    const nowMs=clock(),slotStart=Math.floor(nowMs/12_000)*12_000;
    const slotId="auto-12s-"+slotStart;
    if(!busyStart&&!inFlightStart&&!autoAttempts.has(slotStart)&&
       !signalLedger.all.has(slotId)){
      autoAttempts.set(slotStart,true);
      lastAutoCheckAt=nowMs;
      void start(slotId).catch(error=>{
        lastError="AUTO_SLOT_"+String(error?.message||error).slice(0,100);
      });
    }
    for(const key of autoAttempts.keys())if(key<slotStart-60_000)autoAttempts.delete(key);
    const expiring=history.filter(h=>
      h.status==="PREDICTED" && h.proxyHit===null && h.proxyOutcome===null &&
      clock()>=h.expiresAt && !h.settlementStatus);
    if(!expiring.length)return;
    busySettle=true;
    try{
      const now=clock();
      for(const h of expiring){
        if(now>h.expiresAt+15000){
          h.settlementStatus="UNVERIFIABLE_PRICE_NEAR_EXPIRY";persist();signalLedger.settle(h);
        }
      }
      const pending=expiring.filter(h=>!h.settlementStatus);
      if(!pending.length)return;
      const indexSessions=pending.filter(h=>h.decisionReviewVersion===RULE_VERSION||
         h.decisionReviewVersion==="EVENT10_EMA_921_ENTRY_V26_20261113"||
         h.decisionReviewVersion==="EVENT10_MULTI_HORIZON_ENTRY_V25_20261113"||
         h.decisionReviewVersion==="EVENT10_PRICE_ACTION_V24_20261113"||
         h.decisionReviewVersion==="EVENT10_REVERSAL_AWARE_10M_V23_20261113"||
         h.decisionReviewVersion==="EVENT10_MULTI_TF_SUPERTREND_V22_20261112"||
         h.decisionReviewVersion==="EVENT10_LIVE_INDEX_3_PER_10M_V21_20261112"||
         h.decisionReviewVersion==="EVENT10_ENTRY_POSITION_V20_20261111"||
         h.decisionReviewVersion==="EVENT10_PURE_RULE_V19_20261107"||
        h.decisionReviewVersion==="EVENT10_AI_REQUIRED_LEARNING_V18_20261106"||
        h.decisionReviewVersion==="EVENT10_AI_FEEDBACK_V17_20261106"||
        h.decisionReviewVersion==="EVENT10_EMA5_DIRECTION_V16_20261106"||
        h.decisionReviewVersion==="EVENT10_PACED_MOMENTUM_V15_20261106"||
        h.decisionReviewVersion==="EVENT10_FAST_MOMENTUM_V14_20261105"||
        h.decisionReviewVersion==="EVENT10_QUALITY_FILTER_V13_20261105"||
        h.decisionReviewVersion==="EVENT10_DUAL_EMA_FREQUENCY_V12_20261105"||
        h.decisionReviewVersion==="EVENT10_DUAL_EMA_FREQUENCY_V12_20261105"||
        h.decisionReviewVersion==="EVENT10_TIERED_V11_20261105"||
        (h.decisionReviewVersion==="EVENT10_TIERED_V11_20261105"||h.decisionReviewVersion==="EVENT10_FREQUENCY_V10_20261104")||
        h.decisionReviewVersion==="EVENT10_TARGETED_MOMENTUM_V9_20261104"||
        h.decisionReviewVersion==="EVENT10_BALANCED_SIGNAL_V8_20261103"||
        h.decisionReviewVersion==="EVENT10_REVERSAL_GUARD_V7_20261103"||
        h.decisionReviewVersion==="EVENT10_FRESH_NONOVERLAP_V6_20261103"||
        h.decisionReviewVersion==="EVENT10_TREND_CONFIRMED_V5_20261103"||
        h.decisionReviewVersion==="EVENT10_HYBRID_3PH_V4_FRESH_20261102"||
        h.decisionReviewVersion==="EVENT10_HYBRID_3PH_V4_20261102"||
        h.decisionReviewVersion==="EVENT10_FREQ_2M_TREND_V3_20261102"||
        h.decisionReviewVersion==="EVENT10_BALANCED_TREND_5M_V2_20261102"||
        h.decisionReviewVersion==="EVENT10_SELECTIVE_TREND_V1_20261102"||
        h.decisionReviewVersion==="EVENT10_FORCED_CONTRARIAN_12M_V1_20261101"||
        h.decisionReviewVersion==="EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101"||
        h.decisionReviewVersion==="EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031"||
        h.decisionReviewVersion==="EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030");
      const oldSessions=pending.filter(h=>!indexSessions.includes(h));
      if(indexSessions.length){
        try{
          const r=await fetcher("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
            {signal:AbortSignal.timeout(2200),headers:{Accept:"application/json"}});
          if(!r.ok)throw Error("INDEX_SETTLEMENT_HTTP_"+r.status);
          const item=await r.json(),sampleAt=Number(item?.time),price=Number(item?.indexPrice);
          if(item?.symbol!=="BTCUSDT"||!Number.isSafeInteger(sampleAt)||
             !Number.isFinite(price)||price<=0||
             sampleAt>clock()+1000||clock()-sampleAt>5000)
            throw Error("INDEX_SETTLEMENT_UNVERIFIED");
          for(const h of indexSessions){
            if(sampleAt<h.expiresAt||sampleAt>h.expiresAt+15000)continue;
            const score=scoreProxy(h.openPrice,price,h.direction);
            Object.assign(h,{closePrice:price,closeObservedAt:sampleAt,
              expirySampleLagMs:sampleAt-h.expiresAt,
              settlementStatus:[RULE_VERSION,"EVENT10_EMA_921_ENTRY_V26_20261113","EVENT10_MULTI_HORIZON_ENTRY_V25_20261113","EVENT10_PRICE_ACTION_V24_20261113","EVENT10_REVERSAL_AWARE_10M_V23_20261113","EVENT10_MULTI_TF_SUPERTREND_V22_20261112","EVENT10_LIVE_INDEX_3_PER_10M_V21_20261112","EVENT10_ENTRY_POSITION_V20_20261111","EVENT10_PURE_RULE_V19_20261107","EVENT10_AI_REQUIRED_LEARNING_V18_20261106","EVENT10_AI_FEEDBACK_V17_20261106","EVENT10_EMA5_DIRECTION_V16_20261106","EVENT10_PACED_MOMENTUM_V15_20261106","EVENT10_FAST_MOMENTUM_V14_20261105","EVENT10_QUALITY_FILTER_V13_20261105","EVENT10_DUAL_EMA_FREQUENCY_V12_20261105","EVENT10_TIERED_V11_20261105","EVENT10_FREQUENCY_V10_20261104","EVENT10_TARGETED_MOMENTUM_V9_20261104","EVENT10_BALANCED_SIGNAL_V8_20261103","EVENT10_REVERSAL_GUARD_V7_20261103","EVENT10_FRESH_NONOVERLAP_V6_20261103","EVENT10_TREND_CONFIRMED_V5_20261103","EVENT10_HYBRID_3PH_V4_FRESH_20261102","EVENT10_HYBRID_3PH_V4_20261102","EVENT10_FREQ_2M_TREND_V3_20261102","EVENT10_BALANCED_TREND_5M_V2_20261102","EVENT10_SELECTIVE_TREND_V1_20261102","EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101","EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031"].includes(h.decisionReviewVersion)?
                "INDEX_SIGNAL_TPLUS10_PROXY_ONLY":"INDEX_CYCLE_PROXY_ONLY",
              ...score});persist();signalLedger.settle(h);
          }
        }catch(e){lastError="SETTLE_INDEX_"+String(e?.message||e).slice(0,120);}
      }
      if(oldSessions.length){
        const market=await readFeed();
        const observed=checkedTick(market,clock(),6000);
        for(const h of oldSessions){
          if(observed.observedAt<h.expiresAt||observed.observedAt>h.expiresAt+15000)
            continue;
          const score=scoreProxy(h.openPrice,observed.price,h.direction);
          Object.assign(h,{closePrice:observed.price,
            closeObservedAt:observed.observedAt,
            expirySampleLagMs:observed.observedAt-h.expiresAt,
            settlementStatus:"PUBLIC_MARKET_PROXY_ONLY",
            ...score});persist();signalLedger.settle(h);
        }
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
  return {status,start,tick,probe,history:all,signals:signalLedger.list};
}
