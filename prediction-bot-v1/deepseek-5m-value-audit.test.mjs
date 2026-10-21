import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assessQuote,summarizeTiming,assessPromotion} from './deepseek-5m-value-audit.mjs';
import {newDecisionJournal} from './deepseek-5m-decision-journal.mjs';
test('no imaginary quotes, stale quotes, or subjective LLM confidence masquerading as calibrated probability',()=>{
 assert.equal(assessQuote({direction:'UP'}).reason,'FORWARD_CALIBRATED_PROBABILITY_REQUIRED');
 const calibration={source:'FORWARD_CALIBRATED',winProbability:.65};
 const quote={source:'BINANCE_PREDICTION_EXECUTABLE_QUOTE',direction:'UP',quotedAt:10000,ask:.7,payout:1,fees:.01,slippageAllowance:.01};
 assert.equal(assessQuote({direction:'UP',calibration,quote,at:14001}).reason,'FRESH_EXECUTABLE_QUOTE_REQUIRED');
 const v=assessQuote({direction:'UP',calibration,quote,at:11000});
 assert.equal(v.ok,true);assert.equal(v.profitableAtEstimatedProbability,false);
 assert.equal(v.expectedNetPerShare,-.07);assert.equal(v.breakEvenProbability,.72);
 assert.equal(assessQuote({direction:'DOWN',calibration,quote,at:11000}).ok,false);
});
test('timing report never fabricates profitability from bare prediction accuracy',()=>{
 const r=1800000000000,rows=[
  {round:r,signalAt:r+90000,settledAt:r+302000,actual:'UP',direction:'UP'},
  {round:r+300000,signalAt:r+390000,settledAt:r+602000,actual:'DOWN',direction:'UP',
   execution:{verified:true,status:'FILLED',fillPrice:.4,payout:1,fees:.01}},
  {round:r+600000,signalAt:r+710000,settledAt:r+902000,actual:'UP',direction:'UP',
   execution:{verified:true,status:'FILLED',fillPrice:.65,payout:1,fees:.01}}
 ];
 const report=summarizeTiming(rows);
 const mid=report[1];
 assert.equal(mid.resolvedPredictions,3);assert.equal(mid.hits,2);
 assert.equal(mid.verifiedFills,2);assert.equal(mid.realizedNet,-.07);
 assert.equal(report[0].realizedNet,null);
});
test('no model promotion on retrospectively fitted or unpaired rows',()=>{
 const r=1800000000000,base={trainedThrough:r-300000,decisionAt:r+60000,direction:'UP',netPerUnit:-.1};
 const cand={...base,netPerUnit:.2};
 assert.equal(assessPromotion({rows:[{round:r,actual:'UP',settledAt:r+301000,baseline:base,candidate:cand}]}).promote,false);
 assert.equal(assessPromotion({rows:[{round:r,actual:'UP',settledAt:r+301000,baseline:base,candidate:{...cand,trainedThrough:r+1}}],minimum:1}).paired,0);
 const a=assessPromotion({rows:[{round:r,actual:'UP',settledAt:r+301000,baseline:base,candidate:cand}],minimum:1});
 assert.equal(a.promote,false);assert.equal(a.reason,'REVIEW_REQUIRED_NOT_AUTO_DEPLOY');
});
test('inference journal sanitizes and persists attempt audit without token secrets',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zl-deepseek-journal-'));
 try{
  const journal=newDecisionJournal(dir),at=1800000000000;
  assert.equal(journal.append({at,round:1799999700000,attempt:1,outcome:'WAIT_LLM',
   direction:'WAIT',confidence:.5,reason:'re-evaluate',secret:'SENSITIVE_KEY',tokens:100}),true);
  const h=journal.history(5,at);
  assert.equal(h.records.length,1);
  assert.equal(h.records[0].outcome,'WAIT_LLM');
  assert.equal(JSON.stringify(h).includes('SENSITIVE_KEY'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
