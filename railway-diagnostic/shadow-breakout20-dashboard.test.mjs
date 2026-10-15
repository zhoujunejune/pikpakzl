import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { shadowCard, shadowScript, createShadowStatusProxy } from './shadow-breakout20-dashboard.mjs';

const sample = {
  name:'突破20%即可',readOnly:true,orders:false,productionIntegration:false,
  version:'BREAKOUT20_RSI_MACD_RANGE_V1',serverSecret:'NEVER_FORWARD',
  timed:{lastTickAt:Date.now(),lastGoodDataAt:Date.now(),nextAlarm:Date.now()+300000,deadlineMs:8000},
  training:{historicalApproxSamples:191,trainedModel:'BASELINE',latestTraining:{at:Date.now(),ok:true,adopted:false}},
  results:{rounds:3,locked:2,dataGaps:1,pending:0,
    overall:{samples:2,hits:1,accuracy:0.5},
    up:{samples:1,hits:1,accuracy:1},down:{samples:1,hits:0,accuracy:0},
    recent20:{samples:2,hits:1,accuracy:0.5},recent100:{samples:2,hits:1,accuracy:0.5}},
  latest:{t:Date.now()-300000,direction:'UP',actual:'UP',status:'SETTLED',lockedAt:Date.now()-293000,delayMs:6850},
  recent:[{t:Date.now()-300000,direction:'UP',actual:'UP',status:'SETTLED',lockedAt:Date.now()-293000}]
};

function fakeResponse() {
  return {status:0,headers:{},body:null,writeHead(code,headers){this.status=code;this.headers=headers;},
    end(body){this.body=JSON.parse(body);}};
}

test('readonly proxy validates external status, caches and strips unspecified payload fields',async()=>{
  let calls=0;
  const proxy=createShadowStatusProxy({fetcher:async(url,options)=>{
    calls++; assert.equal(url,'https://breakout20-shadow.zl528094-3ba.workers.dev/status');
    assert.equal(options.method,'GET');
    return {ok:true,json:async()=>sample};
  },now:()=>100000,cacheTtlMs:4500});
  const a=fakeResponse(),b=fakeResponse();
  await Promise.all([proxy(a),proxy(b)]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(calls,1);
  assert.equal(a.body.results.overall.accuracy,0.5);
  assert.equal(a.body.training.historicalApproxSamples,191);
  assert.equal(a.body.latest.direction,'UP');
  assert.equal(a.body.serverSecret,undefined);
  assert.equal(a.body.readOnly,undefined);
  assert.equal(a.body.ok,true);
});

test('readonly proxy fails closed on non-shadow trading payload or network fault',async()=>{
  for(const fetcher of [
    async()=>({ok:true,json:async()=>({...sample,orders:true})}),
    async()=>{throw Error('timeout');}
  ]){
    const res=fakeResponse();
    await createShadowStatusProxy({fetcher})(res);
    assert.equal(res.status,502);
    assert.equal(res.body.ok,false);
    assert.equal(res.body.error,'SHADOW_STATUS_TEMPORARILY_UNAVAILABLE');
  }
});

test('the UI renders only observational data and independent forward accuracy',async()=>{
  assert.match(shadowCard,/突破20%即可/);
  assert.match(shadowCard,/仅观察 · 不参与下单/);
  assert.doesNotMatch(shadowScript,/\/api\/control|\/api\/confirm|method:\s*['"]POST/);
  let requested=[];
  const els=new Map(),element=id=>{
    if(!els.has(id))els.set(id,{textContent:'',innerHTML:'',style:{}});
    return els.get(id);
  };
  element('breakout20ShadowCard');
  const env={document:{readyState:'complete',getElementById:element},
    fetch:async(url)=>{requested.push(String(url));return {ok:true,json:async()=>({...sample,ok:true,fetchedAt:Date.now()})};},
    setInterval:()=>0,Date,Array,Math,Number,String,Object,Error,Promise,isFinite};
  new vm.Script(shadowScript.replace(/^<script>/,'').replace(/<\/script>$/,'')).runInNewContext(env);
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('b20Accuracy').textContent,/50\.00%/);
  assert.match(element('b20UpAccuracy').textContent,/100\.00%/);
  assert.match(element('b20DownAccuracy').textContent,/0\.00%/);
  assert.match(element('b20Training').textContent,/保留基线/);
  assert.match(element('b20Rows').innerHTML,/命中/);
  assert.ok(requested.every(u=>u.startsWith('/api/shadow-breakout20/status?ts=')));
});

test('production shell only imports and mounts isolated UI and GET route',()=>{
  const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
  assert.match(shell,/import \{ shadowCard, shadowScript, proxyShadowStatus \}/);
  assert.match(shell,/shadowCard/);
  assert.match(shell,/url.pathname === '\/api\/shadow-breakout20\/status'\) return proxyShadowStatus\(res\)/);
  assert.doesNotMatch(shadowScript,/window\.(confirmOrder|setV|setDirectionMode)/);
});
