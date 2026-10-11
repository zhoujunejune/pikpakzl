// Continuous read-only audit. It never imports or calls the live order execution path.
// Reports are NOT certification: official per-position realizedPnl, fees and per-order
// reconciliation require independent verification before the live fuse can be enabled.
import crypto from 'node:crypto';
import { createClient } from 'redis';
import { getDailyLossDraft } from './daily-loss-draft.mjs';
import { shanghaiDay, previousShanghaiDay, collectOfficialSettlements,
  compareOfficialScopes, sumOpenExposure, shadowDecision, shadowUnitCases, STAKE_TESTS_USDT } from './daily-loss-audit-core.mjs';

const GET_ORIGIN='https://api.binance.com';
const LOG_INTERVAL_MS=15*60*1000;
const MAX_PAGES=20, PAGE_SIZE=100;
const SNAPSHOT_KEY='trade-control:daily-loss-audit:latest:v1';
const HISTORY_KEY='trade-control:daily-loss-audit:reports:v1';
const apiKey=String(process.env.BINANCE_PREDICTION_API_KEY||'');
const apiSecret=String(process.env.BINANCE_PREDICTION_API_SECRET||'');
let lastAudit={ok:false,status:'PENDING',enforcementEnabled:false,realizedPnlVerified:false,
  checkedAt:null,reason:'AUTOMATIC_AUDIT_NOT_COMPLETED'};
let running=false,timer=null,redis=null,connecting=null,stopping=false;

function reasonCode(err) {
  const value=String(err?.message||err||'UNKNOWN');
  return value.replace(/[^A-Z0-9_]/gi,'_').slice(0,92);
}
function log(event,extra={}) { console.log(JSON.stringify({event,audit:'daily-loss',at:new Date().toISOString(),...extra})); }
function assertArray(data,field) {
  if(!Array.isArray(data?.[field]))throw new Error('OFFICIAL_'+field.toUpperCase()+'_SCHEMA_UNVERIFIED');
  return data[field];
}
async function signedGet(path,params) {
  if(!apiKey||!apiSecret)throw new Error('OFFICIAL_API_CREDENTIALS_MISSING');
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params||{})){
    if(value!==null&&value!==undefined&&value!=='')query.append(key,String(value));
  }
  query.set('timestamp',String(Date.now()));
  query.set('recvWindow','5000');
  query.set('signature',crypto.createHmac('sha256',apiSecret).update(query.toString()).digest('hex'));
  let response;
  try {
    response=await fetch(GET_ORIGIN+path+'?'+query.toString(),{
      method:'GET',headers:{'X-MBX-APIKEY':apiKey},cache:'no-store',signal:AbortSignal.timeout(9000)
    });
  }catch{throw new Error('OFFICIAL_NETWORK_UNAVAILABLE');}
  if(!response.ok)throw new Error('OFFICIAL_HTTP_'+response.status);
  let body;
  try {body=await response.json();} catch{throw new Error('OFFICIAL_JSON_INVALID');}
  if(body?.code && Number(body.code)<0)throw new Error('OFFICIAL_API_ERROR_'+String(body.code).replace(/[^0-9-]/g,''));
  return body;
}
async function getWalletAddress(){
  const direct=String(process.env.BINANCE_PREDICTION_WALLET_ADDRESS||'').trim();
  if(direct)return direct;
  const body=await signedGet('/sapi/v1/w3w/wallet/prediction/wallet/list',{});
  const list=assertArray(body,'wallets');
  const address=list.find(x=>x?.walletAddress)?.walletAddress;
  if(!address)throw new Error('PREDICTION_WALLET_MISSING');
  return String(address);
}
async function fetchAll(path,baseParams,field) {
  const items=[];
  for(let page=0;page<MAX_PAGES;page++){
    const payload=await signedGet(path,{...baseParams,offset:page*PAGE_SIZE,limit:PAGE_SIZE});
    const rows=assertArray(payload,field);
    items.push(...rows);
    if(rows.length<PAGE_SIZE)return {rows:items,pages:page+1};
  }
  throw new Error('OFFICIAL_PAGINATION_LIMIT_REACHED');
}
async function reportRedis(){
  if(redis?.isReady)return redis;
  const url=String(process.env.SIGNAL_REDIS_URL||'');
  if(!url)throw new Error('AUDIT_REDIS_URL_MISSING');
  if(!connecting){
    const candidate=createClient({url,disableOfflineQueue:true,
      socket:{connectTimeout:3500,reconnectStrategy:n=>n>=2?new Error('AUDIT_REDIS_FAILED'):250*(n+1)}});
    candidate.on('error',()=>{});
    connecting=candidate.connect().then(()=>{redis=candidate;return candidate;}).catch(async e=>{
      connecting=null;try{await candidate.disconnect();}catch{}throw e;
    });
  }
  return connecting;
}
export function currentDailyLossAudit(){return {...lastAudit};}
export async function runDailyLossAuditOnce(nowMs=Date.now()){
  if(running)return currentDailyLossAudit();
  running=true;
  const started=new Date().toISOString(),day=shanghaiDay(nowMs);
  const cases=shadowUnitCases(),simulationPassed=cases.every(x=>x.passed);
  let report={ok:true,checkedAt:started,day,timezone:'Asia/Shanghai',status:'FETCHING',
    monitorEnabled:false,enforcementEnabled:false,realizedPnlVerified:false,settlementReconciled:false,
    auditFresh:false,openExposureVerified:false,simulationPassed,simulationCases:cases,
    realizedPnlUsdt:null,openExposureUsdt:null,settlementCount:null,orderHistoryCount:null,
    shadowDecisions:[],checks:[],errors:[],certification:'NOT_APPROVED'};
  try{
    try{
      const config=await getDailyLossDraft();
      report.monitorEnabled=config?.monitorEnabled===true;
      report.dailyLimitUsdt=config?.dailyLimitUsdt??null;
      report.configFound=Boolean(config);
      report.checks.push('CONFIG_REDIS_READ_OK');
    }catch(e){report.errors.push('CONFIG_REDIS_'+reasonCode(e));}
    const address=await getWalletAddress();
    const wide=await fetchAll('/sapi/v1/w3w/wallet/prediction/position/settled-history',{
      walletAddress:address,l1Category:'crypto',startDate:previousShanghaiDay(nowMs),endDate:day},'positions');
    const narrow=await fetchAll('/sapi/v1/w3w/wallet/prediction/position/settled-history',{
      walletAddress:address,l1Category:'crypto',startDate:day,endDate:day},'positions');
    const current=collectOfficialSettlements(wide.rows,day,nowMs);
    const narrowData=collectOfficialSettlements(narrow.rows,day,nowMs);
    const scopeCheck=compareOfficialScopes(narrowData,current);
    report.settlementCount=current.settlementCount;
    report.realizedPnlUsdt=current.realizedPnlUsdt;
    report.settlementPages=wide.pages;
    report.checks.push('OFFICIAL_SETTLED_HISTORY_FETCHED');
    report.scopeComparison={narrowCount:narrowData.settlementCount,wideCount:current.settlementCount,issues:scopeCheck.issues};
    if(scopeCheck.issues.length)report.errors.push(...scopeCheck.issues);
    else report.checks.push('OFFICIAL_DATE_SCOPE_CONSISTENT');
    const ongoing=await fetchAll('/sapi/v1/w3w/wallet/prediction/position/list',{
      walletAddress:address,tab:'ONGOING'},'positions');
    const open=sumOpenExposure(ongoing.rows);
    report.openExposureUsdt=open.openExposureUsdt;
    report.openPositionCount=open.openPositionCount;
    report.openExposureVerified=true;
    report.checks.push('OFFICIAL_OPEN_POSITIONS_FETCHED');
    const orders=await fetchAll('/sapi/v1/w3w/wallet/prediction/order/history',{
      walletAddress:address},'orders');
    report.orderHistoryCount=orders.rows.length;
    report.checks.push('OFFICIAL_ORDER_HISTORY_FETCHED');
    const orderTopics=new Set(orders.rows.map(x=>String(x?.marketTopicId||'')).filter(Boolean));
    const settledTopics=current.rows.map(x=>x.marketTopicId).filter(Boolean);
    const matched=settledTopics.filter(id=>orderTopics.has(id)).length;
    report.orderTopicMatches=matched;
    if(settledTopics.length && matched<settledTopics.length)report.errors.push('SETTLED_ORDERS_NOT_FULLY_MATCHED');
    // Even matched topics are not a definitive fee / per-fill PnL reconciliation.
    report.errors.push('INDEPENDENT_ORDER_PNL_RECONCILIATION_REQUIRED');
    report.shadowDecisions=STAKE_TESTS_USDT.map(orderUsdt=>({
      orderUsdt,
      ...shadowDecision({limitUsdt:report.dailyLimitUsdt,realizedPnlUsdt:report.realizedPnlUsdt,
        openExposureUsdt:report.openExposureUsdt,orderUsdt,verified:false})
    }));
    report.status=report.errors.length?'NEEDS_RECONCILIATION':'DATA_COLLECTED';
    report.auditFresh=true;
  }catch(e){
    report.status='INCOMPLETE';
    report.errors.push(reasonCode(e));
    report.shadowDecisions=STAKE_TESTS_USDT.map(orderUsdt=>({
      orderUsdt,decision:'UNVERIFIED',reason:'OFFICIAL_DATA_UNAVAILABLE'
    }));
  }finally{
    // No path can set enforcementEnabled=true here.
    report.finishedAt=new Date().toISOString();
    report.checkedAt=report.finishedAt;
    report.errors=[...new Set(report.errors)].slice(0,16);
    if(!simulationPassed){report.status='SIMULATION_FAILED';report.errors.push('SHADOW_UNIT_CASE_FAILED');}
    lastAudit=report;
    try{
      const db=await reportRedis();
      const summary=JSON.stringify(report);
      const tx=db.multi();tx.set(SNAPSHOT_KEY,summary);tx.lPush(HISTORY_KEY,summary);tx.lTrim(HISTORY_KEY,0,95);
      await tx.exec();
      lastAudit.persisted=true;
    }catch(e){lastAudit.persisted=false;lastAudit.errors.push('AUDIT_REDIS_'+reasonCode(e));}
    log('daily_loss_audit_report',{
      day:report.day,status:lastAudit.status,settlementCount:report.settlementCount,
      realizedPnlUsdt:report.realizedPnlUsdt,openExposureUsdt:report.openExposureUsdt,
      simulationPassed,errors:lastAudit.errors,monitorEnabled:report.monitorEnabled,
      enforcementEnabled:false,persisted:lastAudit.persisted
    });
    running=false;
  }
  return currentDailyLossAudit();
}
export function startDailyLossAuditService(){
  if(timer)return;
  stopping=false;
  void runDailyLossAuditOnce();
  timer=setInterval(()=>{if(!stopping)void runDailyLossAuditOnce();},LOG_INTERVAL_MS);
  timer.unref?.();
  log('daily_loss_auditor_started',{intervalMinutes:15,enforcementEnabled:false,mode:'READ_ONLY_SHADOW'});
}
export function stopDailyLossAuditService(){
  stopping=true;if(timer){clearInterval(timer);timer=null;}
}
