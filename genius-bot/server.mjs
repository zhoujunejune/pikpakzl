// 海派合约天才 · continuous Binance public market observation + DeepSeek autonomous PAPER decisions.
// No authenticated exchange API keys or real-money order endpoints.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ENGINE_VERSION,DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,
  newState,rollDay,paperOpen,paperMark} from './engine.mjs';
import {ingestTrade,summarizeTrades,bookSummary,shouldAnalyze} from './market-signals.mjs';

const PORT=Number(process.env.GENIUS_PORT||13023),HOST='127.0.0.1';
const STATE_FILE=process.env.GENIUS_STATE_FILE||'/var/lib/haipai-genius-paper/state.json';
const MODEL='deepseek-flash',BASE='https://fapi.binance.com';
const SITE='https://prediction.47-237-188-69.sslip.io';
const SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT'];
// Binance retired the legacy URL in April 2026. Use its dedicated market stream.
const WS_URL='wss://fstream.binance.com/market/stream?streams='+SYMBOLS.flatMap(s=>{
  const lower=s.toLowerCase();
  return [lower+'@markPrice@1s',lower+'@aggTrade',lower+'@bookTicker'];
}).join('/');
const tickPrices=new Map(),candleCache=new Map(),tradeBuckets=new Map(),orderBooks=new Map();
const metrics={wsMessages:0,markEvents:0,aggTrades:0,bookEvents:0,wsReconnects:0,
  wsLagMs:null,aiAttempts:0,aiSuccess:0,aiFailure:0,aiDurationMs:null,aiLastFinishedAt:0,
  lastTrigger:'NONE',marketRestFallbacks:0,errors:[]};
let busy=false,marketError=null,wsState='CONNECTING',lastSocketAt=0,lastModelCallAt=0,wsOpenedAt=0;
let socket=null,reconnectTimer=null;

function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    // Migrate existing settings without resetting balance, history or a paper position.
    const {takeProfitPct,stopLossPct,maxDailyLossUsdt,cooldownMinutes,...currentSettings}=s.settings;
    s.settings={...DEFAULT_SETTINGS,...currentSettings};
    validateSettings(s.settings);
    // Historic paper positions may still carry obsolete price targets; never execute them.
    if(s.position){delete s.position.stop;delete s.position.takeProfit;}
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
function rememberError(kind,error){
  const detail=String(error?.message||error).slice(0,140),at=Date.now();
  metrics.errors.unshift({at,kind,detail});metrics.errors=metrics.errors.slice(0,15);
}
function connectStream(){
  if(typeof WebSocket!=='function'){wsState='WEBSOCKET_NOT_SUPPORTED_REST_FALLBACK';return;}
  try{
    socket=new WebSocket(WS_URL);wsState='CONNECTING';
    socket.addEventListener('open',()=>{wsState='LIVE';wsOpenedAt=Date.now();});
    socket.addEventListener('message',event=>{
      try{
        const now=Date.now(),msg=JSON.parse(String(event.data)),m=msg.data||msg;
        const symbol=String(m.s||'').toUpperCase(),eventAt=Number(m.E||m.T||now);
        if(!SYMBOLS.includes(symbol)||!Number.isSafeInteger(eventAt)||Math.abs(now-eventAt)>7000)return;
        metrics.wsMessages++;lastSocketAt=now;wsState='LIVE';
        const lag=Math.max(0,now-eventAt);
        metrics.wsLagMs=metrics.wsLagMs===null?lag:Math.round(.85*metrics.wsLagMs+.15*lag);
        if(m.e==='markPriceUpdate'){
          const price=Number(m.p);
          if(!Number.isFinite(price)||price<=0)return;
          tickPrices.set(symbol,{price,time:eventAt});
          metrics.markEvents++;
          if(state.lastMarket?.symbol===symbol)
            state.lastMarket={...state.lastMarket,markPrice:price,markTime:eventAt,checkedAt:now};
          if(!Array.isArray(state.marketSnapshots))state.marketSnapshots=[];
          const index=state.marketSnapshots.findIndex(x=>x.symbol===symbol);
          const next={symbol,markPrice:price,checkedAt:now};
          if(index>=0)state.marketSnapshots[index]=next;else state.marketSnapshots.push(next);
        }else if(m.e==='aggTrade'){
          const b=tradeBuckets.get(symbol)||[];
          if(ingestTrade(b,{price:Number(m.p),qty:Number(m.q),
            time:Number(m.T||eventAt),buyerMaker:m.m===true},now)){
            tradeBuckets.set(symbol,b);metrics.aggTrades++;
          }
        }else if(m.e==='bookTicker'||(m.b!==undefined&&m.a!==undefined)){
          orderBooks.set(symbol,{bid:Number(m.b),ask:Number(m.a),bidQty:Number(m.B),
            askQty:Number(m.A),at:now});metrics.bookEvents++;
        }
        // Never submit a simulated close merely because a price level is reached.
      }catch(e){marketError=String(e.message||e).slice(0,120);rememberError('WS_MESSAGE',e);}
    });
    socket.addEventListener('error',()=>{wsState='ERROR_RECONNECTING';});
    socket.addEventListener('close',()=>{
      wsState='DISCONNECTED_RECONNECTING';metrics.wsReconnects++;
      if(reconnectTimer)clearTimeout(reconnectTimer);
      reconnectTimer=setTimeout(connectStream,Math.min(10000,1500+metrics.wsReconnects*300));
    });
  }catch(e){
    wsState='ERROR_RECONNECTING';rememberError('WS_CONNECT',e);
    if(reconnectTimer)clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(connectStream,5000);
  }
}
function verifyStreamHealth(){
  if(socket&&wsState==='LIVE'&&Date.now()-lastSocketAt>15000){
    wsState='STALE_RECONNECTING';
    try{socket.close();}catch(e){rememberError('WS_CLOSE',e);}
  }
  // Connections are rotated before Binance's 24-hour maximum lifetime.
  if(socket&&wsOpenedAt&&Date.now()-wsOpenedAt>23*60*60*1000){
    wsOpenedAt=0;try{socket.close();}catch(e){rememberError('WS_ROTATE',e);}
  }
}
function marketMicro(symbol,now=Date.now()){
  return {trades:summarizeTrades(tradeBuckets.get(symbol)||[],now),
    book:bookSummary(orderBooks.get(symbol),now)};
}
async function collectMarket(symbol,now=Date.now()){
  if(!SYMBOLS.includes(symbol))throw Error('UNSUPPORTED_SYMBOL');
  let cached=candleCache.get(symbol);
  if(!cached||now-cached.savedAt>15000){
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
    // REST fallback for stale stream data; state remains observable to the operator.
    metrics.marketRestFallbacks++;
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
      volumeRatio:m.volumeRatio,pricePosition20mPct:m.pricePosition20mPct,high20m:m.high20m,low20m:m.low20m,
      micro:marketMicro(m.symbol)})),
    position:position?{symbol:position.symbol,side:position.side,entry:position.entry,
      markPrice:markets.find(x=>x.symbol===position.symbol)?.markPrice,
      unrealizedPct:(()=>{
        const price=markets.find(x=>x.symbol===position.symbol)?.markPrice;
        if(!Number.isFinite(price))return null;
        return Number((100*(price/position.entry-1)*(position.side==='LONG'?1:-1)).toFixed(4));
      })(),
      heldSeconds:Math.floor((Date.now()-position.openedAt)/1000),openedAt:position.openedAt}:null,
    rules:'Only PAPER simulation. Entry risk bounded server-side. Do not assume profitable trades.'};
  lastModelCallAt=Date.now();metrics.aiAttempts++;state.aiStatus='THINKING';
  const response=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(27000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
      response_format:{type:'json_object'},max_tokens:1800,messages:[
      {role:'system',content:'你是永续合约模拟研究分析模型。只返回JSON对象，字段action、symbol、confidence、reason。无仓时action只能LONG/SHORT/WAIT，持仓时只能HOLD/CLOSE；symbol为BTCUSDT/ETHUSDT/SOLUSDT，持仓时必须与持仓币种一致。confidence为0到1，reason为6到300字中文。你须在每次持仓分析中自行判断继续持有或主动平仓；后台不设置固定止盈价或止损价，也不会因触价自动平仓。请综合趋势、波动、成交量、当前损益和持仓时间，自行分析退出时机。行情数据不足或模型不确定时谨慎决策。模型评分不是胜率保证。仅做模拟交易，不会发出实盘订单。'},
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
  metrics.aiSuccess++;metrics.aiLastFinishedAt=Date.now();
  metrics.aiDurationMs=metrics.aiLastFinishedAt-lastModelCallAt;
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
      if(state.settings.emergencyStop)paperMark(state,held,Date.now(),'EMERGENCY_STOP');
    }
    if(state.settings.enabled&&!state.settings.emergencyStop){
      if(!process.env.DEEPSEEK_API_KEY)state.aiStatus='KEY_NOT_CONFIGURED';
      else {
        const holding=Boolean(state.position);
        const target=holding?[state.position.symbol]:SYMBOLS;
        const largestMove=Math.max(0,...target.map(sym=>
          Math.abs(marketMicro(sym).trades.w10?.changePct||0)));
        if(!shouldAnalyze({now:Date.now(),lastAt:lastModelCallAt,holding,
          change10sPct:largestMove,enabled:true})){
          // Market is still monitored continuously; model calls are paced separately.
        }else{
        metrics.lastTrigger=largestMove>=(holding?.12:.25)?'PRICE_EVENT':'SCHEDULED';

        const oldPosition=state.position;
        const decision=await deepseekDecision(markets,oldPosition);
        state.lastDecision=decision?{...decision,at:Date.now(),model:MODEL}:null;
        if(decision&&oldPosition){
          const fresh=await collectMarket(oldPosition.symbol);
          if(state.position&&state.position.id===oldPosition.id){
            if(state.settings.emergencyStop)paperMark(state,fresh,Date.now(),'EMERGENCY_STOP');
            else if(state.position&&decision.action==='CLOSE')
              paperMark(state,fresh,Date.now(),'AI_CLOSE',decision.reason);
            // HOLD never mutates or generates a fixed exit trigger.
          }
        }else if(decision&&['LONG','SHORT'].includes(decision.action)){
          const before=markets.find(x=>x.symbol===decision.symbol);
          if(!before)throw Error('SELECTED_MARKET_UNAVAILABLE');
          const fresh=await collectMarket(decision.symbol);
          if(before.trend1m!==fresh.trend1m||before.trend5m!==fresh.trend5m||
              Math.abs(fresh.markPrice/before.markPrice-1)>0.005){
            state.aiStatus='SIGNAL_STALE_OR_TREND_CHANGED_NO_ENTRY';
          }else if(!state.position)paperOpen(state,fresh,decision,Date.now());
        }
        }
      }
    }else if(!state.settings.enabled)state.aiStatus='PAUSED';
    state.cycleCount=(state.cycleCount||0)+1;state.lastError=null;store();
  }catch(e){
    marketError=String(e?.message||e).slice(0,150);state.lastError=marketError;
    if(state.aiStatus==='THINKING'||String(marketError).startsWith('DEEPSEEK')||
      /timeout|aborted|AI_/.test(String(marketError).toLowerCase())){
      metrics.aiFailure++;
      metrics.aiDurationMs=lastModelCallAt?Date.now()-lastModelCallAt:null;
      rememberError('AI_OR_DECISION',e);
    }else rememberError('MARKET_OR_CYCLE',e);
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
    metrics:{...metrics,marketAgeMs:lastSocketAt?Date.now()-lastSocketAt:null,
      perSymbol:Object.fromEntries(SYMBOLS.map(sym=>[sym,{markAgeMs:tickPrices.get(sym)?
        Date.now()-tickPrices.get(sym).time:null,...marketMicro(sym)}]))},
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
  setInterval(verifyStreamHealth,5000).unref();
  setInterval(()=>void cycle(),2000).unref();
  void cycle();
}
export {server,publicSnapshot,cycle};
