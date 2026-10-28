// Deterministic BTC 10-minute directional rule. No LLM, no order execution.
// Candle indicators use CONFIRMED CLOSED spot BTCUSDT candles at/before the
// reference tick; depth/trades are explicitly USD-M public-market context.
export const RULE_VERSION="EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029";
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
export function evaluatePureSignal({feed,reference,orderBook=null,aggressiveFlow=null,cycleMs=600000}){
  const at=reference?.observedAt,price=reference?.price;
  if(!Number.isSafeInteger(at)||!finitePositive(price)||feed?.symbol!=="BTCUSDT"||
    feed?.ok!==true||feed?.readOnly!==true)throw Error("UNVERIFIED_REFERENCE");
  const one=closedBars(feed,"1m",60000,at);
  const five=closedBars(feed,"5m",300000,at);
  const oneCloses=one.map(b=>b.c),fiveCloses=five.map(b=>b.c);
  const ema1m9=ema(oneCloses,9),ema1m21=ema(oneCloses,21);
  const ema5m9=ema(fiveCloses,9),ema5m21=ema(fiveCloses,21);
  const previous9=ema(oneCloses.slice(0,-1),9),previous21=ema(oneCloses.slice(0,-1),21);
  const crossUp=previous9<=previous21&&ema1m9>ema1m21;
  const crossDown=previous9>=previous21&&ema1m9<ema1m21;
  const volumeAvg20=one.slice(-21,-1).reduce((sum,x)=>sum+x.v,0)/20;
  if(!finitePositive(volumeAvg20))throw Error("ZERO_VOLUME_BASELINE");
  const ratio=one.at(-1).v/volumeAvg20;
  const rsi=rsiWilder(oneCloses);
  const positive5=five.slice(-2).every(x=>x.c>x.o);
  const negative5=five.slice(-2).every(x=>x.c<x.o);
  const last1=one.at(-1);
  // A futures depth snapshot must be sampled BEFORE (or at) the reference tick
  // and be fresh; never treat a post-reference orderbook as pre-signal evidence.
  const bookFresh=orderBook&&valid(orderBook.observedAt)&&
    orderBook.observedAt<=at&&at-orderBook.observedAt<=5000;
  const bid=bookFresh?n(orderBook.bidTop5QtyBtc):null;
  const ask=bookFresh?n(orderBook.askTop5QtyBtc):null;
  const hasBook=finitePositive(bid)&&finitePositive(ask);
  const buyStreak=aggressiveFlow&&valid(aggressiveFlow.lastTradeAt)&&
    aggressiveFlow.lastTradeAt<=at&&at-aggressiveFlow.lastTradeAt<=4000&&
    Number.isSafeInteger(aggressiveFlow.consecutiveTakerBuys)&&
    aggressiveFlow.consecutiveTakerBuys>=3;
  const up={
    trend5m:ema5m9>ema5m21&&positive5,
    momentum1m:(ema1m9>ema1m21||crossUp)&&last1.c>last1.o&&price>ema1m9,
    volume:ratio>=1.3,
    orderflow:(hasBook&&bid>ask)||!!buyStreak,
    rsi:rsi>=45&&rsi<=70
  };
  const down={
    trend5m:ema5m9<ema5m21&&negative5,
    momentum1m:(ema1m9<ema1m21||crossDown)&&last1.c<last1.o&&price<ema1m9,
    volume:ratio>=1.3,
    orderflow:hasBook&&ask>bid,
    rsi:rsi>=30&&rsi<=55
  };
  const all=x=>Object.values(x).every(v=>v===true);
  const direction=all(up)?"UP":all(down)?"DOWN":null;
  const conditions=direction==="UP"?up:direction==="DOWN"?down:null;
  const missing=x=>Object.entries(x).filter(([,ok])=>!ok).map(([name])=>name);
  const elapsed=((at%cycleMs)+cycleMs)%cycleMs;
  const label=direction==="UP"?"看涨 Higher":direction==="DOWN"?"看跌 Lower":"无信号";
  const reason=direction?label+"：5分钟趋势、1分钟动量、放量、盘口/主动成交、RSI 全部通过。":
    "无信号：有条件未满足；看涨未通过 "+missing(up).join("、")+
    "；看跌未通过 "+missing(down).join("、")+"。";
  return {
    strategyVersion:RULE_VERSION,direction,signal:direction??"NO_SIGNAL",
    status:direction?"PREDICTED":"NO_SIGNAL",reason,confidence:null,
    cycleStartAt:at-elapsed,firstThreeMinutes:elapsed<180000,
    snapshotAt:at,conditions,upChecks:up,downChecks:down,
    evidence:{
      ema5m9,ema5m21,ema1m9,ema1m21,previous1mEma9:previous9,
      previous1mEma21:previous21,crossUp,crossDown,
      lastTwo5m:five.slice(-2).map(b=>({open:b.o,close:b.c,at:b.t})),
      lastClosed1m:{open:last1.o,close:last1.c,volume:last1.v,at:last1.t},
      priceAtSignal:price,volumeAvg20,volumeRatio:ratio,
      rsi14:rsi,bidTop5QtyBtc:hasBook?bid:null,askTop5QtyBtc:hasBook?ask:null,
      consecutiveTakerBuys:buyStreak?aggressiveFlow.consecutiveTakerBuys:0,
      bookEvidenceAvailable:!!hasBook,aggressiveBuyConfirmed:!!buyStreak,
      referenceSource:"BINANCE_BTC_PUBLIC_SPOT_PROXY",
      bookSource:"BINANCE_USDM_BTCUSDT_ORDERBOOK_TOP5"
    }
  };
}
