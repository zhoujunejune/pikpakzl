import test from "node:test";
import assert from "node:assert/strict";
import {confirmedPriceStructure} from "./price-structure.mjs";
const MIN=60000;
const now=Date.parse("2026-10-24T15:00:00Z");
const make=()=>Array.from({length:100},(_,i)=>{
 const t=now-(100-i)*MIN;
 const c=100000+55*Math.sin(i*0.35);
 return {t,c:Math.round(c*100)/100,h:c+16,l:c-16,v:1};
});
test("confirmed support and resistance only from 100 closed contiguous minute bars",()=>{
 const rows=make();
 const d=confirmedPriceStructure(rows,100000,now,29);
 assert.equal(d.source,"SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES");
 assert.ok(d.adaptiveLookbackBars>=40&&d.adaptiveLookbackBars<=90);
 assert.ok(d.nearestSupport?.price<100000);
 assert.ok(d.nearestResistance?.price>100000);
 assert.equal(d.lastFiveMoves.up+d.lastFiveMoves.down+d.lastFiveMoves.flat,5);
 assert.equal(d.lastClosedCandleAt,now);
 assert.equal(d.confirmedThreeBarBreakout,"NONE");
});
test("never accept future, gapped or unclosed candles into price zones",()=>{
 const rows=make();
 const withFuture=confirmedPriceStructure([...rows,{...rows.at(-1),t:now}],100000,now,29);
 const normal=confirmedPriceStructure(rows,100000,now,29);
 assert.deepEqual(withFuture,normal); // future closed candle excluded, never consumed
 const gap=make();gap[90].t+=1000;
 assert.equal(confirmedPriceStructure(gap,100000,now,29),null);
 assert.equal(confirmedPriceStructure(rows,100000,now+500000,29),null);
});
test("breakout requires three CLOSED confirmations, one spike never enough",()=>{
 const rows=make();
 for(let k=0;k<3;k++){
  const r=rows[97+k];
  r.c=100400+40*k;r.h=r.c+10;r.l=r.c-10;
 }
 const yes=confirmedPriceStructure(rows,100480,now,28);
 assert.equal(yes.confirmedThreeBarBreakout,"UP");
 const no=make();
 no[99].c=100900;no[99].h=100910;
 assert.equal(confirmedPriceStructure(no,100900,now,28).confirmedThreeBarBreakout,"NONE");
});
test("no look-ahead into settling tick; intervals are determined by closed bar times",()=>{
 const rows=make();
 const a=confirmedPriceStructure(rows,100010,now,28);
 assert.equal(a.lastClosedCandleAt,now);
 const prior=confirmedPriceStructure(rows,100010,now-1,28);
 assert.equal(prior.lastClosedCandleAt,now-60000);
 assert.ok(prior.lastClosedCandleAt<=now-1);
});
