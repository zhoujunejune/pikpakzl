import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeWindow,collect,decodeAnalysis,registerAnalysis,analysisRequest,finalize,closeExpiredWindow,DEADLINE_MS} from './deepseek-adaptive15-core.mjs';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';
import {buildAdaptive15CompatibleSignal} from './deepseek-adaptive15-production-adapter.mjs';
import {makeQualityStore} from './deepseek-adaptive15-quality-store.mjs';
const R=1800000300000;
function ready() {
 const w=makeWindow(R);
 for(let i=0;i<120;i++)collect(w,{round:R-300000,at:R-120000+i*1000,price:67000+i*.25,open:67000});
 for(let i=0;i<8;i++)collect(w,{round:R,at:R+i*1000,price:68000+i*.5,open:68000});
 return w;
}
function add(w,pass,direction,at) {
 const a=decodeAnalysis(JSON.stringify({direction,confidence:.57,reason:'genuine observation',risk:'market risk'}),R,at,pass);
 registerAnalysis(w,a);
}
test('25 seconds is a hard boundary for non-fabricated DeepSeek judgments',()=>{
 assert.equal(DEADLINE_MS,25000);
 const w=ready();
 add(w,'initial','UP',R-50000);
 add(w,'review','UP',R-25000);
 add(w,'current','DOWN',R+16000);
 collect(w,{round:R,at:R+20000,price:68018,open:68000});
 const d=finalize(w,R+21000);
 assert.equal(d.latest.direction,'DOWN');
 assert.equal(d.latest.selectedAnalysis,'current');
 assert.equal(d.latest.currentAnalysis,'DOWN');
 assert.equal(d.generatedAt,R+21000);
 assert.equal(d.orders,false);
 const envelope=buildAdaptive15CompatibleSignal(d,R+21000,'deepseek-flash');
 assert.equal(envelope.latest.direction,'DOWN');
 assert.equal(envelope.generatedAt,R+21000);
 assert.equal(envelope.expiryAt,R+270000);
 assert.throws(()=>buildAdaptive15CompatibleSignal(d,R+25000,'deepseek-flash'),/INVALID/);
 const w2=ready();add(w2,'initial','UP',R-50000);
 assert.throws(()=>finalize(w2,R+25000),/NOT_IN_15S_LOCK_WINDOW|NOT_IN_25S_LOCK_WINDOW/);
 assert.equal(closeExpiredWindow(w2,R+25000),true);
 assert.equal(w2.terminal.direction,'WAIT');
});
test('DeepSeek can choose WAIT, and no market-rule vote overrides model',()=>{
 const w=ready();
 add(w,'initial','DOWN',R-50000);
 add(w,'current','WAIT',R+11000);
 collect(w,{round:R,at:R+15000,price:68008,open:68000});
 const d=finalize(w,R+16000);
 assert.equal(d.ok,false);
 assert.equal(d.provisional,true);
 assert.equal(d.reason,'DEEPSEEK_CHOSE_WAIT');
 assert.equal(closeExpiredWindow(w,R+25000),true);
 const alt=ready();add(alt,'initial','UP',R-50000);
 for(const x of alt.early)x.price=x.open-40;
 collect(alt,{round:R,at:R+22000,price:67950,open:68000});
 const signal=finalize(alt,R+23000);
 assert.equal(signal.latest.direction,'UP');
 assert.equal(signal.latest.selectedAnalysis,'initial');
});
test('current-round prompt includes actual observed early ticks; no future labels',()=>{
 const w=ready();
 const p=analysisRequest(w,'current',R+10000,{round:R,oneMinute:{ready:true},fiveMinute:{ready:true}},{usable:true,samples:70});
 const v=JSON.parse(p.messages[1].content);
 assert.equal(v.phase,'current');
 assert.equal(v.requireDirectionalForecast,false);
 assert.equal(v.decisionDeadlineMs,R+25000);
 assert.equal(v.currentRoundTicks.length,8);
 assert.equal(v.currentRoundTicks.every(x=>x.at>=R&&x.at<=R+10000),true);
});
test('new official quality cases may be recorded at +20s, not at +25s',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zl-autonomous25-'));
 try{
  const q=makeQualityStore(path.join(dir,'quality.json'),()=>R+22000);
  const mk=(lockedAt)=>({round:R,providerModel:'deepseek-flash',latest:{lockedAt,direction:'DOWN',reason:'deepseek analysis'}});
  assert.equal(q.record(mk(R+20000),{oneMinute:{ready:false},fiveMinute:{ready:false}}),true);
  const q2=makeQualityStore(path.join(dir,'quality2.json'),()=>R+27000);
  assert.equal(q2.record(mk(R+25000),{}),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
const candles=(size,n,now)=>Array.from({length:n},(_,i)=>({
 startMs:now-(n+10-i)*size,open:67000+i,high:67005+i,
 low:66995+i,close:67001+i,volume:100+i,closed:true
}));
const market=at=>{const early=at>=R,nowRound=Math.floor(at/300000)*300000;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
 eventMs:at,roundStartMs:nowRound,lastPrice:early?68000+(at-R)/1000:67000+(at-(R-120000))/1000,
 roundOpenPrice:early?68000:67000,marketFeedConnected:true},
 candles:{'1m':{rows:candles(60000,70,at)},'5m':{rows:candles(300000,70,at)}}};
};
test('runner sends 3rd live DeepSeek review and obeys 25s with no order API',async()=>{
 let at=R-120000;const calls=[];const locks=[];
 const runner=createAdaptiveRunner({clock:()=>at,env:{ADAPTIVE15_ENABLE_AI:'1',DEEPSEEK_API_KEY:'fake',DEEPSEEK_MODEL:'deepseek-flash'},
   getHistoricalFeedback:()=>({usable:false}),onLocked:(s)=>locks.push(s),
   fetcher:async(url,options)=>{
    if(String(url).includes('shadow-market-data'))return {ok:true,json:async()=>market(at)};
    const prompt=JSON.parse(JSON.parse(options.body).messages[1].content);
    calls.push({at,phase:prompt.phase});
    return {ok:true,json:async()=>({usage:{total_tokens:115},choices:[{finish_reason:'stop',
     message:{content:JSON.stringify({direction:prompt.phase==='current'?'DOWN':'UP',confidence:.69,reason:'valid evidence'})}}]})};
   }});
 for(at=R-120000;at<=R+24500;at+=500)await runner.tick();
 assert.equal(calls.length,3);
 assert.deepEqual(calls.map(c=>c.phase),['initial','review','current']);
 assert.equal(locks.length,1);
 assert.equal(locks[0].latest.direction,'DOWN');
 assert.ok(locks[0].generatedAt<R+25000);
 assert.equal(runner.status().orders,false);
});
