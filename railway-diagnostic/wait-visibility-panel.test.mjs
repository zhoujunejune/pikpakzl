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
  assert.ok(source.includes('${policyCard}${previewCard}${statsCard}'));
  assert.ok(source.includes('${statsScript}${previewScript}${policyScript}'));
  assert.ok(embedded,'embedded browser script must be parseable and present');
  const sandboxScript=new vm.Script(embedded,{filename:'embedded-wait-visibility.js'});
  const dom=new Map();
  for(const id of ['waitVisibilityCard','wvTradeStatus','wvMeta','wvPreview','wvPmSide','wvCoverage','wvHitRate','wvBlockers','wvRows'])dom.set(id,{textContent:'',innerHTML:''});
  const start=Date.parse('2026-10-10T12:15:00.000Z');
  const base={roundStartMs:start,productionPrediction:'WAIT',productionActual:'UP',
     v3NoBase15sShadow:{round:start,observedAt:start+15500,baseAbsentAtObservation:true,
       inputFrozenBeforeSettlement:true,facts:{upMid:0.60,bookMappingReliable:true,bookRoundAligned:true,gateFailures:[],dataFresh:true},
       candidates:{CURRENT_03_PM_AGREE:{decision:'UP',qualified:true,reasons:[]}, BLENDED_04_PM_AGREE:{decision:'UP',qualified:true,reasons:[]}}}};
  const j={ok:true,records:[base]};
  const environment={
    document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
    fetch:async()=>({ok:true,json:async()=>j}),
    setInterval:()=>0,
    __active15sCandidateIds:['CURRENT_03_PM_AGREE'],
    Date,Math,Set,Array,Number,Error,Promise,String,Object
  };
  sandboxScript.runInNewContext(environment);
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(dom.get('wvTradeStatus').innerHTML,/生产.*WAIT/);
  assert.match(dom.get('wvPreview').innerHTML,/UP/);
  assert.match(dom.get('wvCoverage').textContent,/1\/1/);
  assert.match(dom.get('wvHitRate').textContent,/100.0%/);
  assert.match(dom.get('wvRows').innerHTML,/CURRENT_03_PM_AGREE/);
  assert.doesNotMatch(dom.get('wvRows').innerHTML,/BLENDED_04_PM_AGREE/);
  assert.doesNotMatch(dom.get('wvRows').innerHTML,/PM_LEAN_03/);
  assert.match(dom.get('wvPreview').innerHTML,/仅观察/);
});

test('no frozen candidate must not be mislabeled a locked production direction',async()=>{
  assert.ok(embedded?.includes('productionPrediction'));
  assert.ok(embedded?.includes('inputFrozenBeforeSettlement'));
  assert.ok(embedded?.includes('gateFailures'));
  assert.ok(embedded?.includes('候选'));
});

const policyHtml=source.match(/const policyCard = \`([\s\S]*?)\`;/)?.[1];
const policyEmbedded=source.match(/const policyScript = \`<script>([\s\S]*?)<\/script>\`;/)?.[1];

function policyFixture(approved) {
  const make=(id,ok)=>({
    candidateId:id,source:'LOW_PRIORITY_15S_'+id+'_PRIMARY',
    eligibleForProduction:ok,forwardQualified:ok,
    candidateForward:{candidateId:id,status:ok?'ELIGIBLE_FOR_INDEPENDENT_REVIEW':'COLLECTING',
      strictForwardSamples:ok?120:27,hits:ok?104:18,misses:ok?16:9,
      forwardAccuracy:ok?0.8667:0.6667,
      recent30:{samples:ok?30:27,accuracy:ok?0.8:0.66},
      up:{samples:ok?65:14,accuracy:ok?0.8:0.64},
      down:{samples:ok?55:13,accuracy:ok?0.8:0.69}},
    timedFuse:{scopes:{GLOBAL:{mode:'OPEN'},UP:{mode:'OPEN'},DOWN:{mode:'OPEN'}}}
  });
  return {ok:true,models:{all15sCandidateRegistry:{
    productionRoute:'QUALIFIED_15S_15_TO_20S_THEN_SELECTIVE_V2_EDGE_THEN_QUALIFIED_15S_25_TO_35S',
    candidates:['CURRENT_03_PM_AGREE',
      'PM_FLOW15_CURRENT_03','PM_TREND_045_CURRENT_03',
      'CURRENT_04_TREND_055_PM05','CURRENT_03_TREND_045_PM08',
      'PM_REGIME35_SUPPORT08','PM_CURRENT25_SUPPORT08',
      'ABS_PM_CURRENT15'].map((id,i)=>make(id,approved&&i===0))
  }}};
}
async function renderPolicy(payload){
  assert.ok(policyHtml?.includes('id="signalPolicyCard"'));
  assert.ok(policyEmbedded);
  new vm.Script(policyEmbedded,{filename:'embedded-auto-promotion-ui.js'});
  const dom=new Map();
  for(const id of ['signalPolicyCard','spTitle','spRule','spQualified',
    'spObserve','spFreshness','spNotice','spRows'])dom.set(id,{innerHTML:'',textContent:''});
  let readPath=null;
  const context={
    document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
    fetch:async(path)=>{readPath=path;return {ok:payload.ok===true,json:async()=>payload}},
    setInterval:()=>0,Date,Math,Set,Array,Number,Error,Promise,String,Object,isFinite
  };
  new vm.Script(policyEmbedded).runInNewContext(context);
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  return {dom,readPath};
}
test('panel lists only active candidates instead of resurrecting deleted models',async()=>{
  const {dom,readPath}=await renderPolicy(policyFixture(false));
  assert.match(readPath,/api\/training-status/);
  assert.match(policyHtml,/15—20秒/);
  assert.doesNotMatch(policyHtml,/25—35秒/);
  assert.match(policyHtml,/停止晋级/);
  assert.match(policyHtml,/Edge Rescue/);
  assert.match(dom.get('spTitle').innerHTML,/当前无现役15秒策略可放行/);
  assert.equal(dom.get('spQualified').textContent,'0/6');
  assert.equal(dom.get('spObserve').textContent,'6/6');
  assert.doesNotMatch(dom.get('spRows').innerHTML,/BLENDED_04_PM_AGREE/);
  assert.doesNotMatch(dom.get('spRows').innerHTML,/ABS_PM_REGIME35/);
  assert.doesNotMatch(dom.get('spRows').innerHTML,/PM_LEAN_03/);
  assert.doesNotMatch(dom.get('spRows').innerHTML,/zl_new_vip75/);
  assert.doesNotMatch(dom.get('spRows').innerHTML,/PM_TREND_045_CURRENT_03/);
  assert.doesNotMatch(dom.get('spRows').innerHTML,/CURRENT_04_TREND_055_PM05/);
});
test('panel differentiates current live risk permission and blocked models',async()=>{
  const {dom}=await renderPolicy(policyFixture(true));
  assert.equal(dom.get('spQualified').textContent,'1/6');
  assert.equal(dom.get('spObserve').textContent,'5/6');
  assert.match(dom.get('spTitle').innerHTML,/1种现役15秒策略可放行/);
  assert.match(dom.get('spRows').innerHTML,/现役可放行/);
  assert.match(dom.get('spRows').innerHTML,/暂不可放行/);
});
test('unavailable training API is not incorrectly reported as zero promoted',async()=>{
  const {dom}=await renderPolicy({ok:false,error:'TIMEOUT'});
  assert.match(dom.get('spTitle').textContent,/读取失败/);
  assert.equal(dom.get('spQualified').textContent,'未获取');
  assert.match(dom.get('spRows').innerHTML,/TIMEOUT/);
});
test('official history labels historical speculative locks separately from promoted 15s locks',()=>{
  const stats=source.match(/const statsScript = \`<script>([\s\S]*?)<\/script>\`;/)?.[1];
  assert.ok(stats);
  new vm.Script(stats);
  assert.match(stats,/productionFallbackReason/);
  assert.match(stats,/15秒现役/);
  assert.match(stats,/15秒历史试验/);
  assert.match(stats,/SELECTIVE_V2_EDGE_RESCUE_PRIMARY/);
  assert.match(stats,/当前路由：现役15秒/);
  assert.doesNotMatch(stats,/25—35秒/);
});

test('permanently deleted strategies cannot return in the policy panel even from a stale registry',async()=>{
  const stale=policyFixture(true);
  stale.models.all15sCandidateRegistry.candidates.push({
    candidateId:'BLENDED_04_PM_AGREE', eligibleForProduction:true
  });
  stale.models.all15sCandidateRegistry.candidates.push({
    candidateId:'ABS_PM_REGIME35', eligibleForProduction:true
  });
  const {dom}=await renderPolicy(stale);
  assert.equal(dom.get('spQualified').textContent,'1/6');
  for(const id of ['PM_TREND_045_CURRENT_03','CURRENT_04_TREND_055_PM05','BLENDED_04_PM_AGREE','ABS_PM_REGIME35']){
    assert.equal(dom.get('spRows').innerHTML.includes(id),false,id);
  }
});
