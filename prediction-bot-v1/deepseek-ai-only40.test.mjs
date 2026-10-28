import test from 'node:test';
import assert from 'node:assert/strict';
import {COLLECT_MS,DEADLINE_MS,makeWindow,collect,decodeAnalysis,registerAnalysis,finalize,closeExpiredWindow,analysisRequest} from './deepseek-adaptive15-core.mjs';
import {buildAdaptive15CompatibleSignal} from './deepseek-adaptive15-production-adapter.mjs';
import {MAX_AI_CALLS_PER_ROUND,MAX_PRE_ROUND_CALLS,MAX_LIVE_CALLS} from './deepseek-adaptive15-runner.mjs';

const R=1800000300000;
function windowAt(seconds=30){
 const w=makeWindow(R);
 for(let i=0;i<105;i++)collect(w,{round:R-300000,at:R-120000+i*1000,price:67000+i*.2,open:66000});
 for(let i=0;i<=seconds;i++)collect(w,{round:R,at:R+i*1000,price:68000+i*.2,open:68000});
 return w;
}
function add(w,pass,side,at){
 registerAnalysis(w,decodeAnalysis(JSON.stringify({direction:side,confidence:.57,reason:'Model response from genuine BTC data',risk:'uncertain'}),R,at,pass));
}
test('prewarm 120s and hard current AI cutoff +40s; 15s current sampling required',()=>{
 assert.equal(COLLECT_MS,120000);
 assert.equal(DEADLINE_MS,40000);
 assert.equal(MAX_AI_CALLS_PER_ROUND,5);
 assert.equal(MAX_PRE_ROUND_CALLS,2);
 assert.equal(MAX_LIVE_CALLS,3);
 const w=windowAt(28);
 add(w,'initial','UP',R-55000);
 assert.throws(()=>finalize(w,R+14000),/NOT_IN_15_TO_40S_LOCK_WINDOW/);
 const missing=finalize(w,R+28000);
 assert.equal(missing.ok,false);
 assert.equal(missing.reason,'NO_VALID_CURRENT_ROUND_DEEPSEEK_REVIEW');
 assert.equal(w.final,null);
});
test('no prior-round fallback: current model WAIT means NO order',()=>{
 const w=windowAt(28);
 add(w,'initial','UP',R-55000);
 add(w,'review','UP',R-22000);
 add(w,'current','WAIT',R+23000);
 const d=finalize(w,R+28000);
 assert.equal(d.ok,false);
 assert.equal(d.reason,'DEEPSEEK_CHOSE_WAIT');
 assert.equal(w.final,null);
});
test('valid real current DeepSeek UP can lock after +15s and before +40s',()=>{
 const w=windowAt(33);
 add(w,'initial','DOWN',R-53000);
 add(w,'current','UP',R+30000);
 const d=finalize(w,R+34000);
 assert.equal(d.ok,true);
 assert.equal(d.latest.direction,'UP');
 assert.equal(d.latest.selectedAnalysis,'current');
 assert.equal(d.latest.aiVerified,true);
 assert.equal(d.latest.analysisAt,R+30000);
 const s=buildAdaptive15CompatibleSignal(d,R+34000,'deepseek-flash');
 assert.equal(s.latest.aiVerified,true);
 assert.equal(s.latest.decisionMethod,'DEEPSEEK_PREWARM120_LIVE40_AI_ONLY');
 assert.equal(s.expiryAt,R+270000);
 assert.equal(s.orders,false);
});
test('forged evidence, early model response and late decision are rejected',()=>{
 const w=windowAt(39);
 add(w,'current','DOWN',R+25000);
 const d=finalize(w,R+39600);
 assert.equal(d.latest.direction,'DOWN');
 assert.throws(()=>buildAdaptive15CompatibleSignal({...d,latest:{...d.latest,aiVerified:false}},R+39600,'deepseek-flash'),/FAST10_PROD_INVALID_CANDIDATE/);
 const early=windowAt(22);
 add(early,'current','UP',R+1000);
 const before=finalize(early,R+22000);
 assert.equal(before.ok,false);
 const late=windowAt(39);
 add(late,'current','UP',R+27000);
 assert.throws(()=>finalize(late,R+40000),/NOT_IN_15_TO_40S_LOCK_WINDOW/);
 assert.equal(closeExpiredWindow(late,R+40000),true);
 assert.equal(late.terminal.direction,'WAIT');
 assert.equal(late.terminal.reason,'DEADLINE_40S_EXPIRED');
});
test('model compares directions and permits WAIT only when evidence cannot support a choice',()=>{
 const w=windowAt(16);
 const a=analysisRequest(w,'current',R+16000,{}, {samples:200});
 const str=JSON.stringify(a.messages);
 assert.match(str,/rank UP and DOWN using verified live opening price/);
 assert.match(str,/Do not default to WAIT/);
 assert.match(str,/Never invent a directional edge/);
 assert.match(str,/explain which observed evidence favored the chosen direction/);
 assert.match(JSON.stringify(a.messages[1]),/preferActionableDirectionalRanking/);
 assert.equal(a.reasoning_effort,'high');
 assert.equal(a.thinking.type,'enabled');
});
