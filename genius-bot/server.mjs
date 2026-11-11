// 海派合约天才 · DeepSeek V4 analysis, PAPER-only position automation.
// No Binance authenticated order endpoints, credentials, or live trading.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ENGINE_VERSION,DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,newState,rollDay,paperOpen,paperMark} from './engine.mjs';
const PORT=Number(process.env.GENIUS_PORT||13023),HOST='127.0.0.1';
const STATE_FILE=process.env.GENIUS_STATE_FILE||'/var/lib/haipai-genius-paper/state.json';
const MODEL='deepseek-v4-flash',BASE='https://fapi.binance.com';
const SITE='https://prediction.47-237-188-69.sslip.io';
let busy=false,marketError=null;
function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    validateSettings(s.settings);
    if(typeof s.balance!=='number'||!Number.isFinite(s.balance)||!Array.isArray(s.closed)||
        s.closed.some(x=>x.paper!==true)||s.position&&s.position.source!=='DEEPSEEK_PAPER_ONLY')
      throw Error('INVALID_PAPER_LEDGER');
    return s;
  }catch(err){if(err.code==='ENOENT')return newState();throw err;}
}
const state=load();
function store(){
  fs.mkdirSync(path.dirname(STATE_FILE),{recursive:true,mode:0o700});
  const tmp=STATE_FILE+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600,flag:'w'});
  fs.renameSync(tmp,STATE_FILE);
}
async function getJson(url,timeout=6500){
  const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeout)});
  if(!response.ok){const err=Error('EXCHANGE_HTTP_'+response.status);err.status=response.status;throw err;}
  return response.json();
}
function convertCandles(raw,now,ms){
  if(!Array.isArray(raw))throw Error('KLINES_INVALID');
  return raw.filter(x=>Array.isArray(x)&&Number.isSafeInteger(x[0])&&x[0]+ms<=now)
    .map(x=>({startMs:x[0],close:Number(x[4]),high:Number(x[2]),low:Number(x[3]),volume:Number(x[5])}));
}
async function collectMarket(now){
  const symbol=state.settings.symbol,ss=encodeURIComponent(symbol);
  const [quote,one,five]=await Promise.all([
    getJson(BASE+'/fapi/v1/premiumIndex?symbol='+ss),
    getJson(BASE+'/fapi/v1/klines?symbol='+ss+'&interval=1m&limit=65'),
    getJson(BASE+'/fapi/v1/klines?symbol='+ss+'&interval=5m&limit=44')
  ]);
  return makeMarket({symbol,markPrice:Number(quote.markPrice),markTime:Number(quote.time),
    oneMin:convertCandles(one,now,60000),fiveMin:convertCandles(five,now,300000),now});
}
async function deepseekDecision(market){
  const key=process.env.DEEPSEEK_API_KEY||'';
  if(!key){state.aiStatus='KEY_NOT_CONFIGURED';return null;}
  const prompt={symbol:market.symbol,markPrice:market.markPrice,trend1m:market.trend1m,
    trend5m:market.trend5m,momentum3mPct:market.momentum3mPct,
    volumeRatio:market.volumeRatio,pricePosition20mPct:market.pricePosition20mPct,
    high20m:market.high20m,low20m:market.low20m,
    task:'Evaluate short-horizon direction for simulated research; choose WAIT if uncertain.'};
  const response=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(27000),
    headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
      response_format:{type:'json_object'},max_tokens:1200,messages:[
      {role:'system',content:'你是永续合约模拟研究分析员，只分析公开行情，不执行实盘交易。只返回JSON对象：action为LONG、SHORT或WAIT；confidence为0到1数字；reason为6到300字中文。市场趋势冲突、波动不足、数据不足时选择WAIT。confidence不是统计校准的真实胜率。不要回复JSON以外文字。'},
      {role:'user',content:JSON.stringify(prompt)}]})});
  if(!response.ok)throw Error('DEEPSEEK_HTTP_'+response.status);
  const json=await response.json(),content=json?.choices?.[0]?.message?.content;
  if(typeof content!=='string'||!content.trim())throw Error('DEEPSEEK_EMPTY_DECISION');
  state.aiStatus='SUCCESS';
  return parseDecision(content);
}
async function cycle(){
  if(busy)return;busy=true;const now=Date.now();
  try{
    rollDay(state,now);
    const market=await collectMarket(now);
    state.lastMarket=market;marketError=null;
    if(state.position)paperMark(state,market,now,state.settings.emergencyStop);
    if(state.settings.enabled&&!state.settings.emergencyStop&&!state.position){
      if(!process.env.DEEPSEEK_API_KEY)state.aiStatus='KEY_NOT_CONFIGURED';
      else if(state.dayStart-state.balance>=state.settings.maxDailyLossUsdt)state.aiStatus='DAILY_LOSS_STOP';
      else if(!state.lastActionAt||now-state.lastActionAt>=state.settings.cooldownMinutes*60000){
        const decision=await deepseekDecision(market);
        state.lastDecision=decision?{...decision,at:Date.now(),model:MODEL}:null;
        // If AI takes too long, entry fails closed; old quote is not traded.
        if(decision)paperOpen(state,market,decision,Date.now());
      }
    }
    state.cycleCount=(state.cycleCount||0)+1;state.lastError=null;store();
  }catch(e){marketError=String(e?.message||e).slice(0,150);state.lastError=marketError;
    state.aiStatus='ERROR_OR_MARKET_UNAVAILABLE';store();
  }finally{busy=false;}
}
function publicSnapshot(){
  return {ok:true,app:'海派合约天才',version:ENGINE_VERSION,mode:'PAPER_ONLY',
    realTradingEnabled:false,realOrderExecutionAvailable:false,aiModel:MODEL,
    aiConfigured:Boolean(process.env.DEEPSEEK_API_KEY),aiStatus:state.aiStatus,
    settings:state.settings,paperBalance:state.balance,paperDayStart:state.dayStart,
    position:state.position,lastDecision:state.lastDecision,lastMarket:state.lastMarket,
    lastError:state.lastError,marketError,totalClosed:state.closed.length,
    cycleCount:state.cycleCount||0,tradingSafety:'NO_REAL_ORDERS_NO_API_KEY_IN_CLIENT',
    paperLimitations:'Paper-only estimates; no real execution, funding, liquidation, depth or real exchange-side protective orders.'};
}
function json(res,code,obj){
  const body=JSON.stringify(obj);
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
}
const server=http.createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(req.method==='GET'&&pathname==='/api/status')return json(res,200,publicSnapshot());
    if(req.method==='GET'&&pathname==='/api/history')return json(res,200,{ok:true,version:ENGINE_VERSION,
      records:state.closed.slice(0,100),paper:true});
    if(req.method==='GET'&&pathname==='/healthz')return json(res,200,{ok:true,paperOnly:true});
    if(req.method==='POST'&&pathname==='/api/settings'){
      if(req.headers.origin!==SITE||req.headers['x-haipai-paper-control']!=='yes'||
          !String(req.headers['content-type']||'').startsWith('application/json'))
        return json(res,403,{ok:false,error:'UNTRUSTED_ORIGIN'});
      let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>4000)break;}
      if(raw.length>4000)return json(res,413,{ok:false,error:'TOO_LARGE'});
      const settings=validateSettings(JSON.parse(raw));
      if(state.position&&(settings.symbol!==state.settings.symbol||
          settings.paperBalance!==state.settings.paperBalance))
        return json(res,409,{ok:false,error:'CANNOT_CHANGE_SYMBOL_OR_PAPER_CAPITAL_WITH_POSITION'});
      if(settings.paperBalance!==state.settings.paperBalance){
        const delta=settings.paperBalance-state.settings.paperBalance;
        if(state.balance+delta<0)return json(res,409,{ok:false,error:'PAPER_WITHDRAW_EXCEEDS_BALANCE'});
        state.balance+=delta;state.dayStart+=delta;
      }
      Object.assign(state.settings,settings);store();
      return json(res,200,{ok:true,settings:state.settings,mode:'PAPER_ONLY'});
    }
    return json(res,404,{ok:false,error:'NOT_FOUND'});
  }catch(e){return json(res,400,{ok:false,error:String(e.message||e).slice(0,130)});}
});
if(process.env.NODE_ENV!=='test'){
  server.listen(PORT,HOST,()=>console.log('HAIPAI_GENIUS_PAPER_LISTENING='+PORT));
  setInterval(()=>void cycle(),60000).unref();
  void cycle();
}
export {server,publicSnapshot,cycle};