import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL,INPUT_VERSION,BASE_WEIGHTS,FACTORS,predictMarket,weighted,summarize,fitExperimentalWeights} from './novice-mix-core.mjs';

const ROUND=1792166400000;
function snapshot(at=ROUND+6200,step=2){
 const one=Array.from({length:60},(_,i)=>{const startMs=ROUND-(59-i)*60000;
  const close=60000+i*step;
  return {startMs,open:close-step,close,high:close+10,low:close-10,volume:i+500};
 });
 return {ok:true,readOnly:true,generatedAtMs:at-100,source:'RSI_TEST',
  latest:{lastPrice:one.at(-1).close,eventMs:at-100},
  candles:{'1m':{rows:one},'5m':null}};
}
test('RSI(14) alone determines direction: no MACD, price, range, volume or previous-direction feature',()=>{
 assert.deepEqual(FACTORS,['rsi']);
 assert.deepEqual(BASE_WEIGHTS,[1]);
 const at=ROUND+6200,s=snapshot(at);
 const first=predictMarket(s,[{direction:'DOWN',factors:{technical:-100}}],BASE_WEIGHTS,at);
 assert.equal(first.model,MODEL);assert.equal(first.inputVersion,INPUT_VERSION);
 assert.equal(first.status,'LOCKED');assert.equal(first.direction,'UP');
 assert.equal(first.rsi,100);
 assert.deepEqual(Object.keys(first.factors),['rsi']);
 assert.equal(first.score,1);
 const reversed=predictMarket(snapshot(at,-2),[{direction:'UP'}],BASE_WEIGHTS,at);
 assert.equal(reversed.direction,'DOWN');assert.equal(reversed.rsi,0);
 assert.equal(reversed.score,-1);
});
test('RSI(14) computes from observations available by T+8 only',()=>{
 const at=ROUND+6200,s=snapshot(at);
 const before=predictMarket(s,[],BASE_WEIGHTS,at);
 s.candles['1m'].rows.push({startMs:ROUND+60000,close:1,volume:99999});
 assert.equal(predictMarket(s,[],BASE_WEIGHTS,at).rsi,before.rsi);
 assert.ok(before.lockedAt<ROUND+8000);
});
test('stale and absent RSI market input never inherits previous guessed direction',()=>{
 const at=ROUND+7400;
 const a=predictMarket(null,[{direction:'DOWN'}],BASE_WEIGHTS,at);
 assert.equal(a.direction,'UP');assert.equal(a.status,'NO_DATA_FALLBACK');assert.equal(a.score,null);
 assert.equal(a.inputVersion,INPUT_VERSION);
 const sum=summarize([{...a,actual:'DOWN'},
  {...predictMarket(snapshot(ROUND+6200),[],BASE_WEIGHTS,ROUND+6200),round:ROUND+300000,actual:'UP'}]);
 assert.equal(sum.overall.samples,1);assert.equal(sum.overall.hits,1);
 assert.equal(sum.dataGaps,1);
});
test('all seven legacy factors and weight-search optimizer are retired',()=>{
 assert.equal(weighted({price:1,kline:1,technical:1,previous:1,gambler:1,volume:1,range:1}).score,null);
 const fit=fitExperimentalWeights([]);
 assert.equal(fit.status,'RSI_ONLY_FIXED');assert.deepEqual(fit.weights,[1]);
 assert.equal(fit.required,0);
});
