// Render migration preflight, READ-ONLY. No keys, signatures or order submissions.
const tests = [
  ['binance_spot','https://api.binance.com/api/v3/time'],
  ['binance_prediction','https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/list?limit=1'],
  ['binance_data','https://data-api.binance.vision/api/v3/time'],
  ['binance_futures','https://fapi.binance.com/fapi/v1/time'],
  ['cloudflare_edge','https://edge-5m-v1.zl528094-3ba.workers.dev/status'],
  ['cloudflare_breakout20','https://breakout20-shadow.zl528094-3ba.workers.dev/status']
];
await Promise.all(tests.map(async ([target,url]) => {
  const result={event:'render_migration_readonly_preflight',target,at:new Date().toISOString()};
  try {
    const response=await fetch(url,{method:'GET',headers:{accept:'application/json'},
      signal:AbortSignal.timeout(8000),cache:'no-store',redirect:'manual'});
    result.httpStatus=response.status;
    result.regionBlocked=response.status===451;
    let body=null;
    try {body=await response.json();}catch{}
    if(target==='cloudflare_edge' || target==='cloudflare_breakout20'){
      result.model=typeof body?.model==='string'?body.model:(typeof body?.version==='string'?body.version:null);
      result.name=typeof body?.name==='string'?body.name:null;
      result.readOnly=body?.readOnly===true;
      result.orders=body?.orders===true;
      result.productionIntegration=body?.productionIntegration===true;
      result.statsScope=typeof body?.statsScope==='string'?body.statsScope:null;
      result.trainingSamples=Number.isFinite(Number(body?.training?.samples))?Number(body.training.samples):null;
      result.latestStatus=typeof body?.latest?.status==='string'?body.latest.status:null;
      result.latestLockedAt=Number.isFinite(Number(body?.latest?.lockedAt))?Number(body.latest.lockedAt):null;
      result.timedLastTickAt=Number.isFinite(Number(body?.timed?.lastTickAt))?Number(body.timed.lastTickAt):null;
      result.latestDirection=['UP','DOWN'].includes(body?.latest?.direction)?body.latest.direction:null;
      result.latestRound=Number.isFinite(Number(body?.latest?.round))?Number(body.latest.round):null;
    }else {
      result.exchangeCode=typeof body?.code==='number'?body.code:null;
    }
  }catch(error){result.error=error?.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR';}
  console.log(JSON.stringify(result));
}));
