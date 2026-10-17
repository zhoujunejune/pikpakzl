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

const officialResult={
 ok:true,model:'BREAKOUT20_RSI_MACD_RANGE_V1',
 source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
 statsScope:'CURRENT_MODEL_VERSION_PRODUCTION_LOCKS_ONLY',
 generatedAt:100000,retentionMayLimitTotal:false,
 results:{rounds:3,locked:3,pending:1,
   overall:{samples:2,hits:1,accuracy:0.5},
   up:{samples:1,hits:0,accuracy:0},
   down:{samples:1,hits:1,accuracy:1},
   recent20:{samples:2,hits:1,accuracy:0.5},
   recent100:{samples:2,hits:1,accuracy:0.5}},
 latest:{t:100000,direction:'UP',actual:null,status:'PENDING',lockedAt:107000,delayMs:7000},
 recent:[{t:100000,direction:'UP',actual:null,status:'PENDING',lockedAt:107000},
   {t:100000-300000,direction:'UP',actual:'DOWN',status:'SETTLED',lockedAt:0}]
};

function fakeResponse() {
  return {status:0,headers:{},body:null,writeHead(code,headers){this.status=code;this.headers=headers;},
    end(body){this.body=JSON.parse(body);}};
}

test('readonly proxy validates external status, caches and strips unspecified payload fields',async()=>{
  let calls=0;
  const proxy=createShadowStatusProxy({fetcher:async(url,options)=>{
    calls++;assert.equal(options.method,'GET');
    if(url.includes('breakout20-shadow'))return {ok:true,json:async()=>sample};
    assert.match(url,/\/api\/breakout20-official-accuracy$/);
    return {ok:true,json:async()=>officialResult};
  },now:()=>100000,cacheTtlMs:4500});
  const a=fakeResponse(),b=fakeResponse();
  await Promise.all([proxy(a),proxy(b)]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(calls,2);
  assert.equal(a.body.results.overall.accuracy,0.5);
  assert.equal(a.body.results.up.accuracy,0); // official, NOT spot proxy 100%
  assert.equal(a.body.shadowSpotResults.up.accuracy,1);
  assert.equal(a.body.official.source,'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY');
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
  assert.match(shadowCard,/官方结算只读统计/);
  assert.doesNotMatch(shadowScript,/\/api\/control|\/api\/confirm|method:\s*['"]POST/);
  let requested=[];
  const els=new Map(),element=id=>{
    if(!els.has(id))els.set(id,{textContent:'',innerHTML:'',style:{}});
    return els.get(id);
  };
  element('breakout20ShadowCard');
  const env={document:{readyState:'complete',getElementById:element},
    fetch:async(url)=>{
      requested.push(String(url));
      if(String(url).includes('/api/postflip-official-stats')){
        return {ok:true,json:async()=>({
          ok:true,model:'BREAKOUT20_RSI_MACD_RANGE_V1',statsScope:'POSTFLIP_EMITTED_SIGNAL_ONLY',
          resetAt:1792218000000,source:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
          results:officialResult.results,
          latest:{round:Date.now()-300000,raw:'DOWN',emitted:'UP',direction:'UP',actual:null,lockedAt:Date.now()-293000},
          recent:[{round:Date.now()-300000,raw:'DOWN',emitted:'UP',direction:'UP',actual:null,lockedAt:Date.now()-293000}]
        })};
      }
      return {ok:true,json:async()=>({...sample,ok:true,fetchedAt:Date.now(),
      official:{available:true},results:officialResult.results,latest:officialResult.latest,
      recent:officialResult.recent})};},
    setInterval:()=>0,Date,Array,Math,Number,String,Object,Error,Promise,isFinite};
  new vm.Script(shadowScript.replace(/^<script>/,'').replace(/<\/script>$/,'')).runInNewContext(env);
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('b20Accuracy').textContent,/50\.00%/);
  assert.match(element('b20UpAccuracy').textContent,/0\.00%/);
  assert.match(element('b20DownAccuracy').textContent,/100\.00%/);
  assert.match(element('b20Training').textContent,/保留基线/);
  assert.match(element('b20Rows').innerHTML,/待官方结算/);
  assert.ok(requested.some(u=>u.startsWith('/api/shadow-breakout20/status?ts=')));
  assert.ok(requested.some(u=>u.startsWith('/api/postflip-official-stats?model=')));
  assert.doesNotMatch(element('b20Meta').textContent,/193|旧模型胜率/);
});

test('production shell only imports and mounts isolated UI and GET route',()=>{
  const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
  assert.match(shell,/import \{ shadowCard, shadowScript, proxyShadowStatus \}/);
  assert.match(shell,/shadowCard/);
  assert.match(shell,/url.pathname === '\/api\/shadow-breakout20\/status'\) return proxyShadowStatus\(res\)/);
  assert.doesNotMatch(shadowScript,/window\.(confirmOrder|setV|setDirectionMode)/);
});


test('no Railway official settlement produces unavailable (not spot-based win rate)',async()=>{
 const proxy=createShadowStatusProxy({now:()=>100000,fetcher:async(url)=>{
  if(url.includes('breakout20-shadow'))return {ok:true,json:async()=>sample};
  throw Error('OFFICIAL_RAILWAY_OFFLINE');
 }});
 const r=fakeResponse();await proxy(r);
 assert.equal(r.status,200);
 assert.equal(r.body.official.available,false);
 assert.equal(r.body.results.overall.accuracy,null);
 assert.equal(r.body.shadowSpotResults.overall.accuracy,0.5);
 assert.equal(r.body.latest,null);
});
