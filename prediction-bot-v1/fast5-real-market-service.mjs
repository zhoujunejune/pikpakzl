// FAST5 loopback-only HTTP producer. Does not read API keys, use DeepSeek,
// place or cancel orders, or modify trading settings. Independent of any LLM.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFast5Calculator,FAST_MODEL_ID} from './fast5-real-market-calculator.mjs';
export const FAST5_MARKET_URL='http://127.0.0.1:13003/api/shadow-market-data';
const trim=e=>String(e?.message||e||'ERROR').slice(0,110);
export function createFast5Service({clock=()=>Date.now(),fetcher=fetch,
 marketURL=FAST5_MARKET_URL}={}){
 const calc=createFast5Calculator({now:clock});
 let busy=false,lastFetchAt=null,lastError=null,attempts=0,lastRequestMs=null;
 async function poll(){
  if(busy)return status();
  busy=true;attempts++;
  const started=clock();
  try{
   const r=await fetcher(marketURL,{headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(1100)});
   if(!r.ok)throw Error('MARKET_HTTP_'+r.status);
   const market=await r.json();
   calc.update(market);
   lastFetchAt=clock();
   lastError=null;
  }catch(e){lastError='FAST5_FEED_'+trim(e)}
  finally{lastRequestMs=clock()-started;busy=false}
  return status();
 }
 function status(){
  const s=calc.status();
  return {...s,service:'FAST5_BTCUSDT_LOCAL_CALCULATOR',
   marketSource:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
   readiness:'READ_ONLY_NOT_SELECTED_FOR_LIVE_ORDERS',
   lastFetchAt,lastError,lastRequestMs,fetchAttempts:attempts,
   requiresDeepSeek:false,orders:false,productionIntegration:false};
 }
 return {poll,status};
}
export function serveFast5(service,port=Number(process.env.FAST5_SIGNAL_PORT||13045)){
 const server=http.createServer((req,res)=>{
  let pathname;
  try{pathname=new URL(req.url,'http://localhost').pathname}
  catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  if(!['/healthz','/api/status','/api/signal'].includes(pathname)){
   res.writeHead(404);return res.end();
  }
  const state=service.status();
  const body=pathname==='/healthz'
   ?{ok:true,service:state.service,requiresDeepSeek:false,orders:false}
   :{...state,latest:state.latest??null,
     signal:state.latest??null};
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(body));
 });
 server.listen(port,'127.0.0.1');
 return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const service=createFast5Service();
 const server=serveFast5(service);
 server.on('error',e=>{console.error('FAST5_LISTEN_FAILED_'+trim(e));process.exitCode=1;});
 void service.poll();
 const timer=setInterval(()=>void service.poll(),300);
 timer.unref?.();
 console.log('FAST5_SIGNAL_LOCAL_RUNNING deepseek=false order_write=false');
}
