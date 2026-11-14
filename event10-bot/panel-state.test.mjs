import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

const page=fs.readFileSync(new URL("./panel.html",import.meta.url),"utf8");
const script=page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,"EVENT10_SCRIPT_MISSING");
function harness({response,historyHangs=true}={}){
 const nodes=new Map();
 class Element{
  constructor(){this.textContent="";this.className="";this.disabled=false;this.style={};this.children=[];this.handlers=new Map();}
  replaceChildren(){this.children=[];this.textContent="";}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(event,cb){this.handlers.set(event,cb);}
 }
 for(const m of page.matchAll(/id="([^"]+)"/g))nodes.set(m[1],new Element());
 const document={getElementById:id=>{assert.ok(nodes.has(id),"NO_ELEMENT:"+id);return nodes.get(id);},
  createElement:()=>new Element()};
 let statusCalls=0,historyCalls=0,manualCalls=0;
 const liveState={ok:true,configured:true,autoTradingEnabled:false,
   stats:{total:0},lastSession:null,lastCheck:null,active:null,lastDataProbe:null};
 const fakeFetch=async (url)=>{
  const path=String(url);
  const json=x=>({ok:true,status:200,json:async()=>x});
  if(path==="api/status"){statusCalls++;return json(liveState);}
  if(path.startsWith("api/signals?")){historyCalls++;if(historyHangs)return new Promise(()=>{});
    return json({ok:true,version:"EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029",records:[],total:0,stats:{total:0,validDirections:0,proxySettled:0}});}
  if(path==="api/stream-health")return json({connected:true,windows:{},totalSinceProcessStart:10});
  if(path==="api/start"){manualCalls++;return json({ok:true,session:response});}
  throw Error("UNEXPECTED_URL "+path);
 };
 const ctx={document,fetch:fakeFetch,crypto:webcrypto,
   AbortSignal,Date,Math,Number,Array,Object,String,Set,Promise,Error,Uint8Array,
   setInterval:()=>0};
 vm.runInNewContext(script,ctx,{timeout:1500});
 return {nodes,ctx,counts:()=>({statusCalls,historyCalls,manualCalls})};
}
const spin=()=>new Promise(resolve=>setImmediate(resolve));
test("live status updates even when heavy history endpoint never completes",async()=>{
 const ui=harness({response:{status:"NO_SIGNAL"}});
 await spin();await spin();
 assert.equal(ui.nodes.get("engine").textContent,"固定五项信号规则已启用");
 assert.ok(ui.counts().historyCalls>0);
 assert.ok(ui.counts().statusCalls>0);
 assert.notEqual(ui.nodes.get("engine").textContent,"连接中");
});
test("NO_SIGNAL POST result paints immediately, independent of history and status refetch",async()=>{
 const ui=harness({response:{
  status:"NO_SIGNAL",signal:"NO_SIGNAL",direction:null,checkedAt:Date.now(),
  openedAt:Date.now(),openPrice:105000,reason:"五项未满足",upChecks:{
   trend5m:true,momentum1m:true,volume:false,orderflow:true,rsi:true},
  downChecks:{trend5m:false,momentum1m:false,volume:false,orderflow:false,rsi:true}
 }});
 await spin();
 await ui.ctx.startClick();
 assert.equal(ui.nodes.get("quickDirection").textContent,"无信号");
 assert.equal(ui.nodes.get("quickPhase").textContent,"检查完成：无信号");
 assert.equal(ui.nodes.get("quickReason").textContent,"五项未满足");
 assert.ok(ui.nodes.get("message").textContent.includes("检查完成"));
 assert.equal(ui.counts().manualCalls,1);
 assert.ok(!ui.nodes.get("quickDirection").textContent.includes("正在检查"));
});
test("DATA_ERROR POST response displays a terminal error, never a stale spinner",async()=>{
 const ui=harness({response:{
  status:"DATA_ERROR",signal:"NO_SIGNAL",checkedAt:Date.now(),
  reason:"数据检查未完成：STALE_1m_CANDLES。",openPrice:null
 }});
 await spin();
 await ui.ctx.startClick();
 assert.equal(ui.nodes.get("quickDirection").textContent,"数据异常·无信号");
 assert.equal(ui.nodes.get("quickPhase").textContent,"行情数据异常：无信号");
 assert.ok(ui.nodes.get("quickReason").textContent.includes("STALE_1m_CANDLES"));
});
