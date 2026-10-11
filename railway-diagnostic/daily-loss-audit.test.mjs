import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 shanghaiDay,previousShanghaiDay,collectOfficialSettlements,
 compareOfficialScopes,sumOpenExposure,shadowDecision,shadowUnitCases
} from './daily-loss-audit-core.mjs';
const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const service=read('daily-loss-audit-service.mjs');
const shell=read('control-shell.mjs');
const page=read('index.mjs');
const client=read('daily-loss-client.js');
const wrapper=read('wrapper.mjs');

test('Beijing day changes at UTC 16:00 and prior-day cross-boundary settlements are included',()=>{
 assert.equal(shanghaiDay(Date.parse('2026-10-10T15:59:59Z')),'2026-10-10');
 assert.equal(shanghaiDay(Date.parse('2026-10-10T16:00:00Z')),'2026-10-11');
 assert.equal(previousShanghaiDay(Date.parse('2026-10-10T16:00:00Z')),'2026-10-10');
 const now=Date.parse('2026-10-11T04:00:00Z');
 const rows=[
  {positionId:'one',settledDate:String(Date.parse('2026-10-10T16:01:00Z')),realizedPnl:'-2.25',marketTopicId:'123'},
  {positionId:'prior',settledDate:String(Date.parse('2026-10-10T15:59:59Z')),realizedPnl:'-9.25',marketTopicId:'456'},
  {positionId:'two',settledDate:String(Date.parse('2026-10-10T16:03:00Z')),realizedPnl:'1.00',marketTopicId:'789'}
 ];
 const pnl=collectOfficialSettlements(rows,'2026-10-11',now);
 assert.equal(pnl.settlementCount,2);
 assert.equal(pnl.realizedPnlUsdt,-1.25);
 assert.equal(pnl.issues.length,0);
 assert.equal(compareOfficialScopes(pnl,pnl).issues.length,0);
});
test('never silently count duplicate official settlement rows or accept ambiguous identifiers',()=>{
 const date=Date.parse('2026-10-11T00:01:00Z'),now=Date.parse('2026-10-11T01:00:00Z'),day='2026-10-11';
 const p={positionId:'AAA',settledDate:date,realizedPnl:'-1.20'};
 const result=collectOfficialSettlements([p,p],day,now);
 assert.equal(result.settlementCount,1);
 assert.deepEqual(result.issues,['POSITION_DUPLICATE_SOURCE']);
 assert.throws(()=>collectOfficialSettlements([{settledDate:date,realizedPnl:'-2'}],day,now),/POSITION_ID_MISSING/);
 assert.throws(()=>collectOfficialSettlements([{positionId:'X',realizedPnl:'-2'}],day,now),/SETTLEMENT_TIMESTAMP_MISSING/);
 assert.throws(()=>collectOfficialSettlements([{positionId:'X',settledDate:date,realizedPnl:''}],day,now),/REALIZED_PNL_INVALID/);
 const conflict=collectOfficialSettlements([p,{...p,realizedPnl:'-2'}],day,now);
 assert.ok(conflict.issues.includes('POSITION_DUPLICATE_CONFLICT'));
});
test('conservative full-wallet open stake exposure counts unique OPEN positions',()=>{
 const r=sumOpenExposure([
  {tokenId:'a',positionStatus:'OPEN',totalCost:'1.25'},
  {tokenId:'b',positionStatus:'OPEN',totalCost:'2.40'},
  {tokenId:'z',positionStatus:'CLOSED',totalCost:'100'}]);
 assert.equal(r.openPositionCount,2);
 assert.equal(r.openExposureUsdt,3.65);
 assert.throws(()=>sumOpenExposure([{positionStatus:'OPEN',totalCost:'1'}]),/OPEN_POSITION_ID_MISSING/);
 assert.throws(()=>sumOpenExposure([{tokenId:'a',totalCost:'1'}]),/OPEN_POSITION_STATUS_MISSING/);
 assert.throws(()=>sumOpenExposure([{tokenId:'a',positionStatus:'OPEN',totalCost:'-2'}]),/OPEN_TOTAL_COST_INVALID/);
 assert.throws(()=>sumOpenExposure([
  {tokenId:'a',positionStatus:'OPEN',totalCost:'1'},{tokenId:'a',positionStatus:'OPEN',totalCost:'2'}]),/OPEN_POSITION_DUPLICATE/);
});
test('shadow gate conditions evaluate profits, open exposure, API outage, boundary and staleness',()=>{
 const cases=shadowUnitCases();
 assert.equal(cases.length,7);
 assert.ok(cases.every(c=>c.passed),JSON.stringify(cases));
 const base={limitUsdt:10,realizedPnlUsdt:-8,openExposureUsdt:0,orderUsdt:3,verified:true};
 assert.equal(shadowDecision(base).decision,'WOULD_BLOCK');
 assert.equal(shadowDecision({...base,realizedPnlUsdt:1,orderUsdt:2}).decision,'WOULD_ALLOW');
 assert.equal(shadowDecision({...base,verified:false}).decision,'UNVERIFIED');
 assert.equal(shadowDecision({...base,stale:true}).decision,'UNVERIFIED');
 assert.equal(shadowDecision({...base,orderUsdt:0,realizedPnlUsdt:-10}).decision,'WOULD_BLOCK');
});
test('scheduled audits use only signed Binance GET, run every 15min, persist result and never approve live fuse',()=>{
 assert.match(service,/const LOG_INTERVAL_MS=15\*60\*1000/);
 assert.match(service,/function signedGet\(path,params\)/);
 assert.match(service,/method:'GET'/);
 assert.doesNotMatch(service,/method:'POST'|signedPost|placeOrder|submitPendingOrder/);
 assert.match(service,/\/position\/settled-history/);
 assert.match(service,/\/position\/list/);
 assert.match(service,/\/order\/history/);
 assert.match(service,/MAX_PAGES=20/);
 assert.match(service,/compareOfficialScopes/);
 assert.match(service,/lPush\(HISTORY_KEY,summary\)/);
 assert.match(service,/lTrim\(HISTORY_KEY,0,95\)/);
 assert.match(service,/INDEPENDENT_ORDER_PNL_RECONCILIATION_REQUIRED/);
 assert.match(service,/ORDER_HISTORY_COMPLETENESS_UNVERIFIED/);
 assert.match(service,/SAMPLED_FIRST_PAGE_UNVERIFIED/);
 assert.match(service,/offset:0,limit:PAGE_SIZE/);
 assert.match(service,/verified:false/);
 assert.match(service,/enforcementEnabled:false/);
 assert.match(shell,/startDailyLossAuditService\(\)/);
 assert.match(shell,/stopDailyLossAuditService\(\)/);
 assert.match(shell,/url.pathname === '\/api\/daily-loss-audit'/);
 assert.match(shell,/verifiedForLiveFuse: false/);
 assert.doesNotMatch(wrapper,/daily-loss-audit-service|DAILY_LOSS_AUDIT/);
});
test('frontend renders non-certified status and never turns provisional PnL into verified remaining budget',()=>{
 const ui=page.indexOf('id="dailyLossAuditArea"'),limit=page.indexOf('id="dailyLossCard"');
 assert.ok(ui>limit);
 for(const id of ['dailyLossAuditHeadline','dailyLossAuditCount','dailyLossAuditExposure',
  'dailyLossAuditTests','dailyLossAuditAt','dailyLossAuditErrors'])assert.ok(page.includes('id="'+id+'"'));
 assert.match(client,/\/api\/daily-loss-audit\?ts=/);
 assert.match(client,/readAudit/);
 assert.match(client,/每15分钟/);
 assert.match(client,/初步，未核验/);
 assert.match(client,/不可计算（未验收）/);
 assert.doesNotMatch(client,/verifiedForLiveFuse:true|enforcementEnabled:true/);
});
