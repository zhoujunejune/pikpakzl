import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
const primary=source.match(/const primaryCard = \`([\\s\\S]*?)\`;/)?.[1];
const mainScript=source.match(/const primaryScript = \`<script>([\\s\\S]*?)<\\/script>\`;/)?.[1];
const stats=source.match(/const statsScript = \`<script>([\\s\\S]*?)<\\/script>\`;/)?.[1];

function mounted(){const ids=['activeFast8Name','activeFast8Direction','activeFast8Accuracy',
 'activeFast8HitMiss','activeFast8Coverage','activeFast8Note','rsMeta','rsAccuracy',
 'rsSettled','rsDecided','rsCorrect','rsWrong','rsWait','rsCoverage','rsRows'];
 const dom=new Map(ids.map(id=>[id,{innerHTML:'',textContent:''}]));
 return dom;
}
async function execute(script,payload){
 const dom=mounted();
 const env={document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
   fetch:async()=>({ok:true,json:async()=>payload}),
   localStorage:{setItem:()=>{},getItem:()=>null},
   setInterval:()=>0,Date,Math,Set,Array,Number,Error,Promise,String,Object,isFinite,
 };
 new vm.Script(script).runInNewContext(env);
 await new Promise(resolve=>setImmediate(resolve));
 await new Promise(resolve=>setImmediate(resolve));
 return dom;
}
function fixture(){
 const past=Math.floor(Date.now()/300000)*300000;
 return {ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
   activeProductionModel:{id:'FLOW_BOOK_PROXY_V1',onlyOneActive:true,deadlineMs:8000,
     metrics:{signalRounds:3,settledRounds:2,hits:1,misses:1,accuracyPct:50,coveragePct:100,fallbackRounds:2}},
   records:[
     {roundStartMs:past,productionModel:'FLOW_BOOK_PROXY_V1',productionPrediction:'DOWN',productionActual:null},
     {roundStartMs:past-300000,productionModel:'FLOW_BOOK_PROXY_V1',productionPrediction:'UP',productionActual:'UP',productionResult:'HIT'},
     {roundStartMs:past-600000,productionModel:'FLOW_BOOK_PROXY_V1',productionPrediction:'DOWN',productionActual:'UP',productionResult:'MISS'},
     {roundStartMs:past-900000,productionModel:'ZL_FAST8_65',productionPrediction:'UP',productionActual:'UP',productionResult:'HIT'},
     {roundStartMs:past-1200000,productionModel:'SELECTIVE_V2',productionPrediction:'UP',productionActual:'UP',productionResult:'HIT'},
   ]};
}
test('the injected trade frontend contains only sole external candidate and official stats',()=>{
 assert.ok(primary?.includes('id="activeFast8ModelCard"'));
 assert.ok(primary?.includes('FLOW_BOOK_PROXY_V1'));
 assert.ok(stats);
 assert.ok(mainScript);
 assert.ok(source.includes('${primaryCard}${statsCard}${marker}'));
 assert.ok(source.includes('${primaryScript}${statsScript}</body>'));
 assert.ok(!source.includes('${policyCard}${previewCard}${statsCard}'));
 assert.ok(!source.includes('${statsScript}${previewScript}${policyScript}'));
 assert.ok(!primary.includes('PM_CURRENT25'));
 assert.ok(!primary.includes('Selective V2'));
 new vm.Script(mainScript);
 new vm.Script(stats);
});
test('current model card reports live direction and only model-specific hit count',async()=>{
 const d=await execute(mainScript,fixture());
 assert.match(d.get('activeFast8Name').textContent,/FLOW_BOOK_PROXY_V1/);
 assert.equal(d.get('activeFast8Direction').textContent,'DOWN');
 assert.equal(d.get('activeFast8Accuracy').textContent,'50.00%');
 assert.equal(d.get('activeFast8HitMiss').textContent,'1 / 1');
 assert.match(d.get('activeFast8Note').textContent,/官方结算 2 轮/);
});
test('the settled history table excludes retired signal performance',async()=>{
 const d=await execute(stats,fixture());
 assert.match(d.get('rsAccuracy').innerHTML,/50.00%/);
 assert.equal(d.get('rsSettled').textContent,2);
 assert.equal(d.get('rsDecided').textContent,2);
 assert.match(d.get('rsMeta').textContent,/唯一现役：FLOW_BOOK_PROXY_V1/);
 assert.match(d.get('rsRows').innerHTML,/外部订单流 FAST8/);
 assert.doesNotMatch(d.get('rsRows').innerHTML,/Selective V2/);
 assert.doesNotMatch(d.get('rsRows').innerHTML,/ZL_FAST8_65/);
});
test('missing upstream switch does not pretend that production has changed',async()=>{
 const d=await execute(mainScript,{ok:true,records:[],activeProductionModel:null});
 assert.equal(d.get('activeFast8Direction').textContent,'状态未确认');
 assert.match(d.get('activeFast8Note').textContent,/尚未切换/);
});
