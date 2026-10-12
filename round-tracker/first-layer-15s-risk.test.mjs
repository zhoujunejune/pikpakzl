import test from 'node:test';
import assert from 'node:assert/strict';
import { firstLayer15sProductionFuseSummary } from './first-layer-15s-risk.mjs';
import { current03PmAgreeProductionFuseSummary } from './current03-pm-agree-production.mjs';
import { createTimedEdgeRescueFuse } from './edge-rescue-timed-fuse.mjs';

const FLOW = 'LOW_PRIORITY_15S_PM_FLOW15_CURRENT_03_PRIMARY';
const PM25 = 'PM_CURRENT25_SUPPORT08_15S_PRIMARY';
const OTHER = 'CURRENT_03_PM_AGREE_15S_PRIMARY';
const OFFICIAL='BINANCE_PREDICTION_OFFICIAL_RESOLUTION';
const row=(n,source,hit,direction='DOWN')=>({
  roundStartMs:n*300000,productionSource:source,
  productionPrediction:direction,
  productionResult:hit?'HIT':'MISS',
  productionActual:hit?direction:(direction==='UP'?'DOWN':'UP'),
  officialDirection:hit?direction:(direction==='UP'?'DOWN':'UP'),
  actualSource:OFFICIAL,
  resolutionEvidence:'OFFICIAL_'+(hit?direction:(direction==='UP'?'DOWN':'UP'))+':STRICT_ROUND_ALIGNED_TOPIC',
});
test('first-layer two consecutive official production MISSes fuse the WHOLE strategy',()=>{
  const rounds=new Map();
  rounds.set(1,row(1,FLOW,false));
  rounds.set(2,row(2,FLOW,false));
  rounds.set(3,row(3,PM25,true));
  rounds.set(4,row(4,OTHER,true));
  const flow=firstLayer15sProductionFuseSummary(rounds,FLOW);
  assert.equal(flow.production.samples,2);
  assert.equal(flow.productionMissStreak,2);
  assert.equal(flow.fuse.globalFused,true);
  assert.equal(flow.down.fused,true);
  assert.equal(flow.up.fused,false);
  assert.equal(firstLayer15sProductionFuseSummary(rounds,PM25).fuse.globalFused,false);
  assert.equal(current03PmAgreeProductionFuseSummary(rounds,FLOW).fuse.globalFused,false,
    'existing other-lane statistics remain unchanged');
  const third={...row(5,FLOW,false),actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE'};
  rounds.set(5,third);
  assert.equal(firstLayer15sProductionFuseSummary(rounds,FLOW).production.samples,2,
    'unofficial labels must not count');
});
test('first-layer rolling production accuracy fuses only after ten official outcomes',()=>{
  const rounds=new Map();
  for(let i=1;i<=9;i++)rounds.set(i,row(i,PM25,i%3!==0,i%2?'DOWN':'UP'));
  const early=firstLayer15sProductionFuseSummary(rounds,PM25);
  assert.equal(early.production.samples,9);
  assert.equal(early.productionMissStreak,1);
  assert.equal(early.fuse.globalFused,false,'three scattered misses among nine are not a rolling-ten fuse');
  rounds.set(10,row(10,PM25,true));
  const atTen=firstLayer15sProductionFuseSummary(rounds,PM25);
  assert.equal(atTen.production.samples,10);
  assert.equal(atTen.production.hits,7);
  assert.equal(atTen.fuse.globalFused,false,'exactly 70% is permitted');
  rounds.set(11,row(11,PM25,false));
  const below=firstLayer15sProductionFuseSummary(rounds,PM25);
  assert.equal(below.recent10.samples,10);
  assert.equal(below.recent10.accuracy,0.6);
  assert.equal(below.fuse.globalFused,true);
});
test('first-layer strict rearming requires two official trial HITs even when forward data recovers',()=>{
  let now=1000000;
  const fuse=createTimedEdgeRescueFuse({now:()=>now,productionSource:FLOW,requireTwoHitRecovery:true});
  const bad={fuse:{globalFused:true},up:{fused:false},down:{fused:true}};
  const good={fuse:{globalFused:false},up:{fused:false},down:{fused:false}};
  assert.equal(fuse.check('DOWN',bad).reason,'GLOBAL_COOLDOWN');
  now+=1800000;
  assert.equal(fuse.check('DOWN',good).trial,true);
  fuse.recordLock('DOWN',300000);
  assert.equal(fuse.check('DOWN',good).allowed,false,'one live trial at a time');
  fuse.onSettled(row(1,FLOW,true,'DOWN'));
  assert.equal(fuse.check('DOWN',good).trial,true,'first HIT must not auto-reopen');
  fuse.recordLock('DOWN',600000);
  fuse.onSettled(row(2,FLOW,true,'DOWN'));
  assert.equal(fuse.status().scopes.GLOBAL.mode,'PROBATION_OPEN');
  assert.equal(fuse.status().scopes.DOWN.mode,'PROBATION_OPEN');
  assert.equal(fuse.check('DOWN',good).allowed,true);
  assert.equal(fuse.status().scopes.GLOBAL.mode,'OPEN');
});
test('strict first-layer recovery ignores unrelated or unverified trial settlement; original factory default stays unchanged',()=>{
  let now=1000000;
  const strict=createTimedEdgeRescueFuse({now:()=>now,productionSource:FLOW,requireTwoHitRecovery:true});
  const regular=createTimedEdgeRescueFuse({now:()=>now});
  const bad={fuse:{globalFused:true},up:{fused:true},down:{fused:false}};
  const good={fuse:{globalFused:false},up:{fused:false},down:{fused:false}};
  strict.check('UP',bad);regular.check('UP',bad);
  now+=1800000;
  assert.equal(strict.check('UP',good).trial,true);
  assert.equal(regular.check('UP',good).trial,false,
    'Edge Rescue and other sources retain the old successful-cooldown rearm behavior');
  strict.recordLock('UP',300000);
  strict.onSettled(row(1,PM25,true,'UP'));
  strict.onSettled({...row(1,FLOW,true,'UP'),actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE'});
  assert.equal(strict.check('UP',good).allowed,false);
});
