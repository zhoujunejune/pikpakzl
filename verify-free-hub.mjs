import {readFileSync,appendFileSync} from 'node:fs';
const log=readFileSync('/tmp/free-hub-deploy.log','utf8');
const url=log.match(/https:\/\/zl-free-market-hub\.[a-zA-Z0-9-]+\.workers\.dev/)?.[0];
if(!url)throw Error('WORKER_URL_NOT_IN_WRANGLER_LOG');
const get=async path=>{const r=await fetch(url+path,{signal:AbortSignal.timeout(16000)});
 const t=await r.text();let d;try{d=JSON.parse(t)}catch{throw Error(path+' NON_JSON_HTTP_'+r.status+' '+t.slice(0,130))}
 return {status:r.status,d};};
const [health,market,edge,baseline,all]=await Promise.all([
 get('/health'),get('/api/market'),get('/api/edge'),get('/api/baseline'),get('/api/status')]);
if(health.status!==200||health.d.ok!==true||health.d.readOnly!==true||health.d.orders!==false)throw Error('READONLY_HEALTH_FAILED');
if(all.status!==200||all.d.ok!==true||all.d.orders!==false)throw Error('INDEPENDENT_AGGREGATOR_FAILED');
if(market.status!==200||market.d.ok!==true||market.d.realData!==true||
 !['BYBIT','OKX'].includes(market.d.venue)||market.d.spotPrice<=0||
 !market.d.providers?.trades||!market.d.providers?.depth)
 throw Error('CLOUDFLARE_REAL_MARKET_NOT_CONFIRMED: '+JSON.stringify(market).slice(0,450));
const forbidden=await fetch(url+'/api/order/submit',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
if(forbidden.status!==405)throw Error('MUTATING_METHOD_NOT_REJECTED');
console.log('DEPLOYED_URL:',url);
console.log('HEALTH',JSON.stringify(health));
console.log('MARKET',JSON.stringify(market));
console.log('EDGE',JSON.stringify(edge));
console.log('BASELINE',JSON.stringify(baseline));
console.log('AGGREGATOR',JSON.stringify(all).slice(0,2200));
console.log('POST_BLOCKED',forbidden.status);
if(edge.status!==200||edge.d.ok!==true)console.warn('EDGE_MODEL_NOT_READABLE_YET');
if(baseline.status!==200||baseline.d.ok!==true)console.warn('BASELINE_STATS_NOT_READABLE_YET');
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '## Cloudflare Free market hub\n\n- [Open new monitoring frontend]('+url+')\n'+
  '- Real market source: '+market.d.venue+'\n- EDGE read-only: '+(edge.d.ok===true)+'\n'+
  '- BASELINE official stats: '+(baseline.d.ok===true)+'\n'+
  '- Binance order API: NOT MOVED\n- Railway live services: UNCHANGED\n');
