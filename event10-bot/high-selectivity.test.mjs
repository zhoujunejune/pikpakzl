import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {evaluatePureSignal,RULE_VERSION,parseTop5Depth,parseAggressiveStreak,parseFuturesCurrentMinute} from "./pure-signal.mjs";
import {createEngine} from "./manual-engine.mjs";

const NOW=Date.parse("2026-10-31T08:14:30Z");
const STEPS=[1,-0.6,1,1,-0.6];
function candles(interval,side=1,at=NOW){
  const closeAt=Math.floor(at/interval)*interval;
  let price=1000;const out=[];
  for(let i=0;i<100;i++){
    const open=price;
    price+=side*(interval===60000?STEPS[i%STEPS.length]:0.8);
    out.push({startMs:closeAt-(100-i)*interval,open,close:price,
      high:Math.max(open,price)+0.1,low:Math.min(open,price)-0.1,
      volume:interval===60000&&i===99?170:100,closed:true});
  }
  return out;
}
function feed(side=1,at=NOW){
  const one=candles(60000,side,at),five=candles(300000,side,at);
  return {ok:true,readOnly:true,symbol:"BTCUSDT",
    latest:{lastPrice:one.at(-1).close+side*0.2,eventMs:at-300,marketFeedConnected:true},
    candles:{"1m":one,"5m":five}};
}
function book(side=1,at=NOW){
  return parseTop5Depth({
    bids:Array.from({length:5},(_,i)=>[String(999-i),String(side===1?5:1)]),
    asks:Array.from({length:5},(_,i)=>[String(1001+i),String(side===1?1:5)]),
    T:at-500
  },at);
}
function liveMinute(side=1,at=NOW,volume=170){
  return {observedAt:at-100,minuteStart:Math.floor(at/60000)*60000,
    open:1000,close:1000+side,volume,mean20:100};
}
function evaluate(side=1,at=NOW){
  return evaluatePureSignal({feed:feed(side,at),reference:{observedAt:at},
    indexSnapshot:{price:100120,observedAt:at-300},orderBook:book(side,at),futuresMinute:liveMinute(side,at)});
}
test("Excel six hard gates Higher and Lower at any minute of UTC cycle",()=>{
  const up=evaluate(1),down=evaluate(-1);
  assert.equal(RULE_VERSION,"EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101");
  assert.equal(up.direction,"UP");assert.equal(down.direction,"DOWN");
  assert.equal(up.status,"PREDICTED");
  assert.equal(Object.keys(up.conditions).length,6);
  assert.ok(Object.values(up.conditions).every(Boolean));
  assert.ok(Object.values(down.conditions).every(Boolean));
  assert.ok(up.evidence.volumeRatio>=1.15&&up.evidence.rsi14>=45&&up.evidence.rsi14<=78);
  assert.ok(down.evidence.rsi14>=22&&down.evidence.rsi14<=55);
  assert.equal(up.lateWindow,false);
  assert.equal(up.evidence.referenceIsActualEventContractStrike,false);
});
test("any missing mandatory gate yields WAIT/NO_SIGNAL and is never forced",()=>{
  const healthy=feed(),quiet=structuredClone(healthy);
  quiet.candles["1m"].at(-1).volume=110;
  const args={reference:{observedAt:NOW},indexSnapshot:{price:100120,observedAt:NOW-300}};
  const lowVolume=evaluatePureSignal({...args,feed:quiet,orderBook:book(),futuresMinute:liveMinute(1,NOW,110)});
  assert.equal(lowVolume.direction,null);assert.equal(lowVolume.signal,"NO_SIGNAL");
  assert.equal(lowVolume.upChecks.volume,false);
  const wrongBook=evaluatePureSignal({...args,feed:healthy,orderBook:book(-1),futuresMinute:liveMinute()});
  assert.equal(wrongBook.direction,null);assert.equal(wrongBook.upChecks.orderflow,false);
  const missingBook=evaluatePureSignal({...args,feed:healthy,futuresMinute:liveMinute()});
  assert.equal(missingBook.direction,null);
  const badFive=structuredClone(healthy);
  badFive.candles["5m"].at(-1).close=badFive.candles["5m"].at(-1).open-0.2;
  badFive.candles["5m"].at(-1).low=badFive.candles["5m"].at(-1).close-0.1;
  assert.equal(evaluatePureSignal({...args,feed:badFive,orderBook:book(),futuresMinute:liveMinute()}).direction,"UP");
});
test("aggressive trades cannot bypass spreadsheet mandatory orderbook gate",()=>{
  const mk=(isSell)=>[1,2,3].map((i)=>({T:NOW-1700+i*200,p:"1000",q:"0.1",m:isSell,a:i}));
  const flowBuy=parseAggressiveStreak(mk(false),NOW);
  const flowSell=parseAggressiveStreak(mk(true),NOW);
  assert.equal(flowBuy.consecutiveTakerBuys,3);
  assert.equal(flowSell.consecutiveTakerSells,3);
  const common={reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-300}};
  assert.equal(evaluatePureSignal({...common,feed:feed(1),aggressiveFlow:flowBuy,futuresMinute:liveMinute()}).direction,null);
  assert.equal(evaluatePureSignal({...common,feed:feed(-1),aggressiveFlow:flowSell,futuresMinute:liveMinute(-1)}).direction,null);
  assert.equal(evaluatePureSignal({...common,feed:feed(1),
    aggressiveFlow:{...flowBuy,lastTradeAt:NOW-9000},futuresMinute:liveMinute()}).direction,null);
});
test("only fully closed contiguous candles, valid fresh index and spot quote count",()=>{
  const bad=feed();bad.candles["1m"].at(-1).closed=false;
  assert.throws(()=>evaluatePureSignal({feed:bad,reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-300},orderBook:book(),futuresMinute:liveMinute()}),/STALE_1m_CANDLES/);
  assert.throws(()=>evaluatePureSignal({feed:feed(),reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-10000},orderBook:book(),futuresMinute:liveMinute()}),/REALTIME_BINANCE_INDEX_REQUIRED/);
});
test("auto/manual signal persisted and index proxy settles at own T+600; no order",async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"event10-six-"));
  let now=NOW,price=100120;
  const json=x=>({ok:true,status:200,json:async()=>x});
  const fetcher=async url=>{
    if(url.includes("/fapi/v1/klines?"))return json(Array.from({length:22},(_,i)=>{
      const t=Math.floor(now/60000)*60000-(21-i)*60000;
      return [t,"1000","1002","999","1001",String(i===21?170:100)];
    }));
    if(url.includes("shadow-market-data"))return json(feed(1,now));
    if(url.includes("premiumIndex"))return json({symbol:"BTCUSDT",indexPrice:String(price),time:now-300});
    if(url.includes("indexPriceKlines"))return json(Array.from({length:12},(_,i)=>[
      Math.floor(now/60000)*60000-(12-i)*60000,"100000","100010","99990","100000"
    ]));
    if(url.includes("/depth"))return json({bids:Array.from({length:5},(_,i)=>[String(999-i),"5"]),
      asks:Array.from({length:5},(_,i)=>[String(1001+i),"1"])});
    if(url.includes("aggTrades"))return {ok:false,status:451};
    throw Error("UNEXPECTED_URL "+url);
  };
  const engine=createEngine({clock:()=>now,fetcher,
    env:{EVENT10_STATE_FILE:path.join(temp,"sessions.json")}});
  const session=await engine.start("manual-six-test-12345");
  assert.equal(session.direction,"UP");
  assert.equal(session.openPrice,price);
  assert.equal(session.expiresAt,now+600000);
  assert.equal(session.ruleChecks.conditions.volume,true);
  assert.equal(engine.signals().stats.total,1);
  assert.equal(engine.signals().records[0].sixOfSix,true);
  assert.equal(engine.status().providerModel,"PURE_SIGNAL_FREQ_OPTIMIZED_V2");
  assert.equal(engine.status().autoTradingEnabled,false);
  assert.equal(session.realOrderPlaced,false);
  now+=600800;price=100110;
  await engine.tick();
  assert.equal(engine.signals().records[0].proxyHit,false);
  assert.equal(engine.signals().records[0].settlementStatus,"INDEX_SIGNAL_TPLUS10_PROXY_ONLY");
  assert.equal(engine.signals().stats.proxySettled,1);
  assert.equal(engine.signals().records[0].strategyVersion,RULE_VERSION);
});

test("Excel 1.15x threshold and near-balanced depth pass with six gates",()=>{
  const f=feed(1);f.candles["1m"].at(-1).volume=116;
  const b=parseTop5Depth({bids:Array.from({length:5},(_,i)=>[String(999-i),"9.7"]),
    asks:Array.from({length:5},(_,i)=>[String(1001+i),"10"]),T:NOW-200},NOW);
  const r=evaluatePureSignal({feed:f,reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-100},orderBook:b,futuresMinute:liveMinute(1,NOW,116)});
  assert.equal(r.direction,"UP");assert.ok(r.evidence.bidAskRatio>0.95);
  assert.equal(r.evidence.volumeBasis,"CURRENT_USDM_FUTURES_1M");
});
test("Excel current forming 1m volume, bullish current body, and RSI boundaries are audited",()=>{
  const f=feed(1), spot=f.latest.lastPrice;
  f.candles["1m"].push({startMs:Math.floor(NOW/60000)*60000,
    open:spot-1,high:spot+0.1,low:spot-2,close:spot,
    volume:125,closed:false});
  f.candles["1m"].at(-2).volume=100;
  const r=evaluatePureSignal({feed:f,reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-300},orderBook:book(),futuresMinute:liveMinute(1,NOW,125)});
  assert.equal(r.direction,"UP");
  assert.equal(r.evidence.volumeBasis,"CURRENT_USDM_FUTURES_1M");
  assert.ok(r.evidence.liveCandleUp);
  assert.equal(r.evidence.volumeCurrentOrLastClosed1m,125);
});

test("missing live forming USD-M minute never falls back to the last closed spot candle",()=>{
  assert.throws(()=>evaluatePureSignal({feed:feed(),reference:{observedAt:NOW},
    indexSnapshot:{price:100120,observedAt:NOW-300},orderBook:book()}),
    /CURRENT_USDM_1M_VOLUME_REQUIRED/);
});
test("USD-M current minute volume versus 20 valid closed minutes",()=>{
  const start=Math.floor(NOW/60000)*60000;
  const klines=Array.from({length:22},(_,i)=>[start-(21-i)*60000,"1000","1002","999","1001",String(i===21?125:100)]);
  const x=parseFuturesCurrentMinute(klines,NOW);
  assert.equal(x.volume,125);assert.equal(x.mean20,100);
  assert.equal(x.minuteStart,start);
  assert.throws(()=>parseFuturesCurrentMinute(klines.slice(0,-1),NOW),/CURRENT_MISSING/);
});
