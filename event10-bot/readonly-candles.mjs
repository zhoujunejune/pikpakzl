// Independent read-only BTC spot candle source. No 5m Guardian process, key, or trading API.
const BASES=["https://api.binance.com","https://data-api.binance.vision"];
const LENGTHS={"1m":245,"5m":83,"15m":83,"30m":83};
export function checkedKlines(payload,interval,asOf){
 const ms={"1m":60000,"5m":300000,"15m":900000,"30m":1800000}[interval]||null;
 if(!ms||!Array.isArray(payload))throw Error("INVALID_CANDLE_SOURCE");
 const values=payload.filter(row=>Array.isArray(row)&&row.length>=7).map(row=>{
  const [start,open,high,low,close,volume,closeTime]=row;
  const n=[+open,+high,+low,+close,+volume];
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(closeTime)||
     start+ms-1!==closeTime||n.some(v=>!Number.isFinite(v))||
     Math.min(n[0],n[1],n[2],n[3])<=0||n[4]<0||
     n[1]<Math.max(n[0],n[3])||n[2]>Math.min(n[0],n[3]))
    throw Error("BINANCE_CANDLE_INVALID");
  return {startMs:start,closed:closeTime<asOf,open:n[0],high:n[1],low:n[2],close:n[3],volume:n[4]};
 }).filter(x=>x.closed).sort((a,b)=>a.startMs-b.startMs);
 const need=interval==="1m"?220:60;
 if(values.length<need)throw Error("BINANCE_CANDLES_INSUFFICIENT_"+interval);
 return values.slice(-need);
}
export async function collectIndependentSpotCandles({fetcher=fetch,now=Date.now,timeoutMs=2400}={}){
 const requests=BASES.map(async(base)=>{
   const receivedAt=now();
   const values=await Promise.all(Object.entries(LENGTHS).map(async([interval,limit])=>{
     const response=await fetcher(base+"/api/v3/klines?symbol=BTCUSDT&interval="+interval+"&limit="+limit,
       {headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
     if(!response.ok)throw Error("PUBLIC_CANDLE_HTTP_"+response.status);
     return [interval,checkedKlines(await response.json(),interval,now())];
   }));
   const candles=Object.fromEntries(values);
   return {ok:true,readOnly:true,symbol:"BTCUSDT",
     marketSource:"BINANCE_SPOT_PUBLIC_REST_MULTI_TF",receivedAt,
     latest:{marketFeedConnected:true,eventMs:now(),lastPrice:candles["1m"].at(-1).close},
     candles};
 });
 try{return await Promise.any(requests);}
 catch{throw Error("INDEPENDENT_SPOT_CANDLES_UNAVAILABLE");}
}
