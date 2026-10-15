import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const log=readFileSync('/tmp/breakout20-deploy.log','utf8');
const url=log.match(/https:\/\/breakout20-shadow\.[a-zA-Z0-9-]+\.workers\.dev/)?.[0];
if(!url)throw Error('No deployment URL in Wrangler output');
console.log('Shadow URL:',url);
async function get(path){const r=await fetch(url+path);if(!r.ok)throw Error(`${path}: HTTP ${r.status}`);return r.json();}
const health=await get('/health');console.log('Health:',JSON.stringify(health));
if(health.orders!==false)throw Error('Unexpected order capability');
let status=await get('/status');
const due=status.timed.nextAlarm;
console.log('Next independent alarm:',new Date(due).toISOString());
await new Promise(r=>setTimeout(r,Math.max(0,due-Date.now())+15000));
for(let i=0;i<6;i++){
 status=await get('/status');if(status.timed.lastTickAt&&status.latest)break;
 await new Promise(r=>setTimeout(r,10000));
}
writeFileSync('/tmp/breakout20-status.json',JSON.stringify(status,null,2));
console.log('Market/training/status:',JSON.stringify(status));
appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Shadow: ${url}/status\n\n\`\`\`json\n${JSON.stringify(status,null,2)}\n\`\`\`\n`);
if(!status.timed.lastGoodDataAt)throw Error('No successful live market fetch');
if(!status.latest)throw Error('No prediction or data-gap record');
if(!status.training.latestTraining)throw Error('No training attempt recorded');
if(status.latest.status==='DATA_GAP')throw Error('First round has data gap; inspect status for timing or market error');
