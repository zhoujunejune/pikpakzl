import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
const html=source.match(/const previewCard = `([\s\S]*?)`;/)?.[1];
const embedded=source.match(/const previewScript = `<script>([\s\S]*?)<\/script>`;/)?.[1];

test('production view preserves immutable WAIT while rendering separate forward candidate',async()=>{
  assert.ok(html?.includes('id="wvTradeStatus"'));
  assert.ok(html?.includes('id="wvPreview"'));
  assert.ok(source.includes('${previewCard}${statsCard}'));
  assert.ok(source.includes('${statsScript}${previewScript}'));
  assert.ok(embedded,'embedded browser script must be parseable and present');
  const sandboxScript=new vm.Script(embedded,{filename:'embedded-wait-visibility.js'});
  const dom=new Map();
  for(const id of ['waitVisibilityCard','wvTradeStatus','wvMeta','wvPreview','wvPmSide','wvCoverage','wvHitRate','wvBlockers','wvRows'])dom.set(id,{textContent:'',innerHTML:''});
  const start=Date.parse('2026-10-10T12:15:00.000Z');
  const base={roundStartMs:start,productionPrediction:'WAIT',productionActual:'UP',
     v3NoBase15sShadow:{round:start,observedAt:start+15500,baseAbsentAtObservation:true,
       inputFrozenBeforeSettlement:true,facts:{upMid:0.60,bookMappingReliable:true,bookRoundAligned:true,gateFailures:[],dataFresh:true},
       candidates:{PM_LEAN_03:{decision:'UP',qualified:true,reasons:[]}}}};
  const j={ok:true,records:[base]};
  const environment={
    document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
    fetch:async()=>({ok:true,json:async()=>j}),
    setInterval:()=>0,
    Date,Math,Set,Array,Number,Error,Promise,String,Object
  };
  sandboxScript.runInNewContext(environment);
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(dom.get('wvTradeStatus').innerHTML,/生产.*WAIT/);
  assert.match(dom.get('wvPreview').innerHTML,/UP/);
  assert.match(dom.get('wvCoverage').textContent,/1\/1/);
  assert.match(dom.get('wvHitRate').textContent,/100.0%/);
  assert.match(dom.get('wvRows').innerHTML,/PM_LEAN_03/);
});

test('no frozen candidate must not be mislabeled a locked production direction',async()=>{
  assert.ok(embedded?.includes('productionPrediction'));
  assert.ok(embedded?.includes('inputFrozenBeforeSettlement'));
  assert.ok(embedded?.includes('gateFailures'));
  assert.ok(embedded?.includes('候选'));
});
