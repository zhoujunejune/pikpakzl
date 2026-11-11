// 海派合约天才 · continuous Binance public market observation + DeepSeek autonomous PAPER decisions.
// No authenticated exchange API keys or real-money order endpoints.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ENGINE_VERSION,DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,
  newState,rollDay,paperOpen,paperMark} from './engine.mjs';
import {ingestTrade,summarizeTrades,bookSummary,shouldAnalyze} from './market-signals.mjs';
import {TIMEFRAMES,summarizeTimeframe,higherTimeframesComplete} from './timeframes.mjs';

const PORT=Number(process.env.GENIUS_PORT||13023),HOST='127.0.0.1';
const STATE_FILE=process.env.GENIUS_STATE_FILE||'/var/lib/haipai-genius-paper/state.json';
const MODEL='deepseek-flash',BASE='https://fapi.binance.com';
const SITE='https://prediction.47-237-188-69.sslip.io';
const SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT'];
// Binance retired the legacy URL in April 2026. Use its dedicated market stream.
const WS_URL='wss://fstream.binance.com/market/stream?streams='+SYMBOLS.flatMap(s=>{
  const lower=s.toLowerCase();
  return [lower+'@markPrice@1s',lower+'@aggTrade'];
}).join('/');
const BOOK_URL='wss://fstream.binance.com/public/stream?streams='+
  SYMBOLS.map(s=>s.toLowerCase()+'@bookTicker').join('/');
const bookLastRest=new Map();
const tickPrices=new Map(),candleCache=new Map(),tradeBuckets=new Map(),orderBooks=new Map();
const higherCache=new Map(),timeframeBySymbol=new Map();
const metrics={wsMessages:0,markEvents:0,aggTrades:0,bookEvents:0,wsReconnects:0,
  wsLagMs:null,bookRestFallbacks:0,bookWsState:'CONNECTING',bookWsMessages:0,aiAttempts:0,aiSuccess:0,aiFailure:0,aiDurationMs:null,aiLastFinishedAt:0,
  lastTrigger:'NONE',marketRestFallbacks:0,higherRequests:0,higherFailures:0,timeframeSnapshots:0,errors:[]};
let busy=false,marketError=null,wsState='CONNECTING',lastSocketAt=0,lastModelCallAt=0,wsOpenedAt=0;
let socket=null,reconnectTimer=null,bookSocket=null,bookReconnectTimer=null,bookWsLastAt=0;

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
function connectBookStream(){
  if(typeof WebSocket!=='function'){metrics.bookWsState='UNSUPPORTED';return;}
  try{
    bookSocket=new WebSocket(BOOK_URL);metrics.bookWsState='CONNECTING';
    bookSocket.addEventListener('open',()=>{metrics.bookWsState='LIVE';});
    bookSocket.addEventListener('message',event=>{
      try{
        const m=JSON.parse(String(event.data)).data;
        const symbol=String(m?.s||'').toUpperCase(),now=Date.now();
        if(!SYMBOLS.includes(symbol))return;
        const item={bid:Number(m.b),ask:Number(m.a),bidQty:Number(m.B),
          askQty:Number(m.A),at:now};
        if(!bookSummary(item,now))return;
        orderBooks.set(symbol,item);bookWsLastAt=now;
        metrics.bookEvents++;metrics.bookWsMessages++;metrics.bookWsState='LIVE';
      }catch(e){rememberError('BOOK_WS_MESSAGE',e);}
    });
    bookSocket.addEventListener('error',()=>{metrics.bookWsState='ERROR';});
    bookSocket.addEventListener('close',()=>{
      metrics.bookWsState='RECONNECTING';
      if(bookReconnectTimer)clearTimeout(bookReconnectTimer);
      bookReconnectTimer=setTimeout(connectBookStream,3500);
    });
  }catch(e){
    metrics.bookWsState='ERROR_RECONNECTING';rememberError('BOOK_WS_CONNECT',e);
    if(bookReconnectTimer)clearTimeout(bookReconnectTimer);
    bookReconnectTimer=setTimeout(connectBookStream,5000);
  }
}
async function bookRestFallback(symbol,now=Date.now()){
  if(bookSummary(orderBooks.get(symbol),now))return;
  const last=bookLastRest.get(symbol)||0;
  if(now-last<15000)return;
  bookLastRest.set(symbol,now);
  try{
    const q=await getJson(BASE+'/fapi/v1/ticker/bookTicker?symbol='+encodeURIComponent(symbol),3500);
    const item={bid:Number(q.bidPrice),ask:Number(q.askPrice),
      bidQty:Number(q.bidQty),askQty:Number(q.askQty),at:Date.now()};
    if(bookSummary(item)) {orderBooks.set(symbol,item);metrics.bookRestFallbacks++;}
  }catch(e){rememberError('BOOK_REST',e);}
}
function verifyStreamHealth(){
  if(bookSocket&&metrics.bookWsState==='LIVE'&&bookWsLastAt&&Date.now()-bookWsLastAt>15000){
    metrics.bookWsState='STALE_RECONNECTING';
    try{bookSocket.close();}catch(e){rememberError('BOOK_WS_CLOSE',e);}
  }
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
  await bookRestFallback(symbol,Date.now());
  return makeMarket({symbol,markPrice:tick.price,markTime:tick.time,
    oneMin:cached.one,fiveMin:cached.five,now:Date.now()});
}
// Fetch higher timeframes at their own pace; never synthesize missing bars.
async function loadHigherTimeframes(symbol,now=Date.now()){
  if(!SYMBOLS.includes(symbol))throw Error('UNSUPPORTED_SYMBOL');
  const frames={};
  await Promise.all(Object.entries(TIMEFRAMES).map(async ([interval,cfg])=>{
    const key=symbol+':'+interval,old=higherCache.get(key);
    if(old&&now<old.nextAt){
      if(old.summary)frames[interval]=old.summary;
      return;
    }
    try{
      metrics.higherRequests++;
      const raw=await getJson(BASE+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+
        '&interval='+interval+'&limit=121',6500);
      const summary=summarizeTimeframe(raw,interval,Date.now());
      higherCache.set(key,{summary,nextAt:Date.now()+cfg.ttlMs});
      frames[interval]=summary;
    }catch(e){
      metrics.higherFailures++;
      rememberError('HIGHER_TIMEFRAME_'+interval,e);
      higherCache.set(key,{summary:null,nextAt:Date.now()+60000});
    }
  }));
  timeframeBySymbol.set(symbol,{frames,complete:higherTimeframesComplete(frames),
    at:Date.now()});
  metrics.timeframeSnapshots++;
  return timeframeBySymbol.get(symbol);
}
function timeframesOf(symbol){
  return timeframeBySymbol.get(symbol)||{frames:{},complete:false,at:0};
}
async function collectMarkets(){
  const results=await Promise.allSettled(SYMBOLS.map(s=>collectMarket(s)));
  const valid=results.flatMap(x=>x.status==='fulfilled'?[x.value]:[]);
  if(!valid.length)throw Error('ALL_MARKETS_UNAVAILABLE');
  if(state.settings.enabled){
    await Promise.all(valid.map(x=>loadHigherTimeframes(x.symbol)));
  }
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
      micro:marketMicro(m.symbol),higherTimeframes:timeframesOf(m.symbol).frames,
      higherTimeframesComplete:timeframesOf(m.symbol).complete})),
    position:position?{symbol:position.symbol,side:position.side,entry:position.entry,
      markPrice:markets.find(x=>x.symbol===position.symbol)?.markPrice,
      unrealizedPct:(()=>{
        const price=markets.find(x=>x.symbol===position.symbol)?.markPrice;
        if(!Number.isFinite(price))return null;
        return Number((100*(price/position.entry-1)*(position.side==='LONG'?1:-1)).toFixed(4));
      })(),
      heldSeconds:Math.floor((Date.now()-position.openedAt)/1000),openedAt:position.openedAt,
      horizon:position.horizon||'UNSPECIFIED'}:null,
    rules:'Only PAPER simulation. Entry risk bounded server-side. Do not assume profitable trades.'};
  lastModelCallAt=Date.now();metrics.aiAttempts++;state.aiStatus='THINKING';
  const response=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(27000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
      response_format:{type:'json_object'},max_tokens:1800,messages:[
      {role:'system',content:'你是永续合约模拟研究分析模型，只返回JSON对象。字段action、symbol、horizon、confidence、reason；horizon必须是SHORT（短线）、MEDIUM（中线）或LONG（长线）。无仓时action只能LONG/SHORT/WAIT，持仓时只能HOLD/CLOSE；symbol为BTCUSDT/ETHUSDT/SOLUSDT，持仓时必须与持仓币种一致。confidence为0到1，reason为6到300字中文。每轮同时分析秒级成交/盘口、1m与5m信号及15m/1h/4h/1d/1w已收盘K线趋势、EMA/RSI/ATR、成交量与结构，区分大趋势与短期噪声；AI自主选择短中长持仓研究周期，不强迫短线交易。若入场所选币种higherTimeframesComplete不为true则选择WAIT。中长线仓位不要仅因几秒波动就改变判断，应结合更高周期结构、持仓时间和盈亏，必要时明确CLOSE。已有持仓时允许依据现有可用数据决定主动CLOSE，即使较长周期数据暂时缺失。后台不设置固定止盈止损也不会触价自动平仓；没有AI CLOSE不平仓。模型评分不是胜率保证，长线杠杆存在巨大风险，且本服务仅模拟、无真实交易。'},
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
            else if(state.position&&decision.action==='HOLD'&&decision.horizon)
              state.position.horizon=decision.horizon;
            // HOLD never mutates or generates a fixed exit trigger.
          }
        }else if(decision&&['LONG','SHORT'].includes(decision.action)){
          const before=markets.find(x=>x.symbol===decision.symbol);
          if(!before)throw Error('SELECTED_MARKET_UNAVAILABLE');
          // Fail closed for NEW positions if medium/long context cannot be verified.
          if(!timeframesOf(decision.symbol).complete){
            state.aiStatus='HIGHER_TIMEFRAME_INCOMPLETE_NO_ENTRY';
            rememberError('AI_ENTRY_BLOCKED','Required higher timeframe market data missing');
          }else{
          const fresh=await collectMarket(decision.symbol);
          if(before.trend1m!==fresh.trend1m||before.trend5m!==fresh.trend5m||
              Math.abs(fresh.markPrice/before.markPrice-1)>0.005){
            state.aiStatus='SIGNAL_STALE_OR_TREND_CHANGED_NO_ENTRY';
          }else if(!state.position)paperOpen(state,fresh,decision,Date.now());
          }
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
        Date.now()-tickPrices.get(sym).time:null,...marketMicro(sym),
        higherComplete:timeframesOf(sym).complete,
        higher:Object.fromEntries(Object.entries(timeframesOf(sym).frames).map(([k,v])=>
          [k,{bias:v.bias,rsi14:v.rsi14,atrPct14:v.atrPct14,
            change20BarsPct:v.change20BarsPct,lastClosedAt:v.lastClosedAt}]))}]))},
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
  connectBookStream();
  setInterval(verifyStreamHealth,5000).unref();
  setInterval(()=>void cycle(),2000).unref();
  void cycle();
}
export {server,publicSnapshot,cycle};
