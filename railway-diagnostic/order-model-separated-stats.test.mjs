import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
function extract(name){
 const start=source.indexOf('const '+name+' = ');
 const open=source.indexOf('<script>',start)+8,close=source.indexOf('</script>',open);
 return source.slice(open,close);
}
const primary=extract('primaryScript'),round=extract('statsScript');
const now=Math.floor(Date.now()/300000)*300000;
const novice={
 ok:true,model:'NOVICE_MIX_LOW_V1',readOnly:true,orders:false,productionIntegration:false,
 results:{rounds:19,locked:16,dataGaps:3,pending:1,
   overall:{samples:15,hits:7,accuracy:7/15},
   up:{samples:9,hits:3,accuracy:1/3},
   down:{samples:6,hits:4,accuracy:2/3}},
 latest:{model:'NOVICE_MIX_LOW_V1',round:now,direction:'UP',status:'LOCKED',
   lockedAt:now+5200,score:.23},
 recent:[
  {round:now,direction:'UP',status:'LOCKED',lockedAt:now+5200,score:.23,actual:null},
  {round:now-300000,direction:'DOWN',status:'LOCKED',lockedAt:now-300000+5300,score:-.41,actual:'UP'},
  {round:now-600000,direction:'UP',status:'LOCKED',lockedAt:now-600000+5100,score:.51,actual:'UP'},
  {round:now-900000,direction:'DOWN',status:'NO_DATA_FALLBACK',lockedAt:now-900000+7400,score:null,actual:null}
 ]
};
const baseline={
 ok:true,productionSignalSourceMode:'BREAKOUT20_FAST8',
 settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
 activeProductionModel:{id:'BREAKOUT20_RSI_MACD_RANGE_V1',source:'SELECTIVE_V2_FAST8_PRIMARY',version:'BREAKOUT20_RSI_MACD_RANGE_V1'},
 activeSignalModels:[{id:'BREAKOUT20_RSI_MACD_RANGE_V1',source:'SELECTIVE_V2_FAST8_PRIMARY',version:'BREAKOUT20_RSI_MACD_RANGE_V1',name:'突破20%即可'}],
 records:[{roundStartMs:now,productionModel:'BREAKOUT20_RSI_MACD_RANGE_V1',productionModelVersion:'BREAKOUT20_RSI_MACD_RANGE_V1',productionSource:'SELECTIVE_V2_FAST8_PRIMARY',productionPrediction:'DOWN',productionActual:'UP'}]
};
const baseOfficial={ok:true,official:{available:true,results:{overall:{samples:193,hits:89,accuracy:89/193},locked:205}}};
const postflip={
 ok:true,model:'NOVICE_MIX_LOW_V1',statsScope:'RSI14_DIRECT_OFFICIAL_ONLY',resetAt:1792218000000,
 results:{rounds:2,locked:2,dataGaps:0,pending:0,
  overall:{samples:2,hits:1,accuracy:.5},up:{samples:1,hits:1,accuracy:1},
  down:{samples:1,hits:0,accuracy:0}},
 latest:{round:now,raw:'UP',emitted:'UP',direction:'UP',actual:'UP',flipped:false,eligible:true,lockedAt:now+5200},
 recent:[
  {round:now,raw:'UP',emitted:'UP',direction:'UP',actual:'UP',eligible:true,flipped:false,lockedAt:now+5200,result:'HIT'},
  {round:now-300000,raw:'DOWN',emitted:'DOWN',direction:'DOWN',actual:'UP',eligible:true,flipped:false,lockedAt:now-300000+5100,result:'MISS'}
 ]
};
const modes={SELECTIVE_V2_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'INVERSE'},
 EDGE_RESCUE_FAST8_PRIMARY:{UP:'OFF',DOWN:'OFF'},
 SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION:{UP:'OFF',DOWN:'OFF'}};
function dom(){const nodes=new Map();return {get(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',style:{},addEventListener(){},querySelectorAll(){return []},disabled:false});return nodes.get(id);}}}
async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
test('history card uses only novice official stats; never includes old 193 samples',async()=>{
 const d=dom(),requests=[];
 const env={document:{readyState:'complete',getElementById:id=>d.get(id)},
  window:{},Date,Math,Number,Array,Set,Object,JSON,String,Error,Promise,isFinite,
  localStorage:{setItem(){},getItem(){return null}},setInterval(){return 1;},
  fetch:async url=>{
   requests.push(String(url));
   if(String(url).includes('/api/postflip-official-stats'))return {ok:true,json:async()=>postflip};
   if(String(url).includes('/api/shadow-breakout20/novice-mix'))return {ok:true,json:async()=>novice};
   if(String(url).includes('/api/round-stats'))return {ok:true,json:async()=>baseline};
   throw Error('Unexpected '+url);
  }};
 env.globalThis=env;env.__orderModelStatsSelection='NOVICE_MIX_LOW_V1';
 new vm.Script(round).runInNewContext(env);
 await flush();
 assert.match(d.get('rsAccuracy').innerHTML,/50\.00%/);
 assert.equal(d.get('rsSettled').textContent,2);
 assert.match(d.get('rsCorrect').innerHTML,/>1</);
 assert.equal(d.get('rsWait').textContent,0);
 assert.match(d.get('rsRows').innerHTML,/NOVICE_MIX_LOW_V1/);
 assert.doesNotMatch(d.get('rsRows').innerHTML,/突破20%即可/);
 assert.equal(requests.some(x=>x.includes('/api/round-stats')),false);
});
test('main card obeys persisted choice, independent UP/DOWN and theoretical mapped ratio',async()=>{
 const d=dom();
 const env={document:{readyState:'complete',getElementById:id=>d.get(id),activeElement:null},
  window:{confirm:()=>true},Date,Math,Number,Array,Set,Object,JSON,String,Error,Promise,isFinite,
  setInterval(){return 1;},fetch:async url=>{
   let payload;
   if(String(url).includes('/api/postflip-official-stats'))payload=postflip;
   else if(String(url).includes('/api/order-signal-model'))payload={ok:true,ready:true,
    model:'NOVICE_MIX_LOW_V1',revision:'rev',models:[{id:'NOVICE_MIX_LOW_V1'},{id:'BREAKOUT20_RSI_MACD_RANGE_V1'}]};
   else if(String(url).includes('/api/shadow-breakout20/novice-mix'))payload=novice;
   else if(String(url).includes('/api/round-stats'))payload=baseline;
   else if(String(url).includes('/api/direction-mode'))payload={ok:true,policy:'SOURCE_SIDE_3WAY_V4:rev',revision:'rev',modes};
   else if(String(url).includes('/api/status'))payload={ok:true,orderSignalModel:'NOVICE_MIX_LOW_V1',
     signal:{round:now,direction:'UP',status:'LOCKED'},directionModeReady:true,
     orderDirectionPolicy:'SOURCE_SIDE_3WAY_V4:rev',orderMappingMode:'FORWARD',
     orderProductionSource:'SELECTIVE_V2_FAST8_PRIMARY',orderSignal:'UP'};
   else if(String(url).includes('/api/shadow-breakout20/status'))payload=baseOfficial;
   else throw Error('Unexpected '+url);
   return {ok:true,json:async()=>payload};
  }};
 env.globalThis=env;
 new vm.Script(primary).runInNewContext(env);
 await flush();
 assert.match(d.get('activeFast8Name').textContent,/NOVICE_MIX_LOW_V1/);
 assert.equal(d.get('activeFast8Accuracy').textContent,'50.00%');
 assert.equal(d.get('activeFast8HitMiss').textContent,'1 / 1（2轮）');
 assert.match(d.get('sourceRateRows').innerHTML,/100\.00%/);
 assert.match(d.get('sourceRateRows').innerHTML,/0\.00%/);
 assert.doesNotMatch(d.get('sourceRateRows').innerHTML,/突破20%即可/);
});
test('missing selected model does not silently revert to old stats',()=>{
 assert.match(round,/未回退使用老模型数据/);
 assert.match(primary,/新模型数据不可用，禁止显示老模型胜率/);
 assert.match(source,/globalThis\.__refreshOrderModelRoundStats/);
});
