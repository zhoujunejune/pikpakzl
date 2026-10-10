import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeNoBase15s } from './v3-no-base-15s-audit.mjs';
import {
  selectCurrent03PmAgree15s,current03PmAgreeProductionFuseSummary,
  CURRENT03_PM_AGREE_SOURCE,CURRENT03_PM_AGREE_START_MS,
} from './current03-pm-agree-production.mjs';

const start = CURRENT03_PM_AGREE_START_MS;
const facts = {
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'aligned-pm-topic',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.56,currentScore:0.41,currentTrendScore:0.43,
  liveScore:0.10,distanceFromOpenBps:0.3,tradeCount15s:12,
  depthAgeMs:100,lastAggTradeAgeMs:100,tradeStreamStalled:false,
  absorptionRisk:false,
};
const row = (f=facts,at=start+15500) => ({
  roundStartMs:start,prediction:null,predictedAt:null,
  v3NoBase15sShadow:freezeNoBase15s({roundStartMs:start,prediction:null,predictedAt:null}, f, at)
});

test('current03 candidate from real 15s frozen observation produces opt-in UP only',()=>{
  const r=row();
  const picked=selectCurrent03PmAgree15s(r,start+17000);
  assert.equal(picked.allowed,true);
  assert.equal(picked.candidate.direction,'UP');
  assert.equal(picked.candidate.currentScore,0.41);
  assert.equal(picked.candidate.accuracyQualification,'USER_OPT_IN_UNVALIDATED_15S_CANDIDATE');
});
test('DOWN needs negative CURRENT and matching PM bid',()=>{
  const r=row({...facts,currentScore:-0.38,predictionMarketUpMid:0.44});
  assert.equal(selectCurrent03PmAgree15s(r,start+18000).candidate.direction,'DOWN');
});
test('no stale replay, backfill, unrelated or future 15s freeze can lock',()=>{
  const r=row();
  for(const at of [start+14999,start+20001,start+300000]){
    assert.equal(selectCurrent03PmAgree15s(r,at).allowed,false);
  }
  assert.equal(selectCurrent03PmAgree15s({...r,roundStartMs:start+300000},start+317000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,actual:'UP'},start+17000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,productionPrediction:'DOWN'},start+17000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,prediction:'UP'},start+17000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,predictedAt:start+16000},start+17000).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,v3NoBase15sShadow:{...r.v3NoBase15sShadow,observedAt:start+17001}},start+17500).allowed,false);
  assert.equal(selectCurrent03PmAgree15s({...r,v3NoBase15sShadow:{...r.v3NoBase15sShadow,observedAt:start+17500}},start+17000).allowed,false);
});
test('other 15s candidates never substitute when CURRENT_03_PM_AGREE is WAIT',()=>{
  const r=row({...facts,currentScore:-0.31,predictionMarketUpMid:0.56,liveScore:0.9});
  assert.equal(r.v3NoBase15sShadow.candidates.CURRENT_03_PM_AGREE.decision,'WAIT');
  assert.equal(selectCurrent03PmAgree15s(r,start+17000).allowed,false);
});
test('PM mapping, market time, liquidity, data freshness, absorption and topic ID must pass',()=>{
  for(const patch of [
    {predictionMarketMappingReliable:false},
    {predictionMarketRoundAligned:false},
    {predictionMarketTopicId:null},
    {predictionMarketBookAgeMs:6000},
    {depthAgeMs:1600},
    {lastAggTradeAgeMs:12500},
    {tradeCount15s:3},
    {tradeStreamStalled:true},
    {absorptionRisk:true},
  ]){
    const r=row({...facts,...patch});
    assert.equal(selectCurrent03PmAgree15s(r,start+17000).allowed,false,JSON.stringify(patch));
  }
});
test('official production fuse exclusively counts settled locked trades, not shadow results',()=>{
  const map=new Map();
  const add=(n,src,result,side='UP',actualSource='BINANCE_PREDICTION_OFFICIAL_RESOLUTION')=>map.set(n,{
    roundStartMs:n,productionSource:src,productionPrediction:side,productionResult:result,
    productionActual:side,officialDirection:side,actualSource,
    resolutionEvidence:'OFFICIAL_UP:variantData:STRICT_ROUND_ALIGNED_TOPIC'
  });
  add(1,CURRENT03_PM_AGREE_SOURCE,'MISS');
  add(2,'LOCK_QUALITY_SELECTIVE_V2_PRIMARY','MISS');
  add(3,CURRENT03_PM_AGREE_SOURCE,'HIT');
  add(4,CURRENT03_PM_AGREE_SOURCE,'MISS','DOWN','BINANCE_5M_KLINE_OPEN_CLOSE');
  let stats=current03PmAgreeProductionFuseSummary(map);
  assert.equal(stats.production.samples,2);
  assert.equal(stats.production.hits,1);
  assert.equal(stats.fuse.globalFused,false);
  for(let i=5;i<=7;i++)add(i,CURRENT03_PM_AGREE_SOURCE,'MISS');
  stats=current03PmAgreeProductionFuseSummary(map);
  assert.equal(stats.production.samples,5);
  assert.equal(stats.fuse.globalFused,true);
});
