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
test('captures only previous round last 22-10 seconds with exact round association',()=>{
  const p=createVip75PreviousRoundInputs();
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+239999),false);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+277999),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+278000),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+290000),true);
  assert.equal(p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+290001),false);
  assert.equal(p.capture({round:PREVIOUS-300000,facts:completeFacts()},PREVIOUS+289000),false);
  assert.equal(p.report().samples,3);
  assert.equal(p.report().backupSamples,1);
  assert.equal(p.report().tailSamples,2);
  assert.equal(p.prepare(PREVIOUS,{}).fromPrevious.length,0);
  assert.equal(p.prepare(NEXT,{}).fromPrevious.length,VIP75_RAW_INPUT_KEYS.length);
  assert.deepEqual(p.prepare(NEXT,{}).sourceWindow,[NEXT-22000,NEXT-10000]);
});
test('uses previous-tail values as primary features, does not turn missing into zeros',()=>{
  const p=createVip75PreviousRoundInputs();
  const old=completeFacts();
  delete old.ofiNormalized60s;
  delete old.liveScore;
  p.capture({round:PREVIOUS,facts:old},PREVIOUS+282000);
  const current={ofiNormalized60s:0.8,liveScore:-0.9,predictionMarketUpMid:0.71};
  const merged=p.prepare(NEXT,current);
  assert.equal(merged.inputVersion,VIP75_PREVIOUS_ROUND_INPUT_VERSION);
  assert.equal(merged.complete,true);
  assert.deepEqual(merged.missing,[]);
  assert.equal(merged.facts.currentScore,old.currentScore);
  assert.equal(merged.facts.ofiNormalized60s,0.8);
  assert.equal(merged.facts.liveScore,-0.9);
  assert.equal(merged.facts.predictionMarketUpMid,0.71);
  assert.equal(merged.facts.absorptionRisk,false);
  assert.equal(merged.fromPrevious.length,15);
  assert.equal(merged.fromCurrent.length,3);
  assert.equal(merged.priorContractQuoteUsed,false);
});
test('an earlier contract quote remains visibly historical when no current quote exists',()=>{
  const p=createVip75PreviousRoundInputs();
  p.capture({round:PREVIOUS,facts:completeFacts()},PREVIOUS+285000);
  const merged=p.prepare(NEXT,{predictionMarketUpMid:null});
  assert.equal(merged.facts.predictionMarketUpMid,0.53);
  assert.equal(merged.priorContractQuoteUsed,true);
  assert.equal(merged.sourceRound,PREVIOUS);
});
test('missing, null, NaN and stale data never silently become legitimate zero features',()=>{
  const p=createVip75PreviousRoundInputs();
  const prev=completeFacts();
  delete prev.tradePressure60s;prev.ofiNormalized5s=null;prev.normalizedMomentum60s='';prev.liveScore=NaN;
  assert.equal(p.capture({round:PREVIOUS,facts:{...prev,dataFresh:false}},PREVIOUS+281000),false);
  p.capture({round:PREVIOUS,facts:prev},PREVIOUS+282000);
  const assembled=p.prepare(NEXT,{tradePressure60s:null});
  assert.equal(assembled.complete,false);
  assert.deepEqual(assembled.missing.sort(),
    ['tradePressure60s','ofiNormalized5s','normalizedMomentum60s','liveScore'].sort());
  for(const k of assembled.missing) assert.equal(Object.hasOwn(assembled.facts,k),false);
});
test('within tail window the latest genuine value per key wins; never read a future round',()=>{
  const p=createVip75PreviousRoundInputs();
  const f=completeFacts();delete f.microScore;
  p.capture({round:PREVIOUS,facts:f},PREVIOUS+279000);
  p.capture({round:PREVIOUS,facts:{microScore:-0.33}},PREVIOUS+289000);
  const target=p.prepare(NEXT,{});
  assert.equal(target.complete,true);
  assert.equal(target.facts.microScore,-0.33);
  assert.equal(p.prepare(NEXT+300000,completeFacts()).fromPrevious.length,0);
  assert.equal(p.capture({round:NEXT,facts:completeFacts()},NEXT+1000),false);
});

test('uses 60-22 second prior-round backup only for fields missing from 22-10 seconds',()=>{
  const p=createVip75PreviousRoundInputs();
  const early=completeFacts();
  early.ofiNormalized60s=-0.72;early.microScore=0.93;
  assert.equal(p.capture({round:PREVIOUS,facts:early},PREVIOUS+244000),true);
  const late=completeFacts();
  late.ofiNormalized60s=undefined;late.microScore=0.41;
  assert.equal(p.capture({round:PREVIOUS,facts:late},PREVIOUS+281000),true);
  const merged=p.prepare(NEXT,{predictionMarketUpMid:0.62});
  assert.equal(merged.complete,true);
  assert.equal(merged.facts.ofiNormalized60s,-0.72);
  assert.equal(merged.facts.microScore,0.41);
  assert.deepEqual(merged.fromPreviousBackup,['ofiNormalized60s']);
  assert.equal(merged.fromPrevious.length,17);
  assert.equal(merged.fromCurrent.length,1);
  assert.equal(merged.priorContractQuoteUsed,false);
  assert.deepEqual(merged.backupWindow,[NEXT-60000,NEXT-22000]);
});
test('older previous-round data never leaks to another target round, stale current is not used',()=>{
  const p=createVip75PreviousRoundInputs();
  p.capture({round:PREVIOUS,facts:{normalizedMomentum60s:0.77}},PREVIOUS+255000);
  assert.equal(p.prepare(NEXT,{dataFresh:false,currentScore:0.8}).facts.currentScore,undefined);
  assert.equal(p.prepare(NEXT+300000,{}).facts.normalizedMomentum60s,undefined);
});
