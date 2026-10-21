import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdaptiveRunner,MAX_AI_CALLS_PER_ROUND,MAX_PRE_ROUND_CALLS,MAX_LIVE_CALLS}
  from './deepseek-adaptive15-runner.mjs';
import {makeWindow,collect,registerAnalysis,decodeAnalysis,finalize,closeExpiredWindow,analysisRequest,DEADLINE_MS}
  from './deepseek-adaptive15-core.mjs';
import {buildAdaptive15CompatibleSignal} from './deepseek-adaptive15-production-adapter.mjs';

const R=1800000300000;
const candles=(ms,n,now)=>Array.from({length:n},(_,i)=>({
 startMs:now-(n+12-i)*ms,open:67000+i,high:67005+i,
 low:66995+i,close:67001+i,volume:100+i,closed:true
}));
const market=at=>{
 const current=at>=R;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
 eventMs:at,roundStartMs:Math.floor(at/300000)*300000,
 lastPrice:current?68000+(at-R)/1000:67000+(at-R+120000)/1000,
 roundOpenPrice:current?68000:67000,marketFeedConnected:true},
 candles:{'1m':{rows:candles(60000,70,at)},'5m':{rows:candles(300000,70,at)}}};
};
async function simulated(answer='UP',late=false){
 let at=R-120000,calls=[],locked=[],waits=[];
 const runner=createAdaptiveRunner({clock:()=>at,
  env:{ADAPTIVE15_ENABLE_AI:'1',DEEPSEEK_API_KEY:'mock',DEEPSEEK_MODEL:'deepseek-flash'},
  onLocked:d=>locked.push(d),onWait:d=>waits.push(d),
  getHistoricalFeedback:()=>({samples:150,officialErrorPatterns:[]}),
  fetcher:async(url,opts)=>{
   if(String(url).includes('shadow-market-data'))
    return {ok:true,json:async()=>market(at)};
   const p=JSON.parse(opts.body),prompt=JSON.parse(p.messages[1].content);
   calls.push({at,provider:p.model,phase:prompt.phase,preTicks:prompt.priorTwoMinuteTicks.length,
    early:prompt.currentRoundTicks.length,thinking:p.thinking,effort:p.reasoning_effort,
    maxTokens:p.max_tokens,deadline:prompt.decisionDeadlineMs});
   if(late)at=R+9200; // forced slow model for causal/timeout guard test
   return {ok:true,json:async()=>({usage:{total_tokens:120},choices:[{finish_reason:'stop',
    message:{content:JSON.stringify({direction:answer,confidence:.52,reason:'real BTC current and historic data',risk:'subjective uncertainty'})}}]})};
  }});
 for(at=R-120000;at<R+10000;at+=500)await runner.tick();
 return {calls,locked,waits,status:runner.status()};
}
test('one DeepSeek high-thinking call uses real new-round open and past market ticks and locks UP quickly',async()=>{
 const a=await simulated();
 assert.equal(DEADLINE_MS,9000);
 assert.equal(MAX_AI_CALLS_PER_ROUND,1);
 assert.equal(MAX_PRE_ROUND_CALLS,0);
 assert.equal(MAX_LIVE_CALLS,1);
 assert.equal(a.calls.length,1);
 assert.equal(a.calls[0].phase,'current');
 assert.ok(a.calls[0].at>=R);
 assert.ok(a.calls[0].at<R+9000);
 assert.ok(a.calls[0].preTicks>=10);
 assert.ok(a.calls[0].early>=1);
 assert.equal(a.calls[0].thinking.type,'enabled');
 assert.equal(a.calls[0].effort,'high');
 assert.equal(a.calls[0].deadline,R+9000);
 assert.equal(a.locked.length,1);
 assert.equal(a.locked[0].latest.direction,'UP');
 assert.ok(a.locked[0].generatedAt<R+9000);
 assert.equal(a.waits.length,0);
 assert.equal(a.status.orders,false);
 assert.equal(buildAdaptive15CompatibleSignal(a.locked[0],a.locked[0].generatedAt,'deepseek-flash').latest.direction,'UP');
});
test('model explicitly returning WAIT never results in synthetic UP or DOWN',async()=>{
 const a=await simulated('WAIT');
 assert.equal(a.calls.length,1);
 assert.equal(a.locked.length,0);
 assert.equal(a.waits.length,1);
 assert.equal(a.waits[0].reason,'DEADLINE_9S_EXPIRED');
 assert.equal(a.waits[0].detail,'DEEPSEEK_CHOSE_WAIT');
});
test('model replying after 9 seconds cannot be locked and is not retried',async()=>{
 const a=await simulated('DOWN',true);
 assert.equal(a.calls.length,1);
 assert.equal(a.locked.length,0);
 assert.ok(a.waits.length<=1);
 assert.equal(a.status.orders,false);
});
test('hard 9-second validation independent of subjective prediction confidence',()=>{
 const w=makeWindow(R);
 for(let i=0;i<60;i++)collect(w,{round:R-300000,at:R-60000+i*1000,price:67000+i,open:67000});
 collect(w,{round:R,at:R+500,price:68000,open:68000});
 const prompt=analysisRequest(w,'current',R+550,{oneMinute:{ready:true},fiveMinute:{ready:true}},{samples:130});
 assert.equal(prompt.thinking.type,'enabled');
 assert.equal(JSON.parse(prompt.messages[1].content).currentRoundTicks.length,1);
 registerAnalysis(w,decodeAnalysis(JSON.stringify({direction:'DOWN',confidence:.1}),R,R+1000,'current'));
 const d=finalize(w,R+1100);
 assert.equal(d.latest.direction,'DOWN');
 assert.throws(()=>buildAdaptive15CompatibleSignal(d,R+9000,'deepseek-flash'),/INVALID/);
 const expired=makeWindow(R);
 assert.equal(closeExpiredWindow(expired,R+8999),false);
 assert.equal(closeExpiredWindow(expired,R+9000),true);
 assert.equal(expired.terminal.reason,'DEADLINE_9S_EXPIRED');
});
