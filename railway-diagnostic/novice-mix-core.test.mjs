import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL,BASE_WEIGHTS,predictMarket,weighted,summarize,fitExperimentalWeights} from './novice-mix-core.mjs';

const ROUND=1792166400000;
function market(at=ROUND+6200){
  const one=Array.from({length:80},(_,i)=>{
    const startMs=ROUND-(79-i)*60000,open=60000+i*4,close=open+2;
    return {startMs,endMs:startMs+59999,open,close,high:close+8,low:open-8,volume:100+i};
  });
  const five=Array.from({length:40},(_,i)=>{
    const startMs=ROUND-(40-i)*300000,open=60000+i*15,close=open+5;
    return {startMs,endMs:startMs+299999,open,close,high:close+10,low:open-10,volume:1000+i};
  });
  return {ok:true,readOnly:true,generatedAtMs:at-100,source:'READONLY_TEST',
    latest:{lastPrice:one.at(-1).close,eventMs:at-100},
    candles:{'1m':{rows:one},'5m':{rows:five}}};
}
test('8-second independent prediction uses only pre-lock price features',()=>{
  const at=ROUND+6200;
  const m=market(at);
  const one=predictMarket(m,[{direction:'DOWN'}],BASE_WEIGHTS,at);
  assert.equal(one.model,MODEL);
  assert.ok(['UP','DOWN'].includes(one.direction));
  assert.ok(['LOCKED','PARTIAL_INPUT'].includes(one.status));
  assert.ok(one.lockedAt<ROUND+8000);
  assert.equal(one.factors.previous,-1);
  const before=one.score;
  m.candles['1m'].rows.push({startMs:ROUND+60000,open:60000,close:1,high:60000,low:1,volume:1});
  assert.equal(predictMarket(m,[{direction:'DOWN'}],BASE_WEIGHTS,at).score,before);
});
test('no valid input outputs a directional but explicitly unscored fallback',()=>{
  const r=predictMarket(null,[{direction:'DOWN'}],BASE_WEIGHTS,ROUND+7500);
  assert.equal(r.direction,'DOWN');assert.equal(r.status,'NO_DATA_FALLBACK');
  assert.equal(r.score,null);
  const stats=summarize([{...r,actual:'UP'},{model:MODEL,round:ROUND+300000,status:'LOCKED',direction:'UP',actual:null},
    {model:MODEL,round:ROUND+600000,status:'LOCKED',direction:'DOWN',actual:'UP'}]);
  assert.equal(stats.overall.samples,1);
  assert.equal(stats.overall.hits,0);
  assert.equal(stats.dataGaps,1);
  assert.equal(stats.pending,1);
});
test('training never invents labels or selects weights before 80 actual settlements',()=>{
  assert.equal(fitExperimentalWeights([],BASE_WEIGHTS).status,'COLLECTING');
  assert.equal(fitExperimentalWeights(Array.from({length:80},(_,i)=>({
    model:MODEL,round:ROUND+i*300000,direction:'UP',status:'LOCKED',actual:null,
    factors:{price:1,kline:1,technical:-1,previous:null,gambler:-1,volume:1,range:0}
  })),BASE_WEIGHTS).samples,0);
  assert.ok(Math.abs(weighted({price:1,kline:-1}).available-.48)<1e-12);
});
