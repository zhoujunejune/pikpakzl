import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
const panel=source.match(/const singleSignalCard = `([\s\S]*?)`;/)?.[1];
const script=source.match(/const singleSignalScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];
test('only the selected FLOW model has a visible current strategy card, without altering trade inputs',()=>{
 assert.ok(panel?.includes('id="singleSignalCard"'));
 assert.ok(panel.includes('FLOW_BOOK_PROXY_V1'));
 assert.ok(source.includes('id="roundStatsCard"')); // audit legacy source retained
 assert.ok(source.includes('function injectStats(html)'));
 assert.match(source,/\$\{singleSignalCard\}/);
 assert.doesNotMatch(panel,/MEAN_REVERSION_FLOW_PROXY_V1|REGIME_SWITCH_PROXY_V1/);
});
test('panel does not mistake selected shadow candidate for live trade signal',async()=>{
 assert.ok(script);
 const compiled=new vm.Script(script);
 const ids=['singleSignalCard','ssModel','ssStatus','ssAccuracy','ssLabeled','ssResults',
  'ssDirection','ssEvidence','ssCurrent','signalPolicyCard','waitVisibilityCard','roundStatsCard'];
 const nodes=new Map(ids.map(id=>[id,{textContent:'',style:{display:''}}]));
 const j={ok:true,productionSignalSourceMode:'FAST8_ONLY',
  selectedExternalSignal:{model:'FLOW_BOOK_PROXY_V1',productionActive:false,
   currentProductionModel:'ZL_FAST8_65',samples:7,hits:4,misses:3,
   accuracy:4/7,verifiedSamples:1,researchDirection:'UP',researchRound:1791888600000}};
 const ctx={document:{readyState:'complete',getElementById:id=>nodes.get(id)},
  fetch:async()=>({ok:true,json:async()=>j}),setInterval:()=>null,
  Date,Math,Number,String,Object,Error,isFinite};
 compiled.runInNewContext(ctx);
 await new Promise(ok=>setImmediate(ok));await new Promise(ok=>setImmediate(ok));
 assert.equal(nodes.get('ssAccuracy').textContent,'57.14%');
 assert.equal(nodes.get('ssLabeled').textContent,'7 轮');
 assert.match(nodes.get('ssStatus').textContent,/尚未接管真实下单/);
 assert.match(nodes.get('ssCurrent').textContent,/ZL_FAST8_65/);
 assert.equal(nodes.get('ssDirection').textContent.startsWith('UP'),true);
 for(const id of ['signalPolicyCard','waitVisibilityCard','roundStatsCard'])
   assert.equal(nodes.get(id).style.display,'none');
});
test('panel displays production active only when backend confirms same-round model lock',async()=>{
 const compiled=new vm.Script(script);
 const ids=['ssModel','ssStatus','ssAccuracy','ssLabeled','ssResults','ssDirection','ssEvidence','ssCurrent'];
 const nodes=new Map(ids.map(id=>[id,{textContent:'',style:{display:''}}]));
 compiled.runInNewContext({document:{readyState:'complete',getElementById:id=>nodes.get(id)||null},
  fetch:async()=>({ok:true,json:async()=>({ok:true,productionSignalSourceMode:'FAST8_ONLY',
   selectedExternalSignal:{model:'FLOW_BOOK_PROXY_V1',productionActive:true,
   currentProductionModel:'FLOW_BOOK_PROXY_V1',samples:18,hits:11,misses:7,
   accuracy:11/18,verifiedSamples:2,researchDirection:'DOWN',researchRound:1791888600000}})}),
  setInterval:()=>null,Date,Math,Number,String,Object,Error,isFinite});
 await new Promise(ok=>setImmediate(ok));await new Promise(ok=>setImmediate(ok));
 assert.match(nodes.get('ssStatus').textContent,/生产已启用/);
 assert.equal(nodes.get('ssResults').textContent,'11 / 7');
});
