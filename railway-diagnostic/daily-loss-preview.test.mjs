import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=filename=>fs.readFileSync(new URL('./'+filename,import.meta.url),'utf8');
const page=read('index.mjs'),shell=read('control-shell.mjs');
const storage=read('daily-loss-draft.mjs'),client=read('daily-loss-client.js');
const worker=read('risk-worker.mjs'),wrapper=read('wrapper.mjs');

test('preview configuration strictly checks money bounds, precision and retains observation mode',()=>{
 const start=storage.indexOf('export function normalizeDailyLossDraft(input) {');
 const end=storage.indexOf('\nfunction decodeDraft(raw)',start);
 assert.ok(start>=0&&end>start);
 const normalize=vm.runInNewContext(storage.slice(start,end).replace('export ','')+'\nnormalizeDailyLossDraft',{
  RangeError,Date,Number,String,Math,DAILY_LOSS_TZ:'Asia/Shanghai',DAILY_LOSS_MODE:'OBSERVE_ONLY'
 });
 assert.equal(normalize({dailyLimitUsdt:'5.25'}).dailyLimitUsdt,5.25);
 assert.equal(normalize({dailyLimitUsdt:0.01}).dailyLimitUsdt,0.01);
 for(const v of ['',0,-1,'2.555','NaN',null,'Infinity',true,100001]){
   assert.throws(()=>normalize({dailyLimitUsdt:v}),undefined,'should reject '+String(v));
 }
 assert.match(storage,/DAILY_LOSS_DRAFT_KEY = 'trade-control:daily-loss-draft:v1'/);
 assert.match(storage,/DAILY_LOSS_MODE = 'OBSERVE_ONLY'/);
 assert.match(storage,/timezone: DAILY_LOSS_TZ/);
 assert.match(storage,/await db\.set\(DAILY_LOSS_DRAFT_KEY,JSON\.stringify\(data\)\)/);
});

test('daily loss card is prominent and contains no false claim of active enforcement',()=>{
 const card=page.indexOf('id="dailyLossCard"'),monitor=page.indexOf('id="realRiskStatusCard"');
 const current=page.indexOf('id="round"');
 assert.ok(card>monitor&&card<current);
 for(const id of ['dailyLossMode','dailyLossLimitValue','dailyLossPnl','dailyLossRemaining',
  'dailyLossAmount','dailyLossPin','dailyLossSaveButton','dailyLossMessage','dailyLossHint'])
    assert.ok(page.includes('id="'+id+'"'),id);
 assert.match(page,/观察模式 · 尚未启用真实熔断/);
 assert.match(page,/尚未核对完整的官方已结算盈亏/);
});

test('separate API only reads or saves PIN-protected Redis draft, no trading decisions',()=>{
 assert.match(shell,/import \{ getDailyLossDraft, saveDailyLossDraft, setDailyLossMonitoring \}/);
 assert.match(shell,/req\.method === 'GET' && url\.pathname === '\/api\/daily-loss-limit'/);
 assert.match(shell,/req\.method === 'POST' && url\.pathname === '\/api\/daily-loss-limit'/);
 assert.match(shell,/if \(!pinOK\(body\.pin\)\)/);
 assert.match(shell,/enforcementEnabled:false/);
 assert.match(shell,/realizedPnlVerified:false/);
 assert.match(shell,/remainingLossUsdt:null/);
 assert.match(shell,/OFFICIAL_DAILY_REALIZED_PNL_NOT_INDEPENDENTLY_VERIFIED/);
 assert.match(shell,/\/daily-loss-client\.js\?v=1/);
 assert.match(shell,/application\/javascript/);
 assert.match(worker,/const tpTriggered = TAKE_PROFIT_ENABLED/);
 assert.match(worker,/const slTriggered = STOP_LOSS_ENABLED/);
 assert.match(wrapper,/async function submitPendingOrder/);
 new vm.Script(client);
});

function fakeEnvironment(data){
 const elements=new Map();
 const ids=['dailyLossCard','dailyLossMode','dailyLossLimitValue','dailyLossPnl',
 'dailyLossRemaining','dailyLossAmount','dailyLossPin','dailyLossSaveButton','dailyLossMessage',
 'dailyLossHint','dailyLossEditor','dailyLossEnableButton','dailyLossDisableButton','dailyLossSwitchStatus','dailyLossSwitchMessage','dailyLossEnforceStatus','pin'];
 for(const id of ids)elements.set(id,{id,textContent:'',value:'',open:false,disabled:false,addEventListener(type,cb){this[type]=cb;}});
 const events=[];
 const ctx={
  document:{readyState:'complete',getElementById:id=>elements.get(id)||null},
  Date,Math,Number,String,JSON,RegExp,
  setInterval:()=>0,
  fetch:async(url,opts={})=>{
   events.push({url,opts});
   if(opts.method==='POST')return {ok:true,json:async()=>({ok:true,dailyLimitUsdt:5.25,enforcementEnabled:false})};
   return {ok:true,json:async()=>data};
  }
 };
 vm.runInNewContext(client,ctx);
 return {elements,events};
}
async function drain(){for(let i=0;i<12;i++)await Promise.resolve();}
test('client clearly shows unknown daily pnl/remaining rather than invented figures',async()=>{
 const ui=fakeEnvironment({ok:true,configured:true,dailyLimitUsdt:5.25,mode:'OBSERVE_ONLY',enforcementEnabled:false,
  realizedPnlVerified:false,realizedPnlUsdt:null,remainingLossUsdt:null});
 await drain();
 const get=id=>ui.elements.get(id).textContent;
 assert.match(get('dailyLossMode'),/观察模式 · 不拦截任何真实交易/);
 assert.equal(get('dailyLossLimitValue'),'5.25 USDT');
 assert.equal(get('dailyLossPnl'),'尚未完成官方核验');
 assert.equal(get('dailyLossRemaining'),'不可计算');
 assert.equal(ui.events.length,1);
 assert.match(ui.events[0].url,/^\/api\/daily-loss-limit\?ts=/);
});
test('PIN save changes only draft API and remains observation-only',async()=>{
 const ui=fakeEnvironment({ok:true,configured:false,dailyLimitUsdt:null,mode:'OBSERVE_ONLY',enforcementEnabled:false});
 await drain();
 ui.elements.get('dailyLossAmount').value='5.25';
 ui.elements.get('dailyLossPin').value='test-pin';
 await ui.elements.get('dailyLossSaveButton').click();
 await drain();
 const post=ui.events.filter(x=>x.opts.method==='POST');
 assert.equal(post.length,1);
 assert.equal(post[0].url,'/api/daily-loss-limit');
 const payload=JSON.parse(post[0].opts.body);
 assert.equal(payload.dailyLimitUsdt,'5.25');
 assert.equal(payload.pin,'test-pin');
 assert.match(ui.elements.get('dailyLossMessage').textContent,/未开启真实熔断/);
 assert.ok(ui.events.every(x=>!x.url.includes('/api/control')&&!x.url.includes('/api/confirm')));
});


test('observation enable/disable inputs are visible near daily risk amount, not a claimed active fuse',()=>{
 const place=page.indexOf('id="dailyLossCard"');
 const btnOn=page.indexOf('id="dailyLossEnableButton"');
 const btnOff=page.indexOf('id="dailyLossDisableButton"');
 const details=page.indexOf('id="dailyLossEditor"');
 assert.ok(place>=0&&btnOn>place&&btnOff>btnOn&&btnOff<details);
 assert.match(page,/真实交易熔断：未接入/);
 assert.match(page,/id="dailyLossPin"/);
 assert.equal(page.split('id="dailyLossPin"').length-1,1);
 assert.match(shell,/changingSwitch = Object\.prototype\.hasOwnProperty\.call\(body,'monitorEnabled'\)/);
 assert.match(shell,/typeof body\.monitorEnabled !== 'boolean'/);
 assert.match(shell,/serializeDailyLossWrite\(\(\) => changingSwitch \? setDailyLossMonitoring/);
 assert.match(shell,/enforcementEnabled:false/);
 assert.match(storage,/if \(data\.monitorEnabled !== undefined && typeof data\.monitorEnabled !== 'boolean'\)/);
 assert.match(storage,/monitorEnabled:data\.monitorEnabled === true/);
 assert.match(storage,/if \(!previous\) throw new RangeError/);
 assert.match(storage,/await db\.set\(DAILY_LOSS_DRAFT_KEY,JSON\.stringify\(data\)\)/);
 assert.doesNotMatch(wrapper,/DAILY_LOSS_DRAFT_KEY|DAILY_LOSS_MODE|setDailyLossMonitoring/);
});

test('both observation buttons write independent PIN-protected switch fields without order requests',async()=>{
 const elements=new Map();
 const ids=['dailyLossCard','dailyLossMode','dailyLossLimitValue','dailyLossPnl',
 'dailyLossRemaining','dailyLossAmount','dailyLossPin','dailyLossSaveButton','dailyLossMessage',
 'dailyLossHint','dailyLossEditor','dailyLossEnableButton','dailyLossDisableButton',
 'dailyLossSwitchStatus','dailyLossSwitchMessage','dailyLossEnforceStatus','pin'];
 for(const id of ids)elements.set(id,{id,value:'',textContent:'',open:false,disabled:false,addEventListener(type,cb){this[type]=cb;}});
 let enabled=false;
 const calls=[];
 const ctx={document:{readyState:'complete',getElementById:id=>elements.get(id)||null},Date,Math,Number,String,JSON,RegExp,setInterval:()=>0,
  fetch:async(url,opts={})=>{
   calls.push({url,opts});
   if(opts.method==='POST'){
    const payload=JSON.parse(opts.body);
    if(typeof payload.monitorEnabled==='boolean')enabled=payload.monitorEnabled;
    return {ok:true,json:async()=>({ok:true,dailyLimitUsdt:5.25,monitorEnabled:enabled,enforcementEnabled:false})};
   }
   return {ok:true,json:async()=>({ok:true,configured:true,dailyLimitUsdt:5.25,monitorEnabled:enabled,
    mode:'OBSERVE_ONLY',enforcementEnabled:false,realizedPnlVerified:false,remainingLossUsdt:null})};
  }};
 vm.runInNewContext(client,ctx);
 await drain();
 assert.match(elements.get('dailyLossSwitchStatus').textContent,/已关闭/);
 assert.equal(elements.get('dailyLossEnableButton').disabled,false);
 elements.get('dailyLossPin').value='pin-for-test';
 await elements.get('dailyLossEnableButton').click();
 await drain();
 let posts=calls.filter(x=>x.opts.method==='POST');
 assert.equal(posts.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(posts[0].opts.body))),{monitorEnabled:true,pin:'pin-for-test'});
 assert.match(elements.get('dailyLossSwitchStatus').textContent,/已开启/);
 assert.equal(elements.get('dailyLossEnableButton').disabled,true);
 assert.equal(elements.get('dailyLossDisableButton').disabled,false);
 assert.match(elements.get('dailyLossEnforceStatus').textContent,/未接入/);
 elements.get('dailyLossPin').value='pin-for-test';
 await elements.get('dailyLossDisableButton').click();
 await drain();
 posts=calls.filter(x=>x.opts.method==='POST');
 assert.equal(posts.length,2);
 assert.equal(JSON.parse(posts[1].opts.body).monitorEnabled,false);
 assert.match(elements.get('dailyLossSwitchStatus').textContent,/已关闭/);
 assert.ok(calls.every(c=>!c.url.includes('/api/confirm')&&!c.url.includes('/api/control')));
});
