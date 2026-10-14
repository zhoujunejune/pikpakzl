import test from 'node:test';
import assert from 'node:assert/strict';
import {createVip75PreviousRoundInputs,VIP75_RAW_INPUT_KEYS,
  VIP75_PREVIOUS_ROUND_INPUT_VERSION} from './vip75-preround-features.mjs';

const PREVIOUS=1800000000000;
const NEXT=PREVIOUS+300000;
function completeFacts(){
  const facts=Object.fromEntries(VIP75_RAW_INPUT_KEYS.map((k,i)=>[k,0.1+i/100]));
  facts.absorptionRisk=false;
  facts.predictionMarketUpMid=0.53;
  facts.regimeScore=-0.5;
  return facts;
}
test('captures previous 120s reserve and 22-10s primary with strict boundaries',()=>{
  const p=createVip75PreviousRoundInputs();
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+179999),false);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+180000),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+277999),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+278000),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+290000),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+290001),false);
  assert.equal(p.capture({round:PREVIOUS-300000,facts:completeFacts()},PREVIOUS+289000),false);
  assert.equal(p.report().samples,2);
  assert.equal(p.report().reserveSamples,2);
  assert.equal(p.prepare(PREVIOUS,{}).fromPrevious.length,0);
  // PM quote from a different contract is never transplanted.
  const next=p.prepare(NEXT,{predictionMarketUpMid:0.61});
  assert.equal(next.fromPrevious.length,17);
  assert.deepEqual(next.sourceWindow,[NEXT-22000,NEXT-10000]);
  assert.deepEqual(next.reserveWindow,[NEXT-120000,NEXT-22000]);
  assert.equal(next.inputVersion,VIP75_PREVIOUS_ROUND_INPUT_VERSION);
});
test('extended previous reserve replenishes raw features missing in final tail',()=>{
  const p=createVip75PreviousRoundInputs();
  const earlier=completeFacts();
  earlier.ofiNormalized60s=0.88;
  earlier.tradePressure60s=-0.45;
  p.capture({round:PREVIOUS,facts:earlier},PREVIOUS+230000);
  const late=completeFacts();delete late.ofiNormalized60s;
  delete late.tradePressure60s;delete late.liveScore;
  p.capture({round:PREVIOUS,facts:late},PREVIOUS+285000);
  const assembled=p.prepare(NEXT,{predictionMarketUpMid:0.71,liveScore:0.82});
  assert.equal(assembled.complete,true);
  assert.equal(assembled.facts.ofiNormalized60s,0.88);
  assert.equal(assembled.facts.tradePressure60s,-0.45);
  assert.equal(assembled.facts.liveScore,earlier.liveScore);
  assert.equal(assembled.facts.predictionMarketUpMid,0.71);
  assert.deepEqual(assembled.fromEarlierPrevious.sort(),['ofiNormalized60s','tradePressure60s','liveScore'].sort());
  assert.equal(assembled.fromPrevious.length,17);
  assert.equal(assembled.fromCurrent.length,1);
  assert.equal(assembled.priorContractQuoteUsed,false);
});
test('new contract quote required; no previous contract price can fake it',()=>{
  const p=createVip75PreviousRoundInputs();
  p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+285000);
  const missing=p.prepare(NEXT,{predictionMarketUpMid:null});
  assert.equal(missing.complete,false);
  assert.deepEqual(missing.missing,['predictionMarketUpMid']);
  assert.equal(Object.hasOwn(missing.facts,'predictionMarketUpMid'),false);
  assert.equal(missing.priorContractQuoteUsed,false);
  const current=p.prepare(NEXT,{predictionMarketUpMid:0.78});
  assert.equal(current.complete,true);
  assert.equal(current.facts.predictionMarketUpMid,0.78);
});
test('invalid or stale values never silently turn into zero',()=>{
  const p=createVip75PreviousRoundInputs();
  const prev=completeFacts();
  delete prev.tradePressure60s;prev.ofiNormalized5s=null;
  prev.normalizedMomentum60s='';prev.liveScore=NaN;
  assert.equal(p.capture({round:PREVIOUS,facts:{...prev,dataFresh:false}},PREVIOUS+220000),false);
  p.capture({round:PREVIOUS,facts:prev},PREVIOUS+282000);
  const assembled=p.prepare(NEXT,{predictionMarketUpMid:0.6,tradePressure60s:null});
  assert.equal(assembled.complete,false);
  assert.deepEqual(assembled.missing.sort(),
    ['tradePressure60s','ofiNormalized5s','normalizedMomentum60s','liveScore'].sort());
  for(const k of assembled.missing)assert.equal(Object.hasOwn(assembled.facts,k),false);
});
test('newest primary genuine values override reserve and current; no future contamination',()=>{
  const p=createVip75PreviousRoundInputs();
  const earlier=completeFacts();earlier.microScore=0.4;
  p.capture({round:PREVIOUS,facts:earlier},PREVIOUS+201000);
  const final=completeFacts();delete final.microScore;
  p.capture({round:PREVIOUS,facts:final},PREVIOUS+282000);
  p.capture({round:PREVIOUS,facts:{microScore:-0.33}},PREVIOUS+289000);
  const target=p.prepare(NEXT,{microScore:0.99,predictionMarketUpMid:0.6});
  assert.equal(target.complete,true);
  assert.equal(target.facts.microScore,-0.33);
  assert.equal(target.fromEarlierPrevious.length,0);
  assert.equal(p.prepare(NEXT+300000,completeFacts()).fromPrevious.length,0);
  assert.equal(p.capture({round:NEXT,facts:completeFacts()},NEXT+1000),false);
});
