import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
const primary=source.match(/const primaryCard = `([\s\S]*?)`;/)?.[1];
const mainScript=source.match(/const primaryScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];
const stats=source.match(/const statsScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];
const modelVersion='SELECTIVE_V2_FAST8_PREWARM_V1';

function mounted(){
 const ids=['activeFast8Name','activeFast8Desc','activeFast8Direction','activeFast8Accuracy',
 'activeFast8HitMiss','activeFast8Coverage','activeFast8Note','activeFast8OrderDirection',
 'activeFast8InverseAccuracy','activeFast8InverseHitMiss','rsMeta','rsAccuracy','rsSettled',
 'rsDecided','rsCorrect','rsWrong','rsWait','rsCoverage','rsRows','sourceRateRows','directionModeMessage'];
 return new Map(ids.map(id=>[id,{innerHTML:'',textContent:''}]));
}
async function execute(script,payload){
 const dom=mounted();
 const env={document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
   window:{confirm:()=>true},
   fetch:async url=>({ok:true,json:async()=>String(url).startsWith('/api/direction-mode')?{
     ok:true,policy:'SOURCE_SIDE_3WAY_V4:fixture',revision:'fixture',
     modes:{SELECTIVE_V2_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'FORWARD'},
       EDGE_RESCUE_FAST8_PRIMARY:{UP:'FORWARD',DOWN:'FORWARD'},
       SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION:{UP:'INVERSE',DOWN:'INVERSE'}}
   }:payload}),
   localStorage:{setItem:()=>{},getItem:()=>null},
   setInterval:()=>0,Date,Math,Set,Array,Number,Error,Promise,String,Object,isFinite};
 new vm.Script(script).runInNewContext(env);
 await new Promise(resolve=>setImmediate(resolve));
 await new Promise(resolve=>setImmediate(resolve));
 return dom;
}
function fixture(){
 const past=Math.floor(Date.now()/300000)*300000;
 const row=(n,source,pred,actual)=>({
   roundStartMs:past-n*300000,productionModel:modelVersion,productionModelVersion:modelVersion,
   productionSource:source,productionPrediction:pred,productionActual:actual,
   productionResult:actual==null?'PENDING':pred===actual?'HIT':'MISS'
 });
 return {ok:true,productionSignalSourceMode:'SELECTIVE_V2_FAST8',
   settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
   activeProductionModel:null,
   records:[
     row(0,'EDGE_RESCUE_FAST8_PRIMARY','DOWN',null),
     row(1,'SELECTIVE_V2_FAST8_PRIMARY','UP','UP'),
     row(2,'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION','DOWN','UP'),
     {roundStartMs:past-900000,productionModel:'zl_new_vip75',productionModelVersion:'OLD',productionPrediction:'UP',productionActual:'UP',productionResult:'HIT'},
     {roundStartMs:past-1200000,productionModel:'ZL_FAST8_65',productionPrediction:'UP',productionActual:'UP',productionResult:'HIT'},
   ]};
}
test('production dashboard identifies 8s Selective V2 + Edge Rescue, not retired VIP75',()=>{
 assert.match(primary,/Selective V2 \+ Edge Rescue/);
 assert.doesNotMatch(primary,/2026-10-10 固定训练版本/);
 assert.match(source,/SELECTIVE_V2_FAST8_THEN_EDGE_RESCUE_FAST8/);
 assert.match(source,/SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION/);
 assert.ok(source.includes('$'+'{primaryCard}'+'$'+'{statsCard}'+'$'+'{marker}'));
 assert.ok(source.includes('$'+'{primaryScript}'+'$'+'{statsScript}</body>'));
 assert.ok(!source.includes('$'+'{policyCard}'+'$'+'{previewCard}'+'$'+'{statsCard}'));
 new vm.Script(mainScript);new vm.Script(stats);
});
test('main card uses current 8s version with correct model and inverse results',async()=>{
 const d=await execute(mainScript,fixture());
 assert.match(d.get('activeFast8Name').textContent,/Selective V2/);
 assert.match(d.get('activeFast8Name').textContent,/Edge Rescue/);
 assert.equal(d.get('activeFast8Direction').textContent,'DOWN');
 assert.equal(d.get('activeFast8Accuracy').textContent,'50.00%');
 assert.equal(d.get('activeFast8InverseAccuracy').textContent,'100.00%');
 assert.equal(d.get('activeFast8InverseHitMiss').textContent,'2 / 0（2轮）');
 assert.equal(d.get('activeFast8HitMiss').textContent,'1 / 1');
 assert.match(d.get('activeFast8Note').textContent,/低置信度方向 1 轮/);
});
test('current stats exclude historical VIP75 and label each new production layer',async()=>{
 const d=await execute(stats,fixture());
 assert.match(d.get('rsAccuracy').innerHTML,/50.00%/);
 assert.equal(d.get('rsSettled').textContent,2);
 assert.equal(d.get('rsDecided').textContent,2);
 assert.match(d.get('rsMeta').textContent,/Selective V2（8秒）/);
 const rows=d.get('rsRows').innerHTML;
 assert.match(rows,/Selective V2（8秒主策略）/);
 assert.match(rows,/Edge Rescue（8秒兜底）/);
 assert.match(rows,/低置信度行情方向（允许下单）/);
 assert.doesNotMatch(rows,/zl_new_vip75/);
 assert.doesNotMatch(rows,/ZL_FAST8_65/);
});
test('without production-mode confirmation frontend does not pretend restored mode is active',async()=>{
 const d=await execute(mainScript,{ok:true,records:[],activeProductionModel:null});
 assert.equal(d.get('activeFast8Name').textContent,'生产模式待确认');
 assert.equal(d.get('activeFast8Accuracy').textContent,'尚无新结算');
});
test('low-confidence direction is distinctly labeled but not suppressed',async()=>{
 const j=fixture(),cur=j.records[0];cur.productionSource='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';
 const d=await execute(mainScript,j);
 assert.match(d.get('activeFast8Direction').textContent,/DOWN（低置信度 · 反向）/);
});
test('the card keeps separate model prediction vs source-aware order direction',()=>{
 assert.ok(primary.includes('id="activeFast8Direction"'));
 assert.ok(primary.includes('id="activeFast8OrderDirection"'));
 assert.match(mainScript,/j\.orderSignal/);
 assert.match(stats,/新版模型命中率/);
 assert.match(primary,/sourceRateRows/);
 assert.match(primary,/按当前下单规则推算命中率/);
});
test('three independent strategy rows preserve sample counts and direction mapping',async()=>{
 const j=fixture();
 const past=Math.floor(Date.now()/300000)*300000;
 j.records.push({roundStartMs:past-1500000,
   productionModel:'SELECTIVE_V2_FAST8_PREWARM_V1',
   productionModelVersion:'SELECTIVE_V2_FAST8_PREWARM_V1',
   productionSource:'EDGE_RESCUE_FAST8_PRIMARY',
   productionPrediction:'DOWN',productionActual:'DOWN',productionResult:'HIT'});
 const d=await execute(mainScript,j);
 const rows=d.get('sourceRateRows').innerHTML;
 assert.match(rows,/Selective V2（主策略）/);
 assert.match(rows,/Edge Rescue（兜底）/);
 assert.match(rows,/低置信度行情兜底/);
 assert.match(rows,/正向/);
 assert.match(rows,/反向/);
 assert.equal((rows.match(/1\/1 · 100\.00%/g)||[]).length,7);
 assert.match(rows,/0\/1 · 0\.00%/);
 assert.match(primary,/UP胜率/);
 assert.match(primary,/DOWN胜率/);
 assert.equal(d.get('activeFast8Accuracy').textContent,'66.67%');
 assert.equal(d.get('activeFast8InverseAccuracy').textContent,'100.00%');
 assert.doesNotMatch(rows,/zl_new_vip75/);
});
test('missing settled current-version predictions shows no synthetic accuracy',async()=>{
 const j=fixture();
 j.records=j.records.filter(z=>z.productionModel==='zl_new_vip75'||z.productionActual==null);
 const d=await execute(mainScript,j);
 assert.equal(d.get('activeFast8Accuracy').textContent,'尚无新结算');
 assert.equal(d.get('activeFast8InverseAccuracy').textContent,'尚无新结算');
});

test('mobile control area contains 12 explicit independent switches, OFF labels and revision checks',async()=>{
 const d=await execute(mainScript,fixture());
 const html=d.get('directionModeChoices').innerHTML;
 assert.equal((html.match(/<button /g)||[]).length,12);
 for(const side of ['UP','DOWN'])for(const mode of ['正向','反向'])
   assert.match(html,new RegExp(side+' '+mode));
 assert.match(html,/data-dir-side="UP"/);
 assert.match(html,/data-dir-side="DOWN"/);
 assert.match(mainScript,/expectedRevision:revision/);
 assert.match(mainScript,/mode=src\.modes\[side\]===selectedMode\?'OFF':selectedMode/);
 assert.match(html,/aria-pressed="true"/);
});
test('mode data is read from backend and no old source-wide toggle is shown',async()=>{
 const d=await execute(mainScript,fixture());
 const html=d.get('directionModeChoices').innerHTML;
 assert.match(html,/Selective V2（主策略）/);
 assert.match(html,/低置信度行情兜底/);
 assert.match(html,/DOWN 反向/);
 assert.doesNotMatch(html,/data-dir-mode="正向"/);
});
