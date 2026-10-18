// Authorized repair: change EDGE official settlement origin, keep all bindings,
// algorithms, lock timing and Durable Object state unchanged.
// Staged with CF_REPAIR_STAGE=edge-official; never touches actual order endpoints.
import {createHash} from 'node:crypto';
const account=String(process.env.CLOUDFLARE_ACCOUNT_ID||'').trim();
const token=String(process.env.CLOUDFLARE_API_TOKEN||'').trim();
const name='edge-5m-v1';
const oldUrl='https://signal-diagnostic-v2-production.up.railway.app/api/round-stats';
const newUrl='https://zl-signal-v2-migration.onrender.com/api/round-stats';
const expectedSha='3e3fd6269178221a';
const expectedMapSha='2347922f24ca2f29';
const origin='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/'+name;
const statusUrl='https://edge-5m-v1.zl528094-3ba.workers.dev/status';
const log=(event,o={})=>console.log(JSON.stringify({
  event,component:'CLOUDFLARE_EDGE_OFFICIAL_ORIGIN_REPAIR',
  at:new Date().toISOString(),...o
}));
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,16);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const api=(url,options={})=>fetch(url,{...options,cache:'no-store',
  signal:AbortSignal.timeout(23000),
  headers:{authorization:'Bearer '+token,accept:'*/*',...options.headers}});
const readStatus=async()=>{
  const response=await fetch(statusUrl,{cache:'no-store',signal:AbortSignal.timeout(12000)});
  const x=await response.json();
  return {http:response.status,trainingSamples:x?.training?.samples??null,
    observed:x?.results?.observedRounds??null,
    pending:x?.results?.pending??null,
    officialError:x?.health?.officialError??null,
    storage:x?.health?.storage??null,persisted:x?.health?.persisted===true,
    latestDirection:x?.latest?.direction??null};
};
try{
  if(process.env.CF_REPAIR_STAGE!=='edge-official')throw Error('STAGE_NOT_AUTHORIZED');
  if(!token||!(/^[a-f0-9]{32}$/i).test(account))throw Error('CF_CREDENTIALS_NOT_CONFIGURED');
  const before=await readStatus();
  const [raw,settings,official]=await Promise.all([
    api(origin+'/content/v2'),
    api(origin+'/settings'),
    fetch(newUrl,{cache:'no-store',signal:AbortSignal.timeout(12000)})
  ]);
  if(!raw.ok||!settings.ok||!official.ok)throw Error(
    'PRECONDITION_HTTP_'+raw.status+'_'+settings.status+'_'+official.status);
  const configuration=(await settings.json())?.result;
  const originalBindings=(configuration?.bindings||[]).map(b=>({name:b.name,type:b.type}));
  if(!originalBindings.some(b=>b.name==='EDGE5'&&b.type==='durable_object_namespace'))
    throw Error('EDGE_DURABLE_OBJECT_BINDING_MISSING');
  const evidence=await official.json();
  const officialRows=(evidence?.records||[]).filter(x=>
    ['UP','DOWN'].includes(x?.actual)&&
    String(x?.resolutionEvidence||'').startsWith('OFFICIAL_'));
  if(evidence?.ok!==true||officialRows.length<8)throw Error('RENDER_V2_OFFICIAL_EVIDENCE_INSUFFICIENT');
  const html=await raw.formData();
  const parts=[];
  for(const [key,file] of html.entries()){
    if(key==='metadata')continue;
    const value=typeof file==='string'?file:await file.text();
    const type=typeof file==='string'?'text/plain':file.type;
    parts.push({key,value,type});
  }
  if(parts.length!==2||!parts.some(p=>p.key==='edge-worker.js')||
    !parts.some(p=>p.key==='edge-worker.js.map'))throw Error('UNEXPECTED_SCRIPT_MODULES');
  const js=parts.find(p=>p.key==='edge-worker.js');
  const map=parts.find(p=>p.key==='edge-worker.js.map');
  const sha=hash(js.value),mapSha=hash(map.value);
  const oldHits=js.value.split(oldUrl).length-1;
  const newHits=js.value.split(newUrl).length-1;
  if(oldHits===0&&newHits===1){
    log('edge_official_already_patched',{sha,before}); 
  }else{
    if(sha!==expectedSha||mapSha!==expectedMapSha||oldHits!==1||newHits!==0)
      throw Error('SOURCE_CHANGED_OR_UNEXPECTED_ORIGIN');
    if(map.value.split(oldUrl).length!==2)throw Error('SOURCEMAP_ORIGIN_NOT_UNIQUE');
    const afterCode=js.value.replace(oldUrl,newUrl);
    const afterMap=map.value.replace(oldUrl,newUrl);
    if(afterCode===js.value||!afterCode.includes('export {')||
      afterCode.includes('PUT_ORDER')||afterCode.includes('executeLiveOrder'))
      throw Error('UNEXPECTED_CODE_OUTPUT');
    const form=new FormData();
    form.set('metadata',new Blob([JSON.stringify({main_module:'edge-worker.js'})],
      {type:'application/json'}));
    form.set('edge-worker.js',
      new Blob([afterCode],{type:'application/javascript+module'}),'edge-worker.js');
    form.set('edge-worker.js.map',
      new Blob([afterMap],{type:'application/source-map'}),'edge-worker.js.map');
    const update=await api(origin+'/content',{method:'PUT',body:form});
    const response=await update.json().catch(()=>({}));
    if(!update.ok||response?.success!==true)throw Error(
      'CONTENT_PUT_REJECTED_'+update.status+'_CODES_'+(response?.errors||[])
      .slice(0,3).map(e=>e.code).join(','));
    log('edge_official_script_updated',{httpStatus:update.status,
      beforeSha:sha,afterSha:hash(afterCode),oldUrlRemoved:true,
      metadataPreservedByApi:true,updatedFiles:2,changedTarget:'OFFICIAL_URL_ONLY'});
  }
  const [check,afterSettings]=await Promise.all([
    api(origin+'/content/v2'),api(origin+'/settings')]);
  if(!check.ok||!afterSettings.ok)throw Error('POST_UPDATE_VERIFY_HTTP_FAILED');
  const contents=await check.formData();
  const latest=await contents.get('edge-worker.js')?.text();
  if(!latest||!latest.includes(newUrl)||latest.includes(oldUrl))
    throw Error('SCRIPT_NOT_UPDATED_AS_EXPECTED');
  const cfg=(await afterSettings.json())?.result;
  const bindings=(cfg?.bindings||[]).map(b=>({name:b.name,type:b.type}));
  if(!same(bindings,originalBindings)||cfg?.compatibility_date!==configuration.compatibility_date)
    throw Error('CONFIGURATION_OR_BINDINGS_CHANGED');
  log('edge_official_verified',{afterSha:hash(latest),bindingNames:bindings.map(b=>b.name),
    durableObjectPreserved:true,compatibilityDateUnchanged:true,beforeStatus:before});
  // Delayed read-only checks across at least one subsequent alarm tick.
  for(const ms of [20000,90000]){
    setTimeout(async()=>{
      try{log('edge_official_settlement_recheck',{waitedMs:ms,status:await readStatus()});}
      catch(e){log('edge_official_settlement_recheck_failed',{waitedMs:ms,
        error:String(e?.message||e).slice(0,120)})}
    },ms).unref();
  }
}catch(e){
  log('edge_official_repair_failed',{reason:String(e?.message||e).slice(0,190)});
}
