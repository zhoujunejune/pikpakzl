// EVENT10 UI server. No exchange order routes or signed Binance secrets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEngine} from "./manual-engine.mjs";
import {createChineseDisplay} from "./chinese-display.mjs";
export {createEngine,HORIZON_MS,checkedTick,buildSnapshot,parseDirection,scoreProxy} from "./manual-engine.mjs";
const WATCH_INTERVAL_MS=800;
const WATCH_TIMEOUT_MS=18_000;
const RECEIPT_STATES=new Set(["NOTIFICATION_POSTED_ALARM_STARTED","NOTIFICATION_POSTED_SOUND_FAILED",
  "NOTIFICATION_BLOCKED","MISSED_SIGNAL_EXPIRED","NOTIFICATION_POSTED_ALARM_MUTED"]);
const RECEIPT_FILE=process.env.EVENT10_ALERT_RECEIPTS_FILE||"/var/lib/zl-event10/alert-receipts-v1.ndjson";
const RECEIPT_MAX_BYTES=2_000_000; // Rotate a bounded client-only audit journal.
const ALLOWED_ORIGINS=new Set([
  "https://47-237-188-69.sslip.io",
  "https://prediction.47-237-188-69.sslip.io"
]);
export function serve(engine,{port=Number(process.env.EVENT10_PORT||13020),host="127.0.0.1"}={}) {
  if(host!=="127.0.0.1")throw Error("LOOPBACK_ONLY");
  const dir=path.dirname(fileURLToPath(import.meta.url));
  const page=fs.readFileSync(path.join(dir,"panel.html"),"utf8");
  const chineseDisplay=createChineseDisplay();
  const server=http.createServer(async(req,res)=>{
    let pathname;
    try{pathname=new URL(req.url,"http://localhost").pathname;}
    catch{res.writeHead(400);return res.end("Invalid URL");}
    const send=(status,data,html=false)=>{
      const body=html?data:JSON.stringify(data);
      res.writeHead(status,{
        "Content-Type":html?"text/html; charset=utf-8":"application/json; charset=utf-8",
        "Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
        "Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
      });
      res.end(body);
    };
    if(req.method==="POST"&&pathname==="/api/start"){
      const id=String(req.headers["x-event10-request-id"]||"");
      const validOrigin=ALLOWED_ORIGINS.has(req.headers.origin);
      if(!validOrigin||req.headers["x-event10-action"]!=="manual-open")
        return send(403,{ok:false,error:"INVALID_SAME_ORIGIN_MANUAL_CLICK"});
      if(Number(req.headers["content-length"]||0)>0)return send(413,{ok:false,error:"EMPTY_BODY_REQUIRED"});
      try{
        const h=await engine.start(id);
        return send(202,{ok:true,session:h,autoTradingEnabled:false});
      }catch(e){
        const error=String(e?.message||e).slice(0,160);
        const status=/ALREADY|ACTIVE|PROCESSING/.test(error)?409:
          /INVALID/.test(error)?400:503;
        return send(status,{ok:false,error});
      }
    }
    // Native app acknowledgement: confirms receipt/notification API invocation,
    // never claims the OS actually presented a heads-up notice or played audio.
    // Caddy HTTP Basic Auth is the perimeter; this service only binds loopback.
    if(req.method==="POST"&&pathname==="/api/alert-receipt"){
      if(req.headers.origin&&!ALLOWED_ORIGINS.has(req.headers.origin))
        return send(403,{ok:false,error:"ORIGIN_REJECTED"});
      if(!String(req.headers["content-type"]||"").startsWith("application/json")||
          Number(req.headers["content-length"]||0)>1000)
        return send(415,{ok:false,error:"INVALID_RECEIPT_TYPE"});
      let bytes=0,done=false,body="";
      req.on("data",chunk=>{
        bytes+=chunk.length;
        if(bytes>1000){done=true;req.destroy();return;}
        body+=chunk.toString("utf8");
      });
      req.on("end",()=>{
        if(done)return;
        let payload;
        try{payload=JSON.parse(body);}catch{return send(400,{ok:false,error:"INVALID_RECEIPT_JSON"});}
        const id=payload?.signalId,clientId=payload?.clientId,state=payload?.state;
        if(typeof id!=="string"||!/^[A-Za-z0-9_-]{12,90}$/.test(id)||
           typeof clientId!=="string"||!/^[0-9a-f-]{36}$/.test(clientId)||
           !RECEIPT_STATES.has(state))
          return send(400,{ok:false,error:"INVALID_RECEIPT_FIELDS"});
        const signal=engine.signals(100,0).records.find(x=>x.id===id);
        if(!signal)return send(404,{ok:false,error:"UNKNOWN_ACTIVE_VERSION_SIGNAL"});
        try{
          const item={at:Date.now(),clientId,signalId:id,state,
            signalOpenedAt:signal.openedAt,serverAgeMs:Math.max(0,Date.now()-signal.openedAt),
            strategyVersion:signal.strategyVersion};
          fs.mkdirSync(path.dirname(RECEIPT_FILE),{recursive:true,mode:0o750});
          try{
            if(fs.statSync(RECEIPT_FILE).size>RECEIPT_MAX_BYTES){
              fs.renameSync(RECEIPT_FILE,RECEIPT_FILE+".previous");
            }
          }catch(e){if(e.code!=="ENOENT")throw e;}
          fs.appendFileSync(RECEIPT_FILE,JSON.stringify(item)+"\n",{encoding:"utf8",mode:0o600});
          return send(200,{ok:true,accepted:true,receiptType:"CLIENT_REPORTED",at:item.at});
        }catch(e){return send(503,{ok:false,error:"RECEIPT_STORE_UNAVAILABLE"});}
      });
      return;
    }
    // Only translates the latest already-finished explanatory text, not a new forecast.
    // Exact authenticated same-origin action; cannot translate arbitrary caller text.
    if(req.method==="POST"&&pathname==="/api/localize-latest"){
      if(!ALLOWED_ORIGINS.has(req.headers.origin)||
          req.headers["x-event10-action"]!=="translate-legacy-only")
        return send(403,{ok:false,error:"INVALID_ORIGIN_OR_ACTION"});
      if(Number(req.headers["content-length"]||0)>0)
        return send(413,{ok:false,error:"EMPTY_BODY_REQUIRED"});
      try{
        const latest=engine.status().lastSession;
        return send(200,await chineseDisplay.translate(latest));
      }catch(e){
        return send(503,{ok:false,error:String(e?.message||e).slice(0,110)});
      }
    }
    if(req.method!=="GET")return send(405,{ok:false,error:"NO_EVENT_CONTRACT_ORDER_API"});
    if(pathname==="/"||pathname==="/event10/"||pathname==="/index.html")
      return send(200,page,true);
    if(pathname==="/healthz")return send(200,{ok:true,service:"zl-event10-manual",tradeExecution:false});
    // Bounded server-assisted long-poll for fast receipt of newly published
    // rule-only directions. Still works when no FCM/third-party push is configured.
    // Clients periodically reconcile /api/signals for outages and missed history.
    if(pathname==="/api/watch"){
      const q=new URL(req.url,"http://localhost").searchParams;
      const after=q.get("after")||"";
      if(after&&!/^[A-Za-z0-9_-]{12,90}$/.test(after))
        return send(400,{ok:false,error:"INVALID_CURSOR"});
      let finished=false;
      let handle=null,deadline=null;
      const clean=()=>{if(handle!==null)clearInterval(handle);if(deadline!==null)clearTimeout(deadline);};
      const reply=(timedOut=false)=>{
        if(finished||res.destroyed)return;
        let ledger;
        try{ledger=engine.signals(8,0);}catch{return;}
        const firstId=ledger.records?.[0]?.id||"";
        if(!timedOut&&after===firstId&&after)return;
        finished=true;clean();
        if(timedOut&&after===firstId){
          return send(200,{ok:true,version:ledger.version,records:[],total:ledger.total,
            watchTimeout:true,serverAt:Date.now()});
        }
        return send(200,{...ledger,watchTimeout:false,serverAt:Date.now()});
      };
      // Never keep an open socket indefinitely if the phone disconnects.
      res.once("close",()=>{finished=true;clean();});
      reply();
      if(!finished){
        handle=setInterval(()=>reply(),WATCH_INTERVAL_MS);
        deadline=setTimeout(()=>reply(true),WATCH_TIMEOUT_MS);
      }
      return;
    }
    if(pathname==="/api/alert-health"){
      const summary={posted:0,audible:0,soundFailed:0,muted:0,blocked:0,late:0};
      let total=0,lastAt=null;
      try{
        if(fs.existsSync(RECEIPT_FILE)){
          const rows=fs.readFileSync(RECEIPT_FILE,"utf8").split("\n").slice(-250);
          for(const line of rows){
            if(!line)continue;let v;try{v=JSON.parse(line);}catch{continue;}
            total++;lastAt=Math.max(lastAt||0,v.at||0);
            if(v.state.startsWith("NOTIFICATION_POSTED"))summary.posted++;
            if(v.state==="NOTIFICATION_POSTED_ALARM_STARTED")summary.audible++;
            if(v.state==="NOTIFICATION_POSTED_SOUND_FAILED")summary.soundFailed++;
            if(v.state==="NOTIFICATION_POSTED_ALARM_MUTED")summary.muted++;
            if(v.state==="NOTIFICATION_BLOCKED")summary.blocked++;
            if(v.state==="MISSED_SIGNAL_EXPIRED")summary.late++;
          }
        }
        return send(200,{ok:true,source:"ANONYMOUS_ANDROID_ACKS_NOT_OS_DELIVERY",
          recentReceiptCount:total,lastAt,summary,
          caveat:"Only receipts successfully uploaded by connected Android clients. Missing receipt does not prove no notification."});
      }catch{return send(503,{ok:false,error:"RECEIPT_HEALTH_UNAVAILABLE"});}
    }
    if(pathname==="/api/status"){
      const state=engine.status();
      return send(200,{...state,lastSession:chineseDisplay.overlay(state.lastSession),
        active:chineseDisplay.overlay(state.active)});
    }
    if(pathname==="/api/history")return send(200,{ok:true,records:engine.history()});
    if(pathname==="/api/signals"){
      const search=new URL(req.url,"http://localhost").searchParams;
      const bounded=(key,defaultValue,max)=>{
        const raw=search.get(key);
        if(raw===null)return defaultValue;
        if(!/^\d{1,7}$/.test(raw))return null;
        const num=Number(raw);
        return Number.isSafeInteger(num)?Math.min(num,max):null;
      };
      const limit=bounded("limit",25,100),offset=bounded("offset",0,1000000);
      if(limit===null||limit<1||offset===null)
        return send(400,{ok:false,error:"INVALID_SIGNAL_PAGE"});
      return send(200,engine.signals(limit,offset));
    }
    if(pathname==="/api/stream-health"){
      try{
        const r=await fetch("http://127.0.0.1:13021/api/health",{signal:AbortSignal.timeout(1800)});
        if(!r.ok)throw Error("COLLECTOR_HTTP_"+r.status);
        const body=await r.json();
        if(body.source!=="BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET")throw Error("COLLECTOR_SOURCE_UNEXPECTED");
        return send(200,body);
      }catch{return send(503,{ok:false,connected:false,error:"TRADE_STREAM_COLLECTOR_UNAVAILABLE"});}
    }
    if(pathname==="/api/data-health"){
      try{return send(200,await engine.probe());}
      catch(e){return send(503,{ok:false,error:"BINANCE_ENRICHMENT_HEALTH_UNAVAILABLE"});}
    }
    return send(404,{ok:false,error:"NOT_FOUND"});
  });
  server.listen(port,host);
  return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const engine=createEngine();
  serve(engine);
  setInterval(()=>void engine.tick(),1000);
  console.log("EVENT10_MANUAL_BUTTON_READY realOrders=false");
}
