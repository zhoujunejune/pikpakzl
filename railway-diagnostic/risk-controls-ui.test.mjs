import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./control-shell.mjs',import.meta.url),'utf8');
const storage=fs.readFileSync(new URL('./risk-config-storage.mjs',import.meta.url),'utf8');
const runner=fs.readFileSync(new URL('./risk-runner.mjs',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('./risk-worker.mjs',import.meta.url),'utf8');
const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
function extract(label){
 const line=source.match(new RegExp('^const '+label+' = (.+);$','m'));
 assert.ok(line, 'missing '+label);
 return JSON.parse(line[1]);
}
const html=extract('riskCards');
const script=extract('riskScript').replace(/^<script>/,'').replace(/<\/script>$/,'');
new vm.Script(script,{filename:'risk-control-ui.js'});
function simulate(){
 const dom=new Map();
 for(const id of ['tpState','slState','tpValue','slValue','tpMeta','slMeta','tpEditor',
  'slEditor','tpPercent','slPercent','tpRange','slRange','tpNotice','slNotice'])
  dom.set(id,{value:'',innerHTML:'',textContent:'',open:false,className:''});
 const state={ok:true,takeProfitEnabled:false,takeProfitPercent:50,
  stopLossEnabled:true,stopLossPercent:25,source:'redis',persistenceReady:true,
  persistenceHealthy:true,execution:{ready:true,enabled:true,configApplied:true}};
 const calls=[];
 const context={
  document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
  setInterval:cb=>{context.tick=cb;return 0;},
  Date,Math,JSON,Number,String,Object,Array,Error,Boolean,isFinite
 };
 class FakeXHR{
  open(method,url){this.method=method;this.url=url}
  setRequestHeader(){}
  send(raw){
   const body=raw?JSON.parse(raw):null;
   calls.push({method:this.method,url:this.url,body});
   this.status=200;
   if(this.method==='POST')Object.assign(state,body);
   this.responseText=JSON.stringify(state);
   this.readyState=4;
   this.onreadystatechange();
  }
 }
 context.XMLHttpRequest=FakeXHR;
 context.window=context;
 vm.runInNewContext(script,context);
 return {state,dom,calls,context};
}
test('website-only authenticated TP and SL settings have no extra PIN',()=>{
 assert.match(html,/id="riskControlsCard"/);
 assert.match(html,/自动止盈止损/);
 assert.doesNotMatch(html,/id="tpPin"|id="slPin"/);
 assert.doesNotMatch(script,/pin:password|__zlOuterAuthOnly|kind\+'Pin'/);
 assert.match(source,/pinOK\(body.pin, req\)/);
 assert.match(source,/x-zl-verified-login/);
 assert.match(source,/sec-fetch-site/);
 assert.match(index,/网页登录 · 自动跟随 \/ 每轮一次/);
});
test('TP percentage saves alone while preserving SL settings and both enable switches',()=>{
 const {state,calls,context,dom}=simulate();
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 context.riskPreset('tp',75);
 context.saveTpPercent();
 const saved=calls.filter(c=>c.method==='POST');
 assert.equal(saved.length,1);
 assert.deepEqual(saved[0].body,{takeProfitPercent:75});
 assert.equal(state.takeProfitPercent,75);
 assert.equal(state.stopLossPercent,25);
 assert.equal(state.takeProfitEnabled,false);
 assert.equal(state.stopLossEnabled,true);
 assert.equal(dom.get('tpEditor').open,false);
});
test('SL percentage and enable switches remain independent',()=>{
 const {state,calls,context,dom}=simulate();
 context.riskOpen('sl');dom.get('slEditor').open=true;
 dom.get('slPercent').value='12.5';
 context.riskSync('sl','number');
 context.saveSlPercent();
 assert.deepEqual(calls.filter(c=>c.method==='POST')[0].body,{stopLossPercent:12.5});
 assert.equal(state.stopLossPercent,12.5);
 assert.equal(state.takeProfitPercent,50);
 context.setTp(true);
 assert.deepEqual(calls.filter(c=>c.method==='POST')[1].body,{takeProfitEnabled:true});
 assert.equal(state.stopLossEnabled,true);
});
test('enable does not accidentally submit unsaved ratio edit',()=>{
 const {state,dom,context,calls}=simulate();
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 dom.get('tpPercent').value='87';
 context.setTp(true);
 assert.deepEqual(calls.filter(c=>c.method==='POST')[0].body,{takeProfitEnabled:true});
 assert.equal(state.takeProfitPercent,50);
});
test('invalid ratio and redundant clicks cannot send unsafe settings',()=>{
 const {dom,context,calls}=simulate();
 dom.get('slPercent').value='0';
 context.saveSlPercent();
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
 assert.match(dom.get('slNotice').textContent,/1%到100%/);
});
test('refresh does not overwrite an unsaved editor value',()=>{
 const {state,dom,context}=simulate();
 context.riskOpen('tp');
 dom.get('tpEditor').open=true;
 dom.get('tpPercent').value='72.5';
 state.takeProfitPercent=53;
 context.tick();
 assert.equal(dom.get('tpPercent').value,'72.5');
 dom.get('tpEditor').open=false;
 context.tick();
 assert.equal(dom.get('tpPercent').value,53);
});
test('all runtime processes use the exact same service-allowed risk file',()=>{
 assert.match(storage,/process\.env\.RISK_CONTROL_FILE/);
 assert.match(source,/RISK_CONFIG_FILE as RISK_CONTROL_FILE/);
 assert.match(runner,/RISK_CONFIG_FILE as CONTROL_FILE/);
 assert.match(runner,/process\.env\.RISK_STATUS_FILE/);
 assert.match(worker,/process\.env\.RISK_WORKER_HEALTH_FILE/);
 assert.match(source,/execution:riskExecutionStatus\(\)/);
 assert.match(source,/persistenceReady \|\| !persistenceHealthy/);
});
