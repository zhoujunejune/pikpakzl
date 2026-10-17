import {readFileSync,appendFileSync} from 'node:fs';
const log=readFileSync('/tmp/edge5m-deploy.log','utf8');
const url=log.match(/https:\/\/edge-5m-v1\.[a-zA-Z0-9-]+\.workers\.dev/)?.[0];
if(!url)throw Error('Missing EDGE Worker URL from Wrangler output');
const get=async(path)=>{const r=await fetch(url+path);return {httpStatus:r.status,body:await r.json()};};
const health=await get('/health'),status=await get('/status');
if(health.httpStatus!==200||status.httpStatus!==200||
 health.body.ok!==true||health.body.orders!==false||
 status.body.model!=='EDGE_5M_V1'||status.body.readOnly!==true||
 status.body.orders!==false||status.body.productionIntegration!==false||
 status.body.inputVersion!=='EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1'||
 status.body.statsScope!=='EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY')
 throw Error('ISOLATED_READ_ONLY_CONTRACT_FAILED');
if(!Number.isFinite(Number(status.body.timed?.nextAlarm)))
 throw Error('DURABLE_OBJECT_ALARM_NOT_SCHEDULED');
console.log('EDGE Worker deployed:',url);
console.log('Alarm:',new Date(status.body.timed.nextAlarm).toISOString());
console.log('Training:',JSON.stringify(status.body.training));
let probe;
try{probe=await get('/market-check');}
catch(e){probe={httpStatus:0,body:{ok:false,error:String(e)}};}
console.log('Market feed:',JSON.stringify(probe));
if(probe.body?.ok!==true)console.log('WARNING: provider restriction/latency; model rejects missing real data');
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
 '## EDGE_5M_V1 Cloudflare Free\n\n'+
 '- Worker: '+url+'\n- Status: '+url+'/status\n'+
 '- Dashboard: '+url+'/\n- Health: '+url+'/health\n'+
 '- Real feed available: '+(probe.body?.ok===true)+'\n'+
 '- Error: '+(probe.body?.error||'none')+'\n'+
 '- Training samples: '+(status.body.training?.samples||0)+' / 5000\n'+
 '- No live order mutation; existing Workers unchanged\n');
