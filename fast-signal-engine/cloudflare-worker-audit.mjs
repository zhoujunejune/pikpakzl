// One-shot, read-only inspection of exactly two existing Cloudflare Workers.
// User stores CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Render Environment.
// Never log the token, full Worker scripts, environment values, or binding secrets.
// Does NOT deploy, PATCH, POST, PUT, DELETE or edit anything on Cloudflare.
import {createHash} from 'node:crypto';

const token=String(process.env.CLOUDFLARE_API_TOKEN||'').trim();
const accountId=String(process.env.CLOUDFLARE_ACCOUNT_ID||'').trim();
const workers=['edge-5m-v1','breakout20-shadow'];
const origins=[
  'signal-diagnostic-v2-production.up.railway.app',
  'signal-diagnostic-v3-production.up.railway.app',
  'zl-signal-v2-migration.onrender.com',
  'zl-signal-v3-migration.onrender.com'
];
const say=(event,fields={})=>console.log(JSON.stringify({
  event,source:'CLOUDFLARE_READONLY_REPAIR_AUDIT',at:new Date().toISOString(),...fields
}));
if(!token||!(/^[a-f0-9]{32}$/i).test(accountId)){
  say('cloudflare_repair_audit_not_configured',{tokenPresent:!!token,
    accountIdShapeValid:/^[a-f0-9]{32}$/i.test(accountId)});
}else{
  const base='https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/scripts/';
  async function apiGet(url){
    const res=await fetch(url,{method:'GET',headers:{authorization:'Bearer '+token,
      accept:'*/*'},cache:'no-store',signal:AbortSignal.timeout(15000)});
    return res;
  }
  async function inspectContent(name){
    const res=await apiGet(base+encodeURIComponent(name)+'/content/v2');
    const type=String(res.headers.get('content-type')||'').split(';')[0];
    if(!res.ok)return {httpStatus:res.status,contentType:type,files:[],error:'CONTENT_HTTP_'+res.status};
    const ctype=String(res.headers.get('content-type')||'');
    let entries=[];
    if(ctype.toLowerCase().startsWith('multipart/form-data')){
      const form=await res.formData();
      for(const [part,value] of form.entries()){
        if(part==='metadata')continue;
        const textData=typeof value==='string'?value:await value.text();
        if(textData.length>1500000){entries.push({part:part.slice(0,100),
          size:textData.length,oversize:true});continue;}
        const candidates=Object.fromEntries(origins.map(origin=>[origin,
          textData.split(origin).length-1]));
        const lineNos=Object.fromEntries(origins.map(origin=>[origin,
          textData.split('\n').flatMap((line,index)=>line.includes(origin)?[index+1]:[]).slice(0,15)]));
        const contexts=[];
        if (!part.endsWith('.map')) {
          for(const oldOrigin of origins.slice(0,2)){
            let pos=textData.indexOf(oldOrigin);
            if(pos>=0){
              const segment=textData.slice(Math.max(0,pos-520),Math.min(textData.length,pos+oldOrigin.length+520));
              contexts.push({origin:oldOrigin,codeAroundOrigin:segment.replace(
                /(?:Bearer\\s+)[A-Za-z0-9._-]{20,}/g,'Bearer [REDACTED]')});
            }
          }
        }
        entries.push({part:part.slice(0,100),size:textData.length,
          sha256:createHash('sha256').update(textData).digest('hex').slice(0,16),
          originMatches:candidates,originLines:lineNos,
          contentType:typeof value==='string'?'text':value.type,
          functionContexts:(!part.endsWith('.map')&&name==='edge-5m-v1')?
            ['OFFICIAL_URL','resolveOfficial','officialDirections','verifiedOfficial','RAILWAY_MARKET_URL']
              .map(term=>{const positions=[];let pos=0;while((pos=textData.indexOf(term,pos))>=0){
                positions.push(pos);pos+=term.length;if(positions.length>=7)break;}
                return {term,uses:positions.length,
                  snippets:positions.slice(-4).map(k=>textData.slice(Math.max(0,k-230),Math.min(textData.length,k+750)))};
              }):null,
          scriptShape:(!part.endsWith('.map'))?{
            esModule:textData.includes('export{')||textData.includes('export default'),
            workerFetch:textData.includes('async fetch(')||textData.includes('fetch(e,'),
            ends:textData.slice(-145)
          }:null,
          contexts});
      }
    }else{
      const textData=await res.text();
      const matches=Object.fromEntries(origins.map(origin=>[origin,
        textData.split(origin).length-1]));
      entries=[{part:'single-worker-response',size:textData.length,
        sha256:createHash('sha256').update(textData).digest('hex').slice(0,16),
        originMatches:matches,originLines:Object.fromEntries(origins.map(origin=>[origin,
        textData.split('\n').flatMap((line,index)=>line.includes(origin)?[index+1]:[]).slice(0,15)]))}];
    }
    return {httpStatus:res.status,contentType:type,files:entries};
  }
  async function inspectSettings(name){
    const res=await apiGet(base+encodeURIComponent(name)+'/settings');
    if(!res.ok)return {httpStatus:res.status,error:'SETTINGS_HTTP_'+res.status};
    const body=await res.json();
    const settings=body?.result||{};
    return {httpStatus:res.status,success:body?.success===true,
      fields:Object.keys(settings).slice(0,35),
      bindings:Array.isArray(settings.bindings)?settings.bindings.map(b=>({
        name:String(b?.name||'').slice(0,90),type:String(b?.type||'').slice(0,65)
      })):[],
      compatibilityDate:typeof settings.compatibility_date==='string'?
        settings.compatibility_date:null,
      placementMode:typeof settings.placement?.mode==='string'?settings.placement.mode:null};
  }
  for(const name of workers){
    try{
      const [content,settings]=await Promise.all([
        inspectContent(name),inspectSettings(name)
      ]);
      say('cloudflare_worker_inspected',{name,content,settings});
    }catch(error){
      say('cloudflare_worker_inspection_failed',{name,
        errorType:String(error?.name||'UNKNOWN').slice(0,60)});
    }
  }
  for(const target of [
    {name:'render_v2_round_stats',url:'https://zl-signal-v2-migration.onrender.com/api/round-stats'},
    {name:'render_v3_market_feed',url:'https://zl-signal-v3-migration.onrender.com/api/shadow-market-data'}
  ]){
    try{
      const r=await fetch(target.url,{cache:'no-store',signal:AbortSignal.timeout(14000)});
      const data=await r.json();
      const rows=Array.isArray(data?.records)?data.records:null;
      const first=rows?.[0];
      const candle=data?.candles;
      const candles=Object.fromEntries(['1m','5m'].map(i=>[i,{
        count:Array.isArray(candle?.[i]?.rows)?candle[i].rows.length:null,
        provider:candle?.[i]?.provider||null,ageMs:candle?.[i]?.ageMs??null
      }]));
      say('cloudflare_target_origin_probe',{name:target.name,httpStatus:r.status,
        ok:data?.ok===true,rootKeys:Object.keys(data||{}).slice(0,35),
        recordCount:rows?.length??null,recordKeys:first?Object.keys(first).slice(0,35):null,
        latestFields:data?.latest?Object.keys(data.latest).slice(0,20):null,
        candles,errors:data?.integrity?.errors?.slice(0,8)??null});
    }catch(error){say('cloudflare_target_origin_probe_failed',{
      name:target.name,errorType:String(error?.name||'UNKNOWN').slice(0,40)});}
  }
  try{
    const [e,v]=await Promise.all([
      fetch('https://edge-5m-v1.zl528094-3ba.workers.dev/status',{signal:AbortSignal.timeout(12000)}).then(r=>r.json()),
      fetch('https://zl-signal-v2-migration.onrender.com/api/round-stats',{signal:AbortSignal.timeout(12000)}).then(r=>r.json())
    ]);
    const cfPending=(e?.recent||[]).filter(r=>!['UP','DOWN'].includes(r?.actual))
      .map(r=>Number(r?.round));
    const official=(v?.records||[]).filter(r=>['UP','DOWN'].includes(r?.actual) &&
      typeof r?.resolutionEvidence==='string'&&r.resolutionEvidence.startsWith('OFFICIAL_'));
    const officialByRound=new Map(official.map(r=>[Number(r.roundStartMs),r.actual]));
    const overlap=cfPending.filter(r=>officialByRound.has(r));
    say('cloudflare_edge_official_overlap',{pendingInRecent:cfPending.length,
      renderRecords:v?.records?.length||0,
      renderOfficialVerified:official.length,
      sameRoundAvailable:overlap.length,
      roundSamples:overlap.slice(0,5),
      missingInRender:cfPending.filter(r=>!officialByRound.has(r)).length,
      officialEvidenceSample:official[0]?.resolutionEvidence?.slice(0,80)||null});
  }catch(e){say('cloudflare_edge_official_overlap_failed',{
    type:String(e?.name||'UNKNOWN').slice(0,50)})}
  say('cloudflare_repair_audit_complete',{workers,
    operations:'GET_ONLY',changes:'NONE',trading:'UNCHANGED'});
}
