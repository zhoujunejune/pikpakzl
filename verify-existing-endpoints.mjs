const checks=[
 ['edge_status','https://edge-5m-v1.zl528094-3ba.workers.dev/status'],
 ['edge_market','https://edge-5m-v1.zl528094-3ba.workers.dev/market-check'],
 ['baseline_stats','https://trade-control-panel-production.up.railway.app/api/postflip-official-stats?model=BREAKOUT20_RSI_MACD_RANGE_V1'],
 ['hub_health','https://zl-free-market-hub.zl528094-3ba.workers.dev/health'],
 ['hub_market','https://zl-free-market-hub.zl528094-3ba.workers.dev/api/market'],
 ['hub_status','https://zl-free-market-hub.zl528094-3ba.workers.dev/api/status'],
 ['hub_home','https://zl-free-market-hub.zl528094-3ba.workers.dev/'],
 ['railway_v3_feed','https://signal-diagnostic-v3-production.up.railway.app/api/shadow-market-data'],
 ['railway_v2_official','https://signal-diagnostic-v2-production.up.railway.app/api/round-stats'],
 ['railway_panel_status','https://trade-control-panel-production.up.railway.app/api/status']
];
for(const [name,url]of checks){
 try{
  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const text=await response.text();let data;
  try{data=JSON.parse(text)}catch{data={nonJson:true,preview:text.slice(0,380)}}
  const d={name,http:response.status,ok:data.ok,model:data.model||null,
   latestDirection:data.latest?.direction||null,liveMarket:data.realData||null,
   venue:data.venue||data.health?.venue||null,
   trainingSamples:data.training?.samples??null,
   settledSamples:data.results?.overall?.samples??null,
   error:data.error||data.health?.marketError||null,preview:data.preview||null,cfRay:response.headers.get('cf-ray'),contentType:response.headers.get('content-type'),lastGoodDataAt:data.timed?.lastGoodDataAt??data.latest?.eventMs??data.dataIntegrity?.lastDepthAt??null,latestRound:data.latest?.round??null,latestLockedAt:data.latest?.lockedAt??null,nowRound:Math.floor(Date.now()/300000)*300000,recentPredictions:Array.isArray(data.recent)?data.recent.length:null,settlementSource:data.settlementSource??null,orders:data.orders??null,productionSignalSourceMode:data.productionSignalSourceMode??null,orderSignalModel:data.orderSignalModel??null,executionEligible:data.latest?.executionEligible??null};
  console.log(JSON.stringify(d));
 }catch(e){console.log(JSON.stringify({name,networkError:String(e?.message||e).slice(0,100)}));}
}

// Public read-only three-point sample, to distinguish transient provider issues from model-locked signals.
for(let i=0;i<3;i++){
 const at=Date.now(),u='https://zl-free-market-hub.zl528094-3ba.workers.dev/api/status';
 try{const r=await fetch(u,{signal:AbortSignal.timeout(14000)}),d=await r.json(),m=d.market||{},edge=d.edge||{};
 console.log(JSON.stringify({sample:i,at,marketOk:m.ok===true,venue:m.venue||null,source:m.source||null,marketError:m.error||null,marketAt:m.marketAt||null,edgeOk:edge.ok===true,edgeSamples:edge.samples??null,edgeLatest:edge.latest||null,edgeLastGoodDataAt:edge.lastGoodDataAt||null,edgeMarketError:edge.marketError||null,edgeOfficialError:edge.officialError||null}));}
 catch(e){console.log(JSON.stringify({sample:i,at,error:String(e).slice(0,120)}));}
 if(i<2)await new Promise(resolve=>setTimeout(resolve,6000));
}

// Independent, READ-ONLY data-provenance audit of the user's Railway endpoints.
// Do not print credentials, raw accounts or order data.
const auditRead=async(url,timeout=9500)=>{
 const r=await fetch(url,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(timeout),
 headers:{accept:'application/json'}});
 const data=await r.json();return {status:r.status,data};
};
for(const [name,url]of [
 ['RAILWAY_V3_HEALTH','https://signal-diagnostic-v3-production.up.railway.app/healthz'],
 ['RAILWAY_V3_MARKET','https://signal-diagnostic-v3-production.up.railway.app/api/shadow-market-data'],
 ['RAILWAY_V2_SETTLEMENT','https://signal-diagnostic-v2-production.up.railway.app/api/round-stats'],
 ['BINANCE_REFERENCE_TICKER','https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT']
]){
 try{
  const {status,data:d}=await auditRead(url);
  if(name==='RAILWAY_V3_HEALTH'){
   const h=d.dataIntegrity||{};
   console.log('AUDIT '+JSON.stringify({name,http:status,ok:d.ok,source:d.source,model:d.model,
    streamConnected:h.wsConnected,depthAgeMs:h.lastDepthAgeMs,tradeAgeMs:h.lastAggTradeAgeMs,
    lastMarketTs:h.lastMarketTs,lastExchangeLagMs:h.lastExchangeEventLagMs,
    predictionWsConnected:h.predictionOrderbookConnected,
    predictionOrderbookFresh:h.predictionOrderbookFresh,
    simulated:h.simulated,estimatedOrderBook:h.estimatedOrderBook,
    ageMs:h.lastMessageAgeMs}));
  }else if(name==='RAILWAY_V3_MARKET'){
   const l=d.latest||{},h=d.integrity||{},c=d.candles||{};
   console.log('AUDIT '+JSON.stringify({name,http:status,ok:d.ok,readOnly:d.readOnly,
    source:d.source,generatedAt:d.generatedAtMs,spotPrice:l.lastPrice,
    spotAt:l.eventMs,spotAgeMs:l.ageMs,spotSource:l.source,
    oneMinuteRows:c['1m']?.rows?.length,fiveMinuteRows:c['5m']?.rows?.length,
    oneMinuteProvider:c['1m']?.provider,fiveMinuteProvider:c['5m']?.provider,
    complete:h.complete,errors:h.errors||[],symbol:d.symbol}));
  }else if(name==='RAILWAY_V2_SETTLEMENT'){
   const rows=(d.records||[]).filter(x=>x?.roundStartMs);
   const settled=rows.filter(x=>['UP','DOWN'].includes(x.productionActual));
   const strict=settled.filter(x=>x.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION'&&
      /STRICT_ROUND_ALIGNED_TOPIC/.test(String(x.resolutionEvidence||'')) &&
      x.officialDirection===x.productionActual);
   const samples=strict.slice(0,3).map(x=>({round:x.roundStartMs,actual:x.productionActual,
    evidence:x.resolutionEvidence,topicId:x.predictionMarketTopicId,
    topicStart:x.officialSettlementAudit?.topicStartDate,
    topicEnd:x.officialSettlementAudit?.topicEndDate,
    endpoint:x.officialSettlementAudit?.sourceEndpoint,
    responseSha256Present:/^[a-f0-9]{64}$/.test(x.officialSettlementAudit?.detailPayloadSha256||''),
    aligned:Number(x.officialSettlementAudit?.topicStartDate)===Number(x.roundStartMs)&&
    Number(x.officialSettlementAudit?.topicEndDate)===Number(x.roundStartMs)+300000}));
   console.log('AUDIT '+JSON.stringify({name,http:status,ok:d.ok,symbol:d.symbol,
    settlementSource:d.settlementSource,records:rows.length,
    settledRows:settled.length,strictVerifiedRows:strict.length,
    pendingRows:rows.length-settled.length,
    nonStrictSettled:settled.length-strict.length,
    lastSettlementOkAt:d.health?.lastSettlementOkAt,
    lastSettlementError:d.health?.lastSettlementError,
    auditExamples:samples}));
  }else if(name==='BINANCE_REFERENCE_TICKER'){
   console.log('AUDIT '+JSON.stringify({name,http:status,symbol:d.symbol,price:Number(d.price)}));
  }
 }catch(e){console.log('AUDIT '+JSON.stringify({name,error:String(e.message||e).slice(0,160)}))}
}


// Strictly read-only Railway data integrity audit. Does not print credentials, orders or user fields.
const BASE='https://signal-diagnostic-v3-production.up.railway.app';
const LEDGER='https://signal-diagnostic-v2-production.up.railway.app';
const getSafe=async u=>{const r=await fetch(u,{cache:'no-store',signal:AbortSignal.timeout(13000)});
 const d=await r.json();return {status:r.status,data:d};};
const auditNow=Date.now();
try{
 const [{status:v3Http,data:v3},{status:marketHttp,data:feed},
        {status:v2Http,data:v2}]=await Promise.all([
    getSafe(BASE+'/healthz'),getSafe(BASE+'/api/shadow-market-data'),
    getSafe(LEDGER+'/api/round-stats')]);
 const ageKey=v3.dataIntegrity||{};
 const recent=(Array.isArray(v2.records)?v2.records:[]).slice(0,50);
 const official=recent.filter(x=>['UP','DOWN'].includes(x.productionActual));
 const sourceRecords=official.filter(x=>x.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION'&&
  String(x.resolutionEvidence||'').startsWith('OFFICIAL_'));
 const audits=official.filter(x=>x.officialSettlementAudit?.sourceEndpoint===
  '/sapi/v1/w3w/wallet/prediction/market/detail'&&
  /^[a-f0-9]{64}$/.test(String(x.officialSettlementAudit?.detailPayloadSha256||'')));
 const different=official.filter(x=>x.actual&&x.actual!==x.productionActual);
 const actualFuture=official.filter(x=>Number(x.roundStartMs)+300000>auditNow+1000);
 const nowRound=Math.floor(auditNow/300000)*300000;
 console.log('RAILWAY_AUDIT',JSON.stringify({
  at:auditNow, v3Http,v3Ok:v3.ok,wsConnected:ageKey.wsConnected??null,
  messageAgeMs:ageKey.lastMessageAgeMs??null,depthAgeMs:ageKey.lastDepthAgeMs??null,
  tradeAgeMs:ageKey.lastAggTradeAgeMs??null,realDepth:ageKey.ofiUsesRealDepth??null,
  simulated:ageKey.simulated??null,marketHttp,marketOk:feed.ok===true,
  source:feed.source||null,spotSource:feed.latest?.source||null,
  spotAgeMs:feed.latest?.ageMs??null,spotEventAgeMs:Number.isFinite(Number(feed.latest?.eventMs))?auditNow-Number(feed.latest.eventMs):null,
  candle1m:feed.candles?.['1m']?.rows?.length??0,
  candle5m:feed.candles?.['5m']?.rows?.length??0,
  candleProviders:{m1:feed.candles?.['1m']?.provider||null,
    m5:feed.candles?.['5m']?.provider||null},
  feedErrors:feed.integrity?.errors||[],
  v2Http,v2Ok:v2.ok,settlementSource:v2.settlementSource||null,
  totalRecentRows:recent.length,officialRows:official.length,
  taggedOfficialRows:sourceRecords.length,detailShaAuditRows:audits.length,
  officialActualMismatch:different.length,futureLabeled:actualFuture.length,
  lastSettlementOkAt:v2.health?.lastSettlementOkAt||null,
  lastSettlementError:v2.health?.lastSettlementError||null,
  latest5:recent.slice(0,5).map(x=>({
    round:x.roundStartMs,actual:x.productionActual||null, prediction:x.productionPrediction||null,
    result:x.productionResult||null,
    source:x.actualSource||null,evidence:String(x.resolutionEvidence||'').slice(0,140),
    topic:x.predictionMarketTopicId||null,
    auditTopic:x.officialSettlementAudit?.marketTopicId||null,
    auditTsStart:x.officialSettlementAudit?.topicStartDate||null,
    auditTsEnd:x.officialSettlementAudit?.topicEndDate||null,
    auditSha:audits.includes(x),
    predictionTime:x.productionLockedAt||x.productionLockAt||x.lockedAt||null,
    settledAt:x.productionSettledAt||x.settledAt||null
  }))
 }));
 const two=audits.filter(x=>x.predictionMarketTopicId&&
   x.roundStartMs+300000<auditNow).slice(0,2);
 for(const x of two){
  try{const {status,data:d}=await getSafe(BASE+'/api/prediction-resolution?round='+x.roundStartMs+
   '&marketTopicId='+encodeURIComponent(String(x.predictionMarketTopicId)));
   console.log('INDEPENDENT_RESOLUTION_CHECK',JSON.stringify({
    round:x.roundStartMs,http:status,resolved:d.resolved===true,
    direction:d.direction||null,archivedDirection:x.productionActual,
    matches:d.resolved===true&&d.direction===x.productionActual,
    matchingTopic:d.marketTopicId==x.predictionMarketTopicId,
    detailShaPresent:!!d.auditEvidence?.detailPayloadSha256,
    topicStart:d.auditEvidence?.topicStartDate||null,topicEnd:d.auditEvidence?.topicEndDate||null,
    error:d.error||null
   }));
  }catch(e){console.log('INDEPENDENT_RESOLUTION_CHECK',JSON.stringify({
   round:x.roundStartMs,error:String(e?.message||e).slice(0,150)}))}
 }
}catch(e){console.log('RAILWAY_AUDIT_FAILURE',String(e?.message||e).slice(0,180))}


// Independent public ticker check, plus historical per-round time consistency.
try{
 const [track,feed,ticker]=await Promise.all([
  getSafe(LEDGER+'/api/round-stats'),
  getSafe(BASE+'/api/shadow-market-data'),
  getSafe('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT')
 ]);
 const rows=(track.data.records||[]).slice(0,50);
 const labeled=rows.filter(x=>['UP','DOWN'].includes(x.productionActual));
 const audited=labeled.filter(x=>x.officialSettlementAudit?.detailPayloadSha256);
 const exactTime=audited.filter(x=>{
  const a=x.officialSettlementAudit,r=Number(x.roundStartMs);
  return Number(a.topicStartDate)===r&&Number(a.topicEndDate)===r+300000
 }).length;
 const beforeClose=audited.filter(x=>{
  const r=Number(x.roundStartMs),locked=Number(x.productionLockedAt);
  const settled=Number(x.productionSettledAt);
  return Number.isFinite(locked)&&locked>=r&&locked<r+300000&&
    Number.isFinite(settled)&&settled>=r+300000
 }).length;
 const railwayPrice=Number(feed.data.latest?.lastPrice);
 const independentPrice=Number(ticker.data.price);
 const diffPct=Number.isFinite(railwayPrice)&&Number.isFinite(independentPrice)&&independentPrice>0?
   Math.abs(railwayPrice-independentPrice)/independentPrice*100:null;
 console.log('MARKET_PRICE_CROSSCHECK',JSON.stringify({
   at:Date.now(),tickerHttp:ticker.status,tickerSymbol:ticker.data.symbol||null,
   publicBinanceTicker:independentPrice,railwaySpot:railwayPrice,
   deviationPct:diffPct,crosscheckWithin0_30Pct:diffPct!==null&&diffPct<0.30,
   railwayFeedOk:feed.data.ok===true,
   examinedLabeled:labeled.length,auditedRounds:audited.length,
   auditedExactRoundTime:exactTime,auditedPredictionBeforeEndAndSettlementAfterEnd:beforeClose
 }));
}catch(e){console.log('MARKET_PRICE_CROSSCHECK_ERROR',String(e?.message||e).slice(0,180))}

// Investigate rows excluded by conservative timestamp validity gate.
try{
 const {data:d}=await getSafe(LEDGER+'/api/round-stats');
 const missing=(d.records||[]).slice(0,50).filter(x=>{
  if(!['UP','DOWN'].includes(x.productionActual)||!x.officialSettlementAudit?.detailPayloadSha256)return false;
  const r=Number(x.roundStartMs),locked=Number(x.productionLockedAt),settled=Number(x.productionSettledAt);
  return !(Number.isFinite(locked)&&locked>=r&&locked<r+300000&&
     Number.isFinite(settled)&&settled>=r+300000);
 }).map(x=>({round:x.roundStartMs,
   lock:x.productionLockedAt??null,settled:x.productionSettledAt??null,
   otherLockKeys:Object.keys(x).filter(k=>/lock|signalat|predictionat|settledat/i.test(k)).slice(0,20),
   firstObserved:x.shadowObservedAt??null,
   generated:x.productionGeneratedAt??null,
   source:String(x.productionSource||'').slice(0,65),
   evidence:String(x.resolutionEvidence||'').slice(0,90)}));
 console.log('AUDIT_TIMESTAMP_EXCEPTIONS',JSON.stringify({count:missing.length,rows:missing}));
}catch(e){console.log('AUDIT_TIMESTAMP_EXCEPTIONS_ERROR',String(e?.message||e).slice(0,150))}


// Production EDGE acceptance (read-only): state, current live selector, model maturity.
// Do not trigger order routes, retry, or change production selection.
try{
 const [edge,hub,panel]=await Promise.all([
  getSafe('https://edge-5m-v1.zl528094-3ba.workers.dev/status'),
  getSafe('https://zl-free-market-hub.zl528094-3ba.workers.dev/api/status'),
  getSafe('https://trade-control-panel-production.up.railway.app/api/status')
 ]);
 const d=edge.data, h=hub.data,p=panel.data,now=Date.now(),round=Math.floor(now/300000)*300000;
 console.log('EDGE_PROD_ACCEPTANCE',JSON.stringify({
  checkedAt:now,edgeHttp:edge.status,edgeOk:d.ok===true,edgeReadOnly:d.readOnly===true,
  edgeProductionIntegration:d.productionIntegration===true,edgeOrders:d.orders===true,
  edgeVenue:d.health?.venue,edgeMarketError:d.health?.marketError??null,
  edgeOfficialError:d.health?.officialError??null,edgeLastMarketAgeMs: d.timed?.lastGoodDataAt?now-d.timed.lastGoodDataAt:null,
  edgeLastTickAgeMs:d.timed?.lastTickAt?now-d.timed.lastTickAt:null,
  edgeLastOfficialAgeMs:d.health?.lastOfficialAt?now-d.health.lastOfficialAt:null,
  edgeSamples:d.results?.overall?.samples??null,
  edgeLocked:d.results?.locked??null,
  edgeTrainingSamples:d.training?.samples??null,
  edgeTrainingRequired:d.training?.required??null,
  edgeCalibrated:d.training?.calibrationReady===true,
  edgeReady:d.training?.ready===true,
  edgeLatest:d.latest?{round:d.latest.round,direction:d.latest.direction,
   executionEligible:d.latest.executionEligible,lockedAt:d.latest.lockedAt}:null,
  edgeLastHistorical:Array.isArray(d.recent)?d.recent.slice(0,3).map(x=>({
   round:x.round,direction:x.direction,actual:x.actual,lockedAt:x.lockedAt
  })):[],
  hubHttp:hub.status,hubMarketOk:h.market?.ok===true,
  hubBaselineOk:h.baseline?.ok===true,hubEdgeOk:h.edge?.ok===true,
  panelHttp:panel.status,panelModel:p.orderSignalModel??p.modelSelection?.model??null,
  panelTopKeys:Object.keys(p||{}).filter(k=>/signal|model|choice|order|select|production/i.test(k)).slice(0,30),
  currentRound:round
 }));
}catch(e){console.log('EDGE_PROD_ACCEPTANCE_FAILED',String(e?.message||e).slice(0,180))}


// Render Free Singapore read-only gateway smoke check.
// Sleep can cause a cold-start; no credentials or order requests.
try{
 const url='https://zl-binance-network-probe.onrender.com/api/network';
 const started=Date.now();
 const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(105000)});
 const txt=await r.text();
 let d={};try{d=JSON.parse(txt)}catch{}
 console.log('RENDER_BINANCE_EGRESS',JSON.stringify({
   status:r.status,elapsedMs:Date.now()-started,ok:d.ok===true,
   orders:d.orders===false,readOnly:d.readOnly===true,
   checks:Array.isArray(d.checks)?d.checks.map(x=>({
     name:x.name,http:x.http,exchangeCode:x.exchangeCode??null,
     regionBlocked:x.regionBlocked,transportReachable:x.transportReachable,error:x.error??null
   })):[],nonJson:r.status!==200?txt.slice(0,160):null
 }));
}catch(e){
 console.log('RENDER_BINANCE_EGRESS_ERROR',JSON.stringify({
  name:String(e?.name||'ERROR'),message:String(e?.message||e).slice(0,160)}));
}
