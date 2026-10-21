import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {caseSnapshot,caseDistance,retrieveOfficialCases} from './deepseek-5m-episodic-memory.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';

const ROUND=1800000000000;
const f=(round=ROUND)=>({
  round,elapsedSec:70,lastPrice:70000,fromOpenPct:0.04,
  oneMinute:{ready:true,rsi14:55,volumeRelative:1.12,momentum1Pct:0.035,
    rangePosition20:0.63,macd:{hist:14}},
  fiveMinute:{ready:true,rsi14:51,volumeRelative:1.01,momentum1Pct:0.012,
    rangePosition20:0.53,macd:{hist:-10}}
});
const oldCases=()=>Array.from({length:55},(_,i)=>({
  round:ROUND-(i+2)*300000,
  direction:i%2?'UP':'DOWN',actual:i%3?'UP':'DOWN',
  settledAt:ROUND-(i+1)*300000,hit:false,
  caseFeatures:caseSnapshot(f()),reason:'Weak mixed momentum, volume marginal'
}));

test('case snapshot is causal and normalized; invalid indicators excluded',()=>{
  const snap=caseSnapshot(f());
  assert.equal(snap.length,12);
  assert.ok(snap.every(x=>x===null||Math.abs(x)<=1));
  assert.equal(caseDistance(snap,snap),0);
  assert.equal(caseSnapshot({...f(),oneMinute:{ready:false}}),null);
});

test('retrieved cases are exclusively earlier official settlements, never current or future',()=>{
  const cases=oldCases();
  cases.push({...cases[0],round:ROUND,actual:'UP',settledAt:ROUND+300000});
  cases.push({...cases[0],round:ROUND+300000,actual:'DOWN',settledAt:ROUND+600000});
  cases.push({...cases[0],round:ROUND-300000,actual:null});
  const x=retrieveOfficialCases(cases,f(),{minimum:50});
  assert.equal(x.usable,true);
  assert.equal(x.officialComparableCases,55);
  assert.ok(x.cases.length<=4);
  assert.ok(x.cases.every(c=>c.priorRound<ROUND));
  assert.ok(x.cases.every(c=>typeof c.wasCorrect==='boolean'));
  assert.equal(retrieveOfficialCases(cases.slice(0,20),f()).usable,false);
});

test('legacy sparse samples never masquerade as complete learning examples',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ds-case-'));
  try{
    const file=path.join(dir,'learning.json');
    fs.writeFileSync(file,JSON.stringify({
      schema:1,predictions:oldCases().map(x=>({...x,caseFeatures:null}))
    }));
    const learner=newLearner(file,()=>ROUND);
    const out=learner.feedback(f());
    assert.equal(out.usable,true);
    assert.equal(out.episodicMemory.usable,false);
    assert.equal(out.episodicMemory.officialComparableCases,0);
    assert.equal(learner.summary().comparableOfficialCases,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('new DeepSeek signal writes the original reason and feature snapshot without changing direction',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ds-write-'));
  try{
    const file=path.join(dir,'learning.json');
    const learner=newLearner(file,()=>ROUND+90000);
    learner.record({round:ROUND,providerModel:'deepseek-flash',
      latest:{direction:'DOWN',reason:'5m bearish divergence',lockedAt:ROUND+82000,confidence:0.61}},f(),2);
    const raw=JSON.parse(fs.readFileSync(file));
    assert.equal(raw.predictions[0].direction,'DOWN');
    assert.equal(raw.predictions[0].caseFeatures.length,12);
    assert.equal(raw.predictions[0].reason,'5m bearish divergence');
    assert.equal(learner.summary().officialSamples,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
