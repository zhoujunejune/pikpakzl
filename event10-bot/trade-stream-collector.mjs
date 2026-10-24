// Binance USD-M BTCUSDT continuous, read-only public aggTrade WebSocket collector.
// No Binance API credentials and no order-execution code. Node >= 20 with --experimental-websocket.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const TRADE_STREAM_URL="wss://fstream.binance.com/market/ws/btcusdt@aggTrade";
export const STREAM_SOURCE="BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET";
const WINDOWS=[60000,300000,600000];
const RING_LIMIT=100000;
const HOUR_MS=3600000;
const safeInt=v=>Number.isSafeInteger(v)&&v>=0;
const n=v=>Number(v);
const finite=v=>Number.isFinite(v);
const round=(v,d=3)=>Number(v.toFixed(d));

export function parseTrade(payload,receivedAt){
 const o=typeof payload==="string"?JSON.parse(payload):payload;
 const e=o?.data??o;
 if(e?.e!=="aggTrade"||e.s!=="BTCUSDT"||!safeInt(e.a)||!safeInt(e.T)||!safeInt(e.E)||
   typeof e.m!=="boolean"||(e.st!==undefined&&e.st!==1))throw Error("INVALID_AGGTRADE_PAYLOAD");
 const p=n(e.p),q=n(e.q);
 if(!finite(p)||!finite(q)||p<=0||q<=0||e.T>receivedAt+3000||
    receivedAt-e.T>60000||e.E>receivedAt+3000)throw Error("STALE_OR_INVALID_AGGTRADE");
 return {id:e.a,eventAt:e.E,tradeAt:e.T,receivedAt,price:p,qty:q,
   takerSide:e.m?"SELL":"BUY",notional:round(p*q,4),
   firstTradeId:safeInt(e.f)?e.f:null,lastTradeId:safeInt(e.l)?e.l:null};
}
export class ContinuousTradeCollector {
 constructor({clock=Date.now,dir="/var/lib/zl-event10-stream",socketFactory=null,
   streamUrl=TRADE_STREAM_URL,disableDisk=false}={}){
  this.clock=clock;this.dir=dir;this.socketFactory=socketFactory||
    (url=>{if(typeof WebSocket!=="function")throw Error("NODE_WEBSOCKET_UNAVAILABLE");return new WebSocket(url)});
  this.url=streamUrl;this.disableDisk=disableDisk;
  this.samples=[];this.gaps=[];this.connected=false;this.lastError=null;
  this.lastReceivedAt=null;this.lastTradeAt=null;this.lastEventLatencyMs=null;
  this.lastId=null;this.lastTradeId=null;this.startedAt=clock();
  this.connectedAt=null;this.lastConnectedAt=null;
  this.total=0;this.duplicate=0;this.invalid=0;this.gapCount=0;
  this.missingAggregateIds=0;this.reconnectCount=0;this.backpressure=0;
  this.disconnectedIntervals=[];
  this.ws=null;this.running=false;this.attempt=0;this.retryTimer=null;
  this.checkTimer=null;this.rollTimer=null;this.activeMinute=null;this.journal=null;
  if(!disableDisk){
   fs.mkdirSync(dir,{recursive:true,mode:0o750});
   this.recoverRecent();
  }
 }
 journalPath(ts){
  const stamp=new Date(ts).toISOString().slice(0,16).replace(/[-:T]/g,"");
  return path.join(this.dir,"aggtrades-"+stamp+".ndjson");
 }
 recoverRecent(){
  // Recovered journal is reference history, never evidence that a disconnected interval was complete.
  const cutoff=this.clock()-600000;
  let names=[];
  try{names=fs.readdirSync(this.dir).filter(x=>/^aggtrades-\d{12}\.ndjson$/.test(x)).sort().slice(-12)}catch{return;}
  let count=0;
  for(const filename of names){
   let body;
   try{
    const file=path.join(this.dir,filename);
    if(fs.statSync(file).size>12*1024*1024)continue;
    body=fs.readFileSync(file,"utf8");
   }catch{continue;}
   for(const line of body.split("\n")){
    if(!line||count>RING_LIMIT)continue;
    try{
     const a=JSON.parse(line);
     if(safeInt(a.id)&&safeInt(a.receivedAt)&&a.receivedAt>=cutoff&&
        a.takerSide&&finite(a.notional)){
       this.samples.push(a);count++;
     }
    }catch{}
   }
  }
  this.samples.sort((a,b)=>a.receivedAt-b.receivedAt);
  if(this.samples.length>RING_LIMIT)this.samples=this.samples.slice(-RING_LIMIT);
  const last=this.samples.at(-1);
  if(last){this.lastId=last.id;this.lastTradeId=last.lastTradeId;this.lastReceivedAt=last.receivedAt;
    this.lastTradeAt=last.tradeAt;}
  // A restart is an explicit coverage discontinuity until a full new window is observed.
  if(last)this.gaps.push({at:this.clock(),reason:"COLLECTOR_RESTART",count:null});
 }
 rotateJournal(now){
  if(this.disableDisk)return;
  const filename=this.journalPath(now);
  if(this.activeMinute===filename)return;
  if(this.journal)this.journal.end();
  this.journal=fs.createWriteStream(filename,{flags:"a",mode:0o640,highWaterMark:1024*1024});
  this.journal.on("error",()=>{this.backpressure++;this.addGap("PERSISTENCE_IO_FAILURE",1);});
  this.activeMinute=filename;
 }
 addGap(reason,count=null,at=this.clock()){
  this.gapCount++;
  this.gaps.push({at,reason,count});
  this.gaps=this.gaps.filter(g=>g.at>=at-86400000).slice(-500);
 }
 prune(now=this.clock()){
  const cutoff=now-600000;
  while(this.samples.length&&this.samples[0].receivedAt<cutoff)this.samples.shift();
  if(this.samples.length>RING_LIMIT){
   this.samples.splice(0,this.samples.length-RING_LIMIT);
   this.addGap("RING_CAPACITY_LOSS",null,now);
  }
  this.gaps=this.gaps.filter(g=>g.at>=now-86400000);
 }
 accept(raw,receivedAt=this.clock()){
  let t;
  try{t=parseTrade(raw,receivedAt);}
  catch(e){this.invalid++;this.lastError=String(e?.message||e).slice(0,80);return false;}
  if(this.lastId!==null){
   if(t.id<=this.lastId){this.duplicate++;return false;}
   if(t.id!==this.lastId+1){
    const lost=t.id-this.lastId-1;
    this.missingAggregateIds+=lost;
    this.addGap("AGGREGATE_ID_GAP",lost,receivedAt);
   }
   if(t.firstTradeId!==null&&this.lastTradeId!==null&&t.firstTradeId>this.lastTradeId+1)
      this.addGap("UNDERLYING_TRADE_ID_GAP",t.firstTradeId-this.lastTradeId-1,receivedAt);
  }
  this.lastId=t.id;
  this.lastTradeId=t.lastTradeId;
  this.lastReceivedAt=receivedAt;this.lastTradeAt=t.tradeAt;
  this.lastEventLatencyMs=receivedAt-t.eventAt;
  this.samples.push(t);this.total++;
  if(!this.disableDisk){
   try{
    this.rotateJournal(receivedAt);
    if(this.journal.writableLength>16*1024*1024){
      this.backpressure++;this.addGap("DISK_WRITE_BACKPRESSURE",null,receivedAt);
    }else this.journal.write(JSON.stringify(t)+"\n");
   }catch(e){this.lastError="DISK_IO_ERROR";this.addGap("DISK_IO_ERROR",null,receivedAt);}
  }
  if(this.total%500===0)this.prune(receivedAt);
  return true;
 }
 disconnect(reason="SOCKET_CLOSED"){
  if(this.connected){this.connected=false;this.addGap(reason,null,this.clock());}
  this.lastError=reason;
 }
 summarize(windowMs,now=this.clock()){
  if(!WINDOWS.includes(windowMs))throw Error("UNSUPPORTED_WINDOW");
  this.prune(now);
  const rows=this.samples.filter(t=>t.receivedAt>now-windowMs&&t.receivedAt<=now);
  const lastInWindow=rows.at(-1)||null;
  const age=lastInWindow===null?null:now-lastInWindow.receivedAt;
  const invalidReasons=[];
  if(!this.connected)invalidReasons.push("WEBSOCKET_DISCONNECTED");
  if(this.connectedAt===null||this.connectedAt>now-windowMs)invalidReasons.push("INSUFFICIENT_CONTINUOUS_UPTIME");
  if(age===null||age>5000||age<0)invalidReasons.push("TRADE_STREAM_STALE");
  if(this.gaps.some(g=>g.at>=now-windowMs&&g.at<=now))invalidReasons.push("COLLECTION_GAP_IN_WINDOW");
  if(!rows.length)invalidReasons.push("EMPTY_WINDOW");
  else if(rows[0].receivedAt>now-windowMs+3000)invalidReasons.push("WINDOW_START_NOT_OBSERVED");
  const buy=rows.reduce((a,t)=>a+(t.takerSide==="BUY"?t.notional:0),0);
  const sell=rows.reduce((a,t)=>a+(t.takerSide==="SELL"?t.notional:0),0);
  const big=rows.filter(t=>t.notional>=100000);
  const lat=rows.map(t=>Math.max(0,t.receivedAt-t.eventAt)).sort((a,b)=>a-b);
  const p95=lat.length?lat[Math.floor(0.95*(lat.length-1))]:null;
  return {windowSeconds:windowMs/1000,
   complete:invalidReasons.length===0,issues:invalidReasons,
   observedGroups:rows.length,from:rows[0]?.tradeAt||null,
   to:rows.at(-1)?.tradeAt||null,
   takerBuyNotionalUsd:round(buy,2),takerSellNotionalUsd:round(sell,2),
   netTakerNotionalUsd:round(buy-sell,2),buyFraction:buy+sell?round(buy/(buy+sell),4):null,
   largeAggregateGroups:big.length,largeTakerBuyUsd:round(big.filter(t=>t.takerSide==="BUY").reduce((a,t)=>a+t.notional,0),2),
   largeTakerSellUsd:round(big.filter(t=>t.takerSide==="SELL").reduce((a,t)=>a+t.notional,0),2),
   lastStreamReceiveAgeMs:age,eventLatencyP95Ms:p95,
   source:STREAM_SOURCE,
   caveat:"Full stream of 100ms aggregate events while connected, not raw individual fills. Gaps are not silently backfilled."};
 }
 features(asOf=this.clock()){
  const current=this.clock();
  if(!Number.isSafeInteger(asOf)||asOf>current+1000||asOf<current-600000)
    throw Error("INVALID_HISTORICAL_ASOF");
  const now=asOf;
  const windows={};
  for(const x of WINDOWS)windows[x/1000+"s"]=this.summarize(x,now);
  return {ok:true,source:STREAM_SOURCE,serverTime:now,
   connected:this.connected,asOf:now,lastTradeAt:this.lastTradeAt,
   lastReceivedAt:this.lastReceivedAt,lastAggregateId:this.lastId,
   lastEventLatencyMs:this.lastEventLatencyMs,
   samplesBuffered:this.samples.length,historyRecordingEnabled:!this.disableDisk,
   gapCount:this.gapCount,missingAggregateIds:this.missingAggregateIds,
   reconnectCount:this.reconnectCount,invalidEvents:this.invalid,
   duplicateEvents:this.duplicate,backpressureEvents:this.backpressure,
   totalSinceProcessStart:this.total,
   windows};
 }
 health(){
  const d=this.features();
  return {...d,startedAt:this.startedAt,connectedAt:this.connectedAt,
    uptimeMs:this.clock()-this.startedAt,lastError:this.lastError,
    recentGaps:this.gaps.slice(-12)};
 }
 cleanOldFiles(){
  if(this.disableDisk)return;
  try{
   const names=fs.readdirSync(this.dir).filter(x=>/^aggtrades-\d{12}\.ndjson$/.test(x)).sort();
   const now=this.clock();let totalBytes=0,items=[];
   for(const name of names){
    const full=path.join(this.dir,name),s=fs.statSync(full);
    if(now-s.mtimeMs>12*HOUR_MS&&full!==this.activeMinute){fs.unlinkSync(full);continue;}
    totalBytes+=s.size;items.push({full,size:s.size});
   }
   while(totalBytes>400*1024*1024&&items.length>1){
    const item=items.shift();if(item.full===this.activeMinute)continue;
    fs.unlinkSync(item.full);totalBytes-=item.size;
   }
  }catch(e){this.lastError="JOURNAL_PRUNE_FAILED";}
 }
 connect(){
  if(!this.running)return;
  let ws;
  try{ws=this.socketFactory(this.url);}
  catch(e){this.lastError="WEBSOCKET_CLIENT_START_FAILURE";this.scheduleReconnect();return;}
  this.ws=ws;
  const watchdog=setTimeout(()=>{if(ws===this.ws&&ws.readyState!==1)ws.close();},12000);
  ws.addEventListener("open",()=>{
   clearTimeout(watchdog);
   this.connected=true;this.connectedAt=this.clock();
   this.lastConnectedAt=this.connectedAt;this.attempt=0;this.lastError=null;
  });
  ws.addEventListener("message",evt=>{this.accept(String(evt.data),this.clock());});
  ws.addEventListener("error",()=>{this.lastError="WEBSOCKET_ERROR";});
  ws.addEventListener("close",()=>{
   clearTimeout(watchdog);
   if(this.ws!==ws)return;
   this.disconnect("WEBSOCKET_CLOSED");
   this.ws=null;this.scheduleReconnect();
  });
 }
 scheduleReconnect(){
  if(!this.running||this.retryTimer)return;
  this.reconnectCount++;this.attempt++;
  const delay=Math.min(30000,1000*2**Math.min(this.attempt,5))+
    Math.floor(Math.random()*1000);
  this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.connect();},delay);
 }
 start(){
  if(this.running)return;
  this.running=true;
  this.checkTimer=setInterval(()=>{
   const now=this.clock();
   if(this.connected&&this.lastReceivedAt!==null&&now-this.lastReceivedAt>20000){
    this.addGap("WEBSOCKET_NO_TRADES_20S",null,now);
    try{this.ws?.close()}catch{}
   }
   this.prune(now);
  },5000);
  this.rollTimer=setInterval(()=>this.cleanOldFiles(),60000);
  this.connect();
 }
 stop(){
  this.running=false;
  if(this.retryTimer)clearTimeout(this.retryTimer);
  if(this.checkTimer)clearInterval(this.checkTimer);
  if(this.rollTimer)clearInterval(this.rollTimer);
  try{this.ws?.close()}catch{}
  if(this.journal)this.journal.end();
 }
}
export function serveCollector(c,{port=Number(process.env.EVENT10_STREAM_PORT||13021),host="127.0.0.1"}={}){
 if(host!=="127.0.0.1")throw Error("COLLECTOR_MUST_BE_LOCAL_ONLY");
 const server=http.createServer((req,res)=>{
  const p=new URL(req.url,"http://localhost").pathname;
  const send=(code,body)=>{
    res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify(body));
  };
  if(req.method!=="GET")return send(405,{ok:false,error:"READ_ONLY"});
  if(p==="/healthz"||p==="/api/health")return send(200,c.health());
  if(p==="/api/features"){
   try{
    const request=new URL(req.url,"http://localhost");
    const raw=request.searchParams.get("asof");
    const asOf=raw===null?undefined:Number(raw);
    return send(200,c.features(asOf));
   }catch(e){return send(400,{ok:false,error:"INVALID_ASOF"});}
  }
  return send(404,{ok:false,error:"NOT_FOUND"});
 });
 server.listen(port,host);return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const c=new ContinuousTradeCollector({dir:process.env.EVENT10_STREAM_STATE||"/var/lib/zl-event10-stream"});
 c.start();serveCollector(c);
 process.on("SIGTERM",()=>{c.stop();setTimeout(()=>process.exit(0),300).unref();});
 console.log("EVENT10_CONTINUOUS_AGGTRADE_COLLECTOR_RUNNING readOnly=true");
}
