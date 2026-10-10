import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeNoBase15s, V3_NO_BASE_15S_CONFIGS } from './v3-no-base-15s-audit.mjs';
import {
  LOW_PRIORITY_BACKUP_VERSION, LOW_PRIORITY_BACKUP_MIN_MS,
  LOW_PRIORITY_BACKUP_MAX_MS, lastResortSource, selectLastResort15sBackups
} from './last-resort-15s-backups.mjs';

const start=Date.parse('2026-10-10T17:00:00.000Z');
const facts={
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'round-proof-topic',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.63,currentScore:0.60,currentTrendScore:0.75,
  liveScore:0.80,distanceFromOpenBps:1.2,tradeCount15s:20,
  depthAgeMs:100,lastAggTradeAgeMs:100,tradeStreamStalled:false,
  absorptionRisk:false,regimeDirection:'UP',regimeAgreement:0.88,
  regimeScore:0.77,predictionMarketConflict:false
};
const make=(f=facts)=>{
  const r={roundStartMs:start,prediction:null,predictedAt:null};
  return {...r,v3NoBase15sShadow:freezeNoBase15s(r,f,start+15500)};
};
test('Option B registers exactly nine lower-priority experimental sources',()=>{
  const ids=V3_NO_BASE_15S_CONFIGS.map(x=>x.id).filter(x=>!['PM_CURRENT25_SUPPORT08','CURRENT_03_PM_AGREE'].includes(x));
  assert.equal(ids.length,9);
  assert.equal(new Set(ids.map(lastResortSource)).size,9);
  assert.ok(ids.every(x=>lastResortSource(x)==='LOW_PRIORITY_15S_'+x+'_PRIMARY'));
  assert.equal(lastResortSource('CURRENT_03_PM_AGREE'),null);
  assert.equal(LOW_PRIORITY_BACKUP_VERSION,'UNVERIFIED_15S_LAST_RESORT_V1');
});
test('backup cannot preempt 15s live routes or regular 22s lock',()=>{
  const r=make();
  for(const ms of [14999,17000,21999,24999,35001,300000]){
    assert.equal(selectLastResort15sBackups(r,start+ms).candidates.length,0,ms);
  }
  assert.equal(LOW_PRIORITY_BACKUP_MIN_MS,25000);
  assert.equal(LOW_PRIORITY_BACKUP_MAX_MS,35000);
  assert.ok(selectLastResort15sBackups(r,start+26000).candidates.length>0);
});
test('only one immutable live lock; no future or retroactive lookahead',()=>{
  const r=make();
  for(const patch of [
    {productionPrediction:'UP'}, {productionPrediction:'DOWN'},
    {actual:'UP'}, {settledAt:start+300000},
    {productionSettledAt:start+300000},
    {roundStartMs:start+300000}
  ])assert.equal(selectLastResort15sBackups({...r,...patch},start+26000).candidates.length,0);
  assert.equal(selectLastResort15sBackups({...r,v3NoBase15sShadow:{...r.v3NoBase15sShadow,observedAt:start+18000}},start+26000).candidates.length,0);
  assert.equal(selectLastResort15sBackups({...r,predictedAt:start+14000},start+26000).candidates.length,0);
});
test('late V3 rejected by Selective V2 can only be rescued in matching direction',()=>{
  const r=make();
  const okay={...r,prediction:'UP',predictedAt:start+22000};
  const conflict={...r,prediction:'DOWN',predictedAt:start+22000};
  assert.ok(selectLastResort15sBackups(okay,start+26000).candidates.length>0);
  assert.equal(selectLastResort15sBackups(conflict,start+26000).candidates.length,0);
});
test('reject stale feed, unaligned topic, insufficient trades and wrong PM direction',()=>{
  for(const patch of [
    {predictionMarketBookAgeMs:5500},
    {predictionMarketMappingReliable:false},
    {predictionMarketRoundAligned:false},
    {predictionMarketTopicId:''},
    {depthAgeMs:1700},
    {lastAggTradeAgeMs:12001},
    {tradeCount15s:5},
    {tradeStreamStalled:true},
    {predictionMarketUpMid:0.50,currentScore:0.9},
  ])assert.equal(selectLastResort15sBackups(make({...facts,...patch}),start+26000).candidates.length,0,
  JSON.stringify(patch));
});
test('absorption-only pilot never leaks into clean mode and never bypasses other stale checks',()=>{
  const clean=selectLastResort15sBackups(make(),start+26000);
  assert.ok(clean.candidates.every(x=>!x.id.startsWith('ABS_')));
  const risk=selectLastResort15sBackups(make({...facts,absorptionRisk:true}),start+26000);
  assert.ok(risk.candidates.length>0);
  assert.ok(risk.candidates.every(x=>x.id.startsWith('ABS_')));
  assert.equal(selectLastResort15sBackups(make({...facts,absorptionRisk:true,depthAgeMs:3500}),start+26000).candidates.length,0);
});
