import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FEATURE_SET, FEATURE_NAMES, rsi, features, prospectiveStats, train, baseline, probability} from './src/model.mjs';

test('RSI/MACD-only input excludes every high/low and range feature',()=>{
  assert.equal(FEATURE_SET,'BASELINE_RSI_MACD_ONLY_V2');
  assert.deepEqual(FEATURE_NAMES,['rsi_1m','rsi_5m','macd_hist_1m','macd_hist_5m']);
  const bars=Array.from({length:90},(_,i)=>({
    t:i*60000,o:100+i/10,h:101+i/10,l:99+i/10,c:100.2+i/10,
    end:(i+1)*60000-1,closed:true
  }));
  const f=features(bars,bars,110);
  assert.equal(f.vector.length,4);
  assert.deepEqual(Object.keys(f.indicators).sort(),['macdHist1m','macdHist5m','rsi1m','rsi5m'].sort());
  assert.equal(features([],[],100),null);
  assert.equal(rsi(Array.from({length:40},(_,i)=>100+i)),100);
});

test('BASELINE prior high/low weights are removed, preserving four technical coefficients',()=>{
  const x=[.4,-.25,.15,.6];
  const fixed=[0,.27,.32,.27,.35];
  assert.ok(Math.abs(baseline(x)-probability(fixed,x))<1e-12);
  assert.equal(probability(Array(11).fill(0),x),null);
});

test('chronological candidate retrains on four features without changing model identity',()=>{
  const rows=Array.from({length:160},(_,i)=>({
    t:i*300000,
    x:[Math.sin(i/4),Math.cos(i/7),Math.sin(i/9),Math.cos(i/13)],
    y:i%3===0?1:0
  }));
  const out=train(rows);
  assert.equal(out.ok,true);
  assert.equal(out.trainingSamples+out.holdoutSamples+1,160);
  assert.equal(out.holdoutSamples,32);
  assert.ok(out.weights===null||(out.weights.length===5&&out.weights.every(Number.isFinite)));
  assert.equal(train([]).reason,'INSUFFICIENT_SETTLED_ROUNDS');
});

test('historical model audit is retained but new strategy has a separate version and one retrain attempt',()=>{
  const source=readFileSync(new URL('./src/index.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("const FIXED_MODEL='BASELINE'"));
  assert.ok(source.includes('featureSet:FEATURE_SET'));
  assert.ok(source.includes('s.rows.filter(r=>r.featureSet===FEATURE_SET)'));
  assert.ok(source.includes("const TRAINING_POLICY='BASELINE_FROZEN_WEIGHTS_NO_RETRAIN'"));
  assert.ok(source.includes('trainingEnabled:false,weightsFrozen:true,policy:TRAINING_POLICY'));
  assert.ok(source.includes('const trained=Array.isArray(s.weights)&&s.weights.length===5&&'));
  assert.ok(source.includes('probability(s.weights,f.vector)'));
  assert.ok(!source.includes('if(!s.trainAttempted)'));
  assert.ok(!source.includes('const fitted=train('));
  assert.ok(!source.includes('s.weights=fitted.weights'));
  assert.ok(!source.includes('s.seed=seeds('));
  assert.ok(source.includes('s.effectiveFromRound'));
  assert.ok(source.includes("source:'HISTORICAL_SPOT_OPEN_CLOSE_PROXY_NOT_OFFICIAL'"));
  assert.ok(source.includes("path==='/model-history'"));
  assert.ok(source.includes("r.model==='LOGISTIC_L2_V1'"));
  assert.ok(source.includes("firstLogisticSignal:summarize(firstLogistic)"));
  assert.ok(!source.includes("const TRAINING_DISABLED_CODE="));
});

test('prospective statistics only count provided valid outcomes, never pending/gaps',()=>{
 const s=prospectiveStats([{direction:'UP',actual:'UP',status:'SETTLED'},
   {direction:'DOWN',actual:'UP',status:'SETTLED'},{direction:null,status:'DATA_GAP'}]);
 assert.equal(s.overall.accuracy,.5);
 assert.equal(s.overall.samples,2);
 assert.equal(s.dataGaps,1);
});
