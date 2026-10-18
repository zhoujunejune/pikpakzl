// Read-only presentation window. V1/V2 SQLite history, official backfill
// and cumulative parameter training are deliberately never reset or deleted.
// First genuinely locked Binance+Prediction V2 shadow round, October 18, 2026 18:55 CST.
export const DISPLAY_START_ROUND=1792320900000;
const number=n=>Number.isFinite(Number(n))?Math.max(0,Number(n)):0;
const group=(samples,hits)=>{
 const n=number(samples),h=Math.min(n,number(hits));
 return {samples:n,hits:h,misses:n-h,accuracy:n?h/n:null};
};
export function v1DisplaySummary(groups=[]){
 let locked=0,settled=0,hits=0;
 const sides={UP:group(0,0),DOWN:group(0,0)};
 for(const row of groups){
  if(!['UP','DOWN'].includes(row?.direction))continue;
  const total=number(row.total),n=Math.min(total,number(row.settled)),h=Math.min(n,number(row.hits));
  locked+=total;settled+=n;hits+=h;
  sides[row.direction]=group(n,h);
 }
 return {observedRounds:locked,locked,pending:locked-settled,
   overall:group(settled,hits),up:sides.UP,down:sides.DOWN};
}
export function v2DisplaySummary(row={}){
 const observed=number(row.total),n=Math.min(observed,number(row.settled));
 return {observedRounds:observed,locked:observed,pending:observed-n,
   pmOnly:group(n,row.pmHits),blend:group(n,row.blendHits)};
}
