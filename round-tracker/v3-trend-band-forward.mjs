// Strict-forward audit of V3's FIRST eligible 0.4–0.6 trend-band shadow freeze.
// Read-only training metrics: no changes to production signal or order routing.
export const VERSION='V3_TREND_BAND_FORWARD_V1';
export const FORWARD_START_MS=Date.parse('2026-10-09T05:22:00.000Z');
const finite=x=>x==null||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
const pct=(h,n)=>n?Number((h/n).toFixed(4)):null;
const metric=(arr)=>{let hits=arr.filter(r=>r.v3TrendBandForward.direction===r.actual).length;
 return {samples:arr.length,hits,misses:arr.length-hits,accuracy:pct(hits,arr.length)};};
export function freezeV3TrendBand(row,facts,now=Date.now()){
 const s=finite(row?.roundStartMs),f=facts?.v3TrendBandShadow;
 if(s==null||s<FORWARD_START_MS||!f||f.frozen!==true||f.eligible!==true||
    f.productionEffect!=='NONE_SHADOW_ONLY')return null;
 const time=finite(f.observedAt),score=finite(f.score),threshold=finite(f.threshold);
 const d=f.direction;
 if(time==null||score==null||threshold==null||threshold!==0.6||
    time<s||time>=s+300000||time>now||now>=s+300000||now<time||
    finite(f.round)!==s|| !['UP','DOWN'].includes(d) ||
    (d==='UP' ? score<0.4||score>=0.6 : score>-0.4||score<=-0.6))
   return null;
 // First-eligible V3 fact survives later raw locks. No settlement-time sampling.
 return {version:VERSION,round:s,direction:d,sourceObservedAt:time,
   recordedAt:now,score,threshold,inputFrozenBeforeSettlement:true,
   productionEffect:'NONE_SHADOW_ONLY'};
}
export function summarizeV3TrendBand(rounds){
 const rows=Array.from(rounds?.values?.()||[]);
 const settled=rows.filter(r=>Number(r.roundStartMs)>=FORWARD_START_MS&&
   (r.actual==='UP'||r.actual==='DOWN')&&r.officialDirection===r.actual&&
   String(r.resolutionEvidence||'').startsWith('OFFICIAL_'+r.actual+':')&&
   String(r.resolutionEvidence||'').includes('STRICT_ROUND_ALIGNED_TOPIC'));
 const eligible=settled.filter(r=>{
   const s=finite(r.roundStartMs),f=r.v3TrendBandForward;
   return f?.version===VERSION&&f.inputFrozenBeforeSettlement===true&&
     f.productionEffect==='NONE_SHADOW_ONLY'&&f.round===s&&
     ['UP','DOWN'].includes(f.direction)&&
     finite(f.sourceObservedAt)!=null&&finite(f.recordedAt)!=null&&
     f.sourceObservedAt>=s&&f.sourceObservedAt<=f.recordedAt&&
     f.recordedAt<s+300000&&f.sourceObservedAt<s+300000&&
     (f.direction==='UP'?f.score>=0.4&&f.score<0.6:
       f.score<=-0.4&&f.score> -0.6);
 }).sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
 const up=eligible.filter(r=>r.v3TrendBandForward.direction==='UP');
 const down=eligible.filter(r=>r.v3TrendBandForward.direction==='DOWN');
 const recent20=eligible.slice(-20);
 // Count additional decisions only where production actually emitted no signal.
 const extra=eligible.filter(r=>r.productionPrediction!=='UP'&&r.productionPrediction!=='DOWN');
 const all=metric(eligible),r20=metric(recent20),u=metric(up),d=metric(down);
 const r10=metric(eligible.slice(-10));
 const u6=metric(up.slice(-6)),d6=metric(down.slice(-6));
 let streak=0,maxConsecutiveMisses=0;
 for(const r of eligible){if(r.v3TrendBandForward.direction!==r.actual){streak++;maxConsecutiveMisses=Math.max(maxConsecutiveMisses,streak);}else streak=0;}
 const qualified=all.samples>=60&&all.accuracy>=0.75&&r20.samples>=20&&
   r20.accuracy>=0.75&&r10.samples>=10&&r10.accuracy>=0.70&&u.samples>=10&&d.samples>=10&&
   u.accuracy>=0.70&&d.accuracy>=0.70&&u6.samples>=6&&d6.samples>=6&&
   u6.accuracy>=0.70&&d6.accuracy>=0.70&&maxConsecutiveMisses<=2;
 return {version:VERSION,scope:'OFFICIAL_SETTLED_STRICT_FORWARD_FIRST_ELIGIBLE',
   prospectiveStartMs:FORWARD_START_MS,observedOfficialSettledRounds:settled.length,
   eligible:all,recent10:r10,recent20:r20,up:u,down:d,upRecent6:u6,downRecent6:d6,maxConsecutiveMisses,
   incrementalOverProduction:metric(extra),
   eligibleCoverage:pct(eligible.length,settled.length),
   incrementalCoverage:pct(extra.length,settled.length),
   status:qualified?'ELIGIBLE_FOR_INDEPENDENT_REVIEW':
     all.samples<60?'COLLECTING':'FORWARD_COMPLETE_NOT_QUALIFIED',
   required:{samples:60,overallAccuracy:0.75,recent20Accuracy:0.75,recent10Accuracy:0.70,
     eachDirectionAccuracy:0.70,eachDirectionSamples:10,eachDirectionRecent6Accuracy:0.70,maxConsecutiveMisses:2},
   productionEffect:'NONE_SHADOW_ONLY',autoProduction:false};
}
