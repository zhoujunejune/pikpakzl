// 海派合约天才 · continuous Binance public market observation + DeepSeek autonomous PAPER decisions.
// No authenticated exchange API keys or real-money order endpoints.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {ENGINE_VERSION,DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,
  newState,rollDay,paperOpen,paperMark,parsePortfolioPlan,normalizePaperPositions,
  paperFloatingPnL,paperPnlSummary,MAX_PAPER_POSITIONS} from './engine.mjs';
import {ingestTrade,summarizeTrades,bookSummary,shouldAnalyze,shouldRefreshClosedCandles,shouldScoutOpportunities} from './market-signals.mjs';
import {summarizeClosedTrades,estimatedEntryCosts,assessPositions,resolveAIExit,resolveAIEntry} from './decision-context.mjs';
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
  lastTrigger:'NONE',marketRestFallbacks:0,higherRequests:0,higherFailures:0,timeframeSnapshots:0,
  exitReviewCalls:0,exitReviewConfirmed:0,exitReviewRejected:0,exitReviewFailed:0,lastExitReview:null,
  entryReviewCalls:0,entryReviewConfirmed:0,entryReviewRejected:0,entryReviewFailed:0,lastEntryReview:null,
  consecutiveAllWait:0,scoutCalls:0,scoutSuccess:0,scoutEntriesProposed:0,scoutFailure:0,lastScout:null,
  candleBoundaryRefreshes:0,errors:[]};
let busy=false,marketError=null,wsState='CONNECTING',lastSocketAt=0,lastModelCallAt=0,wsOpenedAt=0;
let socket=null,reconnectTimer=null,bookSocket=null,bookReconnectTimer=null,bookWsLastAt=0;

function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    // Migrate existing settings without resetting balance, history or a paper position.
    const {takeProfitPct,stopLossPct,maxDailyLossUsdt,cooldownMinutes,...currentSettings}=s.settings;
    s.settings={...DEFAULT_SETTINGS,...currentSettings};
    validateSettings(s.settings);
    // One-way idempotent migration of previous singleton position; never reset trade history.
    if(!Array.isArray(s.positions)){
      s.positions=s.position?[s.position]:[];
    }
    normalizePaperPositions(s);
    delete s.position;
    // Migrate once from preserved closed trade ledger, then accumulate for lifetime even
    // after the 500-entry display cap; never clear history or modify an open position.
    if(!Number.isFinite(s.realizedNetPnl)){
      if(s.closed.some(t=>!Number.isFinite(t.netPnl)))throw Error('INVALID_HISTORIC_PNL');
      s.realizedNetPnl=Number(s.closed.reduce((sum,t)=>sum+t.netPnl,0).toFixed(6));
    }
    if(typeof s.balance!=='number'||!Number.isFinite(s.balance)||!Array.isArray(s.closed)||
        s.closed.some(x=>x.paper!==true))throw Error('INVALID_PAPER_LEDGER');
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
  if(shouldRefreshClosedCandles(cached,now)){
    if(cached&&now-cached.savedAt<=15000)metrics.candleBoundaryRefreshes++;
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
  results.forEach((r,i)=>{if(r.status==='rejected')rememberError('MARKET_'+SYMBOLS[i],r.reason);});
  if(!valid.length){
    const details=results.map((r,i)=>SYMBOLS[i]+':'+String(r.reason?.message||r.reason).slice(0,42)).join(' | ');
    throw Error('ALL_MARKETS_UNAVAILABLE: '+details.slice(0,190));
  }
  if(state.settings.enabled){
    await Promise.all(valid.map(x=>loadHigherTimeframes(x.symbol)));
  }
  return valid;
}
const DECISION_POLICY=[
  '你是多币种永续合约模拟研究AI。只返回JSON对象：{"decisions":[{"action":"HOLD","symbol":"ETHUSDT","horizon":"MEDIUM","confidence":0.7,"reason":"至少6字的具体中文分析原因"}]}。',
  '每个币种最多一条，支持BTCUSDT、ETHUSDT、SOLUSDT。无仓位可LONG/SHORT/WAIT，持有仓位必须HOLD或CLOSE；每个持仓必须给出决定。',
  '短线SHORT、中线MEDIUM、长线LONG由你自主选择；比较1m、5m、15m、1h、4h、日线、周线和实时成交盘口。',
  '你必须主动扫描三类机会：短期顺势动量(1m/5m/15m)、中线趋势延续(1h/4h)、长期趋势(日/周)。每种机会分别判断方向、风险收益比与净收益空间；短线反弹与长线下跌不必然互相否决，可选择适当SHORT周期研究，但不得无视反转和追高风险。',
  '开仓前要分析交易费与滑点、市场波动潜力、预期净收益和风险收益比。0.16%是模型的估算往返盈亏平衡波动，不是每次都不能突破的固定行情阈值。短周期预期可实现波动足够覆盖成本时，不要仅因为4h/日线方向不一致就永远WAIT。',
  '评估持仓应依据entryHorizon原始开仓周期及entryThesis开仓依据：短周期噪声不应自动导致中长线平仓。比较开仓逻辑是否被新事实推翻、持仓结构与风险暴露、浮动盈亏及预计平仓后的净盈亏，独立决定HOLD或CLOSE。',
  '亏损不意味着必须立刻平仓，盈利也不意味着必须立即止盈；当趋势失效或风险收益显著恶化时，可主动CLOSE。不要仅为避免实现亏损而长期死扛。',
  '结合recentClosedTradeReview识别同一币种、同一周期反复小亏、交易费侵蚀或过早平仓的问题；交易历史只是少量模拟样本，不是训练结果，不意味着未来必定盈利。',
  'reason必须具体说明关键周期信号和净收益/风险考虑。提出CLOSE前，先对照entryThesis、entryHorizon和latestAIHoldReason，说明什么新的市场证据让继续HOLD不如CLOSE；如果只是秒级噪声或手续费造成的小额浮亏，优先重新考虑持有而不是反复止损。明确判断获利兑现机会，不要只会亏损平仓。但趋势真的失效时可以果断CLOSE，不要死扛。不得把未知行情当作真实值；已有持仓缺少对应最新价格不能CLOSE。',
  '新增开仓只允许higherTimeframesComplete=true的币种。单币种不可重复持仓，最多三笔。RSI超买/超卖是风险提示，不是单独否决强势趋势的理由；综合量价、盘口、波动及周期冲突。无真实优势则WAIT，不能为了数量编造信号，也不要因追求近乎完美条件长期放弃所有可行机会。',
  '每笔止盈、止损和平仓都只由你实时自主决定，没有固定价格/百分比自动止盈止损；紧急停止仅供用户手动操作。不要保证盈利。仅模拟交易，不进行币安真实下单。'
].join('');

// Re-examine a persistent all-WAIT market from a distinct trade-horizon lens.
// The scout cannot open positions: every proposal still passes independent
// direction review and fresh-market checks.
async function scoutAlternativeOpportunities(markets){
  metrics.scoutCalls++;
  const key=process.env.DEEPSEEK_API_KEY||'';
  if(!key)return null;
  const snapshot=markets.map(m=>({
    symbol:m.symbol,markPrice:m.markPrice,checkedAt:m.checkedAt,
    trend1m:m.trend1m,trend5m:m.trend5m,momentum3mPct:m.momentum3mPct,
    volumeRatio:m.volumeRatio,pricePosition20mPct:m.pricePosition20mPct,
    micro:marketMicro(m.symbol),
    higherTimeframes:timeframesOf(m.symbol).frames,
    higherTimeframesComplete:timeframesOf(m.symbol).complete
  }));
  const policy='你是永续合约模拟交易机会侦察AI，所有主要AI判断都为WAIT后进行独立复核。'
    +'仅返回JSON对象{"decisions":[{"symbol":"BTCUSDT","action":"WAIT","horizon":"SHORT","confidence":0.5,"reason":"不少于六字的详细中文理由"}]}。'
    +'每个币种最多一条，可LONG、SHORT、WAIT，候选周期可SHORT/MEDIUM/LONG，最多3个币种。'
    +'主动比较趋势延续、超卖反弹、短期回调结束、强动量突破机会。较大周期反向不自动否决短线机会，'
    +'高RSI不单独否决趋势；但必须核查秒级主动成交、盘口、波动空间、模拟费率与滑点。'
    +'若缺少一致的可执行方向或净收益空间仍返回WAIT。不能为达到交易次数制造信号或承诺高胜率。'
    +'仅研究模拟交易，不允许真实订单。';
  const body={paperOnly:true,sizing:estimatedEntryCosts(state.settings),
    recentLosses:summarizeClosedTrades(state.closed,20),markets:snapshot};
  try{
    const response=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',signal:AbortSignal.timeout(27000),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
        response_format:{type:'json_object'},max_tokens:3800,messages:[
        {role:'system',content:policy},
        {role:'user',content:JSON.stringify(body)}
      ]})
    });
    if(!response.ok)throw Error('SCOUT_HTTP_'+response.status);
    const raw=await response.json();
    const answer=raw?.choices?.[0]?.message?.content;
    if(typeof answer!=='string'||!answer.trim())throw Error('SCOUT_EMPTY_'+String(raw?.choices?.[0]?.finish_reason||'UNKNOWN'));
    const decisions=parsePortfolioPlan(answer);
    for(const d of decisions){
      if(!['WAIT','LONG','SHORT'].includes(d.action)||
          !markets.some(m=>m.symbol===d.symbol))
        throw Error('SCOUT_INVALID_SYMBOL_OR_ACTION');
    }
    metrics.scoutSuccess++;
    const entries=decisions.filter(d=>['LONG','SHORT'].includes(d.action));
    metrics.scoutEntriesProposed+=entries.length;
    metrics.lastScout={at:Date.now(),entries:entries.map(d=>({symbol:d.symbol,action:d.action})),
      summary:decisions.map(d=>({symbol:d.symbol,action:d.action,reason:d.reason.slice(0,120)}))};
    return decisions;
  }catch(e){
    metrics.scoutFailure++;
    rememberError('AI_OPPORTUNITY_SCOUT',e);
    metrics.lastScout={at:Date.now(),error:String(e.message||e).slice(0,150)};
    return null;
  }
}

async function deepseekDecision(markets,positions){
  const key=process.env.DEEPSEEK_API_KEY||'';
  if(!key){state.aiStatus='KEY_NOT_CONFIGURED';return null;}
  const marketViews=markets.map(m=>({symbol:m.symbol,markPrice:m.markPrice,checkedAt:m.checkedAt,
    trend1m:m.trend1m,trend5m:m.trend5m,momentum3mPct:m.momentum3mPct,
    volumeRatio:m.volumeRatio,pricePosition20mPct:m.pricePosition20mPct,
    high20m:m.high20m,low20m:m.low20m,micro:marketMicro(m.symbol),
    higherTimeframes:timeframesOf(m.symbol).frames,
    higherTimeframesComplete:timeframesOf(m.symbol).complete}));
  const payload={
    task:'Manage all PAPER positions and evaluate optional entries. Always provide a HOLD/CLOSE decision for EACH held symbol; optional LONG/SHORT/WAIT for each unheld symbol.',
    maxPositions:MAX_PAPER_POSITIONS,
    paperTradingCostModel:estimatedEntryCosts(state.settings),
    recentClosedTradeReview:summarizeClosedTrades(state.closed),
    positions:assessPositions(positions,markets,Date.now()),
    markets:marketViews,
    rules:'PAPER ONLY: no real orders; independent AI-managed exits, no fixed stop loss or take profit; unknown prices are not zero PnL; no risk-free assumptions.'
  };
  lastModelCallAt=Date.now();metrics.aiAttempts++;state.aiStatus='THINKING';
  const response=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(27000),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
      response_format:{type:'json_object'},max_tokens:5600,messages:[
      {role:'system',content:DECISION_POLICY},
      {role:'user',content:JSON.stringify(payload)}]})});
  if(!response.ok)throw Error('DEEPSEEK_HTTP_'+response.status);
  const obj=await response.json(),msg=obj?.choices?.[0]?.message?.content;
  if(typeof msg!=='string'||!msg.trim())throw Error('DEEPSEEK_EMPTY_DECISION_'+String(obj?.choices?.[0]?.finish_reason||'UNKNOWN'));
  const decisions=parsePortfolioPlan(msg);
  for(const d of decisions){
    const held=positions.some(p=>p.symbol===d.symbol);
    if(held&&!['HOLD','CLOSE'].includes(d.action))throw Error('AI_HELD_SYMBOL_DECISION_INVALID');
    if(!held&&!['WAIT','LONG','SHORT'].includes(d.action))throw Error('AI_UNHELD_SYMBOL_DECISION_INVALID');
  }
  const heldSymbols=positions.map(p=>p.symbol);
  if(heldSymbols.some(symbol=>!decisions.some(d=>d.symbol===symbol)))
    throw Error('AI_MISSING_HELD_SYMBOL_DECISION');
  metrics.aiSuccess++;metrics.aiLastFinishedAt=Date.now();
  metrics.aiDurationMs=metrics.aiLastFinishedAt-lastModelCallAt;
  state.aiStatus='SUCCESS';
  return decisions;
}
// An independent AI checks the proposed new entry for direction, cost and
// timeframe consistency. Only two matching AI decisions create a PAPER entry.
async function reviewProposedEntry(proposal,market){
  metrics.entryReviewCalls++;
  const key=process.env.DEEPSEEK_API_KEY||'';
  if(!key||!timeframesOf(market.symbol).complete){
    metrics.entryReviewFailed++;
    rememberError('AI_ENTRY_REVIEW',!key?'AI_ENTRY_REVIEW_MISSING_KEY':'AI_ENTRY_REVIEW_HIGHER_INCOMPLETE');
    return null;
  }
  const payload={
    task:'独立审核本次模拟开仓是否真的值得执行，输出明确方向或WAIT。',
    proposedEntry:proposal,
    candidateMarket:{
      ...market,
      micro:marketMicro(market.symbol),
      higherTimeframes:timeframesOf(market.symbol).frames,
      higherTimeframesComplete:timeframesOf(market.symbol).complete
    },
    paperCostModel:estimatedEntryCosts(state.settings),
    recentClosedTradeReview:summarizeClosedTrades(state.closed,25),
    existingExposure:state.positions.map(p=>({symbol:p.symbol,side:p.side,
      leverage:p.leverage,marginUsdt:p.marginUsdt,
      horizon:p.entryHorizon||p.horizon||'UNSPECIFIED'}))
  };
  const policy='你是独立的永续合约模拟开仓复核AI，只输出单个JSON对象：{"action":"WAIT","symbol":"BTCUSDT","confidence":0.65,"horizon":"MEDIUM","reason":"至少六字的具体中文理由"}。'
    +'action只允许LONG、SHORT或WAIT，必须选择请求中的同一币种。不要盲从最初的开仓建议；重新评估短中长周期趋势、行情质量、'
    +'预期波动空间能否覆盖模型手续费与滑点、净收益风险比、持仓组合和近期失败交易。开仓方向以所选交易周期为主，日线趋势冲突不必然否定明确短周期机会，RSI极值也并非单项否决。方向证据不足或成本不合理时自主选择WAIT，'
    +'确认方向和净收益逻辑时可自主选择LONG或SHORT。不保证盈利，不使用固定胜率承诺。只做模拟交易，不调用真实交易接口。';
  try{
    const response=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',signal:AbortSignal.timeout(27000),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
        response_format:{type:'json_object'},max_tokens:3000,messages:[
        {role:'system',content:policy},
        {role:'user',content:JSON.stringify(payload)}
      ]})
    });
    if(!response.ok)throw Error('ENTRY_REVIEW_HTTP_'+response.status);
    const raw=await response.json(),msg=raw?.choices?.[0]?.message?.content;
    if(typeof msg!=='string'||!msg.trim())throw Error('ENTRY_REVIEW_EMPTY_'+String(raw?.choices?.[0]?.finish_reason||'UNKNOWN'));
    const review=parseDecision(msg);
    if(review.symbol!==market.symbol||!['LONG','SHORT','WAIT'].includes(review.action))
      throw Error('ENTRY_REVIEW_INVALID_ACTION_OR_SYMBOL');
    if(review.action===proposal.action)metrics.entryReviewConfirmed++;
    else metrics.entryReviewRejected++;
    metrics.lastEntryReview={at:Date.now(),symbol:market.symbol,proposed:proposal.action,
      result:review.action,reason:review.reason.slice(0,200)};
    return review;
  }catch(e){
    metrics.entryReviewFailed++;
    rememberError('AI_ENTRY_REVIEW',e);
    metrics.lastEntryReview={at:Date.now(),symbol:market.symbol,proposed:proposal.action,
      result:'UNAVAILABLE',reason:String(e?.message||e).slice(0,140)};
    return null;
  }
}

// Independent AI review of each proposed close, with immutable entry thesis,
// cost-aware mark-to-market and fresh cross-timeframe evidence. Never invent
// a fixed stop-loss or take-profit. The review is advisory when unavailable.
async function reviewProposedClose(proposal,position,market){
  metrics.exitReviewCalls++;
  const key=process.env.DEEPSEEK_API_KEY||'';
  const context=assessPositions([position],[market],Date.now())[0];
  if(!key||!context?.marketDataFresh){
    metrics.exitReviewFailed++;
    const error=!key?'AI_EXIT_REVIEW_MISSING_KEY':'AI_EXIT_REVIEW_STALE_MARKET';
    rememberError('AI_EXIT_REVIEW',error);
    return null;
  }
  const payload={
    task:'独立复核一次已有AI提出的模拟平仓请求，重新决定CLOSE或HOLD。',
    originalCloseProposal:proposal,
    position:context,
    currentMarket:{
      ...market,
      micro:marketMicro(position.symbol),
      higherTimeframes:timeframesOf(position.symbol).frames,
      higherTimeframesComplete:timeframesOf(position.symbol).complete
    },
    recentClosedTradeReview:summarizeClosedTrades(state.closed,20),
    costModel:estimatedEntryCosts(state.settings)
  };
  const policy='你是独立的永续合约模拟平仓复核AI。只返回单个JSON对象，格式{"action":"HOLD","symbol":"BTCUSDT","confidence":0.7,"horizon":"MEDIUM","reason":"至少六字的具体中文依据"}。只能HOLD或CLOSE，必须同币种。'
    +'同时认真考虑最初开仓理由entryThesis、原定周期entryHorizon、实际最新行情、周期结构、净收益与手续费、继续持有与立即平仓的机会成本。'
    +'不要把短周期噪声和仅因手续费造成的浮亏视为趋势确认失效；但也不要为了避免亏损或提高胜率而死扛，严重趋势失效、风险恶化时可以果断CLOSE。'
    +'盈利时也需客观比较兑现与继续持有，不要只能判断亏损离场。没有最新价格不能确认平仓。不要保证盈利，不添加固定止盈止损。仅模拟，不下实盘单。';
  try{
    const response=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',signal:AbortSignal.timeout(27000),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,thinking:{type:'enabled'},reasoning_effort:'high',
        response_format:{type:'json_object'},max_tokens:3000,messages:[
        {role:'system',content:policy},
        {role:'user',content:JSON.stringify(payload)}
      ]})
    });
    if(!response.ok)throw Error('EXIT_REVIEW_HTTP_'+response.status);
    const raw=await response.json(),msg=raw?.choices?.[0]?.message?.content;
    if(typeof msg!=='string'||!msg.trim())throw Error('EXIT_REVIEW_EMPTY_'+String(raw?.choices?.[0]?.finish_reason||'UNKNOWN'));
    const review=parseDecision(msg);
    if(review.symbol!==position.symbol||!['HOLD','CLOSE'].includes(review.action))
      throw Error('EXIT_REVIEW_INVALID_ACTION_OR_SYMBOL');
    if(review.action==='HOLD')metrics.exitReviewRejected++;
    else metrics.exitReviewConfirmed++;
    metrics.lastExitReview={at:Date.now(),symbol:position.symbol,
      proposed:'CLOSE',result:review.action,reason:review.reason.slice(0,200)};
    return review;
  }catch(e){
    metrics.exitReviewFailed++;
    rememberError('AI_EXIT_REVIEW',e);
    metrics.lastExitReview={at:Date.now(),symbol:position.symbol,
      proposed:'CLOSE',result:'UNAVAILABLE',reason:String(e?.message||e).slice(0,140)};
    return null;
  }
}

async function cycle(){
  if(busy)return;
  busy=true;
  try{
    const now=Date.now();rollDay(state,now);
    const markets=await collectMarkets();marketError=null;
    const heldSymbols=new Set(state.positions.map(p=>p.symbol));
    state.lastMarket=markets.find(m=>heldSymbols.has(m.symbol))||markets[0];
    state.marketSnapshots=markets.map(x=>({symbol:x.symbol,markPrice:x.markPrice,checkedAt:x.checkedAt}));
    if(state.settings.emergencyStop){
      for(const p of [...state.positions]){
        const m=markets.find(m=>m.symbol===p.symbol);
        if(m)paperMark(state,m,Date.now(),'EMERGENCY_STOP');
      }
      state.aiStatus='EMERGENCY_STOP';
    }else if(state.settings.enabled){
      if(!process.env.DEEPSEEK_API_KEY)state.aiStatus='KEY_NOT_CONFIGURED';
      else {
        const holding=state.positions.length>0;
        const largestMove=Math.max(0,...SYMBOLS.map(sym=>
          Math.abs(marketMicro(sym).trades.w10?.changePct||0)));
        if(shouldAnalyze({now:Date.now(),lastAt:lastModelCallAt,holding,
          change10sPct:largestMove,enabled:true})){
          metrics.lastTrigger=largestMove>=(holding?.12:.25)?'PRICE_EVENT':'SCHEDULED';
          const beforePositions=[...state.positions];
          const decisions=await deepseekDecision(markets,beforePositions);
          if(decisions){
            const allWait=beforePositions.length===0&&decisions.every(d=>d.action==='WAIT');
            metrics.consecutiveAllWait=allWait?metrics.consecutiveAllWait+1:0;
            let chosen=decisions;
            if(shouldScoutOpportunities({enabled:state.settings.enabled,
              heldCount:beforePositions.length,decisions,
              waitStreak:metrics.consecutiveAllWait})){
              const alternate=await scoutAlternativeOpportunities(markets);
              if(alternate?.some(d=>['LONG','SHORT'].includes(d.action)))chosen=alternate;
            }
            state.lastDecisions=chosen.map(d=>({...d,at:Date.now(),model:MODEL}));
            state.lastDecision=state.lastDecisions[0];
            // UI controls may change while awaiting DeepSeek. NEVER execute an obsolete plan.
            if(state.settings.enabled&&!state.settings.emergencyStop){
              // Apply closes first, then entries; each symbol is unique and positions <=3.
              for(const d of chosen.filter(d=>d.action==='CLOSE')){
                const original=beforePositions.find(p=>p.symbol===d.symbol);
                if(!original)continue;
                const current=state.positions.find(p=>p.symbol===d.symbol);
                if(!current||current.id!==original.id)continue;
                const fresh=await collectMarket(d.symbol);
                const review=await reviewProposedClose(d,current,fresh);
                const resolution=resolveAIExit(d,review);
                current.lastExitReview={at:Date.now(),action:review?.action||'UNAVAILABLE',
                  status:resolution.status,reason:review?.reason||'独立复核不可用，遵从原AI的平仓决定'};
                // Review rejection is AI choosing HOLD, not a price/time gate.
                if(!resolution.execute){
                  current.lastHoldReason=review.reason;
                  continue;
                }
                if(!state.settings.enabled||state.settings.emergencyStop)continue;
                const latest=await collectMarket(d.symbol);
                const stillHeld=state.positions.find(p=>p.id===original.id);
                if(!stillHeld||!state.settings.enabled||state.settings.emergencyStop)continue;
                paperMark(state,latest,Date.now(),'AI_CLOSE',
                  (d.reason+'；复核：'+(review?.reason||'复核不可用，原AI决策')).slice(0,300));
              }
              for(const d of chosen.filter(d=>d.action==='HOLD')){
                const current=state.positions.find(p=>p.symbol===d.symbol);
                if(current){
                  // Keep the original investment horizon: transient AI flips do not
                  // silently turn a failed short-term trade into a "long-term" hold.
                  if(current.horizon==='UNSPECIFIED'&&d.horizon)current.horizon=d.horizon;
                  current.lastHoldReason=d.reason;
                }
              }
              for(const d of chosen.filter(d=>['LONG','SHORT'].includes(d.action))){
                if(!state.settings.enabled||state.settings.emergencyStop)break;
                if(state.positions.some(p=>p.symbol===d.symbol)||
                    state.positions.length>=MAX_PAPER_POSITIONS)continue;
                const before=markets.find(m=>m.symbol===d.symbol);
                if(!before||!timeframesOf(d.symbol).complete)continue;
                const fresh=await collectMarket(d.symbol);
                if(before.trend1m!==fresh.trend1m||before.trend5m!==fresh.trend5m||
                    Math.abs(fresh.markPrice/before.markPrice-1)>0.005)continue;
                const entryReview=await reviewProposedEntry(d,fresh);
                const entryResolution=resolveAIEntry(d,entryReview);
                if(!entryResolution.execute)continue;
                if(!state.settings.enabled||state.settings.emergencyStop)break;
                // Refresh once more after the second AI call, and reject stale plans.
                const latest=await collectMarket(d.symbol);
                if(before.trend1m!==latest.trend1m||before.trend5m!==latest.trend5m||
                    Math.abs(latest.markPrice/before.markPrice-1)>0.005)continue;
                if(state.positions.some(p=>p.symbol===d.symbol)||
                    state.positions.length>=MAX_PAPER_POSITIONS)continue;
                paperOpen(state,latest,d,Date.now());
              }
            }
          }
        }
      }
    }else state.aiStatus='PAUSED';
    state.cycleCount=(state.cycleCount||0)+1;state.lastError=null;store();
  }catch(e){
    marketError=String(e?.message||e).slice(0,150);state.lastError=marketError;
    if(state.aiStatus==='THINKING'||String(marketError).startsWith('DEEPSEEK')||
      /timeout|aborted|AI_/i.test(String(marketError))){
      metrics.aiFailure++;metrics.aiDurationMs=lastModelCallAt?Date.now()-lastModelCallAt:null;
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
    positions:state.positions,position:state.positions[0]||null,positionCount:state.positions.length,
    lastDecision:state.lastDecision,lastDecisions:state.lastDecisions||[],lastMarket:state.lastMarket,
    marketSnapshots:state.marketSnapshots||[],marketStream:tickFresh?'LIVE':wsState,
    lastMarketTickAt:lastSocketAt,lastModelCallAt,
    metrics:{...metrics,marketAgeMs:lastSocketAt?Date.now()-lastSocketAt:null,
      perSymbol:Object.fromEntries(SYMBOLS.map(sym=>[sym,{markAgeMs:tickPrices.get(sym)?
        Date.now()-tickPrices.get(sym).time:null,...marketMicro(sym),
        higherComplete:timeframesOf(sym).complete,
        higher:Object.fromEntries(Object.entries(timeframesOf(sym).frames).map(([k,v])=>
          [k,{bias:v.bias,rsi14:v.rsi14,atrPct14:v.atrPct14,
            change20BarsPct:v.change20BarsPct,lastClosedAt:v.lastClosedAt}]))}]))},
    floatingPnl:paperFloatingPnL(state.positions,state.marketSnapshots||[]),
    pnlSummary:paperPnlSummary(state,state.marketSnapshots||[]),
    recentTradeQuality:summarizeClosedTrades(state.closed),
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
