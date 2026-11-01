import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {RULE_VERSION,verifiedClosedCandles,evaluatePureSignal} from "./pure-signal.mjs";
import {createEngine,scoreProxy} from "./manual-engine.mjs";
const T=Date.parse("2026-11-02T00:01:00Z");
const quote=(at=T,p=70000)=>({price:p,observedAt:at-100,source:"BINANCE_USDM_BTCUSDT_INDEX_PRICE"});
function sample(side=1,at=T,flat=false){
  const one=[],five=[];
  for(const [rows,n,ms,base] of [[one,65,60000,1000],[five,40,300000,1000]]){
    let price=base;
    const start=Math.floor(at/ms)*ms;
    for(let i=0;i<n;i++){
      const d=flat?0:side*(ms===60000?[2,-1.4,2,-0.8][i%4]:[2,-0.5,2.2,-0.3][i%4]);
      const next=price+d;
      rows.push({startMs:start-(n-i)*ms,closed:true,open:price,close:next,
        high:Math.max(price,next)+0.1,low:Math.min(price,next)-0.1,
        volume:ms===60000&&i===n-1?140:100});
      price=next;
    }
  }
  return {ok:true,readOnly:true,symbol:"BTCUSDT",
    latest:{marketFeedConnected:true},candles:{"1m":one,"5m":five}};
}
const calc=(side=1,feed=sample(side),at=T)=>evaluatePureSignal({
  feed,reference:{observedAt:at},indexSnapshot:quote(at)});
test("V1 Higher/Lower require six matching conditions",()=>{
  assert.equal(RULE_VERSION,"EVENT10_BALANCED_TREND_5M_V2_20261102");
  for(const side of [1,-1]){
    const r=calc(side);
    assert.equal(r.direction,side===1?"UP":"DOWN");
    assert.equal(r.status,"PREDICTED");
    assert.ok(Object.values(r.conditions).every(Boolean));
    assert.equal(r.evidence.referenceIsActualEventContractStrike,false);
    assert.equal(r.confidence,null);
  }
});
test("flat and insufficient volume are NO_SIGNAL, not forced Higher",()=>{
  const flat=calc(1,sample(1,T,true));assert.equal(flat.direction,null);
  assert.equal(flat.status,"NO_SIGNAL");
  const low=sample(1);low.candles["1m"].at(-1).volume=50;
  const r=calc(1,low);assert.equal(r.direction,null);
  assert.equal(r.upChecks.volume,false);
});
test("5m disagreement, overextended move and noncontiguous candles fail safely",()=>{
  const conflict=sample(1);
  conflict.candles["5m"]=sample(-1).candles["5m"];
  assert.equal(calc(1,conflict).direction,null);
  const gap=sample(1);gap.candles["1m"].at(-2).startMs+=60000;
  assert.throws(()=>calc(1,gap),/NONCONTIGUOUS/);
  const future=sample(1);future.candles["1m"].at(-1).startMs=T;
  assert.throws(()=>calc(1,future),/NONCONTIGUOUS|STALE|INSUFFICIENT/);
});
test("stale index fails and 5m candles cannot look into future",()=>{
  assert.throws(()=>evaluatePureSignal({feed:sample(),reference:{observedAt:T},
    indexSnapshot:quote(T-10000)}),/REALTIME_BINANCE_INDEX_REQUIRED/);
  assert.equal(verifiedClosedCandles(sample(),"5m",T,40).length,40);
});
function engineFixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-selective-"));
  let now=T,price=70000;
  const stateFile=path.join(dir,"sessions.json");
  const fetcher=async url=>{
    if(url.includes("shadow-market-data"))return {ok:true,json:async()=>sample(1,now)};
    if(url.includes("premiumIndex"))return {ok:true,json:async()=>({
      symbol:"BTCUSDT",indexPrice:String(price),time:now-100})};
    throw Error("UNEXPECTED_URL "+url);
  };
  const env={EVENT10_STATE_FILE:stateFile};
  return {engine:createEngine({env,clock:()=>now,fetcher}),
    setNow:x=>now=x,setPrice:x=>price=x,env,fetcher,clock:()=>now};
}
test("manual and automatic signals are version-isolated, and expire at own T+600",async()=>{
  const f=engineFixture();
  const s=await f.engine.start("manual-selective-v1-00001");
  assert.equal(s.direction,"UP");assert.equal(s.realOrderPlaced,false);
  assert.equal(s.expiresAt-s.openedAt,600000);
  assert.equal(f.engine.status().providerModel,"PURE_SIGNAL_BALANCED_TREND_V2");
  assert.equal(f.engine.signals().total,1);
  f.setNow(s.expiresAt+1000);f.setPrice(70001);await f.engine.tick();
  const row=f.engine.signals().records[0];
  assert.equal(row.closePrice,70001);assert.equal(row.proxyHit,true);
  const reboot=createEngine({env:f.env,fetcher:f.fetcher,clock:f.clock});
  assert.equal(reboot.signals().stats.proxyAccuracyPct,100);
});
test("same index price has null hit and is excluded from win rate",()=>{
  assert.equal(scoreProxy(1000,1000,"DOWN").proxyHit,null);
});
test("old strategies stay in history but cannot contaminate new accuracy",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"event10-old-"));
  const stateFile=path.join(dir,"history.json");
  fs.writeFileSync(stateFile,JSON.stringify([{id:"old-001",openedAt:T-1,
    expiresAt:T+599999,direction:"UP",status:"PREDICTED",
    decisionReviewVersion:"EVENT10_FORCED_CONTRARIAN_12M_V1_20261101",
    openPrice:1000,proxyHit:true}]));
  const e=createEngine({env:{EVENT10_STATE_FILE:stateFile},clock:()=>T});
  assert.equal(e.history().length,1);
  assert.equal(e.signals().total,0);
});

test("V2 allows near-average volume but retains both trend directions",()=>{
  const f=sample(1);
  f.candles["1m"].at(-1).volume=95;
  assert.equal(calc(1,f).direction,"UP");
  const opposing=sample(1);opposing.candles["5m"]=sample(-1).candles["5m"];
  assert.equal(calc(1,opposing).signal,"NO_SIGNAL");
});
test("auto checks at five-minute slots, no duplicate within a slot",async()=>{
  const f=engineFixture();
  const tickAt=async ms=>{
    f.setNow(ms);await f.engine.tick();
    await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
  };
  const a=T+4*60000+2000;
  await tickAt(a);
  assert.equal(f.engine.signals().total,1);
  assert.equal(f.engine.signals().records[0].id,"auto-5m-"+(Math.floor(a/300000)*300000));
  await tickAt(a+2000);
  assert.equal(f.engine.signals().total,1);
  await tickAt(a+5*60000);
  assert.equal(f.engine.signals().total,2);
  assert.equal(f.engine.status().autoIntervalMs,300000);
  assert.ok(f.engine.signals().records.every(x=>x.realOrderPlaced===false));
});
