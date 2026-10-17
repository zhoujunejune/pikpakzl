// Public market data adapter. One single venue per training epoch.
// Never combine orderbook from one exchange with a different exchange's perp.
const err=e=>String(e?.message||e).slice(0,140);
async function read(url){
 const res=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(2300),
  headers:{accept:'application/json'}});
 if(!res.ok)throw Error('HTTP_'+res.status+'_'+new URL(url).hostname);
 return {data:await res.json(),url,at:Date.now()};
}
async function first(hosts,path,valid){
 let errors=[];
 for(const host of hosts){const url=host+path;
  try{const x=await read(url);if(!valid(x.data))throw Error('INVALID_SCHEMA');return x;}
  catch(e){errors.push(err(e));}}
 throw Error(errors.join('|').slice(0,160));
}
function fresh(observedAt,sourceAt){
 return Number.isFinite(sourceAt)&&sourceAt>0&&observedAt-sourceAt>=-300&&observedAt-sourceAt<=3500;
}
export async function bybitMarket(){
 const hosts=['https://api.bybit.com','https://api.bytick.com'];
 const url=['/v5/market/tickers?category=spot&symbol=BTCUSDT',
  '/v5/market/tickers?category=linear&symbol=BTCUSDT',
  '/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=25',
  '/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=200'];
 const [spot,perp,book,trades]=await Promise.all(url.map((path,i)=>first(hosts,path,d=>
  d?.retCode===0&&(i===2?Array.isArray(d.result?.b)&&d.result.b.length>=5&&
    Array.isArray(d.result?.a)&&d.result.a.length>=5:
    Array.isArray(d.result?.list)&&d.result.list.length>=3-(i===3?0:2)))));
 const now=Date.now(),s=spot.data.result.list[0],p=perp.data.result.list[0];
 const spotPrice=Number(s.lastPrice),perpPrice=Number(p.lastPrice);
 const spotAt=Number(spot.data.time),perpAt=Number(perp.data.time);
 if(!(spotPrice>0&&perpPrice>0&&fresh(now,spotAt)&&fresh(now,perpAt)&&
   fresh(now,Number(book.data.result.ts))))throw Error('BYBIT_SPOT_OR_PERP_STALE');
 const rows=trades.data.result.list.map(x=>({T:Number(x.time),q:x.size,
   m:x.side==='Sell'}));
 if(rows.filter(x=>fresh(now,x.T)&&Number(x.q)>0).length<3)
  throw Error('BYBIT_RECENT_TRADES_STALE');
 return {venue:'BYBIT',at:now,spotPrice,spotAt,perpPrice,perpAt,
  bids:book.data.result.b,asks:book.data.result.a,trades:rows,
  providers:{spot:spot.url,perp:perp.url,depth:book.url,trades:trades.url}};
}
export async function okxMarket(){
 const host='https://www.okx.com';
 const url=['/api/v5/market/ticker?instId=BTC-USDT',
  '/api/v5/market/ticker?instId=BTC-USDT-SWAP',
  '/api/v5/market/books?instId=BTC-USDT&sz=10',
  '/api/v5/market/trades?instId=BTC-USDT-SWAP&limit=100'];
 const [spot,perp,book,trades]=await Promise.all(url.map(path=>first([host],path,d=>
  d?.code==='0'&&Array.isArray(d.data)&&d.data.length>0)));
 const now=Date.now(),s=spot.data.data[0],p=perp.data.data[0],b=book.data.data[0];
 const spotPrice=Number(s.last),perpPrice=Number(p.last);
 const spotAt=Number(s.ts),perpAt=Number(p.ts);
 if(!(spotPrice>0&&perpPrice>0&&fresh(now,spotAt)&&fresh(now,perpAt)&&
   fresh(now,Number(b.ts))&&Array.isArray(b.bids)&&b.bids.length>=5&&
   Array.isArray(b.asks)&&b.asks.length>=5))
  throw Error('OKX_SPOT_OR_PERP_STALE');
 const rows=trades.data.data.map(x=>({T:Number(x.ts),q:x.sz,m:x.side==='sell'}));
 if(rows.filter(x=>fresh(now,x.T)&&Number(x.q)>0).length<3)
  throw Error('OKX_RECENT_TRADES_STALE');
 return {venue:'OKX',at:now,spotPrice,spotAt,perpPrice,perpAt,
  bids:b.bids,asks:b.asks,trades:rows,
  providers:{spot:spot.url,perp:perp.url,depth:book.url,trades:trades.url}};
}
export async function bestMarket(pinnedVenue=null,binanceFn=null){
 const map={BYBIT:bybitMarket,OKX:okxMarket,BINANCE:binanceFn};
 if(pinnedVenue){
  if(typeof map[pinnedVenue]!=='function')throw Error('UNKNOWN_PINNED_VENUE');
  return await map[pinnedVenue]();
 }
 const fails=[];
 for(const [venue,fn] of Object.entries(map)){
  if(typeof fn!=='function')continue;
  try{return await fn();}
  catch(e){fails.push(venue+':'+err(e));}
 }
 throw Error('ALL_MARKET_VENUES_UNAVAILABLE_'+fails.join(';').slice(0,135));
}
