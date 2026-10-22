// DeepSeek-first + real current-round price fallback with a T+100ms target.
// If this round's quote is missing at 100ms, use first valid quote received by T+15s.
// Never re-use previous round price or incorrectly claim a 100ms success.
// This service only publishes signals; it never submits orders.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const ID='DEEPSEEK_5M_V1';
const ROUND_MS=300000;
const AI_LIMIT_MS=100;
const FALLBACK_END_MS=15000;
const LIMIT_MS=FALLBACK_END_MS;
const EXPOSE_UNTIL_MS=35000; // retain selected trader's 30-second window
const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const API='https://api.deepseek.com/chat/completions';
const side=x=>x==='UP'||x==='DOWN';
const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
function parseTick(raw,now,expectedRound){
 const q=raw?.latest??{};
 const t=Number(q.eventMs),r=Number(q.roundStartMs);
 const price=Number(q.lastPrice),open=Number(q.roundOpenPrice);
 if(raw?.ok!==true||raw?.readOnly!==true||raw?.symbol!=='BTCUSDT'||
  !Number.isSafeInteger(t)||!Number.isSafeInteger(r)||r!==expectedRound||
  t<expectedRound||t>now+750||now-t>3000||
  !(price>0)||!(open>0)||q.marketFeedConnected===false)return null;
 return {round:r,at:t,price,open};
}
function modelDirection(s){
 let j;
 try{j=JSON.parse(String(s))}catch{return null}
 if(!side(j?.direction))return null;
 return {direction:j.direction,reason:String(j.reason||'实时BTC开盘价及现价判断').slice(0,110)};
}
export function buildFastSignal({round,at,tick,decision,providerModel}){
 if(!Number.isSafeInteger(round)||round%ROUND_MS||
  !Number.isSafeInteger(at)||at<round||at>=round+LIMIT_MS||
  tick?.round!==round||tick.at>at||at-tick.at>3500||!side(decision?.direction))
  throw Error('INVALID_CURRENT_ROUND_100MS_SIGNAL');
 const dir=decision.direction;
 return {ok:true,model:ID,round,generatedAt:at,readOnly:true,orders:false,
  productionIntegration:false,providerModel,
  latest:{model:ID,round,status:'LOCKED',direction:dir,lockedAt:at,
   marketAt:tick.at,confidence:null,score:0.5,
   reason:String(decision.reason||'').slice(0,110),
   confidenceIsCalibrated:false,selectedModelConfidence:null,
   decisionMethod:decision.method,
   directionalPolicy:'DEEPSEEK_100MS_OR_PRICE_FALLBACK_NO_LEARNING',
   uncertainty:'UNQUANTIFIED',
   prewarmDirection:null,reviewDirection:null,lastSelectedReview:'current',
   waitAllowed:false,fromOpenBps:Number(((tick.price/tick.open-1)*10000).toFixed(3)),
   earlyObservationCount:1,
   entry:{direction:dir,at,marketAt:tick.at,score:0.5,strength:0.5,modelVersion:ID}},
  expiryAt:round+270000};
}
export function createFastProductionProvider({
 env=process.env,clock=()=>Date.now(),fetcher=fetch,
 marketFeed=String(env.ADAPTIVE15_MARKET_URL||FEED),
 api=String(env.DEEPSEEK_API_URL||API),
 saveFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/deepseek5/signal.json')
}={}){
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const key=String(env.DEEPSEEK_API_KEY||'');
 let round=roundOf(clock()),attempted=false,pending=false,feedBusy=false,saved=null;
 let snapshot=null,error=null,latency=null,completed=null,modelCalls=0,apiTokens=null;
 let lastMarketAt=null,missed=0,lastFailure=null,diagnosticError=null,expiredLogged=false;
 const diagnosticFile=String(env.AI15_DIAGNOSTIC_FILE||
   path.join(path.dirname(saveFile),'ai15-diagnostics.ndjson'));
 function audit(event,detail={}){
  const row={event,at:new Date(clock()).toISOString(),round,...detail};
  console.log(JSON.stringify(row));
  try{
   fs.mkdirSync(path.dirname(diagnosticFile),{recursive:true,mode:0o750});
   fs.appendFileSync(diagnosticFile,JSON.stringify(row)+'\n',{mode:0o640});
   diagnosticError=null;
  }catch(e){diagnosticError='AUDIT_WRITE_'+String(e?.code||e?.message||e).slice(0,70)}
 }
 function failed(code,detail={}){
  const r=String(code||'DEEPSEEK_UNKNOWN_FAILURE').slice(0,125);
  error=r;lastFailure={round,at:clock(),reason:r};
  audit('deepseek100ms_analysis_failed',{reason:r,...detail});
 }

 // Previous output is for the previous round only; never republish it.
 const commit=(decision,tick)=>{
  const now=clock();
  if(saved?.round===round||now>=round+LIMIT_MS||roundOf(now)!==round)return false;
  const signal=buildFastSignal({round,at:now,tick,decision,providerModel:model});
  fs.mkdirSync(path.dirname(saveFile),{recursive:true,mode:0o750});
  const tmp=saveFile+'.fast5.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(signal),{mode:0o640});
  fs.renameSync(tmp,saveFile);
  saved=signal;
  completed={round,result:'LOCKED',elapsedMs:now-round,direction:decision.direction,
   method:decision.method};
  error=null;
  audit('deepseek100ms_locked',{direction:decision.direction,elapsedMs:now-round,method:decision.method,
    modelCalls,apiLatencyMs:latency,aiTokens:apiTokens,marketAtMs:tick.at,
    overTargetMs:Math.max(0,now-(round+AI_LIMIT_MS))});
  return true;
 };
 function fallback(reason='DEEPSEEK_NOT_READY_BY_100MS'){
  const now=clock();
  if(saved?.round===round||now<round+AI_LIMIT_MS||now>=round+FALLBACK_END_MS)return false;
  const t=snapshot;
  if(!t||t.round!==round||t.at<round||t.at>now||now-t.at>3000){
   error='CURRENT_ROUND_MARKET_NOT_READY_FOR_PRICE_FALLBACK';
   return false;
  }
  const direction=t.price>=t.open?'UP':'DOWN';
  try{
   const ok=commit({direction,method:'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK',
     reason:'100毫秒内无有效DeepSeek方向，使用本轮真实BTC开盘价和最新价格生成备用方向'},t);
   if(ok)audit('deepseek100ms_price_fallback',{reason,
     elapsedMs:clock()-round,marketEventLagMs:Math.max(0,clock()-t.at),
     aiAttempted:attempted,aiLatencyMs:latency});
   return ok;
  }catch(e){
   failed('PRICE_FALLBACK_PERSIST_FAILED',{name:String(e?.name||'Error')});
   return false;
  }
 }
 async function judge(tick){
  attempted=true;modelCalls=1;pending=true;
  const requestRound=round;
  const started=clock(),available=round+AI_LIMIT_MS-started;
  if(!key||available<25){
   failed(!key?'DEEPSEEK_API_KEY_MISSING':'MODEL_100MS_TIME_BUDGET_EXHAUSTED',{startedMs:started-round});
   pending=false;return;
  }
  const input={roundStartMs:round,observedAtMs:tick.at,
   btcRoundOpen:tick.open,btcCurrentPrice:tick.price,
   changeFromRoundOpenBps:Number(((tick.price/tick.open-1)*10000).toFixed(3))};
  // Exactly one non-thinking API request. No history, RSI, MACD or statistics.
  const payload={model,thinking:{type:'disabled'},max_tokens:120,temperature:0,
   response_format:{type:'json_object'},
   messages:[
    {role:'system',content:'You predict BTC price UP or DOWN at the end of its current 5-minute round versus its opening price. Use ONLY the supplied current-round real BTC prices. Always choose UP or DOWN even if uncertain. Reply JSON only: {"direction":"UP","reason":"brief current-price explanation"}. Never use WAIT. Do not discuss training or historical win rates.'},
    {role:'user',content:JSON.stringify(input)}
   ]};
  try{
   const res=await fetcher(api,{method:'POST',headers:{
    Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(Math.max(1,Math.floor(available-1)))});
   latency=clock()-started;
   if(!res.ok)throw Error('DEEPSEEK_HTTP_'+res.status);
   const body=await res.json();
   apiTokens=Number(body?.usage?.total_tokens)||null;
   const parsed=modelDirection(body?.choices?.[0]?.message?.content);
   if(!parsed)throw Error('INVALID_AI_DIRECTION');
   if(requestRound!==roundOf(clock())||requestRound!==round)return;
   if(saved?.round!==round&&clock()<round+AI_LIMIT_MS){
    const fresh=snapshot?.round===round && clock()-snapshot.at<=3000 ? snapshot : tick;
    if(clock()-fresh.at>3000)throw Error('AI_MARKET_SNAPSHOT_EXPIRED');
    if(!commit({...parsed,method:'DEEPSEEK_SINGLE_CALL_5S'},fresh))throw Error('AI_COMMIT_REJECTED');
   }else if(saved?.round!==round)failed('AI_RESPONSE_AFTER_100MS',{apiLatencyMs:latency});
  }catch(e){
   latency=clock()-started;
   if(requestRound!==round||requestRound!==roundOf(clock())||saved?.round===requestRound)return;
   failed(e?.name==='AbortError'||e?.name==='TimeoutError'?'DEEPSEEK_API_TIMEOUT':String(e?.message||e),
     {apiLatencyMs:clock()-started});
  }finally{pending=false}
 }
 function rotate(now){
  const r=roundOf(now);
  if(r===round)return;
  if(!saved||saved.round!==round)missed++;
  round=r;attempted=false;pending=false;feedBusy=false;expiredLogged=false;
  snapshot=null;error=null;latency=null;completed=null;modelCalls=0;apiTokens=null;
 }
 async function tick(){
  const now=clock();rotate(now);
  if(saved?.round===round)return status();
  if(now-round>=FALLBACK_END_MS){
   if(!expiredLogged){
    expiredLogged=true;
    const reason='NO_TRUSTED_CURRENT_ROUND_MARKET_BEFORE_15S';
    lastFailure={round,at:now,reason};
    audit('deepseek100ms_round_unavailable',{reason,modelCalls,aiLatencyMs:latency});
   }
   return status();
  }
  if(now>=round+AI_LIMIT_MS)fallback('DEEPSEEK_100MS_DEADLINE');
  if(saved?.round===round)return status();
  if(!feedBusy){
   feedBusy=true;
   try{
    const res=await fetcher(marketFeed,{headers:{Accept:'application/json'},
     signal:AbortSignal.timeout(650)});
    if(!res.ok)throw Error('MARKET_HTTP_'+res.status);
    const raw=await res.json();
    const t=parseTick(raw,clock(),round);
    if(t){
     snapshot=t;lastMarketAt=t.at;
     if(!attempted&&clock()<round+AI_LIMIT_MS)void judge(t);
     if(clock()>=round+AI_LIMIT_MS)fallback('FIRST_VALID_CURRENT_ROUND_MARKET_AFTER_100MS');
    }else error='CURRENT_ROUND_MARKET_NOT_READY';
   }catch(e){error='MARKET_'+String(e?.message||e).slice(0,100)}
   finally{feedBusy=false}
  }
  return status();
 }
 function status(){
  const now=clock();rotate(now);
  const locked=saved?.round===round;
  const visible=locked&&now<round+EXPOSE_UNTIL_MS;
  const ended=now>=round+FALLBACK_END_MS&&!locked;
  return {ok:true,model:ID,providerModel:model,configured:Boolean(key),
   round,signal:visible?saved:null,
   roundDecision:{round,status:locked?'LOCKED':ended?'UNAVAILABLE':'ANALYZING',
    direction:locked?saved.latest.direction:null,
    reason:ended?(lastFailure?.round===round?lastFailure.reason:(error||'NO_VALID_REAL_BTC_PRICE_BEFORE_15S')):null,
    decisionDeadlineMs:round+AI_LIMIT_MS,lockedAt:locked?saved.latest.lockedAt:null,
    fallbackMarketDeadlineMs:round+FALLBACK_END_MS},
   lastSignal:saved?{round:saved.round,direction:saved.latest.direction}:null,
   decisionWindowEndMs:round+AI_LIMIT_MS,fallbackMarketDeadlineMs:round+FALLBACK_END_MS,
   maxCallsPerRound:1,preRoundMaxCalls:0,currentRoundMaxCalls:1,
   analysisCountLimit:'LIVE1_ONLY',
   decisionRule:'DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK',
   analysisModelCalls:modelCalls,tries:modelCalls,
   busy:pending,featureReady:Number.isSafeInteger(lastMarketAt)&&now-lastMarketAt<=3000,
   error,waitReason:null,lastApiLatencyMs:latency,aiTokens:apiTokens,lastFailure,diagnosticError,
   fallbackPending:!locked&&now>=round+AI_LIMIT_MS&&now<round+FALLBACK_END_MS,
   lastDecision:completed,missedRounds:missed,skippedRounds:missed,
   learningDisabled:true,trainingDisabled:true,statisticsDisabled:true,
   aiDirectionalRequired:true,realOrderEnabled:false,tradeIntegration:false};
 }
 return {tick,status};
}
export function serveFastProduction(p,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data,code=200;
  if(['/healthz','/status','/api/status'].includes(u.pathname))data=p.status();
  else if(u.pathname==='/signal'){
   const st=p.status();
   data=st.signal;
   if(!data){
    code=503;data={ok:false,model:ID,round:st.round,
     direction:null,status:st.roundDecision.status,
     error:st.roundDecision.reason||'WAITING_FOR_VALID_CURRENT_ROUND_PRICE',
     signalAvailable:false};
   }
  }else {res.writeHead(404);return res.end('Not Found')}
  res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(data));
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const p=createFastProductionProvider();serveFastProduction(p);
 void p.tick();setInterval(()=>void p.tick(),20); // local first-quote poll; timing is measured, never asserted
 console.log('DEEPSEEK_100MS_REAL_PRICE_FALLBACK_NO_TRAINING_PRODUCTION_RUNNING');
}
