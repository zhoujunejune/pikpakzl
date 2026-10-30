// Deterministic BTC 10-minute directional rule. No LLM, no order execution.
// Candle indicators use CONFIRMED CLOSED spot BTCUSDT candles at/before the
// reference tick; depth/trades are explicitly USD-M public-market context.
export const RULE_VERSION="EVENT10_HIGH_SELECTIVITY_6GATES_V1_20261031";
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
  if(receivedAt-last.T>5000)throw Error("STALE_AGGTRADES");
  const count=side=>{
    let hits=0;
    for(let i=rows.length-1;i>=0;i--){
      if(rows[i].m!==side||last.T-rows[i].T>4000)break;
      hits++;
    }
    return hits;
  };
  return {lastTradeAt:last.T,observedAt:last.T,
    consecutiveTakerBuys:count(false),consecutiveTakerSells:count(true),
    source:"BINANCE_USDM_BTCUSDT_AGGTRADES_10S"};
}
// Workbook: BTC_10分钟事件合约_高选择性信号策略.xlsx.
// Six mandatory gates: confirmed 5m trend, 1m EMA momentum, price/3 candles,
// >=1.5x last completed minute volume, top-5 depth OR aggressive streak,
// and Wilder RSI14. Full T+600 index proxy outcome; no real order execution.
export const LATE_WINDOW_RULE_VERSION=RULE_VERSION;
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
export function evaluatePureSignal({feed,reference,indexSnapshot=null,
  orderBook=null,aggressiveFlow=null,cycleMs=600000}={}){
  const at=reference?.observedAt;
  if(!Number.isSafeInteger(at)||!indexSnapshot||
    !finitePositive(indexSnapshot.price)||
    !Number.isSafeInteger(indexSnapshot.observedAt)||
    indexSnapshot.observedAt>at||at-indexSnapshot.observedAt>5000)
      throw Error("REALTIME_BINANCE_INDEX_REQUIRED");
  if(feed?.ok!==true||feed?.readOnly!==true||feed?.symbol!=="BTCUSDT"||
      feed?.latest?.marketFeedConnected===false)throw Error("UNVERIFIED_BTCUSDT_SPOT_FEED");
  const spot=n(feed?.latest?.lastPrice),spotAt=n(feed?.latest?.eventMs);
  if(!finitePositive(spot)||!Number.isSafeInteger(spotAt)||
      spotAt>at||at-spotAt>6000)throw Error("STALE_BTCUSDT_SPOT_REFERENCE");
  const one=closedBars(feed,"1m",60000,at);
  const five=closedBars(feed,"5m",300000,at);
  const c1=one.map(b=>b.c),c5=five.map(b=>b.c);
  const ema1m9=ema(c1,9),ema1m21=ema(c1,21);
  const ema5m9=ema(c5,9),ema5m21=ema(c5,21);
  const diff=(series)=>ema(series,9)-ema(series,21);
  const prior1=diff(c1.slice(0,-1)),prior2=diff(c1.slice(0,-2));
  const crossUp=(prior1<=0&&ema1m9>ema1m21)||(prior2<=0&&prior1>0&&ema1m9>ema1m21);
  const crossDown=(prior1>=0&&ema1m9<ema1m21)||(prior2>=0&&prior1<0&&ema1m9<ema1m21);
  const stayUp=prior1>0&&prior2>0&&ema1m9>ema1m21;
  const stayDown=prior1<0&&prior2<0&&ema1m9<ema1m21;
  const previous20=one.slice(-21,-1),latest1m=one.at(-1),latest5m=five.at(-1);
  const avgVolume=previous20.reduce((total,b)=>total+b.v,0)/20;
  const volumeRatio=avgVolume>0?latest1m.v/avgVolume:null;
  const volumeGate=Number.isFinite(volumeRatio)&&volumeRatio>=1.5;
  const recent3=one.slice(-3),green=recent3.filter(b=>b.c>b.o).length;
  const red=recent3.filter(b=>b.c<b.o).length;
  const rsi14=rsiWilder(c1,14);
  const freshBook=!!orderBook&&Number.isSafeInteger(orderBook.observedAt)&&
    orderBook.observedAt<=at&&at-orderBook.observedAt<=5000;
  const bid=freshBook?n(orderBook.bidTop5QtyBtc):null;
  const ask=freshBook?n(orderBook.askTop5QtyBtc):null;
  const bookValid=finitePositive(bid)&&finitePositive(ask);
  const freshAgg=!!aggressiveFlow&&
    Number.isSafeInteger(aggressiveFlow.lastTradeAt)&&
    aggressiveFlow.lastTradeAt<=at&&at-aggressiveFlow.lastTradeAt<=5000;
  const activeBuy=freshAgg&&aggressiveFlow.consecutiveTakerBuys>=3;
  const activeSell=freshAgg&&aggressiveFlow.consecutiveTakerSells>=3;
  const up={
    trend5m:ema5m9>ema5m21&&latest5m.c>latest5m.o,
    momentum1m:ema1m9>ema1m21&&(crossUp||stayUp),
    pricePosition:spot>ema1m9&&green>=2,
    volume:volumeGate,
    orderflow:(bookValid&&bid>ask)||activeBuy,
    rsi:rsi14>=50&&rsi14<=75
  };
  const down={
    trend5m:ema5m9<ema5m21&&latest5m.c<latest5m.o,
    momentum1m:ema1m9<ema1m21&&(crossDown||stayDown),
    pricePosition:spot<ema1m9&&red>=2,
    volume:volumeGate,
    orderflow:(bookValid&&ask>bid)||activeSell,
    rsi:rsi14>=25&&rsi14<=50
  };
  const all=x=>Object.values(x).every(v=>v===true);
  const direction=all(up)?"UP":all(down)?"DOWN":null;
  const failed=x=>Object.entries(x).filter(([,ok])=>!ok).map(([k])=>k).join("、");
  const reason=direction?
    (direction==="UP"?"看涨 Higher":"看跌 Lower")+
    "：5分钟趋势、1分钟动量、价格位置、1分钟成交量≥20均量1.5倍、盘口/主动成交、RSI共6项全部满足；"+
    "锁定本次信号的指数参考价，600秒后用相同指数代理核对。":
    "WAIT：看涨未通过 "+failed(up)+"；看跌未通过 "+failed(down)+"。六项必须全部满足。";
  return {strategyVersion:RULE_VERSION,direction,
    signal:direction??"NO_SIGNAL",status:direction?"PREDICTED":"NO_SIGNAL",
    reason,confidence:null,snapshotAt:at,
    cycleStartAt:at-Math.floor(at%cycleMs),firstThreeMinutes:false,lateWindow:false,
    conditions:direction==="UP"?up:direction==="DOWN"?down:null,
    upChecks:up,downChecks:down,
    referenceBasis:"SIGNAL_CAPTURED_INDEX_PRICE_TPLUS600_NOT_EVENT_CONTRACT_STRIKE",
    evidence:{
      liveIndexPrice:indexSnapshot.price,spotPrice:spot,
      ema1m9,ema1m21,ema5m9,ema5m21,
      last5mOpen:latest5m.o,last5mClose:latest5m.c,
      last1mOpen:latest1m.o,last1mClose:latest1m.c,
      greenLast3:green,redLast3:red,
      volumeLatestClosed1m:latest1m.v,volumePrior20Mean:avgVolume,
      volumeRatio,rsi14,
      crossUp,crossDown,stayUp,stayDown,
      bidTop5QtyBtc:bookValid?bid:null,askTop5QtyBtc:bookValid?ask:null,
      aggressiveBuyConfirmed:activeBuy,aggressiveSellConfirmed:activeSell,
      lastClosed1mAt:latest1m.t,lastClosed5mAt:latest5m.t,
      referenceSource:"BINANCE_USDM_REALTIME_INDEX_TPLUS600_PROXY",
      candleSource:"VERIFIED_CLOSED_BTCUSDT_SPOT_1M_5M",
      bookSource:"BINANCE_USDM_BTCUSDT_TOP5",
      referenceIsActualEventContractStrike:false
    }
  };
}

// Read-only index quote, orderbook and aggregate trades; index klines retained for diagnostics.
// Closed spot BTCUSDT candles come from the existing verified read-only feed.
// HTTP 451, stale or incomplete sources must never create a direction.
export async function collectRuleFeatures({fetcher=fetch,now=Date.now,timeoutMs=3000}={}){
 const endpoints=[
  ["indexQuote","https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",parseBinanceIndexQuote],
  ["indexKlines","https://fapi.binance.com/fapi/v1/indexPriceKlines?pair=BTCUSDT&interval=1m&limit=12",parseBinanceIndexKlines],
  ["orderBook","https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5",parseTop5Depth],
  ["aggressiveFlow","https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=100",parseAggressiveStreak]
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
 return {source:"BINANCE_PUBLIC_INDEX_SPOT_CANDLES_DEPTH_AGGTRADES_PROXY_NOT_OFFICIAL",
   available:results.filter(x=>x.ok).length,total:results.length,
   features,availability,caveats:[
     "六项高选择性过滤仅使用已收盘1m/5m现货K线；成交量使用最近一根已收盘1m对比此前20根均量。",
     "前5档盘口或连续3笔主动成交来自币安USD-M永续合约，与现货K线不是同一市场。",
     "方向信号和到期结果以捕获到的币安USD-M指数代理价作为参考，不等于币安事件合约实际开仓Strike和官方结算。",
     "只生成参考信号，不调用任何真实订单接口；公开行情无法保证胜率。"
   ]};
}
