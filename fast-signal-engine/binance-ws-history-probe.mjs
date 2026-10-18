// One-time, strictly public read-only Binance historical kline probe over WebSocket API.
// Does not sign, authenticate, place orders, or call banned Binance spot REST.
import WebSocket from 'ws';
const url='wss://ws-api.binance.com:443/ws-api/v3?returnRateLimits=false';
const event=(fields)=>console.log(JSON.stringify({event:'binance_ws_history_readonly_probe',
  at:new Date().toISOString(),...fields}));
const ws=new WebSocket(url,{handshakeTimeout:6000,perMessageDeflate:false});
let finished=false;
const done=(data)=>{if(finished)return;finished=true;event(data);ws.close();};
ws.on('open',()=>{
  ws.send(JSON.stringify({id:'preview-spot-klines-once',method:'klines',
    params:{symbol:'BTCUSDT',interval:'5m',limit:40}}));
});
ws.on('message',buf=>{
  try{
    const res=JSON.parse(buf.toString('utf8'));
    if(res.id==='preview-spot-klines-once'){
      const rows=Array.isArray(res.result)?res.result:[];
      done({status:res.status??null,count:rows.length,
        format:Array.isArray(rows[0])?rows[0].length:null,
        latestStartMs:Array.isArray(rows.at(-1))?Number(rows.at(-1)[0]):null,
        errorCode:res.error?.code??null});
    }
  }catch{done({errorType:'BAD_WS_RESPONSE'});}
});
ws.on('unexpected-response',(_,res)=>done({httpStatus:res.statusCode,errorType:'WS_UPGRADE_REJECTED'}));
ws.on('error',e=>done({errorType:String(e?.message||e).slice(0,105)}));
setTimeout(()=>done({errorType:'WS_READ_TIMEOUT'}),9500).unref();
