import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const wrapper=fs.readFileSync(new URL('../railway-diagnostic/wrapper.mjs',import.meta.url),'utf8');
const quote=String.fromCharCode(96);
const prefix='const clientJs = String.raw'+quote;
const a=wrapper.indexOf(prefix);
const b=wrapper.indexOf(quote+';\n\nconst scriptPattern',a);
if(a<0||b<0)throw Error('WRAPPER_CLIENT_SCRIPT_MISSING');
const js=wrapper.slice(a+prefix.length,b);
function simulate(model,signal=null){
 const values=new Map(),nodes=new Map();
 const initial={round:'15:10:00（本轮）',status:'已锁定 · 下单窗口结束（不可补单）',
  direction:'DOWN（跌） · 已锁定',orderDirection:'UP（涨）（反向参考；未提交）',score:'4.73 bps',
  amountView:'1'};
 for(const [id,value] of Object.entries(initial)){
   nodes.set(id,{textContent:value,innerHTML:'',style:{},classList:{add(){},remove(){}}});
 }
 const doc={
  readyState:'complete',hidden:false,activeElement:null,
  addEventListener(){},getElementById(id){return nodes.get(id)||null}
 };
 class XHR{
  open(method,url){this.url=url;}
  setRequestHeader(){}
  send(){
   this.status=200;
   this.readyState=4;
   this.responseText=JSON.stringify({ok:true,
    enabled:false,autoConfirmEnabled:true,orderSignalModel:model,
    signal,orderSignal:null,amount:'1',balance:{ok:false,error:'NO_ACCOUNT'},
    pendingAction:null,lastOrder:null});
   this.onreadystatechange();
  }
 }
 const sandbox={document:doc,window:{},XMLHttpRequest:XHR,Date,Number,
   setInterval(){},console};
 vm.runInNewContext(js,sandbox,{timeout:1500});
 for(const [id] of Object.entries(initial))values.set(id,nodes.get(id).textContent);
 return values;
}
test('expired FAST5 signal never gets overwritten by stale trade API empty fields',()=>{
 const v=simulate('FAST5_SPOT_MOMENTUM_V1',null);
 assert.equal(v.get('round'),'15:10:00（本轮）');
 assert.equal(v.get('direction'),'DOWN（跌） · 已锁定');
 assert.equal(v.get('orderDirection'),'UP（涨）（反向参考；未提交）');
 assert.equal(v.get('status'),'已锁定 · 下单窗口结束（不可补单）');
 assert.equal(v.get('score'),'4.73 bps');
 assert.equal(v.get('amountView'),'1');
});
test('other strategy still renders latest trade API signal including empty state',()=>{
 const v=simulate('OTHER_MODEL',null);
 for(const id of ['round','status','direction','orderDirection','score'])assert.equal(v.get(id),'-');
 assert.equal(v.get('amountView'),'1');
});
test('single owner prevents competing client writers, and uses cache-busted script',()=>{
 assert.match(wrapper,/if\(j.orderSignalModel!=='FAST5_SPOT_MOMENTUM_V1'\)/);
 assert.match(wrapper,/\/panel-client.js\?v=10/);
 assert.doesNotMatch(wrapper,/\/panel-client.js\?v=9/);
});
