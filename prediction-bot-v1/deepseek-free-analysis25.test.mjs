import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWindow,collect,decodeAnalysis,registerAnalysis,finalize,DEADLINE_MS} from './deepseek-adaptive15-core.mjs';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';
import {createAdaptive15ProductionProvider} from './deepseek-adaptive15-production-adapter.mjs';

const R=1800000300000;
function observation(now){
 const isCurrent=now>=R;
 const round=Math.floor(now/300000)*300000;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:now,roundStartMs:round,
   lastPrice:isCurrent?68000+(now-R)/2000:67000+(now-(R-120000))/2000,
   roundOpenPrice:isCurrent?68000:67000,marketFeedConnected:true},
  candles:{'1m':{rows:[]},'5m':{rows:[]}}};
}
test('single trusted current-round tick and genuine DeepSeek result may lock immediately',()=>{
 assert.equal(DEADLINE_MS,25000);
 const w=makeWindow(R);
 for(let i=0;i<30;i++)
  collect(w,{round:R-300000,at:R-30000+i*1000,price:67000+i*.2,open:67000});
 collect(w,{round:R,at:R+100,price:68000,open:68000});
 registerAnalysis(w,decodeAnalysis(JSON.stringify({direction:'DOWN',confidence:0.27,reason:'my real analysis',continueAnalysis:false}),R,R+200,'current'));
 const result=finalize(w,R+300,{samples:400,downSamples:200,downHistoricalAccuracy:0.01});
 assert.equal(result.ok,true);
 assert.equal(result.latest.direction,'DOWN');
 assert.equal(result.latest.lockedAt,R+300);
 assert.equal(result.latest.selectedAnalysis,'current');
 assert.equal(result.latest.policy.basis,'INFORMATION_ONLY_NO_PROGRAM_DECISION_RULE');
 const w2=makeWindow(R);
 for(let i=0;i<30;i++)collect(w2,{round:R-300000,at:R-30000+i*1000,price:67000+i,open:67000});
 collect(w2,{round:R,at:R+20000,price:68000,open:68000});
 registerAnalysis(w2,decodeAnalysis(JSON.stringify({direction:'UP',confidence:.6}),R,R+21000,'current'));
 assert.throws(()=>finalize(w2,R+25000),/NOT_IN_25S_LOCK_WINDOW/);
});
test('DeepSeek uses at most six total calls, revises itself, and locks without forced waiting',async()=>{
 let at=R-120000;
 const calls=[];const locks=[];let currentCount=0;
 const fetcher=async(url,opts)=>{
  if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>observation(at)};
  const req=JSON.parse(opts.body),input=JSON.parse(req.messages[1].content);
  calls.push({at,phase:input.phase});
  if(input.phase!=='current')return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({direction:'UP',confidence:.65,continueAnalysis:false})}}]})};
  currentCount++;
  const keep=currentCount<=3;
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({direction:keep?'UP':'DOWN',confidence:.52,continueAnalysis:keep,reason:'new observed data'})}}]})};
 };
 const runner=createAdaptiveRunner({clock:()=>at,fetcher,
   env:{ADAPTIVE15_ENABLE_AI:'1',DEEPSEEK_API_KEY:'mock',DEEPSEEK_MODEL:'deepseek-flash'},
   getHistoricalFeedback:()=>({usable:false}),onLocked:s=>locks.push(s)});
 for(at=R-120000;at<=R+22000;at+=500)await runner.tick();
 assert.equal(locks.length,1);
 assert.equal(locks[0].latest.direction,'DOWN');
 assert.ok(locks[0].generatedAt>=R);
 assert.ok(locks[0].generatedAt<R+25000);
 assert.equal(locks[0].latest.selectedAnalysis,'current');
 assert.equal(currentCount,4);
 assert.equal(calls.length,6);
 assert.ok(calls.filter(x=>x.phase==='current').every((x,i,a)=>i===0||x.at-a[i-1].at>=6000));
 assert.ok(calls.length>3);
 assert.equal(runner.status().orders,false);
});
test('production may publish with unavailable optional indicators under six-call cap',async()=>{
 let at=R-120000,modelCalls=0;
 const provider=createAdaptive15ProductionProvider({
  env:{DEEPSEEK_API_KEY:'mock',DEEPSEEK_MODEL:'deepseek-flash',
   LLM_STATE_FILE:'/tmp/zl-free25-unused-'+process.pid+'.json',
   DEEPSEEK_LEARNING_FILE:'/tmp/zl-free25-learner-unused-'+process.pid+'.json',
   DEEPSEEK_QUALITY_JOURNAL_FILE:'/tmp/zl-free25-quality-unused-'+process.pid+'.json',
   DEEPSEEK_WAIT_JOURNAL_FILE:'/tmp/zl-free25-waits-unused-'+process.pid+'.json'},
  clock:()=>at,
  fetcher:async (url,opts)=>{
   if(String(url).includes('round-stats'))return {ok:true,json:async()=>({ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',records:[]})};
   if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>observation(at)};
   modelCalls++;
   const v=JSON.parse(JSON.parse(opts.body).messages[1].content);
   const isCurrent=v.phase==='current';
   return {ok:true,json:async()=>({choices:[{finish_reason:'stop',
    message:{content:JSON.stringify({direction:'UP',confidence:.75,continueAnalysis:isCurrent&&modelCalls<6,reason:'real but few indicators'})}}]})};
  }});
 for(at=R-120000;at<=R+22000;at+=500)await provider.tick();
 const s=provider.status();
 assert.equal(s.maxCallsPerRound,6);
 assert.equal(s.preRoundMaxCalls,2);
 assert.equal(s.currentRoundMaxCalls,4);
 assert.equal(s.liveReviewMinIntervalMs,6000);
 assert.equal(s.analysisCountLimit,'PRE2_LIVE4_TOTAL6');
 assert.equal(s.featureReady,true);
 assert.equal(s.signal?.latest.direction,'UP');
 assert.equal(s.signal?.round,R);
 assert.ok(s.signal.generatedAt<R+25000);
 assert.equal(s.realOrderEnabled,false);
});
