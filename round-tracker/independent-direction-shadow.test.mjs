import test from 'node:test';
import assert from 'node:assert/strict';
import {
  independentFeatures,chooseIndependentDirection,validLiveObservation,
  trainIndependentModel,freezeIndependentModel,independentForwardStats,
  INDEPENDENT_TARGET,
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
  assert.equal(chooseIndependentDirection(0.51,0.05),'WAIT');
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
  assert.ok(['UP','DOWN','WAIT'].includes(frozen.direction));
  assert.equal(freezeIndependentModel(row(170,'UP',false),trained.model),null);
});
test('future/retroactive model predictions never inflate forward accuracy or coverage',()=>{
  const model={version:'test-model',startRoundMs:base+300000,trainedAt:base};
  const settled=Array.from({length:200},(_,i)=>row(i+1,i%2===0?'UP':'DOWN'));
  settled.forEach((r,i)=>{
    if(i%4<2){
      r.independentDirectionShadow={modelVersion:'test-model',direction:r.actual,trainedAt:base,
        observedAt:r.roundStartMs+12000};
    }
  });
  const s=independentForwardStats(settled,model);
  assert.equal(s.forwardRounds,200);
  assert.equal(s.decidedRounds,100);
  assert.equal(s.accuracy,1);
  assert.equal(s.coverage,INDEPENDENT_TARGET.coverage);
  assert.equal(s.status,'QUALIFIED_75_50_FOR_INDEPENDENT_REVIEW');
  settled[0].independentDirectionShadow.modelVersion='old-model';
  const s2=independentForwardStats(settled,model);
  assert.equal(s2.decidedRounds,99);
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
