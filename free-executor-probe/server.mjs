// Zero-cost Render deployment feasibility check. No credentials and NO orders.
// Endpoints return coarse network status only; no user accounts, wallets or secrets.
import http from 'node:http';
const PORT=Number(process.env.PORT||10000);
const SOURCES=Object.freeze([
 ['binance_spot','https://api.binance.com/api/v3/time'],
 ['binance_prediction','https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/list?limit=1'],
 ['binance_data','https://data-api.binance.vision/api/v3/time'],
 ['binance_futures','https://fapi.binance.com/fapi/v1/time']
]);
const send=(res,status,obj)=>{const body=JSON.stringify(obj);
 res.writeHead(status,{'content-type':'application/json; charset=utf-8',
 'cache-control':'no-store','x-content-type-options':'nosniff',
 'content-length':Buffer.byteLength(body)});
 res.end(body);};
async function checkOne(name,url){
 try{
  const r=await fetch(url,{method:'GET',headers:{accept:'application/json'},
   signal:AbortSignal.timeout(4000),redirect:'manual'});
  let code=null;
  try{const d=await r.json();if(typeof d?.code==='number')code=d.code;}catch{}
  return {name,http:r.status,exchangeCode:code,regionBlocked:r.status===451,
   // HTTP 401/400 are only evidence the API gateway is reachable, not that trading is authorized.
   transportReachable:r.status!==451 && r.status!==403};
 }catch(e){
  return {name,http:null,transportReachable:false,
   error:e?.name==='TimeoutError'?'TIMEOUT':'NETWORK_UNAVAILABLE'};
 }
}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method!=='GET')return send(res,405,{ok:false,error:'READ_ONLY_NO_ORDERS'});
  const pathname=new URL(req.url||'/', 'http://localhost').pathname;
  if(pathname==='/'||pathname==='/healthz')return send(res,200,{
   ok:true,service:'zl-binance-network-probe',mode:'READ_ONLY',orders:false,
   note:'No trading keys, balances, Binance signed APIs or order submissions'});
  if(pathname==='/api/network'){
   const checks=await Promise.all(SOURCES.map(([name,url])=>checkOne(name,url)));
   return send(res,200,{ok:true,readOnly:true,orders:false,at:Date.now(),
    disclaimer:'Network access does not prove account eligibility, Binance authorization or order speed.',
    checks});
  }
  return send(res,404,{ok:false,error:'NOT_FOUND'});
 }catch(e){return send(res,503,{ok:false,error:'PROBE_FAILED'})}
});
server.listen(PORT,'0.0.0.0',()=>console.log('Read-only probe listening on port '+PORT));
