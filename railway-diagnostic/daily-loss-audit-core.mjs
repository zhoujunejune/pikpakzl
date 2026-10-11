// Pure, side-effect-free validation and hypothetical-order calculations.
// This file MUST NOT send orders or modify the live trading decision path.
export const DAILY_LOSS_AUDIT_TZ = 'Asia/Shanghai';
export const STAKE_TESTS_USDT = [1, 2, 5];
const TWO_DAYS_MS = 86400000;
function number(value, label, min=-Infinity) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(label+'_MISSING');
  const raw=String(value).trim();
  if (!/^-?\d+(?:\.\d{1,12})?$/.test(raw)) throw new Error(label+'_INVALID');
  const n=Number(raw);
  if (!Number.isFinite(n) || n<min) throw new Error(label+'_INVALID');
  return n;
}
export function shanghaiDay(epochMs=Date.now()) {
  if (!Number.isFinite(epochMs)) throw new Error('INVALID_DATE');
  return new Date(epochMs+8*3600000).toISOString().slice(0,10);
}
export function previousShanghaiDay(epochMs=Date.now()) {
  return shanghaiDay(epochMs-TWO_DAYS_MS);
}
export function parseSettlementTime(row) {
  const value=row?.settledDate ?? row?.settlementTime ?? row?.settledAt;
  if (value===null||value===undefined||value==='') throw new Error('SETTLEMENT_TIMESTAMP_MISSING');
  const n=Number(value);
  let ms;
  if (Number.isFinite(n) && n>0) ms=n<1e11?Math.trunc(n*1000):Math.trunc(n);
  else ms=Date.parse(String(value));
  if (!Number.isFinite(ms) || ms<1600000000000 || ms>Date.now()+60000) throw new Error('SETTLEMENT_TIMESTAMP_INVALID');
  return ms;
}
export function stablePositionKey(row) {
  // Only rely on official identifiers; multiple fills/positions may share a topic.
  const id=row?.positionId ?? row?.walletPositionId ?? row?.id ?? row?.tokenId;
  if (id===undefined||id===null||String(id).trim()==='') throw new Error('POSITION_ID_MISSING');
  return String(id)+'@'+String(parseSettlementTime(row));
}
export function collectOfficialSettlements(rows,day,nowMs=Date.now()) {
  if (!Array.isArray(rows)) throw new Error('SETTLEMENT_ITEMS_NOT_ARRAY');
  const seen=new Map();
  const issues=[];
  for(const row of rows){
    const ms=parseSettlementTime(row);
    if(ms>nowMs+60000)throw new Error('FUTURE_SETTLEMENT');
    if(shanghaiDay(ms)!==day)continue;
    const k=stablePositionKey(row);
    const amount=number(row.realizedPnl,'REALIZED_PNL');
    const item={id:k,pnlUsdt:amount,settledAt:ms,marketTopicId:row.marketTopicId==null?null:String(row.marketTopicId)};
    if(seen.has(k)){
      if(Math.abs(seen.get(k).pnlUsdt-amount)>0.00000001) issues.push('POSITION_DUPLICATE_CONFLICT');
      else issues.push('POSITION_DUPLICATE_SOURCE');
      continue;
    }
    seen.set(k,item);
  }
  const out=Array.from(seen.values()).sort((a,b)=>a.id.localeCompare(b.id));
  const realizedPnlUsdt=Math.round(out.reduce((sum,x)=>sum+x.pnlUsdt,0)*100000000)/100000000;
  if(!Number.isFinite(realizedPnlUsdt))throw new Error('REALIZED_TOTAL_INVALID');
  return {rows:out,realizedPnlUsdt,issues,settlementCount:out.length};
}
export function compareOfficialScopes(narrow,wide) {
  const errors=[...narrow.issues,...wide.issues];
  const ids=new Map(wide.rows.map(x=>[x.id,x.pnlUsdt]));
  for (const x of narrow.rows){
    if(!ids.has(x.id))errors.push('SCOPE_ROW_MISSING');
    else if(Math.abs(ids.get(x.id)-x.pnlUsdt)>0.00000001)errors.push('SCOPE_PNL_MISMATCH');
  }
  // Wide scope may legitimately contain settlements whose market began the previous day.
  return {matched:narrow.rows.length,wideCount:wide.rows.length,issues:[...new Set(errors)]};
}
export function sumOpenExposure(rows) {
  if(!Array.isArray(rows))throw new Error('OPEN_POSITIONS_NOT_ARRAY');
  let sum=0,count=0;
  const seen=new Set();
  for(const p of rows) {
    // ONGOING API entries with an unknown state cannot be silently counted as zero risk.
    if(!p || typeof p.positionStatus!=='string' || !p.positionStatus.trim())throw new Error('OPEN_POSITION_STATUS_MISSING');
    if(String(p.positionStatus).toUpperCase()!=='OPEN') continue;
    const key=p?.tokenId??p?.positionId??p?.id;
    if(key===undefined||key===null||!String(key).trim())throw new Error('OPEN_POSITION_ID_MISSING');
    if(seen.has(String(key)))throw new Error('OPEN_POSITION_DUPLICATE');
    seen.add(String(key));
    const cost=number(p?.totalCost,'OPEN_TOTAL_COST',0);
    sum+=cost;count++;
  }
  return {openExposureUsdt:Math.round(sum*100000000)/100000000,openPositionCount:count};
}
export function shadowDecision({limitUsdt,realizedPnlUsdt,openExposureUsdt,orderUsdt,verified=false,stale=false}) {
  if(!verified||stale)return {decision:'UNVERIFIED',reason:stale?'AUDIT_STALE':'AUDIT_INCOMPLETE'};
  try {
    const limit=number(limitUsdt,'DAILY_LIMIT',0.01);
    const pnl=number(realizedPnlUsdt,'REALIZED_PNL');
    const exposure=number(openExposureUsdt,'OPEN_EXPOSURE',0);
    const order=number(orderUsdt,'ORDER_AMOUNT',0);
    const expectedRisk=Math.max(0,-pnl)+exposure+order;
    return {decision:expectedRisk>=limit?'WOULD_BLOCK':'WOULD_ALLOW',
      budgetUsageUsdt:Math.round(expectedRisk*100000000)/100000000,
      limitUsdt:limit,reason:expectedRisk>=limit?'LIMIT_REACHED':'BELOW_LIMIT'};
  }catch{return {decision:'UNVERIFIED',reason:'INVALID_RISK_INPUT'};}
}
export function shadowUnitCases() {
  const base={limitUsdt:10,realizedPnlUsdt:-3,openExposureUsdt:0,verified:true};
  const cases=[
    {name:'below_limit',args:{...base,orderUsdt:2},expected:'WOULD_ALLOW'},
    {name:'new_order_exceeds',args:{...base,realizedPnlUsdt:-8,orderUsdt:3},expected:'WOULD_BLOCK'},
    {name:'at_limit',args:{...base,realizedPnlUsdt:-10,orderUsdt:0},expected:'WOULD_BLOCK'},
    {name:'open_exposure_exceeds',args:{...base,realizedPnlUsdt:-7,openExposureUsdt:3,orderUsdt:1},expected:'WOULD_BLOCK'},
    {name:'official_api_error',args:{...base,verified:false,orderUsdt:1},expected:'UNVERIFIED'},
    {name:'stale_reading',args:{...base,stale:true,orderUsdt:1},expected:'UNVERIFIED'},
    {name:'new_day_budget',args:{...base,realizedPnlUsdt:0,openExposureUsdt:0,orderUsdt:2},expected:'WOULD_ALLOW'},
  ];
  return cases.map(x=>({name:x.name,expected:x.expected,actual:shadowDecision(x.args).decision,
    passed:shadowDecision(x.args).decision===x.expected}));
}
