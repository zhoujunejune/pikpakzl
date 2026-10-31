import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src=fs.readFileSync(new URL("./app.js",import.meta.url),"utf8");
const version="EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101";
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
 assert.ok(html.includes("频率优化策略信号记录"));
 assert.ok(!html.includes("历史信号（新旧策略）"));
});

test("price comparison uses frozen index reference and exact settlement values",()=>{
 const first=src.indexOf("function eventIndexPrice(v){");
 const last=src.indexOf("function renderRecords(id,items,kind){",first);
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
 assert.ok(src.includes("state.eventOffset"));
 const html=fs.readFileSync(new URL("./index.html",import.meta.url),"utf8");
 for(const part of ["record-signal-grid","eRecordPrev","eRecordNext","eRecordPage"])
  assert.ok(html.includes(part),part);
});
