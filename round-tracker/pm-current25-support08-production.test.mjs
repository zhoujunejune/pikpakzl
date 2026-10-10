import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeNoBase15s} from './v3-no-base-15s-audit.mjs';
import {selectCurrent03PmAgree15s,current03PmAgreeProductionFuseSummary,CURRENT03_PM_AGREE_SOURCE} from './current03-pm-agree-production.mjs';
import {selectPmCurrent25Support0815s,PM_CURRENT25_SUPPORT08_SOURCE,PM_CURRENT25_SUPPORT08_START_MS} from './pm-current25-support08-production.mjs';
const start=PM_CURRENT25_SUPPORT08_START_MS;
const facts={
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'pm-topic-verified',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.60,predictionMarketConflict:false,
  currentScore:0.27,currentTrendScore:0.20,liveScore:0.05,
  distanceFromOpenBps:0.2,tradeCount15s:15,depthAgeMs:100,
  lastAggTradeAgeMs:100,tradeStreamStalled:false,absorptionRisk:false,
  regimeDirection:'RANGE',regimeAgreement:0.25
};
const row=(f=facts,at=start+15500)=>{
  const r={roundStartMs:start,prediction:null,predictedAt:null};
  return {...r,v3NoBase15sShadow:freezeNoBase15s(r,f,at)};
};

test('PM_CURRENT25_SUPPORT08 qualifies with current 0.25 but below current03 0.30',()=>{
  const r=row();
  const pm=selectPmCurrent25Support0815s(r,start+17000);
  assert.equal(pm.allowed,true);
  assert.equal(pm.candidate.direction,'UP');
  assert.equal(selectCurrent03PmAgree15s(r,start+17000).allowed,false);
});
test('PM_CURRENT25_SUPPORT08 requires support 0.08 each side (UP and DOWN)',()=>{
  assert.equal(selectPmCurrent25Support0815s(row({...facts,predictionMarketUpMid:0.59}),start+17000).candidate.direction,'UP');
  assert.equal(selectPmCurrent25Support0815s(row({...facts,predictionMarketUpMid:0.60,currentScore:-0.35}),start+17000).allowed,false);
  assert.equal(selectPmCurrent25Support0815s(row({...facts,predictionMarketUpMid:0.40,currentScore:-0.28}),start+17000).candidate.direction,'DOWN');
  assert.equal(selectPmCurrent25Support0815s(row({...facts,predictionMarketUpMid:0.44,currentScore:-0.28}),start+17000).allowed,false);
});
test('both candidates qualified may be resolved in deterministic priority; no double lock',()=>{
  const r=row({...facts,currentScore:0.45});
  assert.equal(selectPmCurrent25Support0815s(r,start+17000).allowed,true);
  assert.equal(selectCurrent03PmAgree15s(r,start+17000).allowed,true);
  const locked={...r,productionPrediction:'UP',productionSource:PM_CURRENT25_SUPPORT08_SOURCE};
  assert.equal(selectPmCurrent25Support0815s(locked,start+17000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s(locked,start+17000).allowed,false);
});
test('pre-settlement lock deadline and frozen source cannot be bypassed',()=>{
  const r=row();
  for(const now of [start+14999,start+20001,start+300000]){
    assert.equal(selectPmCurrent25Support0815s(r,now).allowed,false);
  }
  for(const patch of [
    {prediction:'DOWN'}, {predictedAt:start+16000},
    {productionPrediction:'UP'},{actual:'DOWN'},{settledAt:start+299000}
  ]) assert.equal(selectPmCurrent25Support0815s({...r,...patch},start+17000).allowed,false);
  assert.equal(selectPmCurrent25Support0815s({...r,roundStartMs:start+300000},start+317000).allowed,false);
  assert.equal(selectPmCurrent25Support0815s({...r,v3NoBase15sShadow:{...r.v3NoBase15sShadow,observedAt:start+17500}},start+18000).allowed,false);
});
test('market integrity and frozen candidate veto protect PM_CURRENT25_SUPPORT08',()=>{
  for(const patch of [
    {predictionMarketMappingReliable:false},{predictionMarketRoundAligned:false},
    {predictionMarketTopicId:null},{predictionMarketBookAgeMs:6000},
    {depthAgeMs:2000},{lastAggTradeAgeMs:13000},
    {tradeCount15s:2},{tradeStreamStalled:true},{absorptionRisk:true},
    {predictionMarketConflict:true},
    {regimeDirection:'DOWN',regimeAgreement:0.9},
  ]){
    const r=row({...facts,...patch});
    assert.equal(selectPmCurrent25Support0815s(r,start+18000).allowed,false,JSON.stringify(patch));
  }
});
test('each source has separate official-settlement accuracy and fuse stats',()=>{
  const records=new Map();
  const add=(i,source,hit)=>records.set(i,{
    roundStartMs:i,productionSource:source,
    productionPrediction:'UP',productionResult:hit?'HIT':'MISS',
    productionActual:hit?'UP':'DOWN',officialDirection:hit?'UP':'DOWN',
    actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
    resolutionEvidence:'OFFICIAL_'+(hit?'UP':'DOWN')+':STRICT_ROUND_ALIGNED_TOPIC'
  });
  for(let i=0;i<5;i++)add(i,PM_CURRENT25_SUPPORT08_SOURCE,false);
  for(let i=5;i<10;i++)add(i,CURRENT03_PM_AGREE_SOURCE,true);
  const pm=current03PmAgreeProductionFuseSummary(records,PM_CURRENT25_SUPPORT08_SOURCE);
  const current=current03PmAgreeProductionFuseSummary(records);
  assert.equal(pm.production.samples,5);
  assert.equal(pm.fuse.globalFused,true);
  assert.equal(current.production.samples,5);
  assert.equal(current.fuse.globalFused,false);
});
