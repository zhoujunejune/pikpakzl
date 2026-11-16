import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';

export const modelId='DEEPSEEK_5M_V1';
export const roundOf=t=>Math.floor(t/300000)*300000;
export const SIGNAL_DEADLINE_MS=270000; // reserve 30s for exchange quote/settlement
const MAX_CALLS_PER_ROUND=6;
const MODEL_MAX_TIMEOUT_MS=65000;
const MODEL_WAIT_MS=22000;
const OFFICIAL_STATS_URL='http://127.0.0.1:13002/api/round-stats';

export function marketInput(data,now=Date.now()){
 const f=extractFeatures(data,now);
 return {round:f.round,marketAt:f.observedAt,lastPrice:f.lastPrice,
  roundOpenPrice:f.roundOpenPrice,features:f};
}
export function parseDecision(raw){
 let j;const s=String(raw||'').trim();
 try{j=JSON.parse(s)}catch{
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a<0||b<a)throw Error('NON_JSON_LLM_OUTPUT');
  j=JSON.parse(s.slice(a,b+1));
 }
 if(!j||!['UP','DOWN','WAIT'].includes(j.direction))throw Error('INVALID_LLM_DIRECTION');
 return {direction:j.direction,
  confidence:typeof j.confidence==='number'&&j.confidence>=0&&j.confidence<=1?j.confidence:null,
  reason:String(j.reason||'').slice(0,180),
  nextReviewSec:Math.max(15,Math.min(55,Number(j.nextReviewSec)||25))};
}
export function parseDirection(raw){
 const j=parseDecision(raw);
 if(j.direction==='WAIT')throw Error('MODEL_NOT_READY');
 return j;
}
export function createSignal(input,decision,now,model){
 if(roundOf(now)!==input.round||now>=input.round+SIGNAL_DEADLINE_MS||now<input.marketAt||
    now-input.marketAt>90000)throw Error('SIGNAL_LATE_OR_MARKET_EXPIRED');
 return {ok:true,model:modelId,round:input.round,generatedAt:now,
  readOnly:true,orders:false,productionIntegration:false,providerModel:model,
  latest:{model:modelId,round:input.round,status:'LOCKED',direction:decision.direction,lockedAt:now,
    marketAt:input.marketAt,confidence:decision.confidence,score:decision.confidence??0,
    reason:decision.reason,
    entry:{direction:decision.direction,at:now,marketAt:input.marketAt,
      score:decision.confidence??0,strength:decision.confidence??0,modelVersion:modelId}},
  expiryAt:input.round+SIGNAL_DEADLINE_MS};
}
function modelPayload(input,feedback){
 return {
  model:'deepseek-flash',
  thinking:{type:'enabled'},
  reasoning_effort:'high',
  max_tokens:4096,
  response_format:{type:'json_object'},
  messages:[
   {role:'system',content:[
    'You are an analyst of the CURRENT Binance BTCUSDT five-minute round only.',
    'Think carefully and reason over observed live, causal evidence. Historical technical patterns are noisy; no indicator predicts outcomes with certainty.',
    'Your target is the official Binance Prediction 5-minute UP/DOWN resolution; use the available BTCUSDT spot data as a proxy and explicitly recognize basis risk.',
    'You may choose WAIT when the evidence is not sufficient; WAIT means request fresh data later and no trade. There is no obligation to decide in the first 30 seconds.',
    'If confident enough to act, output UP or DOWN. Never invent order-book, funding, liquidation or official settlement observations.',
    'Return a valid JSON object ONLY: {"direction":"UP or DOWN or WAIT","confidence":0.5,"reason":"brief evidence and caveat","nextReviewSec":25}.',
    'Confidence is a subjective internal strength indicator, NOT a calibrated win probability. Do not claim guaranteed profitability.',
    'Use the time remaining: do not rush into a signal solely because the round began. Only a single locked UP/DOWN is permitted per round.',
    'Past officially resolved performance is descriptive information, not permission to force a direction or reverse a weak model.'
   ].join(' ')},
   {role:'user',content:JSON.stringify({
    round:input.round,marketAt:input.marketAt,btcMarket:input.features,
    officialSettledFeedback:feedback
   })}
  ]
 };
}
export function createEngine({env=process.env,clock=()=>Date.now(),fetcher=fetch}={}){
 const key=String(env.DEEPSEEK_API_KEY||'');
 const model=String(env.DEEPSEEK_MODEL||'deepseek-flash');
 const api=String(env.DEEPSEEK_API_URL||'https://api.deepseek.com/chat/completions');
 const feed=String(env.LLM_MARKET_URL||'http://127.0.0.1:13003/api/shadow-market-data');
 const official=String(env.DEEPSEEK_OFFICIAL_STATS_URL||OFFICIAL_STATS_URL);
 const stateFile=String(env.LLM_STATE_FILE||'/var/lib/zl-prediction/deepseek5/signal.json');
 const learner=newLearner(String(env.DEEPSEEK_LEARNING_FILE||'/var/lib/zl-prediction/deepseek5/learning.json'),clock);
 let signal=null,round=null,tries=0,retryAt=0,busy=false,error=null,learningLastPoll=0,waitReason=null;
 let lastFeatures=null,lastApiTokens=null,lastApiLatencyMs=null,lastSettlementCount=0,settlementError=null;
 try{const old=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(old.model===modelId)signal=old}catch{}
 const bestEffortSummary=()=>{try{return learner.summary()}catch{return {officialSamples:0,error:'LEARNING_FILE_ERROR'}}};
 function status(){
  const r=roundOf(clock()),stats=bestEffortSummary();
  return {ok:true,model:modelId,providerModel:model,configured:Boolean(key),round:r,
   signal:signal?.round===r?signal:null,
   lastSignal:signal?{round:signal.round,direction:signal.latest.direction}:null,
   tries:round===r?tries:0,maxCallsPerRound:MAX_CALLS_PER_ROUND,
   decisionWindowEndMs:r+SIGNAL_DEADLINE_MS,
   busy,error,waitReason,nextReviewAt:retryAt,
   reasoning:{enabled:true,effort:'high'},
   featuresVersion:'BTC_OHLCV_RSI_MACD_ATR_V2',
   featureReady:lastFeatures?.dataQuality?.indicatorsReady??false,
   lastApiLatencyMs,lastApiTokens,
   learning:{...stats,lastOfficialUpdates:lastSettlementCount,lastError:settlementError,
    autoFeedback:true,modelWeightsFineTuned:false,
    modelReviewSuggested:stats.officialSamples>=100&&stats.recentAccuracy<0.50},
   realOrderEnabled:false,tradeIntegration:false
  };
 }
 async function pollSettlements(now){
  if(learningLastPoll&&now-learningLastPoll<65000)return;
  learningLastPoll=now;
  try{
   const r=await fetcher(official,{signal:AbortSignal.timeout(9000)});
   if(!r.ok)throw Error('OFFICIAL_STATS_HTTP_'+r.status);
   lastSettlementCount=learner.settle(await r.json());
   settlementError=null;
  }catch(e){settlementError=String(e?.message||e).slice(0,110)}
 }
 async function tick(){
  const now=clock(),r=roundOf(now);
  // Non-blocking learning. Never replace settlement outcomes with live price movement.
  if(key)void pollSettlements(now);
  if(!key||busy||now<r+1000||now>=r+SIGNAL_DEADLINE_MS)return status();
  if(round!==r){round=r;tries=0;retryAt=0;error=null;waitReason=null;lastFeatures=null}
  if(signal?.round===r||tries>=MAX_CALLS_PER_ROUND||now<retryAt)return status();
  busy=true;tries++;
  try{
   const market=await fetcher(feed,{signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
   if(!market.ok)throw Error('MARKET_HTTP_'+market.status);
   const input=marketInput(await market.json(),clock());
   if(input.round!==r)throw Error('ROUND_CHANGED');
   lastFeatures=input.features;
   if(!input.features.dataQuality.indicatorsReady){
    waitReason='WAIT_FOR_SUFFICIENT_CLOSED_OHLCV';
    retryAt=clock()+15000;return status();
   }
   const remaining=r+SIGNAL_DEADLINE_MS-clock()-1000;
   if(remaining<2000)throw Error('MODEL_REQUEST_WINDOW_EXPIRED');
   const payload=modelPayload(input,learner.feedback(input.features));
   payload.model=model;
   const start=clock();
   const response=await fetcher(api,{method:'POST',
    signal:AbortSignal.timeout(Math.min(MODEL_MAX_TIMEOUT_MS,remaining)),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify(payload)});
   lastApiLatencyMs=clock()-start;
   if(!response.ok)throw Error('MODEL_HTTP_'+response.status);
   const body=await response.json();
   lastApiTokens=Number(body?.usage?.total_tokens)||null;
   if(body?.choices?.[0]?.finish_reason==='length')throw Error('MODEL_RESPONSE_TRUNCATED');
   const result=parseDecision(body?.choices?.[0]?.message?.content);
   if(result.direction==='WAIT'){
    waitReason=result.reason||'MODEL_REVIEWING';
    retryAt=clock()+result.nextReviewSec*1000;
    return status();
   }
   // Prevent locking an old analysis after a long chain of thought when BTC has
   // materially moved. The final fresh ticker is explicitly checked.
   const fresh=await fetcher(feed,{signal:AbortSignal.timeout(5000)});
   if(!fresh.ok)throw Error('FRESH_MARKET_HTTP_'+fresh.status);
   const current=marketInput(await fresh.json(),clock());
   if(current.round!==input.round)throw Error('ROUND_CHANGED_AFTER_THINKING');
   const drift=Math.abs(current.lastPrice/input.lastPrice-1);
   if(drift>0.0015){
    waitReason='MARKET_MOVED_DURING_REASONING';
    retryAt=clock()+12000;return status();
   }
   const locked=createSignal(input,result,clock(),model);
   fs.mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o750});
   const tmp=stateFile+'.tmp.'+process.pid;
   fs.writeFileSync(tmp,JSON.stringify(locked),{mode:0o640});fs.renameSync(tmp,stateFile);
   signal=locked;error=null;waitReason=null;
   try{learner.record(locked,input.features,tries)}catch(e){settlementError='LEARNER_RECORD_'+String(e?.message||e).slice(0,65)}
  }catch(e){error=String(e?.message||e).slice(0,100);retryAt=clock()+20000}
  finally{busy=false}
  return status();
 }
 return {status,tick,history:(limit)=>learner.history(limit)};
}
export function serve(engine,port=Number(process.env.LLM_SERVICE_PORT||13029)){
 const server=http.createServer((req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{res.writeHead(400);return res.end('Bad Request')}
  if(req.method!=='GET'){res.writeHead(405);return res.end()}
  const data=engine.status();
  if(['/healthz','/status','/api/status'].includes(url.pathname)){
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
   return res.end(JSON.stringify(data));
  }
  if(url.pathname==='/api/history'){
   const history=engine.history?.(url.searchParams.get('limit'));
   res.writeHead(history?.ok?200:503,{'content-type':'application/json','cache-control':'no-store'});
   return res.end(JSON.stringify(history||{ok:false,error:'HISTORY_UNAVAILABLE'}));
  }
  if(url.pathname==='/signal'){
   res.writeHead(data.signal?200:503,{'content-type':'application/json','cache-control':'no-store'});
   return res.end(JSON.stringify(data.signal||{ok:false,error:data.configured?(data.waitReason||data.error||'WAITING_FOR_MODEL'):'DEEPSEEK_API_KEY_MISSING'}));
  }
  if(url.pathname==='/'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
   return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek 5分钟智能预测</title><body style="background:#101623;color:#eaf0ff;font-family:system-ui;padding:20px"><h2>DEEPSEEK_5M_V1 · 深度思考与结算反馈</h2><p>动态判断时间；只展示独立信号，不直接发送币安订单。</p><pre id="s"></pre><script>async function update(){try{let r=await fetch("/deepseek/api/status",{cache:"no-store"});document.getElementById("s").textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.getElementById("s").textContent=String(e)}}update();setInterval(update,5000)</script></body></html>');
  }
  res.writeHead(404);res.end('Not Found');
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]&&import.meta.url==='file://'+path.resolve(process.argv[1])){
 const eng=createEngine();serve(eng);void eng.tick();
 setInterval(()=>void eng.tick(),5000);
 console.log('DEEPSEEK_5M_RUNNING configured='+eng.status().configured);
}
