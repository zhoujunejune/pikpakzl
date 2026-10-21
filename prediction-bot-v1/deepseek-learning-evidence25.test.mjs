import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeQualityStore} from './deepseek-adaptive15-quality-store.mjs';
import {newLearner} from './deepseek-5m-learner.mjs';
import {caseSnapshot} from './deepseek-5m-episodic-memory.mjs';
import {createAdaptive15ProductionProvider} from './deepseek-adaptive15-production-adapter.mjs';
import {DEADLINE_MS} from './deepseek-adaptive15-core.mjs';
import {MAX_AI_CALLS_PER_ROUND,MAX_PRE_ROUND_CALLS,MAX_LIVE_CALLS} from './deepseek-adaptive15-runner.mjs';

const R=1800000300000,OFFICIAL='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const features=round=>({round,elapsedSec:8,lastPrice:68000,fromOpenPct:0.03,
 oneMinute:{ready:true,ema9:68002,ema21:67998,rsi14:54,volumeRelative:1.05,momentum1Pct:0.02,rangePosition20:0.65,macd:{hist:8}},
 fiveMinute:{ready:true,ema9:67995,ema21:68005,rsi14:47,volumeRelative:0.9,momentum1Pct:-0.01,rangePosition20:0.36,macd:{hist:-10}}});
const signal=(r,dir='UP')=>({round:r,providerModel:'deepseek-flash',
 latest:{lockedAt:r+7200,marketAt:r+7000,direction:dir,reason:'real fresh market evidence',
 selectedModelConfidence:.53,fromOpenBps:3.2,earlyObservationCount:7}});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ds-learning-proof-'));

test('25s six-call production configuration is unchanged',()=>{
 assert.equal(DEADLINE_MS,25000);
 assert.equal(MAX_AI_CALLS_PER_ROUND,6);
 assert.equal(MAX_PRE_ROUND_CALLS,2);
 assert.equal(MAX_LIVE_CALLS,4);
});
test('experience telemetry and authentic market snapshots persist and receive official settlement',()=>{
 const dir=temp();
 try{
  const now=R+330000;
  const quality=makeQualityStore(path.join(dir,'quality.json'),()=>now);
  const ledger=newLearner(path.join(dir,'learning.json'),()=>now);
  const official=[];
  for(let i=0;i<35;i++){
   const round=R-(i+1)*300000,dirn=i%2?'UP':'DOWN';
   const candidate=signal(round,dirn);
   assert.equal(quality.record(candidate,features(round),{llmPasses:3,
    experienceEvidence:[{pass:'current',at:round+3500,
     historyOffered:true,similarCaseCount:2,errorPatternsOffered:1}]}),true);
   ledger.record({round,providerModel:'deepseek-flash',latest:{...candidate.latest,confidence:.52}},features(round),3);
   official.push({roundStartMs:round,productionActual:i%3===0?(dirn==='UP'?'DOWN':'UP'):dirn,
    productionSettledAt:round+300500,officialSettlementAudit:{source:'official'}});
  }
  const result={ok:true,settlementSource:OFFICIAL,records:official};
  assert.equal(quality.settle(result),35);
  assert.equal(ledger.settle(result),35);
  const a=quality.summary();
  assert.equal(a.learningEvidence.featureSnapshotCount,35);
  assert.equal(a.learningEvidence.settledFeatureSnapshots,35);
  assert.equal(a.learningEvidence.modelRequestsAuditedRounds,35);
  assert.equal(a.learningEvidence.roundsWithHistoricalFeedbackOffered,35);
  assert.equal(a.learningEvidence.roundsWithSimilarCasesOffered,35);
  assert.equal(a.learningEvidence.roundsWithErrorPatternsOffered,35);
  assert.equal(a.controlledExperiment.effectVerified,false);
  assert.equal(a.controlledExperiment.pairedRounds,0);
  assert.ok(a.errors.patterns.length>0);
  const hist=quality.feedback(R+300000);
  assert.equal(hist.usable,true);
  assert.ok(ledger.qualitySnapshotEvidence().every(x=>x.caseFeatures.length===12));
  const reread=makeQualityStore(path.join(dir,'quality.json'),()=>now).summary();
  assert.equal(reread.learningEvidence.featureSnapshotCount,35);
  assert.ok(ledger.summary().comparableOfficialCases>=35);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('legacy error records backfill only actual same-round, same-lock, same-direction snapshots',()=>{
 const dir=temp();
 try{
  const qfile=path.join(dir,'quality.json'),now=R+600000;
  const quality=makeQualityStore(qfile,()=>now);
  const good=signal(R,'UP'),wrong=signal(R-300000,'DOWN');
  quality.record(good,{round:R,lastPrice:68000,oneMinute:{ready:false},fiveMinute:{ready:false}});
  quality.record(wrong,{round:R-300000,lastPrice:68000,oneMinute:{ready:false},fiveMinute:{ready:false}});
  assert.equal(quality.summary().learningEvidence.featureSnapshotCount,0);
  assert.equal(quality.backfillOriginalSnapshots([
   {round:R,direction:'DOWN',signalAt:R+7200,caseFeatures:caseSnapshot(features(R))},
   {round:R-300000,direction:'DOWN',signalAt:R-300000+7200,caseFeatures:caseSnapshot(features(R-300000))}
  ]),1);
  assert.equal(quality.summary().learningEvidence.featureSnapshotCount,1);
  assert.equal(quality.backfillOriginalSnapshots([]),0);
  assert.equal(makeQualityStore(qfile,()=>now).summary().learningEvidence.featureSnapshotCount,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('dedicated learning-effect status is read only, has no model or order API calls',()=>{
 const dir=temp();
 try{
  const p=createAdaptive15ProductionProvider({clock:()=>R,
   env:{DEEPSEEK_API_KEY:'',LLM_STATE_FILE:path.join(dir,'signal.json'),
    DEEPSEEK_LEARNING_FILE:path.join(dir,'learn.json'),
    DEEPSEEK_QUALITY_JOURNAL_FILE:path.join(dir,'quality.json'),
    DEEPSEEK_WAIT_JOURNAL_FILE:path.join(dir,'wait.json')}});
  const summary=p.learningEffect();
  assert.equal(summary.ok,true);
  assert.equal(summary.maxCallsPerRound,6);
  assert.equal(summary.hardDecisionDeadlineMs,25000);
  assert.equal(summary.additionalApiCalls,0);
  assert.equal(summary.controlledComparisonVerdict,'NOT_PROVEN');
  assert.equal(summary.experiment.effectVerified,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
