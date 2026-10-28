// EVENT10 UI server. No exchange order routes or signed Binance secrets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEngine} from "./manual-engine.mjs";
import {createChineseDisplay} from "./chinese-display.mjs";
export {createEngine,HORIZON_MS,checkedTick,buildSnapshot,parseDirection,scoreProxy} from "./manual-engine.mjs";
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
