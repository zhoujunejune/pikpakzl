// 海派合约天才 · independent PAPER-ONLY perpetual futures engine.
// Financial research software, not a real-money order executor.
export const ENGINE_VERSION = 'HAIPAI_GENIUS_PAPER_V142_AI_EXIT_ONLY';
export const DEFAULT_SETTINGS = Object.freeze({enabled:false,emergencyStop:false,
  symbol:'BTCUSDT',paperBalance:200,leverage:2,marginUsdt:5});
const finite = Number.isFinite;
const round=(n,p=6)=>Number(n.toFixed(p));
export function validateSettings(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
      Object.keys(value).sort().join('|')!==Object.keys(DEFAULT_SETTINGS).sort().join('|'))
    throw Error('INVALID_SETTINGS_FIELDS');
  const s={...value};
  for(const name of ['enabled','emergencyStop'])if(typeof s[name]!=='boolean')throw Error('INVALID_'+name);
  if(!['BTCUSDT','ETHUSDT','SOLUSDT'].includes(s.symbol))throw Error('UNSUPPORTED_SYMBOL');
  const ranges={paperBalance:[10,10000],leverage:[1,10],marginUsdt:[1,100],
    };
  for(const [name,[min,max]] of Object.entries(ranges)){
    if(typeof s[name]!=='number'||!finite(s[name])||s[name]<min||s[name]>max)
      throw Error('INVALID_'+name);
  }
  if(!Number.isInteger(s.leverage))throw Error('INVALID_INTEGER_SETTING');
  if(s.marginUsdt>s.paperBalance*0.1)throw Error('MARGIN_OVER_TEN_PERCENT_OF_PAPER_BALANCE');
  return s;
}
export function parseDecision(payload){
  const d=typeof payload==='string'?JSON.parse(payload):payload;
  if(!d||typeof d!=='object'||Array.isArray(d)||!['LONG','SHORT','WAIT','HOLD','CLOSE'].includes(d.action))
    throw Error('INVALID_AI_DIRECTION');
  if(typeof d.reason!=='string'||d.reason.length<6||d.reason.length>300)
    throw Error('INVALID_AI_REASON');
  if(typeof d.confidence!=='number'||!finite(d.confidence)||d.confidence<0||d.confidence>1)
    throw Error('INVALID_AI_SCORE');
  if(d.symbol!=null&&!['BTCUSDT','ETHUSDT','SOLUSDT'].includes(d.symbol))throw Error('INVALID_AI_SYMBOL');
  const out={action:d.action,reason:d.reason,confidence:round(d.confidence,3)};
  if(d.symbol)out.symbol=d.symbol;
  return out;
}
export function ema(values,period){
  if(!Array.isArray(values)||values.length<period||!values.every(v=>finite(v)&&v>0))throw Error('INVALID_CANDLES_FOR_EMA');
  let avg=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const value of values.slice(period))avg+=(value-avg)*2/(period+1);
  return avg;
}
export function makeMarket({symbol,markPrice,markTime,oneMin,fiveMin,now=Date.now()}){
  if(!['BTCUSDT','ETHUSDT','SOLUSDT'].includes(symbol)||!finite(markPrice)||markPrice<=0||
      !Number.isSafeInteger(markTime)||markTime>now+1000||now-markTime>5000)
    throw Error('STALE_MARK_PRICE');
  const parse=(candles,step,min)=>{
    if(!Array.isArray(candles)||candles.length<min)throw Error('NOT_ENOUGH_CANDLES');
    const arr=candles.map(x=>({startMs:Number(x.startMs),close:Number(x.close),
      high:Number(x.high),low:Number(x.low),volume:Number(x.volume)}));
    if(arr.some(x=>!Number.isSafeInteger(x.startMs)||x.startMs<=0||!finite(x.close)||x.close<=0||
        !finite(x.high)||!finite(x.low)||x.high<x.low||x.high<x.close||x.low>x.close||
        !finite(x.volume)||x.volume<0||x.startMs+step>now))throw Error('INVALID_CLOSED_CANDLES');
    for(let i=1;i<arr.length;i++)if(arr[i].startMs-arr[i-1].startMs!==step)throw Error('GAPPED_CANDLES');
    if(now-(arr.at(-1).startMs+step)>step+5000)throw Error('STALE_CANDLES');
    return arr;
  };
  const one=parse(oneMin,60000,30),five=parse(fiveMin,300000,30);
  const prices=one.map(x=>x.close),fivePrices=five.map(x=>x.close);
  const last=one.at(-1),previous=one.at(-4),volumeBase=one.slice(-21,-1).reduce((a,b)=>a+b.volume,0)/20;
  const trend1m=ema(prices,9)>ema(prices,21)?'UP':'DOWN';
  const trend5m=ema(fivePrices,9)>ema(fivePrices,21)?'UP':'DOWN';
  const high20=Math.max(...one.slice(-20).map(x=>x.high));
  const low20=Math.min(...one.slice(-20).map(x=>x.low));
  return {symbol,markPrice,markTime,checkedAt:now,
    trend1m,trend5m,momentum3mPct:round(100*(last.close/previous.close-1),5),
    volumeRatio:round(volumeBase>0?last.volume/volumeBase:0,3),
    pricePosition20mPct:round(high20>low20?100*(markPrice-low20)/(high20-low20):50,2),
    high20m:high20,low20m:low20,
    dataType:'BINANCE_USDM_MARK_PRICE_AND_CLOSED_FUTURES_KLINES'};
}
export function newState(settings=DEFAULT_SETTINGS){return {settings:validateSettings({...settings}),balance:settings.paperBalance,
  day:null,dayStart:settings.paperBalance,position:null,closed:[],lastDecision:null,lastError:null,lastActionAt:0,
  lastMarket:null,aiStatus:'NOT_REQUESTED',cycleCount:0};}
const dayOf=(t)=>new Date(t).toISOString().slice(0,10);
export function rollDay(state,now){
  const day=dayOf(now);
  if(state.day!==day){state.day=day;state.dayStart=state.balance;}
}
export function paperOpen(state,market,decision,now=Date.now()){
  const s=state.settings;
  if(!s.enabled||s.emergencyStop||state.position)return {ok:false,reason:'NOT_ARMED_OR_ALREADY_OPEN'};
  if(!['LONG','SHORT'].includes(decision.action))return {ok:false,reason:'AI_DID_NOT_REQUEST_ENTRY'};
  if(!['BTCUSDT','ETHUSDT','SOLUSDT'].includes(market.symbol)||decision.symbol&&market.symbol!==decision.symbol||now-market.checkedAt>5000)throw Error('STALE_OR_MISMATCHED_MARKET');
  // A numerical self-confidence from an LLM is not a calibrated win probability.
  const side=decision.action==='LONG'?'LONG':'SHORT',sign=side==='LONG'?1:-1;
  const entry=round(market.markPrice*(1+sign*0.0003),6); // pessimistic paper slippage
  const qty=round(s.marginUsdt*s.leverage/entry,8),openFee=round(qty*entry*0.0005,6);
  if(qty<=0||s.marginUsdt+openFee>state.balance)return {ok:false,reason:'INSUFFICIENT_PAPER_FUNDS'};
  // Entry is never assigned a fixed stop/take-profit trigger. AI decides when to close.
  state.balance=round(state.balance-openFee,6);
  state.position={id:'paper-'+now,symbol:market.symbol,side,qty,marginUsdt:s.marginUsdt,leverage:s.leverage,
    entry,openedAt:now,openFee,source:'DEEPSEEK_PAPER_ONLY',reason:decision.reason};
  state.lastActionAt=now;
  return {ok:true,position:state.position};
}
/** Close a simulated position only on a completed AI CLOSE decision or an explicit emergency stop.
 * WebSocket price ticks NEVER trigger automatic take-profit/stop-loss exits.
 */
export function paperMark(state,market,now=Date.now(),closeReason=null,aiReason=null){
  const p=state.position;
  if(!p)return {ok:false,reason:'NO_POSITION'};
  if(market.symbol!==p.symbol||now-market.checkedAt>10000)throw Error('MARKET_NOT_FRESH');
  if(closeReason!=='AI_CLOSE'&&closeReason!=='EMERGENCY_STOP')return {ok:false,reason:'AI_HOLD'};
  const sign=p.side==='LONG'?1:-1;
  const close=round(market.markPrice*(1-sign*0.0003),6); // simulation slippage only
  const gross=round(sign*(close-p.entry)*p.qty,6),fee=round(close*p.qty*0.0005,6);
  const net=round(gross-p.openFee-fee,6);
  state.balance=round(state.balance+gross-fee,6);
  // Legacy stop/takeProfit values from old paper positions are stripped from new history.
  const {stop,takeProfit,...cleanPosition}=p;
  const trade={...cleanPosition,close,closedAt:now,exitReason:closeReason,aiExitReason:closeReason==='AI_CLOSE'?String(aiReason||'AI requested close').slice(0,300):null,
    grossPnl:gross,netPnl:net,closeFee:fee,paper:true};
  state.closed.unshift(trade);state.closed=state.closed.slice(0,500);
  state.position=null;state.lastActionAt=now;
  return {ok:true,trade};
}
