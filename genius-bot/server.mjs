// 海派合约天才 · continuous Binance public market observation + DeepSeek autonomous PAPER decisions.
// No authenticated exchange API keys or real-money order endpoints.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ENGINE_VERSION,DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,
  newState,rollDay,paperOpen,paperMark,paperAdjustStops} from './engine.mjs';

const PORT=Number(process.env.GENIUS_PORT||13023),HOST='127.0.0.1';
const STATE_FILE=process.env.GENIUS_STATE_FILE||'/var/lib/haipai-genius-paper/state.json';
const MODEL='deepseek-flash',BASE='https://fapi.binance.com';
const SITE='https://prediction.47-237-188-69.sslip.io';
const SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT'];
const WS_URL='wss://fstream.binance.com/stream?streams='+SYMBOLS.map(s=>s.toLowerCase()+'@markPrice@1s').join('/');
const tickPrices=new Map(),candleCache=new Map();
let busy=false,marketError=null,wsState='CONNECTING',lastSocketAt=0,lastModelCallAt=0;
let socket=null,reconnectTimer=null;

function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    validateSettings(s.settings);
    // Migrate older hidden tuning: AI now owns ordinary entries/exits, while safety bounds remain.
    s.settings.cooldownMinutes=DEFAULT_SETTINGS.cooldownMinutes;
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
  if(!response.ok)throw Error('EXCHANGE_HTTP_'+response.status);
  return response.json();
}
function convertCandles(raw,now,ms){
  if(!Array.isArray(raw))throw Error('KLINES_INVALID');
  return raw.filter(x=>Array.isArray(x)&&Number.isSafeInteger(x[0])&&x[0]+ms<=now)
    .map(x=>({startMs:x[0],close:Number(x[4]),high:Number(x[2]),low:Number(x[3]),volume:Number(x[5])}));
}
function connectStream(){
  if(typeof WebSocket!=='function'){wsState='WEBSOCKET_NOT_SUPPORTED_REST_FALLBACK';return;}
  try{
    socket=new WebSocket(WS_URL);wsState='CONNECTING';
    socket.addEventListener('open',()=>{wsState='LIVE';});
    socket.addEventListener('message',event=>{
      try{
        const msg=JSON.parse(String(event.data)),m=msg.data||msg;
        const symbol=String(m.s||'').toUpperCase(),price=Number(m.p),time=Number(m.E);
        if(!SYMBOLS.includes(symbol)||!Number.isFinite(price)||price<=0||
            !Number.isFinite(time)||Math.abs(Date.now()-time)>7000)return;
        tickPrices.set(symbol,{price,time});lastSocketAt=Date.now();wsState='LIVE';
        // UI price snapshots move on every websocket tick even while AI is thinking.
        if(state.lastMarket?.symbol===symbol){
          state.lastMarket={...state.lastMarket,markPrice:price,markTime:time,checkedAt:Date.now()};
        }
        if(!Array.isArray(state.marketSnapshots))state.marketSnapshots=[];
        const slot=state.marketSnapshots.findIndex(x=>x.symbol===symbol);
        const item={symbol,markPrice:price,checkedAt:Date.now()};
        if(slot>=0)state.marketSnapshots[slot]=item;
        else state.marketSnapshots.push(item);
        if(state.position&&state.position.symbol===symbol){
          // Protective stops are checked on each fresh market event, not blocked by AI thinking.
          const result=paperMark(state,{symbol,markPrice:price,checkedAt:Date.now()},Date.now(),state.settings.emergencyStop);
          if(result.ok)store();
        }
      }catch(e){marketError=String(e.message||e).slice(0,120);}
    });
    socket.addEventListener('error',()=>{wsState='ERROR_RECONNECTING';});
    socket.addEventListener('close',()=>{
      wsState='DISCONNECTED_RECONNECTING';
      if(reconnectTimer)clearTimeout(reconnectTimer);
      reconnectTimer=setTimeout(connectStream,3000);
    });
  }catch(e){wsState='ERROR_RECONNECTING';reconnectTimer=setTimeout(connectStream,5000);}
}
async function collectMarket(symbol,now=Date.now()){
  if(!SYMBOLS.includes(symbol))throw Error('UNSUPPORTED_SYMBOL');
  let cached=candleCache.get(symbol);
  if(!cached||now-cached.savedAt>30000){
    const ss=encodeURIComponent(symbol);
    const [one,five]=await Promise.all([
      getJson(BASE+'/fapi/v1/klines?symbol='+ss+'&interval=1m&limit=65'),
      getJson(BASE+'/fapi/v1/klines?symbol='+ss+'&interval=5m&limit=44')]);
    cached={savedAt:Date.now(),one:convertCandles(one,Date.now(),60000),
      five:convertCandles(five,Date.now(),300000)};
    candleCache.set(symbol,cached);
  }
  let tick=tickPrices.get(symbol);
  if(!tick||now-tick.time>5000){
    // REST fallback if websocket stalls. No simulated entries on stale quotes.
    const quote=await getJson(BASE+'/fapi/v1/premiumIndex?symbol='+encodeURIComponent(symbol));
    tick={price:Number(quote.markPrice),time:Number(quote.time)};
  }
  return makeMarket({symbol,markPrice:tick.price,markTime:tick.time,
    oneMin:cached.one,fiveMin:cached.five,now:Date.now()});
}
async function collectMarkets(){
  const results=await Promise.allSettled(SYMBOLS.map(s=>collectMarket(s)));
  const valid=results.flatMap(x=>x.status==='fulfilled'?[x.value]:[]);
  if(!valid.length)throw Error('ALL_MARKETS_UNAVAILABLE');
  return valid;
}
async function deepseekDecision(markets,position){
  const key=process.env.DEEPSEEK_API_KEY||'';
  if(!key){state.aiStatus='KEY_NOT_CONFIGURED';return null;}
  const payload={
    task:position?'Decide HOLD or CLOSE for existing paper position. Choose safe exit when risk increases.'
      :'Select best opportunity among BTCUSDT, ETHUSDT and SOLUSDT or WAIT; no obligation to enter.',
    markets:markets.map(m=>({symbol:m.symbol,markPrice:m.markPrice,checkedAt:m.checkedAt,
      trend1m:m.trend1m,trend5m:m.trend5m,momentum3mPct:m.momentum3mPct,
      volumeRatio:m.volumeRatio,pricePosition20mPct:m.pricePosition20mPct,high20m:m.high20m,low20m:m.low20m})),
    position:position?{symbol:position.symbol,side:position.side,entry:position.entry,
      markPrice:markets.find(x=>x.symbol===position.symbol)?.markPrice,
      stop:position.stop,takeProfit:position.takeProfit,openedAt:position.openedAt}:null,
    rules:'Only PAPER simulation. Entry risk bounded server-side. Do not assume profitable trades.'};
  lastModelCallAt=Date.now();state.aiStatus='THINKING';
  const response=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(27000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
      response_format:{type:'json_object'},max_tokens:1800,messages:[
      {role:'system',content:'你是永续合约模拟研究分析模型。仅输出JSON对象，字段action、symbol、confidence、reason、takeProfitPct、stopLossPct。无仓时action只能LONG/SHORT/WAIT，持仓时只能HOLD/CLOSE；symbol为BTCUSDT/ETHUSDT/SOLUSDT，持仓时必须与持仓币种一致；confidence为0至1。reason为6至300字中文。入场时自行建议止盈价格百分比0.2至5、止损百分比0.2至3；持仓时可继续调整，但服务器始终限制最大损失且不允许放宽已设定止损。趋势不一致、流动性或数据不足时选择WAIT。你提供的confidence并非验证过的胜率，不要保证盈利。只做模拟分析，不进行实盘交易。'},
      {role:'user',content:JSON.stringify(payload)}]})});
  if(!response.ok)throw Error('DEEPSEEK_HTTP_'+response.status);
  const obj=await response.json(),msg=obj?.choices?.[0]?.message?.content;
  if(typeof msg!=='string'||!msg.trim())throw Error('DEEPSEEK_EMPTY_DECISION');
  const decision=parseDecision(msg);
  if(position){
    if(!['HOLD','CLOSE'].includes(decision.action)||decision.symbol!==position.symbol)
      throw Error('AI_POSITION_DECISION_MISMATCH');
  }else if(!['WAIT','LONG','SHORT'].includes(decision.action)||
    decision.action!=='WAIT'&&!decision.symbol)throw Error('AI_ENTRY_DECISION_MISMATCH');
  state.aiStatus='SUCCESS';
  return decision;
}
async function cycle(){
  if(busy)return;
  busy=true;
  try{
    const now=Date.now();rollDay(state,now);
    const markets=await collectMarkets();marketError=null;
    const held=state.position?markets.find(x=>x.symbol===state.position.symbol):null;
    state.lastMarket=held||markets[0];
    state.marketSnapshots=markets.map(x=>({symbol:x.symbol,markPrice:x.markPrice,checkedAt:x.checkedAt}));
    if(state.position){
      if(!held)throw Error('POSITION_MARKET_UNAVAILABLE');
      paperMark(state,held,Date.now(),state.settings.emergencyStop);
    }
    if(state.settings.enabled&&!state.settings.emergencyStop){
      if(!process.env.DEEPSEEK_API_KEY)state.aiStatus='KEY_NOT_CONFIGURED';
      else if(!state.position&&state.dayStart-state.balance>=state.settings.maxDailyLossUsdt)
        state.aiStatus='DAILY_LOSS_STOP';
      else if(Date.now()-lastModelCallAt>=25000){
        const oldPosition=state.position;
        const decision=await deepseekDecision(markets,oldPosition);
        state.lastDecision=decision?{...decision,at:Date.now(),model:MODEL}:null;
        if(decision&&oldPosition){
          const fresh=await collectMarket(oldPosition.symbol);
          if(state.position&&state.position.id===oldPosition.id){
            paperMark(state,fresh,Date.now(),state.settings.emergencyStop);
            if(state.position&&decision.action==='CLOSE')paperMark(state,fresh,Date.now(),'AI_CLOSE');
            else if(state.position&&decision.action==='HOLD')paperAdjustStops(state,fresh,decision);
          }
        }else if(decision&&['LONG','SHORT'].includes(decision.action)&&decision.confidence>=0.6){
          const before=markets.find(x=>x.symbol===decision.symbol);
          if(!before)throw Error('SELECTED_MARKET_UNAVAILABLE');
          const fresh=await collectMarket(decision.symbol);
          if(before.trend1m!==fresh.trend1m||before.trend5m!==fresh.trend5m||
              Math.abs(fresh.markPrice/before.markPrice-1)>0.005){
            state.aiStatus='SIGNAL_STALE_OR_TREND_CHANGED_NO_ENTRY';
          }else if(!state.position)paperOpen(state,fresh,decision,Date.now());
        }
      }
    }else if(!state.settings.enabled)state.aiStatus='PAUSED';
    state.cycleCount=(state.cycleCount||0)+1;state.lastError=null;store();
  }catch(e){
    marketError=String(e?.message||e).slice(0,150);state.lastError=marketError;
    state.aiStatus='ERROR_OR_MARKET_UNAVAILABLE';store();
  }finally{busy=false;}
}
function publicSnapshot(){
  const tickFresh=Date.now()-lastSocketAt<6000;
  return {ok:true,app:'海派合约天才',version:ENGINE_VERSION,mode:'PAPER_ONLY',
    realTradingEnabled:false,realOrderExecutionAvailable:false,aiModel:MODEL,
    aiConfigured:Boolean(process.env.DEEPSEEK_API_KEY),aiStatus:state.aiStatus,
    settings:state.settings,paperBalance:state.balance,paperDayStart:state.dayStart,
    position:state.position,lastDecision:state.lastDecision,lastMarket:state.lastMarket,
    marketSnapshots:state.marketSnapshots||[],marketStream:tickFresh?'LIVE':wsState,
    lastMarketTickAt:lastSocketAt,lastModelCallAt,
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
      const submitted=JSON.parse(raw);
      if(!submitted||typeof submitted!=='object'||Array.isArray(submitted))
        throw Error('INVALID_SETTINGS_PAYLOAD');
      const allowed=['enabled','emergencyStop','leverage','marginUsdt'];
      const edits=Object.fromEntries(Object.entries(submitted).filter(([k])=>allowed.includes(k)));
      const updated=validateSettings({...state.settings,...edits});
      // Only two editable money/leveraged parameters; other controls are kept server-side.
      Object.assign(state.settings,updated);store();
      return json(res,200,{ok:true,settings:state.settings,mode:'PAPER_ONLY'});
    }
    return json(res,404,{ok:false,error:'NOT_FOUND'});
  }catch(e){return json(res,400,{ok:false,error:String(e.message||e).slice(0,130)});}
});
if(process.env.NODE_ENV!=='test'){
  server.listen(PORT,HOST,()=>console.log('HAIPAI_GENIUS_PAPER_LISTENING='+PORT));
  connectStream();
  setInterval(()=>void cycle(),5000).unref();
  void cycle();
}
export {server,publicSnapshot,cycle};
