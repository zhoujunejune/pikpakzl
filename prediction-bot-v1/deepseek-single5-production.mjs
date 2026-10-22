// Single-call, five-second DeepSeek live signal provider.
// No historical settlement, learning journal, training, statistics, or WAIT directions.
// Never submits orders. A price-only fallback is distinctly attributed, never DeepSeek.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRoundResultsJournal} from './round-results-only-journal.mjs';
const ID='DEEPSEEK_5M_V1';
const ROUND_MS=300000;
const LIMIT_MS=5000;
const EXPOSE_UNTIL_MS=25000; // existing trade handler may safely re-check the locked signal
const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const API='https://api.deepseek.com/chat/completions';
const OFFICIAL='http://127.0.0.1:13002/api/round-stats';
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
  throw Error('INVALID_FIVE_SECOND_REAL_SIGNAL');
 const dir=decision.direction;
 return {ok:true,model:ID,round,generatedAt:at,readOnly:true,orders:false,
  productionIntegration:false,providerModel,
  latest:{model:ID,round,status:'LOCKED',direction:dir,lockedAt:at,
   marketAt:tick.at,confidence:null,score:0.5,
   reason:String(decision.reason||'').slice(0,110),
   confidenceIsCalibrated:false,selectedModelConfidence:null,
   decisionMethod:decision.method,
   directionalPolicy:'ONE_CALL_FIVE_SECONDS_NO_LEARNING',
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
 let lastMarketAt=null,missed=0;
 const journal=createRoundResultsJournal({file:String(env.ROUND_RESULTS_FILE||
  path.join(path.dirname(saveFile),'round-results-only.ndjson')),clock});
 let firstSeenAt=clock(),journalError=null,lastOfficialError=null,officialBusy=false,officialPollAt=0;
 const finishRoundSafe=(r,observed)=>{
  try{journal.finishRound(r,{observed});journalError=null}
  catch(e){journalError=String(e?.message||e).slice(0,120)}
 };
 async function pollOfficial(){
  const now=clock();
  if(officialBusy||now-officialPollAt<60000)return;
  officialBusy=true;officialPollAt=now;
  try{
   const response=await fetcher(String(env.DEEPSEEK_OFFICIAL_STATS_URL||OFFICIAL),{
    signal:AbortSignal.timeout(7000),headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('OFFICIAL_HTTP_'+response.status);
   journal.settle(await response.json());lastOfficialError=null;
  }catch(e){lastOfficialError=String(e?.message||e).slice(0,125)}
  finally{officialBusy=false}
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
  try{journal.recordSignal(signal);journalError=null}
  catch(e){journalError=String(e?.message||e).slice(0,120)}
  completed={round,result:'LOCKED',elapsedMs:now-round,direction:decision.direction,
   method:decision.method};
  error=null;
  console.log(JSON.stringify({event:'deepseek_single5_locked',round,direction:decision.direction,
   elapsedMs:now-round,method:decision.method,modelCalls}));
  return true;
 };
 const fallback=reason=>{
  if(saved?.round===round||clock()<round+4450||clock()>=round+LIMIT_MS)return;
  if(snapshot&&snapshot.round===round&&clock()-snapshot.at<=3000){
   const direction=snapshot.price>=snapshot.open?'UP':'DOWN';
   try{commit({direction,method:'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK',
      reason:'DeepSeek未按时给出有效结果，按本轮真实BTC开盘价和最新价格给出备用方向'},snapshot)}
   catch(e){error='FALLBACK_PERSIST_'+String(e.message||e).slice(0,90)}
  }else{
   error='NO_TRUSTED_CURRENT_ROUND_PRICE';
  }
 };
 async function judge(tick){
  attempted=true;modelCalls=1;pending=true;
  const started=clock(),available=round+LIMIT_MS-started-350;
  if(!key||available<350){
   error=!key?'DEEPSEEK_API_KEY_MISSING':'MODEL_TIME_BUDGET_EXHAUSTED';
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
    signal:AbortSignal.timeout(Math.max(300,Math.min(3200,available)))});
   latency=clock()-started;
   if(!res.ok)throw Error('DEEPSEEK_HTTP_'+res.status);
   const body=await res.json();
   apiTokens=Number(body?.usage?.total_tokens)||null;
   const parsed=modelDirection(body?.choices?.[0]?.message?.content);
   if(!parsed)throw Error('INVALID_AI_DIRECTION');
   if(!saved&&clock()<round+LIMIT_MS){
    // Input was causal. The market snapshot must still be current when locking.
    if(clock()-tick.at>3000)throw Error('AI_MARKET_SNAPSHOT_EXPIRED');
    commit({...parsed,method:'DEEPSEEK_SINGLE_CALL_5S'},tick);
   }
  }catch(e){
   latency=clock()-started;
   error=String(e?.message||e).slice(0,110);
  }finally{pending=false}
 }
 function rotate(now){
  const r=roundOf(now);
  if(r===round)return;
  finishRoundSafe(round,firstSeenAt<round+LIMIT_MS);
  for(let gap=round+ROUND_MS;gap<r;gap+=ROUND_MS)finishRoundSafe(gap,false);
  if(!saved||saved.round!==round)missed++;
  round=r;firstSeenAt=now;attempted=false;pending=false;feedBusy=false;
  snapshot=null;error=null;latency=null;completed=null;modelCalls=0;apiTokens=null;
 }
 async function tick(){
  const now=clock();rotate(now);
  if(now-round>=LIMIT_MS||saved?.round===round){
   if(now-round>=LIMIT_MS)finishRoundSafe(round,firstSeenAt<round+LIMIT_MS);
   if(now-round>=LIMIT_MS)void pollOfficial();
   return status();
  }
  if(!feedBusy){
   feedBusy=true;
   try{
    const res=await fetcher(marketFeed,{headers:{Accept:'application/json'},
     signal:AbortSignal.timeout(650)});
    if(!res.ok)throw Error('MARKET_HTTP_'+res.status);
    const raw=await res.json();
    const t=parseTick(raw,clock(),round);
    if(t){snapshot=t;lastMarketAt=t.at;if(!attempted)void judge(t)}
    else error='CURRENT_ROUND_MARKET_NOT_READY';
   }catch(e){error='MARKET_'+String(e?.message||e).slice(0,100)}
   finally{feedBusy=false}
  }
  fallback(error||'TIMEOUT');
  return status();
 }
 function status(){
  const now=clock();rotate(now);
  const locked=saved?.round===round;
  const visible=locked&&now<round+EXPOSE_UNTIL_MS;
  const ended=now>=round+LIMIT_MS&&!locked;
  if(ended)finishRoundSafe(round,firstSeenAt<round+LIMIT_MS);
  return {ok:true,model:ID,providerModel:model,configured:Boolean(key),
   round,signal:visible?saved:null,
   roundDecision:{round,status:locked?'LOCKED':ended?'UNAVAILABLE':'ANALYZING',
    direction:locked?saved.latest.direction:null,
    reason:ended?(error||'NO_VALID_REAL_PRICE_BEFORE_5S'):null,
    decisionDeadlineMs:round+LIMIT_MS,lockedAt:locked?saved.latest.lockedAt:null},
   lastSignal:saved?{round:saved.round,direction:saved.latest.direction}:null,
   decisionWindowEndMs:round+LIMIT_MS,
   maxCallsPerRound:1,preRoundMaxCalls:0,currentRoundMaxCalls:1,
   analysisCountLimit:'LIVE1_ONLY',
   decisionRule:'LIVE_BTC_ONE_CALL_OR_REAL_PRICE_BACKUP_5S',
   analysisModelCalls:modelCalls,tries:modelCalls,
   busy:pending,featureReady:Number.isSafeInteger(lastMarketAt)&&now-lastMarketAt<=3000,
   error,waitReason:null,lastApiLatencyMs:latency,aiTokens:apiTokens,
   lastDecision:completed,missedRounds:missed,skippedRounds:missed,
   learningDisabled:true,trainingDisabled:true,statisticsDisabled:true,
   standaloneRoundResultsEnabled:true,roundResultsError:journalError,
   officialSettlementError:lastOfficialError,
   aiDirectionalRequired:true,realOrderEnabled:false,tradeIntegration:false};
 }
 return {tick,status,roundResults:(limit)=>journal.history(limit)};
}
export function serveFastProduction(p,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end()}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  let data,code=200;
  if(['/healthz','/status','/api/status'].includes(u.pathname))data=p.status();
  else if(u.pathname==='/api/round-results'||u.pathname==='/api/history')
   data=p.roundResults(u.searchParams.get('limit'));
  else if(u.pathname==='/signal'){
   const st=p.status();
   data=st.signal;
   if(!data){
    code=503;data={ok:false,model:ID,round:st.round,
     direction:null,status:st.roundDecision.status,
     error:st.roundDecision.reason||'SIGNAL_NOT_LOCKED_BEFORE_5S',
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
 void p.tick();setInterval(()=>void p.tick(),200);
 console.log('DEEPSEEK_SINGLE5_NO_TRAINING_PRODUCTION_RUNNING');
}
