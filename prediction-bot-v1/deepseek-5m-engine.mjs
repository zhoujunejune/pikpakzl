import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
export const modelId='DEEPSEEK_5M_V1';
export const roundOf=t=>Math.floor(t/300000)*300000;
const deadline=285000;
export function marketInput(data,now=Date.now()){
 const x=data?.latest||{},t=Number(x.eventMs),round=roundOf(now);
 if(data?.ok!==true||data?.readOnly!==true||data?.symbol!=='BTCUSDT'||
 !Number.isSafeInteger(t)||t>now+1000||now-t>18000||Number(x.roundStartMs)!==round||
 !(Number(x.lastPrice)>0)||!(Number(x.roundOpenPrice)>0)||x.marketFeedConnected===false)
 throw Error('MARKET_INVALID_OR_STALE');
 return {round,marketAt:t,lastPrice:Number(x.lastPrice),roundOpenPrice:Number(x.roundOpenPrice),
  candles1m:trim(data.candles?.['1m']),candles5m:trim(data.candles?.['5m'])};
}
function trim(x){const a=Array.isArray(x)?x:Array.isArray(x?.items)?x.items:Array.isArray(x?.candles)?x.candles:[];return a.slice(-8)}
export function parseDirection(raw){
 let j;const s=String(raw||'').trim();
 try{j=JSON.parse(s)}catch{const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<a)throw Error('NON_JSON_LLM_OUTPUT');j=JSON.parse(s.slice(a,b+1))}
 if(!j||!['UP','DOWN'].includes(j.direction))throw Error('INVALID_LLM_DIRECTION');
 return {direction:j.direction,confidence:typeof j.confidence==='number'&&j.confidence>=0&&j.confidence<=1?j.confidence:null,reason:String(j.reason||'').slice(0,180)};
}
export function createSignal(input,decision,now,model){
 if(roundOf(now)!==input.round||now>=input.round+deadline||now-input.marketAt>40000)throw Error('SIGNAL_LATE');
 return {ok:true,model:modelId,round:input.round,generatedAt:now,readOnly:true,orders:false,productionIntegration:false,
  providerModel:model,latest:{model:modelId,round:input.round,status:'LOCKED',direction:decision.direction,lockedAt:now,
  marketAt:input.marketAt,confidence:decision.confidence,score:decision.confidence??0,reason:decision.reason,
  entry:{direction:decision.direction,at:now,marketAt:input.marketAt,score:decision.confidence??0,
   strength:decision.confidence??0,modelVersion:'DEEPSEEK_5M_V1'}},
  expiryAt:input.round+deadline};
}
export function createEngine({env=process.env,clock=()=>Date.now(),fetcher=fetch}={}){
 const key=String(env.DEEPSEEK_API_KEY||''),model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const api=String(env.DEEPSEEK_API_URL||'https://api.deepseek.com/chat/completions');
 const feed=String(env.LLM_MARKET_URL||'http://127.0.0.1:13003/api/shadow-market-data');
 const stateFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/llm5/deepseek-signal.json');
 let signal=null,round=null,tries=0,retryAt=0,busy=false,error=null;
 try{const old=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(old.model===modelId)signal=old}catch{}
 function status(){const r=roundOf(clock());return {ok:true,model:modelId,providerModel:model,configured:Boolean(key),round:r,
  signal:signal?.round===r?signal:null,lastSignal:signal?{round:signal.round,direction:signal.latest.direction}:null,
  tries:round===r?tries:0,busy,error,realOrderEnabled:false,tradeIntegration:false}}
 async function tick(){
  const now=clock(),r=roundOf(now);
  if(!key||busy||now<r+1000||now>=r+deadline)return status();
  if(round!==r){round=r;tries=0;retryAt=0;error=null}
  if(signal?.round===r||tries>=2||now<retryAt)return status();
  busy=true;tries++;
  try{
   const market=await fetcher(feed,{signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
   if(!market.ok)throw Error('MARKET_HTTP_'+market.status);
   const input=marketInput(await market.json(),clock());
   if(input.round!==r)throw Error('ROUND_CHANGED');
   const llm=await fetcher(api,{method:'POST',signal:AbortSignal.timeout(22000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model,max_tokens:256,thinking:{type:'disabled'},response_format:{type:'json_object'},messages:[
     {role:'system',content:'Based only on the supplied BTCUSDT data for the current 5-minute interval, predict one direction. Return a valid JSON object only: {"direction":"UP or DOWN","confidence":0.5,"reason":"short"}. Confidence is not calibrated and no win rate is guaranteed.'},
     {role:'user',content:JSON.stringify(input)}]})});
   if(!llm.ok)throw Error('MODEL_HTTP_'+llm.status);
   const body=await llm.json();
   const text=body?.choices?.[0]?.message?.content;
   if(typeof text!=='string')throw Error('MODEL_EMPTY');
   const record=createSignal(input,parseDirection(text),clock(),model);
   fs.mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o750});
   const tmp=stateFile+'.tmp.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(record),{mode:0o640});fs.renameSync(tmp,stateFile);
   signal=record;error=null;
  }catch(e){error=String(e?.message||e).slice(0,100);retryAt=clock()+30000}
  finally{busy=false}
  return status();
 }
 return {status,tick};
}
export function serve(engine,port=Number(process.env.LLM_SERVICE_PORT||13018)){
 const server=http.createServer((req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end('Bad Request')}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  const data=engine.status();
  if(['/healthz','/status','/api/status'].includes(url.pathname)){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(data))}
  if(url.pathname==='/signal'){res.writeHead(data.signal?200:503,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(data.signal||{ok:false,error:data.configured?'WAITING_FOR_MODEL':'DEEPSEEK_API_KEY_MISSING'}))}
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek 5分钟预测</title><body style="background:#101623;color:#eaf0ff;font-family:system-ui;padding:20px"><h2>DEEPSEEK_5M_V1 · DeepSeek 5分钟预测</h2><p>独立信号服务，目前不直接发送币安订单。</p><pre id="s"></pre><script>async function update(){try{let r=await fetch("/llm/api/status",{cache:"no-store"});document.getElementById("s").textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.getElementById("s").textContent=String(e)}}update();setInterval(update,5000)</script></body></html>')}
  res.writeHead(404);res.end('Not Found');
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&import.meta.url==='file://'+path.resolve(process.argv[1])){const eng=createEngine();serve(eng);void eng.tick();setInterval(()=>void eng.tick(),5000);console.log('DEEPSEEK_5M_RUNNING configured='+eng.status().configured)}
