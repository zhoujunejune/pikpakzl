import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=p=>fs.readFileSync(new URL('./'+p,import.meta.url),'utf8');
const index=read('index.mjs');
const control=read('control-shell.mjs');
const worker=read('risk-worker.mjs');
const client=read('risk-monitor-client.js');
const riskCardId='id="realRiskStatusCard"';

test('always visible risk status card is above round and order details, and outside both accordions',()=>{
 assert.equal(index.split(riskCardId).length-1,1);
 assert.ok(index.indexOf(riskCardId)>index.indexOf('id="tradeInputsCard"'));
 assert.ok(index.indexOf(riskCardId)<index.indexOf('id="round"'));
 assert.ok(index.indexOf(riskCardId)<index.indexOf('id="riskControlsAnchor"'));
 for(const id of ['realRiskHeadline','realRiskHealth','realRiskTp','realRiskSl',
                  'realRiskScan','realRiskQuote','realRiskDetails','realRiskUpdated']){
   assert.ok(index.includes('id="'+id+'"'),id);
 }
 assert.match(index,/检查风控工作进程与交易所持仓数据/);
});

test('status endpoint joins runner heartbeat with real worker last successful Binance positions/quotes',()=>{
 assert.match(control,/url\.pathname === '\/api\/risk-runtime-status'/);
 assert.match(control,/RISK_WORKER_HEALTH_FILE/);
 assert.match(control,/data\.pid === result\.workerPid/);
 assert.match(control,/workerMonitorStale/);
 assert.match(control,/scanFresh/);
 assert.match(control,/lastSuccessfulPositionsAt/);
 assert.match(control,/quoteChecks/);
 assert.match(control,/monitorState/);
 assert.match(control,/lastQuoteAt/);
 assert.match(control,/persistenceHealthy/);
 assert.match(worker,/emitHealth/);
 assert.match(worker,/health\.lastSuccessfulPositionsAt = new Date\(\)\.toISOString\(\)/);
 assert.match(worker,/event === 'risk_check'/);
 assert.match(worker,/health\.quoteChecks \+= 1/);
 assert.match(worker,/lastSellEvent/);
 assert.match(worker,/healthTimer\.unref\(\)/);
 assert.match(control,/\/risk-monitor-client\.js\?v=2/);
 assert.match(control,/application\/javascript/);
});

test('independent dashboard client is syntactically valid and uses only read-only GET',()=>{
 new vm.Script(client);
 assert.match(client,/fetch\('\/api\/risk-runtime-status/);
 assert.doesNotMatch(client,/method\s*:\s*['"]POST['"]|\/api\/control|\/api\/confirm|place-order/);
 assert.match(client,/扫描未验证/);
 assert.match(client,/尚无成功报价记录/);
 assert.match(client,/Redis 配置持久化异常/);
});

async function simulate(status){
 const elements=new Map();
 for(const id of ['realRiskStatusCard','realRiskHeadline','realRiskHealth','realRiskTp','realRiskSl',
                  'realRiskScan','realRiskQuote','realRiskDetails','realRiskUpdated'])
   elements.set(id,{textContent:'',style:{}});
 const called=[];
 const ctx={
  document:{readyState:'complete',getElementById:id=>elements.get(id)||null},
  Date,Math,Number,String,JSON,isFinite,
  AbortController:class {constructor(){this.signal={}} },
  fetch:async(url,options)=>{called.push({url,options});return {ok:true,json:async()=>status};},
  setInterval:()=>0,
 };
 vm.runInNewContext(client,ctx);
 for(let n=0;n<7;n++)await Promise.resolve();
 return {elements,called};
}
test('healthy scan is not confused with quote/order filled and shows actual times',async()=>{
 const now=new Date().toISOString();
 const {elements,called}=await simulate({
  ok:true,monitorState:'SCANNING',at:now,
  takeProfitEnabled:true,takeProfitPercent:50,stopLossEnabled:true,stopLossPercent:25,
  persistenceHealthy:true,persistedConfigFound:true,scanFresh:true,
  workerHealth:{positionsSeen:2,lastSuccessfulPositionsAt:now,lastQuoteAt:now,quoteChecks:3,quoteErrors:0}
 });
 const get=id=>elements.get(id).textContent;
 assert.match(get('realRiskHeadline'),/持仓扫描正常/);
 assert.match(get('realRiskScan'),/已扫描 2 笔/);
 assert.match(get('realRiskQuote'),/成功 3 次/);
 assert.match(get('realRiskDetails'),/无法保证触发价或成交/);
 assert.match(get('realRiskTp'),/已开启 50%/);
 assert.match(get('realRiskSl'),/已开启 25%/);
 assert.equal(called.length,1);
 assert.match(called[0].url,/^\/api\/risk-runtime-status\?ts=/);
});
test('disabled flags and degraded scan are visibly distinct without false green status',async()=>{
 const disabled=await simulate({
  ok:true,monitorState:'DISABLED',takeProfitEnabled:false,takeProfitPercent:50,
  stopLossEnabled:false,stopLossPercent:50
 });
 assert.match(disabled.elements.get('realRiskHeadline').textContent,/均关闭/);
 assert.match(disabled.elements.get('realRiskScan').textContent,/未运行/);
 const degraded=await simulate({
  ok:true,monitorState:'SCAN_UNVERIFIED',at:new Date().toISOString(),
  takeProfitEnabled:true,takeProfitPercent:15,stopLossEnabled:false,stopLossPercent:25,
  workerHealth:{lastSuccessfulPositionsAt:null,lastQuoteAt:null,quoteChecks:0,lastError:'BINANCE_UNAVAILABLE'},
  persistenceHealthy:false,scanFresh:false
 });
 assert.match(degraded.elements.get('realRiskHeadline').textContent,/扫描未验证/);
 assert.match(degraded.elements.get('realRiskDetails').textContent,/Redis 配置持久化异常/);
 assert.match(degraded.elements.get('realRiskDetails').textContent,/BINANCE_UNAVAILABLE/);
 assert.match(degraded.elements.get('realRiskQuote').textContent,/尚无成功报价记录/);
});
