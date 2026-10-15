import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
const main=shell.match(/const primaryScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];
const policy=shell.match(/const policyScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];
assert.ok(main&&policy);

const round=Math.floor(Date.now()/300000)*300000;
const model={id:'MARKET_FUSION_FAST8_V2',name:'Market Fusion V2（8秒趋势+报价）',
  source:'SELECTIVE_V2_FAST8_PRIMARY',version:'MARKET_FUSION_FAST8_V2',active:true};
const payload={ok:true,productionSignalSourceMode:'MARKET_FUSION_FAST8',
  activeSignalModels:[model],activeProductionModel:{id:model.id,version:model.version,source:model.source},
  records:[{roundStartMs:round,productionModel:model.id,productionModelVersion:model.version,
    productionSource:model.source,productionPrediction:'DOWN',productionActual:null}]};
function setup(script) {
 const els=new Map(),alerts=[],posts=[],seen=[];
 function el(id){
   if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',value:'',style:{}});
   return els.get(id);
 }
 el('pin').value='testing-pin';
 let modes={SELECTIVE_V2_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'FORWARD'},
   EDGE_RESCUE_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'FORWARD'},
   SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION:{UP:'INVERSE',DOWN:'INVERSE'}};
 let rev='fixture';
 const response=data=>({ok:true,json:async()=>data});
 const fetch=async (url,init={})=>{
   seen.push(String(url));
   if(String(url).startsWith('/api/round-stats'))return response(payload);
   if(String(url).startsWith('/api/status'))return response({ok:true,
     signal:{status:'LOCKED',round,direction:'DOWN'},directionModeReady:true,
     orderDirectionPolicy:'SOURCE_SIDE_3WAY_V4:'+rev,orderProductionSource:model.source,
     orderMappingMode:modes[model.source].DOWN,orderSignal:modes[model.source].DOWN==='INVERSE'?'UP':'DOWN'});
   if(String(url).startsWith('/api/direction-mode')){
     if(init.method==='POST'){
       const body=JSON.parse(init.body);posts.push(body);
       modes={...modes,[body.source]:{...modes[body.source],[body.direction]:body.mode}};
       rev='updated';
     }
     return response({ok:true,policy:'SOURCE_SIDE_3WAY_V4:'+rev,revision:rev,modes});
   }
   throw Error('unexpected endpoint '+url);
 };
 const win={confirm:msg=>{alerts.push(msg);return true}};
 const context={document:{readyState:'complete',getElementById:el},
   window:win,fetch,localStorage:{setItem(){},getItem(){return null}},
   setInterval:()=>0,Date,Math,Set,Array,Number,Error,Promise,String,Object,isFinite};
 new vm.Script(script).runInNewContext(context);
 return {el,win,alerts,posts,seen};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};

test('current-model direction switches, confirmation, save notice and mapped order show Market Fusion only',async()=>{
 const env=setup(main);
 await flush();
 assert.match(env.el('directionModeChoices').innerHTML,/Market Fusion V2（8秒趋势+报价）/);
 assert.doesNotMatch(env.el('directionModeChoices').innerHTML,/Selective V2/);
 assert.equal((env.el('directionModeChoices').innerHTML.match(/<button /g)||[]).length,4);
 await env.win.setDirectionModeFromUI(0,'DOWN','INVERSE');
 await flush();
 // The initial status poll may precede loading Redis direction settings.
 // Save completion triggers a fresh authoritative mapping check.
 assert.match(env.el('activeFast8OrderDirection').textContent,/Market Fusion V2（8秒趋势+报价）/);
 assert.doesNotMatch(env.el('activeFast8OrderDirection').textContent,/Selective V2/);
 assert.equal(env.posts.length,1);
 assert.equal(env.posts[0].source,'SELECTIVE_V2_FAST8_PRIMARY');
 assert.equal(env.posts[0].direction,'DOWN');
 assert.equal(env.posts[0].mode,'INVERSE');
 assert.match(env.alerts[0],/Market Fusion V2（8秒趋势+报价）/);
 assert.doesNotMatch(env.alerts[0],/Selective V2/);
 assert.match(env.el('directionModeMessage').textContent,/Market Fusion V2（8秒趋势+报价）/);
 assert.doesNotMatch(env.el('directionModeMessage').textContent,/Selective V2/);
});

test('current strategy card hides retired waterfall and legacy 15s audit table',async()=>{
 const env=setup(policy);
 await flush();
 assert.match(env.el('spTitle').textContent,/Market Fusion V2（8秒趋势+报价）/);
 assert.match(env.el('spRouteStages').innerHTML,/唯一生产模型/);
 assert.doesNotMatch(env.el('spRouteStages').innerHTML,/Selective V2|Edge Rescue/);
 assert.equal(env.el('spLegacyRegistryWrap').style.display,'none');
 assert.match(env.el('spRule').textContent,/历史70%、实时30%/);
 assert.match(env.el('spRule').textContent,/目标第1秒锁定/);
 assert.match(env.el('spRule').textContent,/均不参与/);
 assert.doesNotMatch(env.el('spRule').textContent,/70%永久淘汰/);
 assert.ok(!env.seen.some(url=>url.startsWith('/api/training-status')));
});
