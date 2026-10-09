import test from 'node:test';
import assert from 'node:assert/strict';
import {
  independentFeatures,chooseIndependentDirection,validLiveObservation,
  trainIndependentModel,freezeIndependentModel,independentForwardStats,
  INDEPENDENT_TARGET,ADAPTIVE_POLICY,
  independentMarketRegime,independentAdaptiveProgramStats,
  createIndependentDirectionShadow,
} from './independent-direction-shadow.mjs';

const base=1791504000000;
const facts=(x=1)=>({
  regimeScore:x*0.8,currentScore:x*0.72,microScore:x*0.6,currentTrendScore:x*0.7,
  normalizedMomentum15s:x*0.30,normalizedMomentum30s:x*0.4,
  normalizedMomentum60s:x*0.5,normalizedMomentum180s:x*0.3,
  normalizedMomentum300s:x*0.2,tradePressure15s:x*0.4,
  tradePressure60s:x*0.5,ofiNormalized5s:x*0.3,ofiNormalized60s:x*0.2,
  rangePosition180:0.3+x*0.3,predictionMarketUpMid:0.5+x*0.17,
  liveScore:x*0.65,distanceFromOpenBps:x*4,absorptionRisk:false
});
function row(i,dir='UP',settled=true){
  const start=base+i*300000;
  return {roundStartMs:start,roundEndMs:start+299999,
    shadowObservedAt:start+12000,shadowFacts:facts(dir==='UP'?1:-1),
    prediction:'WAIT',
    actual:settled?dir:null,actualSource:settled?'BINANCE_PREDICTION_OFFICIAL_RESOLUTION':null,
    settledAt:settled?start+306000:null};
}
test('features use market facts, not an upstream UP/DOWN prediction',()=>{
  assert.equal(independentFeatures(facts()).length,22);
  assert.equal(independentFeatures(facts({})),null);
  assert.equal(chooseIndependentDirection(0.80,0.05),'UP');
  assert.equal(chooseIndependentDirection(0.30,0.05),'DOWN');
  assert.equal(chooseIndependentDirection(0.51),'UP');
  assert.equal(chooseIndependentDirection(0.5),'UP');
  assert.equal(chooseIndependentDirection(0.499999),'DOWN');
  assert.equal(chooseIndependentDirection(NaN),null);
});
test('strict snapshot rejects after-window observations and missing scores',()=>{
  const r=row(3);
  assert.ok(validLiveObservation(r));
  r.shadowObservedAt=r.roundStartMs+25000;
  assert.equal(validLiveObservation(r),false);
  r.shadowObservedAt=r.roundStartMs+12000;
  delete r.shadowFacts.currentScore;
  assert.equal(validLiveObservation(r),false);
});
test('training uses only official settled snapshots before training and predicts no-base rounds',()=>{
  const rows=Array.from({length:170},(_,i)=>row(i,i%2===0?'UP':'DOWN'));
  rows[0].actualSource='BINANCE_5M_KLINE_OPEN_CLOSE';
  rows[1].shadowObservedAt=rows[1].roundStartMs+45000;
  const now=base+175*300000;
  const trained=trainIndependentModel(rows,now,{minSamples:120});
  assert.equal(trained.ok,true,JSON.stringify(trained));
  assert.equal(trained.model.trainingSamples+trained.model.validationSamples+2,168);
  assert.equal(trained.model.independentOfBaseDirection,true);
  const current=row(180,'UP',false);
  current.shadowObservedAt=base+180*300000+12000;
  // Move observation time past the candidate's training time.
  assert.ok(current.shadowObservedAt>trained.model.trainedAt);
  const frozen=freezeIndependentModel(current,trained.model);
  assert.ok(frozen);
  assert.equal(frozen.predictionSource,'INDEPENDENT_MARKET_FEATURES');
  assert.ok(['UP','DOWN'].includes(frozen.direction));
  assert.equal(frozen.margin,undefined);
  assert.equal(freezeIndependentModel(row(170,'UP',false),trained.model),null);
});
test('future/retroactive model predictions never inflate forward accuracy or coverage',()=>{
  const model={version:'test-model',startRoundMs:base+300000,trainedAt:base};
  const settled=Array.from({length:200},(_,i)=>row(i+1,i%2===0?'UP':'DOWN'));
  settled.forEach(r=>{
    r.independentDirectionShadow={modelVersion:'test-model',direction:r.actual,trainedAt:base,
      observedAt:r.roundStartMs+12000};
  });
  const s=independentForwardStats(settled,model);
  assert.equal(s.forwardRounds,200);
  assert.equal(s.decidedRounds,200);
  assert.equal(s.accuracy,1);
  assert.equal(s.coverage,INDEPENDENT_TARGET.coverage);
  assert.equal(s.status,'QUALIFIED_75_100_LONG_TERM_REVIEW');
  settled[0].independentDirectionShadow.modelVersion='old-model';
  const s2=independentForwardStats(settled,model);
  assert.equal(s2.decidedRounds,199);
  assert.equal(s2.coverage,0.995);
  assert.equal(s2.dataGapCount,1);
  assert.equal(s2.status,'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED');
});
test('low hit rate cannot qualify at or above 50% forward coverage',()=>{
  const model={version:'test-model',startRoundMs:base+300000,trainedAt:base};
  const settled=Array.from({length:200},(_,i)=>row(i+1,i%2===0?'UP':'DOWN'));
  settled.forEach((r,i)=>{
    r.independentDirectionShadow={modelVersion:'test-model',trainedAt:base,
      direction:i<140?r.actual:(r.actual==='UP'?'DOWN':'UP'),
      observedAt:r.roundStartMs+12000};
  });
  const s=independentForwardStats(settled,model);
  assert.equal(s.coverage,1);
  assert.equal(s.accuracy,0.7);
  assert.equal(s.status,'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED');
});

test('100% full direction with just 75% aggregate must also satisfy rolling and direction health',()=>{
  const model={version:'test-model',startRoundMs:base+300000,trainedAt:base};
  const settled=Array.from({length:200},(_,i)=>row(i+1,i%2===0?'UP':'DOWN'));
  settled.forEach((r,i)=>{
    r.independentDirectionShadow={
      modelVersion:'test-model',trainedAt:base,
      direction:i>=50?r.actual:(r.actual==='UP'?'DOWN':'UP'),
      observedAt:r.roundStartMs+12000
    };
  });
  const s=independentForwardStats(settled,model);
  assert.equal(s.accuracy,0.75);
  assert.equal(s.coverage,1);
  assert.equal(s.recent100.accuracy,1);
  assert.equal(s.recent40.accuracy,1);
  assert.equal(s.rolling200.accuracy,0.75);
  assert.equal(s.status,'QUALIFIED_75_100_LONG_TERM_REVIEW');
  settled.slice(-40).forEach(r=>{
    r.independentDirectionShadow.direction=
      r.actual==='UP'?'DOWN':'UP';
  });
  const bad=independentForwardStats(settled,model);
  assert.equal(bad.coverage,1);
  assert.ok(bad.recent40.accuracy<0.75);
  assert.equal(bad.status,'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED');
});

test('live regime is derived from only market facts, never official outcomes',()=>{
  assert.equal(independentMarketRegime(facts(1)),'TREND');
  assert.equal(independentMarketRegime(facts(-1)),'TREND');
  assert.equal(independentMarketRegime(facts(0.1)),'RANGE');
  assert.equal(independentMarketRegime(null),'UNKNOWN');
  assert.equal(ADAPTIVE_POLICY.retrainEverySettledRounds,24);
});
test('adaptive program preserves exact denominator and frozen decisions across retrained versions',()=>{
  const second=base+121*300000;
  const versions=[
    {version:'a',trainedAt:base,startRoundMs:base+300000},
    {version:'b',trainedAt:second-300000,startRoundMs:second},
  ];
  const rs=Array.from({length:240},(_,i)=>row(i+1,i%2?'UP':'DOWN'));
  rs.forEach((r,i)=>{
    const m=i<120?versions[0]:versions[1];
    r.independentDirectionShadow={
      modelVersion:m.version,trainedAt:m.trainedAt,
      roundStartMs:r.roundStartMs,observedAt:r.shadowObservedAt,
      direction:r.actual,marketRegime:i%4<2?'TREND':'RANGE'
    };
  });
  const good=independentAdaptiveProgramStats(rs,versions);
  assert.equal(good.forwardRounds,240);
  assert.equal(good.decidedRounds,240);
  assert.equal(good.coverage,1);
  assert.equal(good.accuracy,1);
  assert.equal(good.modelTransitions,1);
  assert.equal(good.status,'QUALIFIED_75_100_LONG_TERM_REVIEW');
  assert.equal(good.up.samples,120);
  assert.equal(good.down.samples,120);
  assert.equal(good.trend.samples,120);
  assert.equal(good.range.samples,120);
  rs[0].independentDirectionShadow.modelVersion='fabricated-after-settlement';
  const gap=independentAdaptiveProgramStats(rs,versions);
  assert.equal(gap.decidedRounds,239);
  assert.equal(gap.noDirectionRounds,1);
  assert.ok(gap.coverage<1);
  assert.equal(gap.status,'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED');
  // Confirm the version reset did not silently hide the first version loss.
  rs[0].independentDirectionShadow.modelVersion='a';
  rs.slice(-30).forEach(r=>{
    r.independentDirectionShadow.direction=r.actual==='UP'?'DOWN':'UP';
  });
  const drift=independentAdaptiveProgramStats(rs,versions);
  assert.equal(drift.coverage,1);
  assert.equal(drift.accuracy,0.875);
  assert.equal(drift.recent40.accuracy,0.25);
  assert.equal(drift.recentDrift,true);
  assert.equal(drift.status,'FORWARD_TARGET_NOT_MET_RETRAIN_REQUIRED');
});
test('settled rounds trigger periodic challenger review without changing live production',()=>{
  const log=[];
  const engine=createIndependentDirectionShadow({
    minTrainingSamples:120,
    log:(name,info)=>log.push({name,info}),
  });
  const history=Array.from({length:170},(_,i)=>row(i,i%2?'UP':'DOWN'));
  const now=base+195*300000;
  assert.equal(engine.trainIfNeeded(history,now),true);
  let status=engine.stats(history);
  assert.equal(status.activeLearning.enabled,true);
  assert.equal(status.activeLearning.adaptationAttempts,1);
  assert.equal(status.model.validation.coverage,1);
  assert.equal(status.model.selectedTrainingWindow>0,true);
  assert.equal(engine.trainIfNeeded(history,now+300000),false);
  assert.equal(engine.stats(history).activeLearning.adaptationAttempts,1);
  for(let i=170;i<194;i++)history.push(row(i,i%2?'UP':'DOWN'));
  engine.trainIfNeeded(history,base+225*300000);
  status=engine.stats(history);
  assert.equal(status.activeLearning.adaptationAttempts,2);
  assert.ok(log.some(x=>x.name==='independent_direction_adaptation_review'));
  assert.ok(status.model);
});
