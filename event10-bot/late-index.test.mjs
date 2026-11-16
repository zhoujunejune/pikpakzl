import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,parseBinanceIndexQuote,parseBinanceIndexKlines} from "./pure-signal.mjs";
import {createEngine} from "./manual-engine.mjs";

const cycle=Date.parse("2026-10-30T00:00:00.000Z");
const instant=cycle+450_000;
const indexBars=(side=1)=>Array.from({length:12},(_,i)=>{
  const minute=i-4,p=100000+side*(Math.max(0,minute)*19);
  let o=p,c=p,h=p+25,l=p-25;
  if(minute===7){
    o=100000+side*142;c=100000+side*150;
    h=Math.max(o,c)+12;l=Math.min(o,c)-12;
  }
  return {at:cycle+minute*60000,open:o,high:h,low:l,close:c};
});
const evaluate=({side=1,now=instant,overridePrice=null,book=true,bars=indexBars(side)}={})=>
  evaluatePureSignal({reference:{observedAt:now},
    indexSnapshot:{price:overridePrice??100000+side*150,observedAt:now-500},
    indexKlines:{rows:bars,observedAt:now-100},
    orderBook:book?{observedAt:now-100,
      bidTop5QtyBtc:side>0?10:5,askTop5QtyBtc:side>0?5:10}:null});

test("7–8.5m and all five gates: UP and DOWN, never a trade",()=>{
  const up=evaluate(),down=evaluate({side:-1});
  assert.equal(RULE_VERSION,"EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031");
  assert.equal(up.direction,"UP");assert.equal(down.direction,"DOWN");
  assert.deepEqual(Object.values(up.conditions),Array(5).fill(true));
  assert.deepEqual(Object.values(down.conditions),Array(5).fill(true));
  assert.equal(up.evidence.referenceIsActualEventContractStrike,false);
});
test("fail closed outside window, below 0.10%, no depth, no opening index",()=>{
  assert.equal(evaluate({now:cycle+419999}).direction,null);
  assert.equal(evaluate({now:cycle+510000}).direction,null);
  assert.equal(evaluate({overridePrice:100050}).direction,null);
  assert.equal(evaluate({book:false}).direction,null);
  assert.equal(evaluate({bars:indexBars().filter(x=>x.at!==cycle)}).direction,null);
});
test("strict index freshness and complete 1m-index KL validation",()=>{
  assert.throws(()=>parseBinanceIndexQuote({symbol:"BTCUSDT",indexPrice:"100150",time:instant-7000},instant),/STALE/);
  assert.throws(()=>parseBinanceIndexKlines([],instant),/INDEX_KLINES/);
  const rows=indexBars().map(x=>[x.at,String(x.open),String(x.high),String(x.low),String(x.close)]);
  assert.equal(parseBinanceIndexKlines(rows,instant).rows.length,12);
});
test("independent signal-to-600s index comparison, no official event order",async()=>{
  let now=instant,price=100150;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"event10-late-"));
  const stateFile=path.join(tmp,"history.json");
  const json=x=>({ok:true,status:200,json:async()=>x});
  const fetcher=async url=>{
    if(url.includes("/fapi/v1/premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(price),time:now-300});
    if(url.includes("/fapi/v1/indexPriceKlines"))return json(indexBars().map(x=>[
      x.at,String(x.open),String(x.high),String(x.low),String(x.close),"0",x.at+59999
    ]));
    if(url.includes("/fapi/v1/depth"))return json({
      bids:Array.from({length:5},(_,i)=>[String(100130-i),String(5)]),
      asks:Array.from({length:5},(_,i)=>[String(100131+i),"1"])
    });
    throw Error("UNEXPECTED_ENDPOINT_"+url);
  };
  const e=createEngine({env:{EVENT10_STATE_FILE:stateFile},clock:()=>now,fetcher});
  const signal=await e.start("manual-late-signal-001");
  assert.equal(signal.direction,"UP");
  assert.equal(signal.openPrice,100150);
  assert.equal(signal.cycleOpenIndexPrice,100000);
  assert.equal(signal.liveIndexPrice,100150);
  assert.equal(signal.expiresAt,signal.openedAt+600000);
  assert.equal(signal.model,"PURE_SIGNAL_INDEX_TPLUS10_V3");
  assert.equal(signal.realOrderPlaced,false);
  assert.equal(e.status().autoTradingEnabled,false);
  assert.equal(e.signals().stats.total,1);
  now=cycle+600500;price=100130;
  await e.tick();
  assert.equal(e.signals().records[0].proxyHit,null); // old UTC cycle already ended
  assert.equal(e.signals().stats.proxySettled,0); // but signal has not reached T+600
  now=signal.expiresAt+800;price=100130;
  await e.tick();
  const last=e.history(20).find(x=>x.id===signal.id);
  assert.equal(last.settlementStatus,"INDEX_SIGNAL_TPLUS10_PROXY_ONLY");
  assert.equal(last.proxyHit,false); // Higher loses against locked 100150
  assert.equal(last.officialEventHit,null);
  assert.equal(e.signals().stats.proxySettled,1);
  assert.equal(e.signals().stats.proxyHits,0);
  assert.equal(e.signals().records[0].leadPct,0.15);
  assert.ok(JSON.parse(fs.readFileSync(stateFile,"utf8")).some(x=>x.id===signal.id));
});
