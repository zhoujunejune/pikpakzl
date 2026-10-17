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
