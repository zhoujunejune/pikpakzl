import WebSocket from 'ws';

const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const S = SYMBOL.toLowerCase();
const BASE = String(process.env.BINANCE_SPOT_WS_BASE || 'wss://stream.binance.com:9443');
const COLLECT_MS = Math.max(1200, Number(process.env.SPOT_PROBE_COLLECT_MS || 2200));
const WINDOW_MS = Math.max(300, Number(process.env.TRADE_WINDOW_MS || 750));
const url = `${BASE}/stream?streams=${S}@aggTrade/${S}@bookTicker/${S}@depth20@100ms`;

const trades = [];
const prices = [];
let book = null;
let messageCount = 0;
let startedAt = 0;
let done = false;

function clamp(v, lo=-1, hi=1) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
function levels(xs, n=10) { return Array.isArray(xs) ? xs.slice(0,n).map(x=>[Number(x?.[0]),Number(x?.[1])]).filter(x=>Number.isFinite(x[0])&&Number.isFinite(x[1])) : []; }
function priceAgo(ms, now) { const target=now-ms; let found=null; for(let i=prices.length-1;i>=0;i--){ found=prices[i]; if(prices[i].ts<=target) break; } return found?.price ?? null; }

const ws = new WebSocket(url,{perMessageDeflate:false,handshakeTimeout:10000});
const hard = setTimeout(()=>fail('TIMEOUT'),12000);
function fail(error){ if(done)return; done=true; clearTimeout(hard); console.error(JSON.stringify({event:'spot_signal_probe_failed',error,messageCount,trades:trades.length,hasBook:Boolean(book)})); try{ws.terminate()}catch{} process.exit(1); }

ws.on('open',()=>{ startedAt=Date.now(); console.log(JSON.stringify({event:'spot_signal_probe_connected',symbol:SYMBOL})); });
ws.on('message',raw=>{
  try {
    messageCount++;
    const o=JSON.parse(raw.toString()), stream=String(o?.stream||''), d=o?.data||{}, ts=Number(d?.E||d?.T||Date.now());
    if(stream.includes('@aggTrade')) { const p=Number(d.p),q=Number(d.q); if(Number.isFinite(p)&&Number.isFinite(q)&&p>0&&q>0) trades.push({ts,notional:p*q,buy:d.m===false}); }
    else if(stream.includes('@depth20')) { const bids=levels(d.b),asks=levels(d.a); if(bids.length&&asks.length){ const bestBid=bids[0][0],bestAsk=asks[0][0],bestBidQty=bids[0][1],bestAskQty=asks[0][1],mid=(bestBid+bestAsk)/2; book={bids,asks,bestBid,bestAsk,bestBidQty,bestAskQty,mid,ts}; prices.push({ts,price:mid}); } }
    else if(stream.includes('@bookTicker')) { const b=Number(d.b),a=Number(d.a),B=Number(d.B),A=Number(d.A); if([b,a,B,A].every(Number.isFinite)&&b>0&&a>0){ const mid=(b+a)/2; book={...(book||{}),bestBid:b,bestAsk:a,bestBidQty:B,bestAskQty:A,mid,ts}; prices.push({ts,price:mid}); } }
    if(startedAt && Date.now()-startedAt>=COLLECT_MS) finish();
  } catch {}
});
ws.on('ping',x=>{try{ws.pong(x)}catch{}});
ws.on('error',e=>console.error(JSON.stringify({event:'spot_signal_probe_error',error:e?.message||String(e)})));

function finish(){
  if(done)return; done=true; clearTimeout(hard);
  const now=Date.now(), recent=trades.filter(t=>t.ts>=now-WINDOW_MS);
  if(!book||recent.length<3){ console.error(JSON.stringify({event:'spot_signal_probe_failed',error:'INSUFFICIENT_LIVE_DATA',messageCount,recentTrades:recent.length,hasBook:Boolean(book)})); process.exit(1); }
  let buy=0,sell=0; for(const t of recent){ if(t.buy) buy+=t.notional; else sell+=t.notional; }
  const tradePressure=(buy-sell)/(buy+sell||1);
  const bids=Array.isArray(book.bids)&&book.bids.length?book.bids:[[book.bestBid,book.bestBidQty]], asks=Array.isArray(book.asks)&&book.asks.length?book.asks:[[book.bestAsk,book.bestAskQty]];
  const bd=bids.slice(0,10).reduce((s,[p,q])=>s+p*q,0), ad=asks.slice(0,10).reduce((s,[p,q])=>s+p*q,0), bookImbalance=(bd-ad)/(bd+ad||1);
  const spread=Math.max(1e-9,book.bestAsk-book.bestBid), micro=((book.bestAsk*book.bestBidQty)+(book.bestBid*book.bestAskQty))/((book.bestBidQty+book.bestAskQty)||1), microprice=clamp((micro-book.mid)/spread);
  const p500=priceAgo(500,now),p1500=priceAgo(1500,now),r500=p500?(book.mid-p500)/p500:0,r1500=p1500?(book.mid-p1500)/p1500:0, momentum=clamp(.6*clamp(r500/0.00015)+.4*clamp(r1500/0.00030));
  const score=clamp(.37*clamp(tradePressure)+.32*clamp(bookImbalance)+.15*microprice+.16*momentum);
  console.log(JSON.stringify({event:'spot_signal_probe_verified',symbol:SYMBOL,collectionMs:Date.now()-startedAt,messageCount,recentTrades:recent.length,bestBid:book.bestBid,bestAsk:book.bestAsk,mid:book.mid,components:{tradePressure:Number(tradePressure.toFixed(6)),bookImbalance:Number(bookImbalance.toFixed(6)),microprice:Number(microprice.toFixed(6)),momentum:Number(momentum.toFixed(6))},score:Number(score.toFixed(6)),direction:score>=0?'UP':'DOWN',confidence:Number(Math.abs(score).toFixed(6)),source:'Binance Spot WebSocket'}));
  try{ws.close()}catch{} setTimeout(()=>process.exit(0),50);
}
