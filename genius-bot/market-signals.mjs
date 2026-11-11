// Bounded one-second trade buckets for continuous public market snapshots.
// Pure helpers: no API keys, no orders, no trading actions.
const finite=Number.isFinite;
const round=(x,n=5)=>Number(x.toFixed(n));
export function ingestTrade(buckets,event,now=Date.now()){
  if(!Array.isArray(buckets)||!event||!finite(event.price)||event.price<=0||
    !finite(event.qty)||event.qty<=0||!finite(event.time)||Math.abs(now-event.time)>7000)return false;
  const sec=Math.floor(event.time/1000),notional=event.price*event.qty;
  if(!finite(notional)||notional<=0)return false;
  const last=buckets.at(-1);
  if(last&&sec<last.sec)return false;
  if(last&&last.sec===sec){
    last.lastPrice=event.price;last.high=Math.max(last.high,event.price);
    last.low=Math.min(last.low,event.price);last.notional+=notional;last.count++;
    if(event.buyerMaker)last.sellNotional+=notional;
    else last.buyNotional+=notional;
  }else{
    buckets.push({sec,firstPrice:event.price,lastPrice:event.price,high:event.price,
      low:event.price,notional,count:1,buyNotional:event.buyerMaker?0:notional,
      sellNotional:event.buyerMaker?notional:0});
  }
  const cutoff=Math.floor(now/1000)-90;
  while(buckets.length&&(buckets[0].sec<cutoff||buckets.length>95))buckets.shift();
  return true;
}
export function summarizeTrades(buckets,now=Date.now()){
  const result={};
  for(const seconds of [10,30,60]){
    const startSec=Math.floor(now/1000)-seconds;
    const items=(Array.isArray(buckets)?buckets:[]).filter(b=>b.sec>=startSec&&b.sec<=Math.floor(now/1000));
    if(!items.length){result['w'+seconds]=null;continue;}
    const first=items[0],last=items.at(-1);
    const total=items.reduce((s,x)=>s+x.notional,0),buy=items.reduce((s,x)=>s+x.buyNotional,0);
    const sell=items.reduce((s,x)=>s+x.sellNotional,0),count=items.reduce((s,x)=>s+x.count,0);
    const high=Math.max(...items.map(x=>x.high)),low=Math.min(...items.map(x=>x.low));
    result['w'+seconds]={changePct:round(100*(last.lastPrice/first.firstPrice-1)),
      notionalUsdt:round(total,2),buyRatio:round(total>0?buy/total:0.5,3),
      buyNotionalUsdt:round(buy,2),sellNotionalUsdt:round(sell,2),
      high,low,tradeEvents:count,ageMs:Math.max(0,now-last.sec*1000)};
  }
  return result;
}
export function bookSummary(book,now=Date.now()){
  if(!book||!finite(book.at)||now-book.at>4000||now<book.at-1000)return null;
  if(![book.bid,book.ask,book.bidQty,book.askQty].every(x=>finite(x)&&x>0)||book.ask<book.bid)return null;
  const total=book.bidQty+book.askQty;
  return {bid:book.bid,ask:book.ask,spreadBps:round(10000*(book.ask-book.bid)/((book.ask+book.bid)/2),3),
    bestBidQty:book.bidQty,bestAskQty:book.askQty,bidQtyRatio:round(book.bidQty/total,3),ageMs:now-book.at};
}
export function shouldAnalyze({now=Date.now(),lastAt=0,holding=false,change10sPct=0,enabled=false}){
  if(!enabled)return false;
  if(!lastAt)return true;
  const elapsed=now-lastAt;
  if(elapsed<0)return false;
  const urgent=finite(change10sPct)&&Math.abs(change10sPct)>=(holding?.12:.25);
  return elapsed>=(holding?16000:25000)||(urgent&&elapsed>=(holding?9000:12000));
}


/** Re-fetch closed candles shortly after the next bar becomes available.
 * Binance's latest incomplete bar must never be promoted to "closed".
 * Throttle the boundary retries so a temporarily delayed exchange does not
 * generate unbounded REST requests. */
export function shouldRefreshClosedCandles(cached,now=Date.now()){
  if(!cached||!Number.isFinite(cached.savedAt))return true;
  const cacheAge=now-cached.savedAt;
  if(cacheAge<0||cacheAge>=15000)return true;
  if(cacheAge<3500)return false;
  for(const [key,periodMs] of [['one',60000],['five',300000]]){
    const last=cached[key]?.at(-1);
    if(!last||!Number.isSafeInteger(last.startMs))return true;
    if(now-(last.startMs+periodMs)>periodMs+1500)return true;
  }
  return false;
}

/** Opportunistic second view only after persistent all-WAIT output. This
 * never creates an order by itself; a separate AI must confirm the direction. */
export function shouldScoutOpportunities({enabled=true,heldCount=0,decisions,waitStreak=0}){
  return enabled&&heldCount===0&&Array.isArray(decisions)&&decisions.length>0&&
    decisions.every(d=>d.action==='WAIT')&&Number.isInteger(waitStreak)&&
    waitStreak>0&&waitStreak%3===0;
}
