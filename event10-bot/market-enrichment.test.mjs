import test from "node:test";
import assert from "node:assert/strict";
import {collectPublicFeatures,tenMinuteWindow,ENRICHMENT_NAMES} from "./market-enrichment.mjs";
const NOW=Date.parse("2026-10-24T02:00:00Z");
const rows=Array.from({length:25},(_,i)=>{
 const t=NOW-(25-i)*60000;
 return {startMs:t,open:100000+i*2,high:100120+i*2,
   low:99950+i*2,close:100030+i*2,volume:100+i,closed:true};
});
const feed={candles:{"1m":{items:rows}}};
const klines=Array.from({length:45},(_,i)=>{
 const t=NOW-((45-i)*900000);
 return [t,"100000","100200","99900",String(100010+i), "12",t+899999];
});
const testJson=(data)=>({ok:true,json:async()=>data});
function payload(url,now){
 if(url.includes("interval=15m"))return klines;
 if(url.includes("depth"))return {T:now-2000,E:now-2000,
  bids:Array.from({length:20},(_,i)=>[String(100000-i*0.1),"1"]),
  asks:Array.from({length:20},(_,i)=>[String(100000.1+i*0.1),"2"])};
 if(url.includes("aggTrades"))return Array.from({length:15},(_,i)=>({
  T:now-10000+i*350,p:"100000",q:"1.5",m:i%2===0
 }));
 if(url.includes("premiumIndex"))return {time:now-1100,indexPrice:"100010",
  markPrice:"100000",lastFundingRate:"0.0001",nextFundingTime:now+500000};
 if(url.includes("openInterestHist"))return [
  {timestamp:now-600000,sumOpenInterest:"1000"},
  {timestamp:now-300000,sumOpenInterest:"1100"}];
 if(url.includes("openInterest"))return {time:now-2200,openInterest:"1101"};
 throw Error("UNKNOWN_FIXTURE_ENDPOINT");
}
test("rolling ten minutes requires ten consecutive CLOSED 1-minute bars",()=>{
 const d=tenMinuteWindow(feed,NOW);
 assert.equal(d.closed1mBars,10);
 assert.equal(d.until,NOW);
 assert.ok(d.volume>0);
 const broken=structuredClone(feed);
 broken.candles["1m"].items.splice(-4,1);
 assert.throws(()=>tenMinuteWindow(broken,NOW),/GAPPED_ROLLING_10M_CANDLES/);
});
test("all six Binance futures public input families validated without any signed order endpoint",async()=>{
 const seen=[];
 const d=await collectPublicFeatures({now:()=>NOW,fetcher:async url=>{
  seen.push(url);
  return testJson(payload(url,NOW));
 }});
 assert.equal(d.available,6);
 assert.deepEqual(Object.keys(d.features).sort(), [...ENRICHMENT_NAMES].sort());
 assert.ok(d.features.orderBook.imbalanceTop20<0);
 assert.ok(d.features.aggressiveFlow.takerBuyFraction>0);
 assert.equal(d.features.aggressiveFlow.verifiedPriceResponse,false);
 assert.equal(d.features.aggressiveFlow.futuresPriceMovePct,null);
 assert.equal(d.features.futuresIndex.indexPrice,100010);
 assert.equal(d.features.fifteenMinute.candles,45);
 assert.equal(d.features.openInterestChange.change5mPct,10);
 for(const url of seen){
   assert.ok(url.startsWith("https://fapi.binance.com/"));
   assert.doesNotMatch(url,/\/order(?:\?|$)|\/balance|\/account|\/leverage/);
 }
});
test("451/418/timeout and malformed timestamps are explicitly marked unavailable",async()=>{
 const d=await collectPublicFeatures({now:()=>NOW,fetcher:async url=>{
  if(url.includes("depth"))return {ok:false,status:451};
  if(url.includes("aggTrades"))return {ok:false,status:418};
  if(url.includes("premiumIndex"))return testJson({...payload(url,NOW),time:NOW-500000});
  return testJson(payload(url,NOW));
 }});
 assert.equal(d.available,3);
 assert.equal(d.availability.orderBook.error,"REGION_RESTRICTED_451");
 assert.equal(d.availability.aggressiveFlow.error,"IP_BLOCK_418");
 assert.equal(d.availability.futuresIndex.error,"INDEX_STALE");
 assert.equal(d.features.futuresIndex,undefined);
});
test("source data from one-off sample does not claim official event-contract settlement",async()=>{
 const d=await collectPublicFeatures({now:()=>NOW,fetcher:async url=>testJson(payload(url,NOW))});
 assert.equal(d.eventsContractIndexOfficial,false);
 assert.match(d.caveats.join(" "),/not authenticated Event Contract/);
 assert.match(d.features.orderBook.caveat,/cancelled/);
 assert.match(d.features.aggressiveFlow.caveat,/not full/);
});
