import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateV2HardFuseRescue, summarizeV2HardFuseRescue, SOURCE, VERSION } from './v2-hard-fuse-rescue.mjs';

const start=1791763200000;
function row(direction='UP', n=0) {
  return {roundStartMs:start+n*300000,prediction:direction,
    predictionFacts:{predictionMarketUpMid:direction==='UP'?0.61:0.39,
      currentScore:direction==='UP'?0.90:-0.90,
      currentTrendScore:direction==='UP'?0.70:-0.70,
      regimeDirection:direction,regimeAgreement:0.80,absorptionRisk:false},
    predictionScore:0.66,predictionDelayMs:18000,actual:null,settledAt:null};
}
function settled(direction, actual, n) {
  const r=row(direction,n);
  r.v2HardFuseRescue=evaluateV2HardFuseRescue(r,r.roundStartMs+19000);
  r.actual=actual;r.actualSource='BINANCE_PREDICTION_OFFICIAL_RESOLUTION';
  r.settledAt=r.roundStartMs+303000;
  return r;
}
test('independent rescue can qualify immediately without sample quota',()=>{
  const r=row();
  const result=evaluateV2HardFuseRescue(r,r.roundStartMs+20000);
  assert.equal(result.version,VERSION);
  assert.equal(result.decision,'UP');
  assert.equal(result.pass,true);
  assert.equal(SOURCE,'SELECTIVE_V2_HARD_FUSE_RESCUE_PRIMARY');
});
test('both directions need genuine market evidence',()=>{
  const r=row('DOWN');
  delete r.predictionFacts.predictionMarketUpMid;
  assert.equal(evaluateV2HardFuseRescue(r,r.roundStartMs+20000).decision,'WAIT');
  const r2=row('DOWN');r2.predictionFacts.currentTrendScore=0.75;
  assert.equal(evaluateV2HardFuseRescue(r2,r2.roundStartMs+20000).decision,'WAIT');
});
test('rejects absorption, strongly opposed regime, delayed, or settled records',()=>{
  for(const change of [
    r=>{r.predictionFacts.absorptionRisk=true;},
    r=>{r.predictionFacts.regimeDirection='DOWN';},
    r=>{r.predictionDelayMs=23000;},
    r=>{r.predictionScore=0.32;},
  ]){
    const r=row();change(r);
    assert.equal(evaluateV2HardFuseRescue(r,r.roundStartMs+20000).decision,'WAIT');
  }
  const r=row();r.actual='UP';r.settledAt=r.roundStartMs+301000;
  assert.equal(evaluateV2HardFuseRescue(r,r.roundStartMs+302000),null);
});
test('official pre-settlement evidence alone contributes to independent fuse',()=>{
  const arr=[
    settled('UP','DOWN',0),settled('UP','DOWN',1),
    settled('UP','UP',2),settled('UP','DOWN',3),
    settled('UP','UP',4),settled('DOWN','DOWN',5),
  ];
  const result=summarizeV2HardFuseRescue(arr);
  assert.equal(result.eligibleStrictForward.samples,6);
  assert.equal(result.up.samples,5);
  assert.equal(result.up.fused,true);
  assert.equal(result.down.samples,1);
  assert.equal(result.down.fused,false);
  assert.equal(result.fuse.globalFused,true);
  const spoof=settled('DOWN','DOWN',6);
  spoof.v2HardFuseRescue.frozenAt=spoof.settledAt+100;
  assert.equal(summarizeV2HardFuseRescue([...arr,spoof]).eligibleStrictForward.samples,6);
});
