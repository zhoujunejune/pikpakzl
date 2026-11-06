import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src=fs.readFileSync(new URL("./app.js",import.meta.url),"utf8");
const version="EVENT10_FORCED_CONTRARIAN_12M_V1_20261101";
const from=src.indexOf("function eventVersion(r){");
const to=src.indexOf("function event(e,ledger){",from);
assert.ok(from>0&&to>from,"current strategy filtering helpers must exist");
const api=vm.runInNewContext(
  "const EVENT10_FREQ_OPTIMIZED_VERSION="+JSON.stringify(version)+";\n"+
  src.slice(from,to)+"\n({eventVersion,currentEventRecord,mergeEventRecords})"
);

const mk=(id,ver,at)=>({id,openedAt:at,direction:"UP",strategyVersion:ver,status:"PREDICTED"});
const old="EVENT10_HIGH_SELECTIVITY_6GATES_V1_20261031";
test("only current strategy signals are displayed, never historical or mismatched records",()=>{
 const records=api.mergeEventRecords({version,records:[
   mk("legacy",old,100),mk("fresh",version,110),mk("fresh",version,110),
   mk("unknown",null,111),{...mk("bad",version,112),direction:"WAIT"}
 ]});
 assert.equal(records.length,1);
 assert.equal(records[0].id,"fresh");
});
test("old or wrong-version signal history is not used as current signal history",()=>{
 assert.equal(api.mergeEventRecords({version:old,records:[mk("fresh",version,110)]}).length,0);
 assert.equal(api.mergeEventRecords(null).length,0);
 assert.equal(api.currentEventRecord({active:mk("old",old,300),lastSession:mk("old2",old,200)}),null);
 const latest=api.currentEventRecord({
   active:mk("old",old,300),
   lastCheck:{...mk("current",version,250),checkedAt:260},
   lastSession:mk("old2",old,240)
 });
 assert.equal(latest.id,"current");
});
test("the app never requests legacy event history or mixes old stats",()=>{
 assert.ok(!src.includes('api("/event10/api/history"'));
 assert.ok(!src.includes("legacyHistory"));
 assert.ok(src.includes("if(e?.decisionReviewVersion!==EVENT10_FREQ_OPTIMIZED_VERSION)"));
 assert.ok(src.includes("const currentLedger=ledger?.version===EVENT10_FREQ_OPTIMIZED_VERSION"));
 assert.ok(src.includes('put("eTotal","新策略 "'));
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 assert.ok(html.includes("当前策略信号记录"));
 assert.ok(!html.includes("历史信号（新旧策略）"));
});

test("price comparison uses frozen index reference and exact settlement values",()=>{
 const first=src.indexOf("function eventIndexPrice(v){");
 const last=src.indexOf("function renderRecords(id,items){",first);
 assert.ok(first>=0&&last>first);
 const c=vm.runInNewContext(src.slice(first,last)+"\n({eventIndexPrice,eventPriceComparison})",{Date});
 assert.equal(c.eventIndexPrice(77579.24043478),"77,579.24043478");
 assert.equal(c.eventIndexPrice(null),"—");
 const base={openPrice:77500,expiresAt:Date.now()+600000,direction:"UP"};
 const pending=c.eventPriceComparison({...base,closePrice:null,proxyHit:null});
 assert.equal(pending.outcome,"等待10分钟到期核验");
 assert.equal(pending.change,"—");
 const win=c.eventPriceComparison({...base,closePrice:77550,proxyHit:true,proxyOutcome:"UP",
   settlementStatus:"INDEX_SIGNAL_TPLUS10_PROXY_ONLY"});
 assert.equal(win.outcome,"指数代理命中");assert.match(win.change,/^\+0\.06452%$/);
 const lose=c.eventPriceComparison({...base,closePrice:77450,proxyHit:false,proxyOutcome:"DOWN",
   settlementStatus:"INDEX_SIGNAL_TPLUS10_PROXY_ONLY"});
 assert.equal(lose.outcome,"指数代理未命中");assert.match(lose.change,/^-0\.06452%$/);
 const missing=c.eventPriceComparison({...base,settlementStatus:"UNVERIFIABLE_PRICE_NEAR_EXPIRY"});
 assert.equal(missing.outcome,"到期数据不足，无法核验");
 const flat=c.eventPriceComparison({...base,closePrice:77500,proxyHit:null,proxyOutcome:"FLAT",
   settlementStatus:"INDEX_SIGNAL_TPLUS10_PROXY_ONLY"});
 assert.match(flat.outcome,/持平/);
});
test("record cards show locked index, expiry index, net change, result and both timestamps",()=>{
 assert.ok(src.includes('"信号锁定指数价"'));
 assert.ok(src.includes('"10分钟后指数价"'));
 assert.ok(src.includes('"record-comparison"'));
 assert.ok(src.includes("r.closeObservedAt"));
 assert.ok(src.includes("state.eventRecords"));
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 for(const part of ["record-signal-grid","eRecordScroll","eRecordStatus","event-record-viewport"])
  assert.ok(html.includes(part),part);
});

test("scrolling merges 125 signal rounds, deduplicates and updates settlement",()=>{
 const from=src.indexOf("function eventVersion(r){"),to=src.indexOf("function event(e,ledger){",from);
 const api=vm.runInNewContext(
  "const EVENT10_FREQ_OPTIMIZED_VERSION="+JSON.stringify(version)+";\n"+
  src.slice(from,to)+"\n({mergeEventRecordPages,eventHistoryFingerprint})");
 const rounds=Array.from({length:125},(_,i)=>({
  ...mk("sig-"+i,version,1000000-i*60000),openPrice:77500+i,closePrice:null,proxyHit:null
 }));
 let loaded=[];
 for(let i=0;i<125;i+=25)
  loaded=api.mergeEventRecordPages(loaded,rounds.slice(i,i+25));
 assert.equal(loaded.length,125);
 assert.equal(loaded[0].id,"sig-0");
 assert.equal(loaded.at(-1).id,"sig-124");
 const settled={...rounds[0],closePrice:77650.12345,proxyHit:true};
 loaded=api.mergeEventRecordPages(loaded,[mk("newest",version,2000000),settled,rounds[1]]);
 assert.equal(loaded.length,126);
 assert.equal(loaded[0].id,"newest");
 assert.equal(loaded.find(x=>x.id==="sig-0").closePrice,77650.12345);
 assert.equal(loaded.at(-1).id,"sig-124");
 assert.ok(api.eventHistoryFingerprint(loaded).includes("77650.12345"));
});
test("finger scrolling replaces static next-page buttons and keeps newest signals up top",()=>{
 assert.ok(src.includes('addEventListener("scroll",onEventHistoryScroll'));
 assert.ok(src.includes("async function loadMoreEventSignals(){"));
 assert.ok(src.includes("state.eventRecords.length-3"));
 assert.ok(src.includes("eventHistorySignature"));
 assert.ok(src.includes("const id=first?.dataset?.eventId"));
 assert.ok(!src.includes("eRecordNext"));
 assert.ok(!src.includes("eRecordPrev"));
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 for(const piece of ["overflow-y:auto","touch-action:pan-y","eRecordScroll","eRecordStatus"])
  assert.ok(html.includes(piece),piece);
 assert.ok(!html.includes("下一页</button>"));
});

test("V16 shows unified accuracy and rejection audit without confusing signal tiers",()=>{
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 for(const id of ["eProxyAccuracy","eScanAudit","eScanGates","eFreshness"])assert.ok(html.includes('id="'+id+'"'),id);
 for(const key of ["scanDiagnostics","lastSuccessfulScanAt","eScanAudit"])assert.ok(src.includes(key),key);
 assert.ok(src.includes("指数代理"),"official event contract settlement must never be claimed");
});
test("海派事件合约 v1.3.1 retains only EVENT10 with no Guardian API or navigation",()=>{
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 const manifest=JSON.parse(fs.readFileSync(new URL("./manifest.webmanifest",import.meta.url),"utf8"));
 assert.ok(html.includes('id="panel-event10"')&&html.includes('id="panel-more"'));
 assert.ok(html.includes('data-go="event10"')&&html.includes('data-go="more"'));
 assert.ok(!html.includes('panel-guardian')&&!html.includes('data-go="guardian"'));
 assert.ok(!html.includes('panel-overview')&&!html.includes('data-go="overview"'));
 assert.ok(!html.includes('gRecords')&&!html.includes('GUARDIAN'));
 assert.ok(!src.includes('/guardian/api/status')&&!src.includes('api("/api/status",7500)'));
 assert.ok(!src.includes('function guardian(')&&!src.includes('guardianError('));
 assert.ok(src.includes('async function refreshEvent10Only(){'));
 assert.ok(src.includes('api("/event10/api/status",9000)'));
 assert.ok(src.includes('if(location.hash==="#event10")void refreshEvent10Only();'));
 assert.ok(src.includes('navigate(["event10","more"].includes(initial)?initial:"event10")'));
 assert.ok(src.includes('APP_VERSION="1.3.1"'));
 assert.equal(manifest.name,"海派事件合约");
});
test("app independently discovers current strategy from live status, verifies ledger only when available",()=>{
 assert.ok(src.includes("let EVENT10_FREQ_OPTIMIZED_VERSION=null;"));
 assert.ok(src.includes("ledger?.version!==EVENT10_FREQ_OPTIMIZED_VERSION"));
 assert.ok(src.includes("event(service,null)"));
 assert.ok(src.includes("state.eventOnline=true"));
 assert.ok(src.includes("state.eventLedgerOnline=false"));
 assert.ok(src.includes("Live direction and AI state must NEVER be blocked"));
 assert.ok(src.includes('api("/event10/api/signals?limit="+state.eventPageSize+"&offset=0",11000)'));
 assert.ok(src.includes("version!==EVENT10_FREQ_OPTIMIZED_VERSION"));
 assert.ok(src.includes("EVENT10_FREQ_OPTIMIZED_VERSION=version"));
 assert.ok(src.includes("state.eventRecords=[]"));
 assert.ok(!src.includes('const EVENT10_FREQ_OPTIMIZED_VERSION="EVENT10_FORCED_CONTRARIAN_12M_V1_20261101"'));
});

test("a slow signal-history endpoint must not hide currently available live AI signal",()=>{
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 assert.ok(html.includes('id="eConnectionDetail"'));
 assert.ok(src.includes('const stats=(currentLedger?ledger?.stats:e?.stats)||{};'));
 assert.ok(src.includes('state.eventOnline=true;state.eventLastError=null;'));
 assert.ok(src.includes('state.eventLastStatus=service'));
 assert.ok(src.includes('event(state.eventLastStatus,null)'));
 assert.ok(src.includes('信号已连接 · 记录同步中'));
 assert.ok(!src.includes('if(!currentLedger)throw Error("新策略历史接口未就绪'));
});
