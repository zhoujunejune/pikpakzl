// Render migration preflight, READ-ONLY. No keys, signatures or order submissions.
const probes = [
  ['binance_spot','https://api.binance.com/api/v3/time'],
  ['binance_prediction','https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/list?limit=1'],
  ['binance_data','https://data-api.binance.vision/api/v3/time'],
  ['binance_futures','https://fapi.binance.com/fapi/v1/time'],
  ['cloudflare_edge','https://edge-5m-v1.zl528094-3ba.workers.dev/status'],
  ['cloudflare_breakout20','https://breakout20-shadow.zl528094-3ba.workers.dev/status']
];
// Never repeatedly probe Spot REST from a banned/shared Render egress.
const tests = probes.filter(([target]) =>
  process.env.BINANCE_REST_PREFLIGHT === 'true' || target.startsWith('cloudflare_'));
console.log(JSON.stringify({event:'render_binance_rest_probes_config',
  enabled:process.env.BINANCE_REST_PREFLIGHT === 'true',skipped:probes.length-tests.length}));
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
      // Read-only health evidence for whether the Cloudflare worker can emit a usable
      // direction. These counters are not a backtested / official accuracy claim.
      result.serviceOk=body?.ok===true;
      result.latestReason=typeof body?.latest?.reason==='string'?body.latest.reason:null;
      result.latestAt=Number.isFinite(Number(body?.latest?.at))?Number(body.latest.at):null;
      result.latestAgeMs=Number.isFinite(result.latestLockedAt)?
        Math.max(0,Date.now()-result.latestLockedAt):null;
      result.trainingOfficialResolved=Number.isFinite(Number(body?.training?.officialResolved))?
        Number(body.training.officialResolved):null;
      result.trainingKeys=body?.training && typeof body.training==='object'?
        Object.keys(body.training).slice(0,18):[];
      result.latestKeys=body?.latest && typeof body.latest==='object'?
        Object.keys(body.latest).slice(0,24):[];
      result.latestLocked=body?.latest?.status==='LOCKED' &&
        ['UP','DOWN'].includes(body?.latest?.direction);

    }else {
      result.exchangeCode=typeof body?.code==='number'?body.code:null;
    }
  }catch(error){result.error=error?.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR';}
  console.log(JSON.stringify(result));
}));
