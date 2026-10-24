// Same-reference 1m price structure from already verified CLOSED candles.
// Adapted in concept from dynamic support/resistance Pine indicators.
// No external model, trading rules, future bars or automatic direction votes.
const finite=Number.isFinite;
const round=(x,n=4)=>Number(x.toFixed(n));
const levels=(prices,tolerance)=>{
 const clusters=[];
 for(const p of [...prices].sort((a,b)=>a-b)){
  const last=clusters.at(-1);
  if(last&&Math.abs(p-last.price)<=tolerance){
   last.price=(last.price*last.pivots+p)/(last.pivots+1);
   last.pivots++;
  }else clusters.push({price:p,pivots:1});
 }
 return clusters.map(c=>({price:round(c.price,2),pivots:c.pivots}));
};
export function confirmedPriceStructure(closed1m,referencePrice,asOf,atr1m){
 if(!Array.isArray(closed1m)||closed1m.length<45||
    !finite(referencePrice)||referencePrice<=0||
    !finite(atr1m)||atr1m<=0||!Number.isSafeInteger(asOf))
   return null;
 // Price tick may precede the most recently closed candle by milliseconds.
 // Drop any candle closing AFTER the locked tick; never let newer bars enter AI.
 const rows=closed1m.filter(r=>Number.isSafeInteger(r?.t)&&r.t>0&&
   r.t+60000<=asOf).sort((a,b)=>a.t-b.t).slice(-100);
 if(rows.length<45||rows.some((r,i)=>
    (i>0&&r.t-rows[i-1].t!==60000)||
    ![r.c,r.h,r.l,r.v].every(finite)||
    r.c<=0||r.h<r.l||r.v<0)||
    asOf-(rows.at(-1).t+60000)>120000)
   return null;
 const recentRange=rows.slice(-20).reduce((v,r)=>v+r.h-r.l,0)/20;
 const prior=rows.slice(-70,-20);
 const baselineRange=prior.reduce((v,r)=>v+r.h-r.l,0)/prior.length;
 const ratio=baselineRange>0?recentRange/baselineRange:1;
 const lookback=ratio>1.25?90:ratio<0.8?45:60;
 const segment=rows.slice(-lookback);
 const pivotStrength=3;
 const high=[],low=[];
 // Confirmed pivots require three CLOSED 1m bars on the right. No hindsight.
 for(let i=pivotStrength;i<segment.length-pivotStrength;i++){
  const r=segment[i];
  const neighbors=segment.slice(i-pivotStrength,i+pivotStrength+1);
  if(neighbors.every((x,j)=>j===pivotStrength||r.h>x.h))high.push(r.h);
  if(neighbors.every((x,j)=>j===pivotStrength||r.l<x.l))low.push(r.l);
 }
 const tolerance=Math.max(atr1m*0.6,referencePrice*0.0002);
 const supports=levels(low,tolerance).filter(x=>x.price<referencePrice);
 const resistances=levels(high,tolerance).filter(x=>x.price>referencePrice);
 const support=supports.at(-1)||null,resistance=resistances[0]||null;
 const d=segment.slice(-6).map(x=>x.c);
 const moves=d.slice(1).map((v,i)=>Math.sign(v-d[i]));
 const up=moves.filter(x=>x>0).length,down=moves.filter(x=>x<0).length;
 const last3=segment.slice(-3),before=segment.slice(-23,-3);
 const priorHigh=Math.max(...before.map(x=>x.h));
 const priorLow=Math.min(...before.map(x=>x.l));
 const bullishBreakout=last3.every(x=>x.c>priorHigh);
 const bearishBreakout=last3.every(x=>x.c<priorLow);
 const persistence=last3[2].c>last3[1].c&&last3[1].c>last3[0].c?"UP":
   last3[2].c<last3[1].c&&last3[1].c<last3[0].c?"DOWN":"MIXED";
 return {
  source:"SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES",
  lastClosedCandleAt:rows.at(-1).t+60000,
  adaptiveLookbackBars:lookback,pivotStrength,
  nearestSupport:support?{price:support.price,pivotCount:support.pivots,
    distanceAtr:round((referencePrice-support.price)/atr1m,3)}:null,
  nearestResistance:resistance?{price:resistance.price,pivotCount:resistance.pivots,
    distanceAtr:round((resistance.price-referencePrice)/atr1m,3)}:null,
  lastFiveMoves:{up,down,flat:5-up-down},
  lastThreeClosedBarsTrend:persistence,
  confirmedThreeBarBreakout:bullishBreakout?"UP":bearishBreakout?"DOWN":"NONE",
  structureQuality:high.length+low.length>0?"PIVOTS_OBSERVED":"NO_CONFIRMED_PIVOTS",
  caveat:"Descriptive closed-candle support/resistance and persistence only; correlated with price momentum. Zones may fail in one-sided trends. No directional order or guarantee."
 };
}