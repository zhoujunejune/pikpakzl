// Alibaba-only standalone read-only model services.
// Uses original GitHub EDGE and DYNAMIC_ENTRY algorithms, Binance market GETs,
// localhost V3 market feed + localhost V2 *official* settlement. No Railway,
// Render, Cloudflare, Polymarket or exchange order-submission clients.
import http from 'node:http';
import {edge5mService} from './edge-5m-service.mjs';
import {dynamicEntryShadow} from './dynamic-entry-shadow.mjs';

const PORT=Number(process.env.LOCAL_SHADOW_PORT||13007);
const HOST='127.0.0.1';
function reply(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
const metrics={startedAt:Date.now(),errors:[]};
for(const [name,service] of [['EDGE_5M_V1',edge5mService],['DYNAMIC_ENTRY_5M_SHADOW_V1',dynamicEntryShadow]]){
  try{
    await service.start();
    console.log(JSON.stringify({event:'aliyun_native_shadow_started',model:name,at:Date.now()}));
  }catch(e){
    const error=String(e?.message||e).slice(0,120);
    metrics.errors.push({model:name,error});
    console.error(JSON.stringify({event:'aliyun_native_shadow_start_failed',model:name,error}));
  }
}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method!=='GET')return reply(res,405,{ok:false,error:'READ_ONLY'});
  if(url.pathname==='/healthz'){
    return reply(res,200,{ok:true,service:'zl-aliyun-native-model-host',
      host:'ALIYUN_LOCAL_ONLY',trading:false,
      sources:{official:'http://127.0.0.1:13002/api/round-stats',
               market:'http://127.0.0.1:13003/api/shadow-market-data'},
      models:['EDGE_5M_V1','DYNAMIC_ENTRY_5M_SHADOW_V1'],
      // Shadow readiness is not an actual Binance order acceptance guarantee.
      startupErrors:metrics.errors});
  }
  if(url.pathname==='/edge-5m'){
    // Same model identifier, but this is a NEW local model epoch; CF Durable
    // Object weight/history must not be silently attributed to this engine.
    return edge5mService.handler(res);
  }
  if(url.pathname==='/dynamic-entry')return dynamicEntryShadow.handler(res);
  return reply(res,404,{ok:false,error:'NOT_FOUND'});
});
server.requestTimeout=10000;
server.listen(PORT,HOST,()=>{
  console.log(JSON.stringify({event:'aliyun_native_model_host_listening',
    port:PORT,host:HOST,readOnly:true,externalServices:false,
    separateModelEpoch:true}));
});
process.once('SIGTERM',async()=>{
  server.close();
  await Promise.allSettled([edge5mService.stop(),dynamicEntryShadow.stop()]);
  process.exit(0);
});
