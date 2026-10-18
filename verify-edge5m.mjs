import {readFileSync,appendFileSync} from 'node:fs';
const log=readFileSync('/tmp/edge5m-deploy.log','utf8');
const url=log.match(/https:\/\/edge-5m-v1\.[a-zA-Z0-9-]+\.workers\.dev/)?.[0];
if(!url)throw Error('Missing EDGE Worker URL from Wrangler output');
const get=async(path)=>{const r=await fetch(url+path);const raw=await r.text();
 let body;try{body=JSON.parse(raw)}catch{throw Error(path+' HTTP '+r.status+' received non-JSON: '+raw.slice(0,1200))}
 return {httpStatus:r.status,body};};
const DISPLAY_START_ROUND=1792320900000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let health,status;
for(let attempt=0;attempt<9;attempt++){
 [health,status]=await Promise.all([get('/health'),get('/status')]);
 if(status.body.statisticsWindow?.startRound===DISPLAY_START_ROUND)break;
 if(attempt<8)await sleep(2500); // Cloudflare edge propagation after deploy
}

if(health.httpStatus!==200||status.httpStatus!==200||
 health.body.ok!==true||health.body.orders!==false||
 status.body.model!=='EDGE_5M_V1'||status.body.readOnly!==true||
 status.body.orders!==false||status.body.productionIntegration!==false||
 status.body.inputVersion!=='EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1'||
 status.body.statsScope!=='EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY'||
 status.body.training?.signalIndependentOfCalibration!==true||
 status.body.health?.officialOrigin!=='https://zl-signal-v2-migration.onrender.com/api/round-stats'||
 status.body.health?.marketOrigin!=='https://zl-signal-v3-migration.onrender.com/api/shadow-market-data')
 throw Error('ISOLATED_READ_ONLY_CONTRACT_FAILED');
// Every public front end must see the post-V2 window, while the model
// still learns from all verified outcomes. Never pass a cached lifetime score.
const stats=status.body.results||{},recent=status.body.recent||[];
const maxRounds=Math.max(0,Math.ceil((Number(status.body.generatedAt||Date.now())-DISPLAY_START_ROUND)/300000)+1);
if(status.body.statisticsWindow?.startRound!==DISPLAY_START_ROUND||
 status.body.statisticsWindow?.historicalRowsPreserved!==true||
 status.body.statisticsWindow?.trainingHistoryPreserved!==true||
 !Array.isArray(recent)||recent.some(r=>Number(r.round)<DISPLAY_START_ROUND)||
 Number(stats.observedRounds)>maxRounds||
 Number(stats.overall?.samples||0)>Number(stats.observedRounds||0)||
 status.body.training?.historyScope!=='ALL_VERIFIED_OFFICIAL_LABELS_UNCHANGED')
 throw Error('POST_V2_DISPLAY_WINDOW_NOT_ACTIVE_OR_LEGACY_HISTORY_LEAKED');
console.log('EDGE display restart:',JSON.stringify({
 since:status.body.statisticsWindow.startAt,visibleResults:stats,
 cumulativeTrainingSamples:status.body.training.samples,
 recentVisible:recent.length}));
if(!Number.isFinite(Number(status.body.timed?.nextAlarm)))
 throw Error('DURABLE_OBJECT_ALARM_NOT_SCHEDULED');
console.log('EDGE Worker deployed:',url);
console.log('Alarm:',new Date(status.body.timed.nextAlarm).toISOString());
console.log('Training:',JSON.stringify(status.body.training));
console.log('Latest immutable prediction:',JSON.stringify(status.body.latest));
console.log('Recent observations:',JSON.stringify(status.body.recent?.slice(0,4)||[]));
console.log('Official results:',JSON.stringify(status.body.results));
console.log('Source & settlement health:',JSON.stringify(status.body.health));
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
