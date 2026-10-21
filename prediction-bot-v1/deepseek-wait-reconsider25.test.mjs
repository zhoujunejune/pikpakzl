import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdaptiveRunner} from './deepseek-adaptive15-runner.mjs';
import {DEADLINE_MS} from './deepseek-adaptive15-core.mjs';
const R=1800000300000;
const candles=(ms,n,now)=>Array.from({length:n},(_,i)=>({
 startMs:now-(n+12-i)*ms,open:67000+i,high:67005+i,
 low:66995+i,close:67001+i,volume:100+i,closed:true
}));
const market=(at)=>{const current=at>=R;
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{eventMs:at,roundStartMs:Math.floor(at/300000)*300000,
 lastPrice:current?68000+(at-R)/1000:67000+(at-R+120000)/1000,
 roundOpenPrice:current?68000:67000,marketFeedConnected:true},
 candles:{'1m':{rows:candles(60000,45,at)},'5m':{rows:candles(300000,45,at)}}};
};
async function scenario(directionForCurrent){
 let at=R-120000;
 const calls=[],locked=[],terminal=[];
 const fetcher=async(url,opts)=>{
  if(String(url).includes('shadow-market-data'))
   return {ok:true,json:async()=>market(at)};
  const req=JSON.parse(opts.body),data=JSON.parse(req.messages[1].content);
  const i=calls.filter(x=>x.phase==='current').length;
  const answer=data.phase==='current'?directionForCurrent(i):'WAIT';
  calls.push({at,phase:data.phase,model:req.model,direction:answer});
  return {ok:true,json:async()=>({usage:{total_tokens:80},choices:[{
   finish_reason:'stop',message:{content:JSON.stringify({
    direction:answer,confidence:.44,continueAnalysis:false,
    reason:answer==='WAIT'?'not sure yet':'observed current BTC data',
    risk:'uncertain direction'})}}]})};
 };
 const runner=createAdaptiveRunner({clock:()=>at,fetcher,
  env:{ADAPTIVE15_ENABLE_AI:'1',DEEPSEEK_API_KEY:'mock',DEEPSEEK_MODEL:'deepseek-flash'},
  getHistoricalFeedback:()=>({samples:30}),
  onLocked:s=>locked.push(s),onWait:term=>terminal.push(term)});
 for(at=R-120000;at<=R+26000;at+=500)await runner.tick();
 return {calls,locked,terminal,status:runner.status()};
}
test('repeated WAIT triggers additional real DeepSeek reviews and a genuine UP lock before 25 seconds',async()=>{
 const x=await scenario(i=>i<4?'WAIT':'UP');
 const cur=x.calls.filter(c=>c.phase==='current');
 assert.ok(cur.length>=5,JSON.stringify(cur));
 assert.equal(x.locked.length,1);
 assert.equal(x.locked[0].latest.direction,'UP');
 assert.equal(x.locked[0].latest.selectedAnalysis,'current');
 assert.ok(x.locked[0].generatedAt<R+DEADLINE_MS);
 assert.equal(x.terminal.length,0);
 assert.equal(x.status.orders,false);
});
test('persistent DeepSeek WAIT never manufactures a direction, and stops by +25 seconds',async()=>{
 const x=await scenario(()=>'WAIT');
 assert.ok(x.calls.filter(c=>c.phase==='current').length>=4);
 assert.equal(x.locked.length,0);
 assert.equal(x.terminal.length,1);
 assert.equal(x.terminal[0].reason,'DEADLINE_25S_EXPIRED');
 assert.equal(x.terminal[0].detail,'DEEPSEEK_CHOSE_WAIT');
 assert.equal(x.status.orders,false);
});
