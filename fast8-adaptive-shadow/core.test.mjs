import test from 'node:test';
import assert from 'node:assert/strict';
import {observeCandles,adaptiveDrift,trainAdaptive,featureVector,FEATURES,ROUND_MS} from './core.mjs';
const candles=()=>Array.from({length:16},(_,i)=>[i*60000,100+i,100+i+.5,100+i-.5,100+i+.2,10+i,0,(10+i)*(100+i),0,6+i*.5]);
test('features from public 1m candles have no invented 5s inputs',()=>{
  const s=observeCandles(candles());assert.ok(s);assert.ok(s.featureCount>=5);
  assert.ok(['TREND','RANGE','HIGH_VOL'].includes(s.regime));
  assert.equal(s.facts.normalizedMomentum5s,undefined);
  assert.equal(featureVector(s.facts).length,FEATURES.length*2+2);
});
test('training needs 300 officially labeled causal examples',()=>{
  assert.throws(()=>trainAdaptive([]),/NEED_300/);
  const s=observeCandles(candles());
  const rows=Array.from({length:310},(_,i)=>({
    x:featureVector(s.facts),y:i%2,roundStartMs:i*ROUND_MS,
    decisionAt:i*ROUND_MS+2000,labelReceivedAt:(i+1)*ROUND_MS+1000,
    baseline:i%2?'UP':'DOWN',regime:i%3===0?'TREND':i%3===1?'RANGE':'HIGH_VOL'
  }));
  const trained=trainAdaptive(rows);
  assert.ok(typeof trained.accepted==='boolean');
  assert.equal(trained.trainingSamples,310);
  assert.equal(trained.holdouts.global.samples,62);
});
test('drift detection uses enough settled forward outcomes',()=>{
  assert.equal(adaptiveDrift([]),false);
  const rows=Array.from({length:200},(_,i)=>({signal:i<100?'UP':'DOWN',y:1}));
  assert.equal(adaptiveDrift(rows),true);
});
