import test from 'node:test';
import assert from 'node:assert/strict';
import { selectiveV2HardFuseSummary } from '../selective-v2-hard-fuse.mjs';
const START = Date.parse('2026-10-11T13:00:00Z');
function settled(i, dir, hit, live=true, shadow=false) {
  const roundStartMs = START + i*300000;
  const row = {
    roundStartMs, actual:hit?dir:(dir==='UP'?'DOWN':'UP'),
    productionSource:live?'LOCK_QUALITY_SELECTIVE_V2_PRIMARY':null,
    productionPrediction:live?dir:null,
    productionResult:live?(hit?'HIT':'MISS'):'NO_DECISION',
    productionLockedAt:roundStartMs+20000,
    officialDirection:hit?dir:(dir==='UP'?'DOWN':'UP'),
    resolutionEvidence:'OFFICIAL_'+(hit?dir:(dir==='UP'?'DOWN':'UP'))+':variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
    officialSettlementAudit:{sourceEndpoint:'/sapi/v1/w3w/wallet/prediction/market/detail',
      observedAt:new Date(roundStartMs+301000).toISOString()},
  };
  if(shadow) row.selectiveV2HardFuseShadow={direction:dir,frozenAt:roundStartMs+22000};
  return row;
}
test('kills live signals by default even when historical hit rate is high',()=>{
  const rounds=Array.from({length:20},(_,i)=>settled(i,'UP',true));
  const r=selectiveV2HardFuseSummary(rounds,'UP',{shadowStartMs:START});
  assert.equal(r.blocked,true);
  assert.ok(r.reasons.includes('MANUAL_SELECTIVE_V2_LIVE_PAUSE'));
});
test('separately trips the losing direction at 3 consecutive misses',()=>{
  const rounds=Array.from({length:10},(_,i)=>settled(i,'DOWN',i<7));
  const r=selectiveV2HardFuseSummary(rounds,'DOWN',{paused:false,shadowStartMs:START});
  assert.equal(r.production.consecutiveMisses,3);
  assert.equal(r.production.direction10.accuracy,0.7);
  assert.ok(r.reasons.includes('DIRECTION_MISS_STREAK_3'));
  assert.equal(r.blocked,true);
});
test('insufficient or hindsight-created shadow records cannot release fuse',()=>{
  const rounds=Array.from({length:20},(_,i)=>settled(i,'UP',true,false,true));
  rounds[0].selectiveV2HardFuseShadow.frozenAt=rounds[0].roundStartMs+320000;
  const r=selectiveV2HardFuseSummary(rounds,'UP',{paused:false,shadowStartMs:START});
  assert.equal(r.shadow.samples,19);
  assert.equal(r.shadow.recoveryReady,false);
  assert.equal(r.blocked,true);
});
test('new independent official paper record can satisfy readiness, not manual pause',()=>{
  const rounds=Array.from({length:20},(_,i)=>settled(i,'UP',i!==3 && i!==6 && i!==10 && i!==15,false,true));
  const r=selectiveV2HardFuseSummary(rounds,'UP',{paused:true,shadowStartMs:START});
  assert.equal(r.shadow.recoveryReady,true);
  assert.equal(r.blocked,true);
  const rearmed=selectiveV2HardFuseSummary(rounds,'UP',{paused:false,shadowStartMs:START});
  assert.equal(rearmed.blocked,false);
});

test('overall warning must not fuse healthy UP when DOWN loses',()=>{
  const upLive=Array.from({length:10},(_,i)=>settled(i,'UP',true));
  const downLive=Array.from({length:10},(_,i)=>settled(i+10,'DOWN',false));
  const newPaperUp=Array.from({length:20},(_,i)=>settled(i+20,'UP',true,false,true));
  const r=selectiveV2HardFuseSummary([...upLive,...downLive,...newPaperUp],'UP',{paused:false,shadowStartMs:START});
  assert.equal(r.production.global10.accuracy,0);
  assert.equal(r.production.direction10.accuracy,1);
  assert.equal(r.shadow.recoveryReady,true);
  assert.equal(r.blocked,false);
});
