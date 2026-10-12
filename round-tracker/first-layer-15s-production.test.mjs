import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freezeNoBase15s, V3_NO_BASE_15S_VERSION } from './v3-no-base-15s-audit.mjs';
import {
  FIRST_LAYER_15S_IDS, userFirst15sProofPass,
  selectUserFirst15sCandidates, selectUserFirst15sWinner,
  selectForwardGated15sCandidates
} from './unified-15s-candidate-router.mjs';

const round = Date.parse('2026-10-11T15:00:00.000Z');
const facts = {
  predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
  predictionMarketTopicId:'same-official-round',predictionMarketBookAgeMs:100,
  predictionMarketUpMid:0.60,currentScore:0.7,currentTrendScore:0.8,
  liveScore:0.9,distanceFromOpenBps:1.4,tradeCount15s:30,
  depthAgeMs:200,lastAggTradeAgeMs:200,tradeStreamStalled:false,
  absorptionRisk:false,regimeDirection:'UP',regimeAgreement:0.7,
  regimeScore:0.8,predictionMarketConflict:false
};
const row=(f=facts)=> {
  const r={roundStartMs:round,predictedAt:null,prediction:null};
  return {...r,v3NoBase15sShadow:freezeNoBase15s(r,f,round+15500)};
};
function proof(id,n,hits) {
  const rate=Number((hits/n).toFixed(4));
  return {candidateId:id,status:'COLLECTING',strictForwardSamples:n,hits,
    misses:n-hits,forwardAccuracy:rate,
    recent10:{samples:10,accuracy:0.8},
    recent20:{samples:Math.min(n,20),accuracy:0.8},
    recent30:{samples:n,accuracy:rate},
    up:{samples:Math.floor(n/2),accuracy:0.78},
    down:{samples:Math.ceil(n/2),accuracy:0.8},
    currentMissStreak:1,oneTimeBootstrapEligible:false,
    oneTimeBootstrapRevoked:false
  };
}
const p1=proof('PM_FLOW15_CURRENT_03',40,36);
const p2=proof('PM_CURRENT25_SUPPORT08',40,35);
const stats=(candidates)=>({
  version:V3_NO_BASE_15S_VERSION,
  scope:'OFFICIAL_SETTLED_STRICT_FORWARD_NO_BASE_AT_15S',
  observedNoBaseSettledRounds:30,
  candidates
});

test('both user-selected 15s signals are first-layer eligible before ordinary 100-round gate',()=>{
  assert.deepEqual(FIRST_LAYER_15S_IDS,['PM_FLOW15_CURRENT_03','PM_CURRENT25_SUPPORT08']);
  const got=selectUserFirst15sCandidates(row(),stats([p2,p1]),round+16000);
  assert.deepEqual(got.candidates.map(x=>x.id),FIRST_LAYER_15S_IDS);
  assert.ok(got.candidates.every(x=>x.proof.userAuthorizedFirstLayer===true));
  assert.ok(got.candidates.every(x=>x.proof.wilsonPriceGateApplied===true));
  // User opt-in is not silently granted to the original secondary routes.
  assert.equal(selectForwardGated15sCandidates(row(),stats([p2,p1]),round+16000,'early',{excludeUserFirst:true}).candidates.length,0);
});

test('unavailable first signal falls through to the second candidate',()=>{
  const bad={...p1,forwardAccuracy:0.79};
  const got=selectUserFirst15sCandidates(row(),stats([bad,p2]),round+16000);
  assert.deepEqual(got.candidates.map(x=>x.id),['PM_CURRENT25_SUPPORT08']);
});

test('priority first layer auto-rejects poor overall/recent/directional quality or revoked bootstrap',()=>{
  for(const bad of [
    {...p1,forwardAccuracy:0.799},
    {...p1,recent10:{samples:10,accuracy:0.7}},
    {...p1,up:{samples:20,accuracy:0.74}},
    {...p1,down:{samples:20,accuracy:0.74}},
    {...p1,currentMissStreak:3},
    {...p1,oneTimeBootstrapRevoked:true},
    {...p1,strictForwardSamples:29,hits:26,misses:3}
  ])assert.equal(userFirst15sProofPass(bad),false,JSON.stringify(bad));
});

test('first-layer selection refuses unfrozen/stale and out-of-window or already locked data',()=>{
  for(const delay of [10000,14500,20001,22000,25000])
    assert.equal(selectUserFirst15sCandidates(row(),stats([p1,p2]),round+delay).candidates.length,0);
  for(const patch of [
    {productionPrediction:'UP'}, {productionPrediction:'DOWN'},
    {actual:'UP'}, {settledAt:round+300000},
    {predictedAt:round+14000,prediction:'UP'}
  ]) assert.equal(selectUserFirst15sCandidates({...row(),...patch},stats([p1,p2]),round+16000).candidates.length,0);
  for(const patch of [
    {predictionMarketBookAgeMs:8000},
    {predictionMarketRoundAligned:false},
    {absorptionRisk:true},{tradeStreamStalled:true},
    {depthAgeMs:3000},
  ])assert.equal(selectUserFirst15sCandidates(row({...facts,...patch}),stats([p1,p2]),round+16000).candidates.length,0);
});

test('real production waterfall is wired with the priority layer before all ordinary lock routes',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  const start=source.indexOf("function productionSignalPayload(now = Date.now())");
  assert.ok(start>0);
  const body=source.slice(start,start+12000);
  const first=body.indexOf("tryUserFirst15sLock(row, now)");
  const regular=body.indexOf("tryAutoPromoted15sLock(row, now, 'early');");
  const primary=body.indexOf("if (productionUsesSelectiveV2())");
  const edge=body.indexOf('evaluateSelectiveV2EdgeRescueRow(row, q)');
  assert.ok(first>=0 && first<regular && regular<primary && primary<edge);
  assert.ok(source.includes('first_layer_15s_direction_conflict'));
  assert.ok(source.includes("lastResort15sFuses[chosen.id]"));
  assert.ok(source.includes('timedPmCurrent25Fuse'));
});

test('FLOW15 wins first-layer UP/DOWN conflicts irrespective of candidate array order',()=>{
  const flow={chosen:{id:'PM_FLOW15_CURRENT_03',direction:'UP'},fuse:{},circuit:{allowed:true}};
  const second={chosen:{id:'PM_CURRENT25_SUPPORT08',direction:'DOWN'},fuse:{},circuit:{allowed:true}};
  assert.equal(selectUserFirst15sWinner([second,flow]),flow);
  assert.equal(selectUserFirst15sWinner([flow,second]),flow);
  assert.equal(selectUserFirst15sWinner([second]),second);
  assert.equal(selectUserFirst15sWinner([]),null);
  assert.equal(selectUserFirst15sWinner(null),null);
  assert.equal(selectUserFirst15sWinner([{chosen:{id:'OTHER',direction:'UP'}},second]),second);
});

test('first-layer conflict no longer falls through to Selective V2 or Edge Rescue',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  const start=source.indexOf('const firstLayerWinner = firstLayer ? selectUserFirst15sWinner(allowed) : null;');
  assert.ok(start > 0,'a priority arbiter must run after risk/fuse approval');
  const block=source.slice(start,source.indexOf('for (const {chosen,fuse,circuit} of (firstLayer',start));
  assert.ok(block.includes('first_layer_15s_direction_conflict'));
  assert.ok(block.includes('selected:firstLayerWinner?.chosen.id'));
  assert.ok(!block.includes('return null;'),'direction disagreement must never discard both eligible candidates');
  assert.ok(source.includes('firstLayerWinner ? [firstLayerWinner] : []'));
});

test('legacy 15-sample bootstrap cannot bypass first-layer gating in early OR late routing',()=>{
  const old={...proof('PM_FLOW15_CURRENT_03',27,23),oneTimeBootstrapEligible:true};
  assert.equal(userFirst15sProofPass(old),false);
  for(const phase of ['early','late']){
    const time=round+(phase==='early'?16000:26000);
    const got=selectForwardGated15sCandidates(row(),stats([old]),time,phase,
      phase==='early'?{userFirst:true}:{});
    assert.equal(got.candidates.length,0,phase);
  }
  const other=proof('PM_TREND_045_CURRENT_03',27,23);
  other.oneTimeBootstrapEligible=true;
  const got=selectForwardGated15sCandidates(row(),stats([other]),round+26000,'late');
  assert.equal(got.candidates.length,1,'unrelated original fallback eligibility unchanged');
});

test('first-layer new sample, win-rate, directional and Wilson-price requirements',()=>{
  const min=proof('PM_FLOW15_CURRENT_03',30,27);
  assert.equal(userFirst15sProofPass(min),true);
  assert.equal(selectUserFirst15sCandidates(row(),stats([min]),round+16000).candidates.length,1);
  for(const p of [
    {...min,strictForwardSamples:29,hits:26,misses:3},
    {...min,forwardAccuracy:0.79},
    {...min,recent10:{samples:10,accuracy:0.7}},
    {...min,up:{samples:15,accuracy:0.74}},
  ])assert.equal(userFirst15sProofPass(p),false);
  assert.equal(selectUserFirst15sCandidates(
    row({...facts,predictionMarketUpMid:0.86}),stats([min]),round+16000
  ).candidates.length,0,'expensive midpoint is rejected even if direction proof passes');
});

test('production has exactly three live signal layers and no future 15s promotion',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  const start=source.indexOf('function productionSignalPayload(now = Date.now())');
  const end=source.indexOf('if (productionUsesShadowV3())',start);
  const live=source.slice(start,end);
  assert.ok(start>0 && end>start);
  assert.match(live,/tryUserFirst15sLock\(row, now\)/);
  assert.match(live,/tryAutoPromoted15sLock\(row, now, 'early'\)/);
  assert.match(live,/if \(productionUsesSelectiveV2\(\)\)/);
  assert.doesNotMatch(live,/tryAutoPromoted15sLock\(row, now, 'late'\)/);
  assert.match(source,/phase !== 'early'\) return null/);
  assert.match(source,/newPromotionsEnabled:false/);
  assert.match(source,/late15sFallbackEnabled:false/);
  assert.match(source,/FROZEN_STARTUP_GRANTS\.has\(x\.candidateId\) && x\.oneTimeBootstrapEligible === true/);
  assert.match(source,/const FROZEN_STARTUP_GRANTS = new Set/);
  assert.match(source,/!deleted\.has\(c\.candidateId\)/);
  assert.ok(!source.includes("productionRoute:'USER_FIRST_DUAL_15S_THEN_EXISTING_EARLY_15S_THEN_SELECTIVE_V2_EDGE_THEN_LATE_15S'"));
});

test('retired Edge Rescue can neither lock a fresh round nor reappear from a frozen pre-retirement round',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
  assert.match(source,/27 HIT \/ 41 settled = 65\.85%/);
  assert.match(source,/'SELECTIVE_V2_EDGE_RESCUE_PRIMARY', 'SELECTIVE_V2_EDGE_RESCUE_V1'/);
  const guard=source.slice(source.indexOf('function isPermanentlyRetiredProductionSignal('),source.indexOf('function isPermanentlyRetiredProductionSignal(')+640);
  assert.match(guard,/retired\.has\(origin\)/);
  const immutable=source.slice(source.indexOf('function productionSignalPayload('),source.indexOf('function productionSignalPayload(')+1500);
  assert.match(immutable,/isPermanentlyRetiredProductionSignal\(row\.productionSource, row\.productionModel\)/);
  const freeze=source.slice(source.indexOf('function freezeProductionLock('),source.indexOf('function freezeProductionLock(')+900);
  assert.match(freeze,/isPermanentlyRetiredProductionSignal\(live\.source, live\.model\)/);
  const live=source.slice(source.indexOf('function productionSignalPayload('));
  assert.match(live,/const edgeRescue = !isPermanentlyRetiredProductionSignal\('SELECTIVE_V2_EDGE_RESCUE_PRIMARY', SELECTIVE_V2_EDGE_RESCUE_VERSION\)/);
  assert.match(source,/FROZEN_FIRST_DUAL_15S_THEN_EXISTING_EARLY_15S_THEN_SELECTIVE_V2_THEN_HARD_FUSE_RESCUE_THEN_WAIT/);
  assert.match(source,/const firstLayer15s = tryUserFirst15sLock\(row, now\)/);
  assert.match(source,/if \(productionUsesSelectiveV2\(\)\)/);
  assert.match(source,/source:V2_FUSE_RESCUE_SOURCE,model:V2_FUSE_RESCUE_VERSION/);
});
