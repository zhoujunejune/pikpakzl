const checks=[
 ['edge_status','https://edge-5m-v1.zl528094-3ba.workers.dev/status'],
 ['edge_market','https://edge-5m-v1.zl528094-3ba.workers.dev/market-check'],
 ['baseline_stats','https://trade-control-panel-production.up.railway.app/api/postflip-official-stats?model=BREAKOUT20_RSI_MACD_RANGE_V1']
];
for(const [name,url]of checks){
 try{
  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const text=await response.text();let data;
  try{data=JSON.parse(text)}catch{data={nonJson:true,preview:text.slice(0,90)}}
  const d={name,http:response.status,ok:data.ok,model:data.model||null,
   latestDirection:data.latest?.direction||null,liveMarket:data.realData||null,
   venue:data.venue||data.health?.venue||null,
   trainingSamples:data.training?.samples??null,
   settledSamples:data.results?.overall?.samples??null,
   error:data.error||data.health?.marketError||null};
  console.log(JSON.stringify(d));
 }catch(e){console.log(JSON.stringify({name,networkError:String(e?.message||e).slice(0,100)}));}
}
