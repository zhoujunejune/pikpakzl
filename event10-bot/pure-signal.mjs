// Deterministic BTC 10-minute directional rule. No LLM, no order execution.
// Candle indicators use CONFIRMED CLOSED spot BTCUSDT candles at/before the
// reference tick; depth/trades are explicitly USD-M public-market context.
export const RULE_VERSION="EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030";
const n=v=>Number(v),valid=v=>typeof v==="number"&&Number.isFinite(v);
const fmt=v=>valid(v)?v.toFixed(3):"缺失";
const finitePositive=v=>valid(v)&&v>0;
export function ema(values,period){
  if(!Array.isArray(values)||values.length<period||values.some(v=>!valid(v)||v<=0))throw Error("EMA_INPUT_INVALID");
  let v=values.slice(0,period).reduce((x,y)=>x+y,0)/period;
  const k=2/(period+1);
  for(const x of values.slice(period))v+=k*(x-v);
  return v;
}
export function rsiWilder(closes,period=14){
  if(!Array.isArray(closes)||closes.length<period+1)throw Error("RSI_HISTORY_INSUFFICIENT");
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){
    const d=closes[i]-closes[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);
  }
  gain/=period;loss/=period;
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gain=(gain*(period-1)+Math.max(0,d))/period;
    loss=(loss*(period-1)+Math.max(0,-d))/period;
  }
  return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
function closedBars(feed,interval,ms,asOf){
  const block=feed?.candles?.[interval];
  const raw=Array.isArray(block)?block:(block?.rows||block?.items||block?.candles);
  if(!Array.isArray(raw))throw Error("MISSING_"+interval+"_CANDLES");
  const bars=raw.filter(row=>{
    const t=n(row.startMs??row.openTime);
    return row.closed===true&&Number.isSafeInteger(t)&&t>0&&t+ms<=asOf&&
      ["open","high","low","close","volume"].every(k=>Number.isFinite(n(row[k])))&&
      n(row.open)>0&&n(row.close)>0&&n(row.high)>=n(row.low)&&
      n(row.high)>=Math.max(n(row.open),n(row.close))&&
      n(row.low)<=Math.min(n(row.open),n(row.close))&&n(row.volume)>=0;
  }).map(row=>({t:n(row.startMs??row.openTime),o:n(row.open),c:n(row.close),
    h:n(row.high),l:n(row.low),v:n(row.volume)})).sort((a,b)=>a.t-b.t);
  if(bars.length<36)throw Error("INSUFFICIENT_"+interval+"_CLOSED_BARS");
  const last=bars.slice(-100);
  for(let i=1;i<last.length;i++){
    if(last[i].t-last[i-1].t!==ms)throw Error("NONCONTIGUOUS_"+interval+"_CANDLES");
  }
  if(asOf-(last.at(-1).t+ms)>ms+10000)throw Error("STALE_"+interval+"_CANDLES");
  return last;
}
// Orderbook quantities (BTC) in 5 levels, rather than 20-level notional.
export function parseTop5Depth(raw,receivedAt){
  if(!Array.isArray(raw?.bids)||!Array.isArray(raw?.asks)||raw.bids.length<5||raw.asks.length<5)
    throw Error("MISSING_TOP5_ORDERBOOK");
  const levels=(rows)=>rows.slice(0,5).map(v=>[n(v?.[0]),n(v?.[1])]);
  const b=levels(raw.bids),a=levels(raw.asks);
  if([...b,...a].some(([p,q])=>!finitePositive(p)||!valid(q)||q<0)||b[0][0]>=a[0][0])
    throw Error("BAD_TOP5_ORDERBOOK");
  for(let i=1;i<5;i++)if(b[i][0]>=b[i-1][0]||a[i][0]<=a[i-1][0])
    throw Error("UNSORTED_TOP5_ORDERBOOK");
  const exchangeAt=raw.T??raw.E;
  const observedAt=exchangeAt===undefined?receivedAt:n(exchangeAt);
  if(!Number.isSafeInteger(observedAt)||observedAt>receivedAt+1000||receivedAt-observedAt>5000)
    throw Error("STALE_TOP5_ORDERBOOK");
  const bidQty=b.reduce((s,x)=>s+x[1],0);
  const askQty=a.reduce((s,x)=>s+x[1],0);
  if(bidQty<=0||askQty<=0)throw Error("ZERO_DEPTH");
  return {observedAt,receivedAt,bidTop5QtyBtc:bidQty,askTop5QtyBtc:askQty,
    source:"BINANCE_USDM_BTCUSDT_ORDERBOOK_TOP5",
    sampleClock:exchangeAt===undefined?"RECEIPT_AT":"EXCHANGE_AT"};
}
export function parseAggressiveStreak(raw,receivedAt){
  if(!Array.isArray(raw))throw Error("AGGTRADES_MISSING");
  const rows=raw.filter(x=>Number.isSafeInteger(x?.T)&&x.T<=receivedAt+1000&&
    receivedAt-x.T<=10000&&finitePositive(n(x.p))&&finitePositive(n(x.q))&&
    typeof x.m==="boolean").sort((a,b)=>a.T-b.T||(a.a??0)-(b.a??0));
  if(rows.length<3)throw Error("INSUFFICIENT_RECENT_AGGTRADES");
  const last=rows.at(-1);
  let buyCount=0;
  for(let i=rows.length-1;i>=0;i--){
    if(rows[i].m!==false||last.T-rows[i].T>4000)break;
    buyCount++;
  }
  return {lastTradeAt:last.T,consecutiveTakerBuys:buyCount,
    source:"BINANCE_USDM_BTCUSDT_AGGTRADES_10S",
    observedAt:last.T};
}
// Workbook: BTC_10分钟事件合约_信号策略.xlsx (Higher/Lower, 2026-10-30).
// Observe the late 7.0–8.5-minute window of a UTC-aligned INDEX REFERENCE
// cycle. IMPORTANT: this is NOT a Binance Event Contract opened at that cycle's
// start. Event-contract expiry is relative to that contract's *actual* open,
// and the official order strike cannot be read through the public market API.
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
const pct=(x)=>Math.round(x*1e6)/1e4;
const between=(x,a,b)=>x>=a&&x<b;

export function parseBinanceIndexQuote(raw,receivedAt){
  const price=Number(raw?.indexPrice),at=Number(raw?.time);
  if(raw?.symbol!=="BTCUSDT"||!finitePositive(price)||
     !Number.isSafeInteger(at)||at>receivedAt+1000||receivedAt-at>5000)
    throw Error("INDEX_QUOTE_STALE_OR_INVALID");
  return {price,observedAt:at,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"};
}
export function parseBinanceIndexKlines(raw,receivedAt){
  if(!Array.isArray(raw))throw Error("INDEX_KLINES_INVALID");
  const rows=raw.filter(x=>Array.isArray(x)&&x.length>=5&&
    Number.isSafeInteger(Number(x[0]))&&
    [1,2,3,4].every(i=>finitePositive(Number(x[i]))))
    .map(x=>({at:Number(x[0]),open:Number(x[1]),high:Number(x[2]),
      low:Number(x[3]),close:Number(x[4])}))
    .sort((a,b)=>a.at-b.at);
  if(rows.length<10||rows.some(x=>x.high<Math.max(x.open,x.close)||
    x.low>Math.min(x.open,x.close)||x.low>x.high))
      throw Error("INDEX_KLINES_MISSING_OR_BAD");
  for(let i=1;i<rows.length;i++)
    if(rows[i].at-rows[i-1].at!==60000)throw Error("INDEX_KLINES_GAP");
  return {rows,observedAt:receivedAt,source:"BINANCE_USDM_INDEX_1M"};
}
export function evaluatePureSignal({
  reference,indexSnapshot=null,indexKlines=null,orderBook=null,cycleMs=600000
}={}){
  const at=reference?.observedAt;
  if(!Number.isSafeInteger(at)||!indexSnapshot||
    !finitePositive(indexSnapshot.price)||
    !Number.isSafeInteger(indexSnapshot.observedAt)||
    indexSnapshot.observedAt>at||at-indexSnapshot.observedAt>5000)
      throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
  const cycleStart=at-Math.floor(at%cycleMs),elapsed=at-cycleStart;
  const inWindow=between(elapsed,420000,510000);
  const opening=indexKlines?.rows?.find(x=>x.at===cycleStart);
  const currentBar=indexKlines?.rows?.find(x=>x.at===Math.floor(at/60000)*60000);
  const rows=indexKlines?.rows||[];
  const hasIndex=!!opening&&!!currentBar&&
    rows.some(x=>x.at===currentBar.at-60000)&&
    Number.isSafeInteger(indexKlines.observedAt)&&
    indexKlines.observedAt<=at&&at-indexKlines.observedAt<=5000;
  const price=indexSnapshot.price,base=hasIndex?opening.open:null;
  const lead=hasIndex?(price-base):null;
  const absLead=hasIndex?Math.abs(lead):null;
  const recent=hasIndex?rows.filter(x=>x.at+60000>at-60000&&x.at<=at):[];
  // 1m bars overlap the last 60s. Including their full OHLC makes
  // adverse-excursion checks conservative rather than inventing tick history.
  const high=recent.length?Math.max(price,...recent.map(x=>x.high)):null;
  const low=recent.length?Math.min(price,...recent.map(x=>x.low)):null;
  const pullback=hasIndex?Math.max(0,high-price):null;
  const rebound=hasIndex?Math.max(0,price-low):null;
  const bookFresh=!!orderBook&&Number.isSafeInteger(orderBook.observedAt)&&
    orderBook.observedAt<=at&&at-orderBook.observedAt<=5000;
  const bid=bookFresh?Number(orderBook.bidTop5QtyBtc):null;
  const ask=bookFresh?Number(orderBook.askTop5QtyBtc):null;
  const hasBook=finitePositive(bid)&&finitePositive(ask);
  const up={
    timeWindow:inWindow,
    lead:hasIndex&&lead/base>=0.001,
    retrace:hasIndex&&lead>0&&pullback<=lead/2,
    minuteCandle:hasIndex&&currentBar.close>=currentBar.open,
    orderBook:hasBook&&bid>ask
  };
  const down={
    timeWindow:inWindow,
    lead:hasIndex&&-lead/base>=0.001,
    retrace:hasIndex&&lead<0&&rebound<=-lead/2,
    minuteCandle:hasIndex&&currentBar.close<=currentBar.open,
    orderBook:hasBook&&ask>bid
  };
  const all=x=>Object.values(x).every(v=>v===true);
  const direction=all(up)?"UP":all(down)?"DOWN":null;
  const missing=x=>Object.entries(x).filter(([,ok])=>!ok).map(([key])=>key);
  const reason=direction?
    (direction==="UP"?"看涨 Higher":"看跌 Lower")+
    "：第7–8.5分钟、指数领先≥0.10%、60秒不利回撤≤领先一半、1分钟K线及盘口全部通过。"+
    "本信号仅为UTC指数参考周期模拟，非币安实际事件合约到期判断。":
    !inWindow?"无信号：不在本周期第7–8.5分钟的观察窗口。":
    !hasIndex?"无信号：缺少同源指数参考开盘价或完整近一分钟K线。":
    "无信号：看涨未通过 "+missing(up).join("、")+
       "；看跌未通过 "+missing(down).join("、")+"。";
  return {
    strategyVersion:LATE_WINDOW_RULE_VERSION,direction,
    signal:direction??"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",
    reason,confidence:null,cycleStartAt:cycleStart,
    firstThreeMinutes:false,lateWindow:inWindow,
    snapshotAt:at,conditions:direction==="UP"?up:direction==="DOWN"?down:null,
    upChecks:up,downChecks:down,
    referenceBasis:"UTC_10M_INDEX_OPEN_PROXY_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{
      cycleOpenIndexPrice:base,liveIndexPrice:price,
      signedLeadPct:hasIndex?pct(lead/base):null,
      leadingAmount:absLead,pullbackPrice:pullback,reboundPrice:rebound,
      retraceBound:hasIndex?absLead/2:null,
      recentIndexBars:recent.length, indexMinuteOpen:currentBar?.open??null,
      indexMinuteClose:currentBar?.close??null,
      bidTop5QtyBtc:hasBook?bid:null,askTop5QtyBtc:hasBook?ask:null,
      referenceSource:"BINANCE_USDM_INDEX_UTC_CYCLE_PROXY",
      bookSource:"BINANCE_USDM_BTCUSDT_ORDERBOOK_TOP5",
      referenceIsActualEventContractStrike:false
    }
  };
}

// Only public read-only Binance USD-M Index Price/Klines and top-5 depth.
// Do not substitute spot/mark prices when index or reference bar is missing.
// HTTP 451, staleness, or missing bar => no direction; never fake an official strike.
export async function collectRuleFeatures({fetcher=fetch,now=Date.now,timeoutMs=3000}={}){
 const endpoints=[
  ["indexQuote","https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",parseBinanceIndexQuote],
  ["indexKlines","https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=BTCUSDT&interval=1m&limit=12",parseBinanceIndexKlines],
  ["orderBook","https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5",parseTop5Depth]
 ];
 const results=await Promise.all(endpoints.map(async([name,url,parser])=>{
   try{
     const response=await fetcher(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
     if(!response.ok)throw Error("HTTP_"+response.status);
     const data=await response.json(),receivedAt=now();
     return {name,ok:true,value:parser(data,receivedAt),receivedAt};
   }catch(e){
     const raw=String(e?.message||e).slice(0,100);
     const error=/HTTP_451/.test(raw)?"REGION_RESTRICTED_451":
       /HTTP_418/.test(raw)?"IP_BLOCK_418":
       /HTTP_\d+/.test(raw)?raw:
       /Abort|timeout/i.test(raw)?"TIMEOUT":raw;
     return {name,ok:false,error};
   }
 }));
 const features={},availability={};
 for(const row of results){
   availability[row.name]=row.ok?{available:true,receivedAt:row.receivedAt}:
     {available:false,error:row.error};
   if(row.ok)features[row.name]={...row.value,receivedAt:row.receivedAt};
 }
 return {source:"BINANCE_USDM_PUBLIC_INDEX_AND_DEPTH_UTC_REFERENCE_NOT_EVENT_ORDER",
   available:results.filter(x=>x.ok).length,total:results.length,
   features,availability,caveats:[
     "固定UTC十分钟周期并非币安事件合约实际开仓后十分钟；本策略不读取真实合约Strike或到期时间。",
     "指数报价及1分钟指数K线来自币安USD-M公开接口；前5档盘口来自币安USD-M永续合约。",
     "最近60秒回撤采用覆盖该区间的1分钟K线最高/最低点作保守上界；不是逐秒逐笔指数轨迹。",
     "仅生成参考信号，不提交真实订单或声称官方事件合约命中率。"
   ]};
}
