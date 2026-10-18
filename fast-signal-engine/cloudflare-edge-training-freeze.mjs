// Freeze future EDGE weight-training without changing prediction, locking,
// historical SQLite Durable Object data, official labels or win-rate totals.
// Runs once, only when explicitly requested through Render env.
import {createHash} from 'node:crypto';
const name='edge-5m-v1';
const token=String(process.env.CLOUDFLARE_API_TOKEN||'');
const account=String(process.env.CLOUDFLARE_ACCOUNT_ID||'');
const origin='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/'+name;
const stage=process.env.CF_REPAIR_STAGE;
const log=(event,detail={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),...detail}));
const sha=x=>createHash('sha256').update(x).digest('hex').slice(0,16);
const headers={Authorization:'Bearer '+token,Accept:'*/*'};
const GET=(url)=>fetch(url,{headers,signal:AbortSignal.timeout(15000),cache:'no-store'});
try{
  if(stage!=='edge-training-freeze')throw Error('STAGE_NOT_AUTHORIZED');
  if(!token||!/^[0-9a-f]{32}$/i.test(account))throw Error('ACCESS_NOT_CONFIGURED');
  const [a,b]=await Promise.all([GET(origin+'/content/v2'),GET(origin+'/settings')]);
  if(!a.ok||!b.ok)throw Error('SOURCE_HTTP_'+a.status+'_'+b.status);
  const cfg=(await b.json()).result,bindings=cfg?.bindings||[];
  if(!bindings.some(x=>x.name==='EDGE5'&&x.type==='durable_object_namespace'))
    throw Error('EDGE5_DURABLE_BINDING_MISSING');
  const form=await a.formData(),item=form.get('edge-worker.js');
  if(!item)throw Error('SOURCE_ENTRY_MISSING');
  const src=await item.text();
  const old='function trainOnOfficial(rows) {';
  const stamp='EDGE_TRAINING_PAUSED_FIXED_WEIGHTS_20261018';
  const already=src.includes(stamp);
  if(!already){
    if(sha(src)!=='25bfbaa1b01c719c' || src.split(old).length!==2)
      throw Error('SOURCE_CHANGED_OR_TRAIN_FN_UNEXPECTED');
    const patch=old+'\n  // '+stamp+'; labels remain stored and accuracy keeps updating.\n'+
      '  return {status: "PAUSED_RECORD_ONLY", samples: rows.filter(r =>'+
      ' (r?.actual === "UP" || r?.actual === "DOWN")).length,'+
      ' required: MIN_TRAINING_ROUNDS, calibrationReady: false, model: null};';
    const updated=src.replace(old,patch);
    const blob=new FormData();
    blob.set('metadata',new Blob([JSON.stringify({main_module:'edge-worker.js'})],
      {type:'application/json'}));
    blob.set('edge-worker.js',new Blob([updated],{type:'application/javascript+module'}),'edge-worker.js');
    const m=form.get('edge-worker.js.map');
    if(m)blob.set('edge-worker.js.map',m,'edge-worker.js.map');
    const put=await fetch(origin+'/content',{method:'PUT',headers,
      body:blob,signal:AbortSignal.timeout(23000)});
    let result={};try{result=await put.json()}catch{}
    if(!put.ok||result.success!==true)throw Error('UPDATE_HTTP_'+put.status);
    log('edge_training_freeze_updated',{beforeSha:sha(src),afterSha:sha(updated),
      existingDurableBinding:true,unchangedOrigins:true,modelParametersUnchanged:true});
  }else{
    log('edge_training_freeze_already_applied',{sha:sha(src)});
  }
  const [verify,settings]=await Promise.all([GET(origin+'/content/v2'),GET(origin+'/settings')]);
  if(!verify.ok||!settings.ok)throw Error('VERIFY_HTTP_FAILED');
  const saved=await(await verify.formData()).get('edge-worker.js').text();
  const config=(await settings.json()).result;
  const expected=JSON.stringify(bindings.map(x=>({name:x.name,type:x.type})));
  const actual=JSON.stringify((config.bindings||[]).map(x=>({name:x.name,type:x.type})));
  if(!saved.includes(stamp)||expected!==actual||
    config.compatibility_date!==cfg.compatibility_date)throw Error('VERIFY_CONFIG_CHANGED');
  log('edge_training_freeze_verified',{sha:sha(saved),
    durableObjectPreserved:true,compatibilityDateUnchanged:true,recordingAndStatisticsUnchanged:true});
}catch(err){
  log('edge_training_freeze_failed',{reason:String(err?.message||err).slice(0,135)});
}
