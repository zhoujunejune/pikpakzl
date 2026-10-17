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
