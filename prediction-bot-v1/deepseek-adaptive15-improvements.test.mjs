import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeWindow,collect,finalize,closeExpiredWindow} from './deepseek-adaptive15-core.mjs';
import {makeQualityStore} from './deepseek-adaptive15-quality-store.mjs';
import {classifyOfficialMistake,pastErrorHints} from './deepseek-adaptive15-error-attribution.mjs';
const r=1800000300000;
function q(at,price,open=68000){return {round:at>=r?r:r-300000,at,price,open};}
function base(){
 const w=makeWindow(r);
 for(let i=0;i<120;i++)collect(w,q(r-120000+i*1000,67000-i*1.1,67000));
 w.passes.push({round:r,at:r-25000,pass:'review',direction:'UP',
  confidence:.81,reason:'prior official evidence'});
 for(let i=0;i<=8;i++)collect(w,q(r+i*1000,68000-i*7,68000));
 return w;
}
test('directional confidence no longer forces WAIT at 8s with valid DeepSeek',()=>{
 const w=base(),first=finalize(w,r+8500);
 assert.equal(first.ok,true);
 assert.equal(first.latest.direction,'UP');
 assert.equal(first.generatedAt,r+8500);
 assert.equal(w.terminal,null);
 assert.equal(closeExpiredWindow(w,r+15000),false);
});
test('a model WAIT remains non-trade, can be reconsidered only before hard deadline',()=>{
 const w=base();w.passes[0].direction='WAIT';
 const early=finalize(w,r+8500);
 assert.equal(early.provisional,true);
 assert.equal(w.terminal,null);
 assert.equal(closeExpiredWindow(w,r+15000),true);
 assert.equal(w.terminal.direction,'WAIT');
 assert.equal(w.terminal.detail,'NO_VALID_DIRECTION_FROM_DEEPSEEK');
 assert.equal(finalize(w,r+16000).direction,'WAIT');
});
test('source-of-truth quality record uses only causal predictions and strict official settlement',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-audit-'));
 let now=r+14000;
 const store=makeQualityStore(path.join(dir,'quality.json'),()=>now);
 const signal={round:r,providerModel:'deepseek-flash',latest:{direction:'UP',
  lockedAt:r+10500,marketAt:r+9500,reason:'reversal',
  selectedModelConfidence:.83,reviewDirection:'UP',prewarmDirection:'DOWN',
  fromOpenBps:-3,earlyObservationCount:9}};
 const feat={oneMinute:{ready:true,ema9:100,ema21:90},fiveMinute:{ready:true,ema9:100,ema21:90}};
 try{
  assert.equal(store.record(signal,feat,{llmPasses:2}),true);
  assert.equal(store.record(signal,feat),false);
  assert.equal(store.summary().signal.predictions,1);
  assert.equal(store.summary().economics.realizedNetPnl,null);
  now=r+320000;
  assert.equal(store.settle({ok:true,settlementSource:'FAKE',
   records:[{roundStartMs:r,productionActual:'DOWN',productionSettledAt:r+320000,officialSettlementAudit:{}}]}),0);
  assert.equal(store.settle({ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
   records:[{roundStartMs:r,productionActual:'DOWN',productionSettledAt:r+320000,officialSettlementAudit:{}}]}),1);
  const sum=store.summary();
  assert.equal(sum.signal.officiallySettled,1);
  assert.equal(sum.signal.settledMisses,1);
  assert.equal(sum.economics.available,false);
  assert.ok(sum.errors.patterns.some(x=>x.tag==='POSSIBLE_MODEL_OVERCONFIDENCE'));
  assert.ok(sum.errors.patterns.some(x=>x.tag==='POSSIBLE_ANALYSIS_REVERSAL'));
  assert.equal(store.feedback(r+600000).usable,false); // low sample
  assert.equal(store.feedback(r).settled,0); // no lookahead
  const reopened=makeQualityStore(path.join(dir,'quality.json'),()=>now);
  assert.equal(reopened.summary().signal.officiallySettled,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('unknown or forged economic ledger cannot be treated as realized profit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-pnl-'));
 try{
  const file=path.join(dir,'orders.json');
  fs.writeFileSync(file,JSON.stringify({realizedNetPnl:9999999,confirmed:true}));
  const store=makeQualityStore(path.join(dir,'journal'),()=>r,file);
  assert.equal(store.summary().economics.realizedNetPnl,null);
  assert.equal(store.summary().economics.reason,'ORDER_RECORD_SOURCE_NOT_AUTHENTICATED_WITH_EXCHANGE');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('unsettled or late predictions are NOT admitted into loss-learning',()=>{
 const fake={round:r,direction:'UP',actual:'DOWN',signalAt:r+12000,settledAt:null};
 assert.equal(classifyOfficialMistake(fake).eligible,false);
 const late={...fake,settledAt:r+350000,signalAt:r+15000};
 assert.equal(classifyOfficialMistake(late).eligible,false);
 assert.equal(pastErrorHints([late],r+300000).usable,false);
});
