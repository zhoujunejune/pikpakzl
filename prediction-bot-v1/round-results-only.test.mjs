import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRoundResultsJournal} from './round-results-only-journal.mjs';
import {buildFastSignal,createFastProductionProvider} from './deepseek-single5-production.mjs';
const R=1792626900000;
const mk=()=>fs.mkdtempSync(path.join(os.tmpdir(),'zl-round-results-'));
const official=(round,actual)=>({ok:true,settlementSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
 records:[{roundStartMs:round,productionActual:actual,productionSettledAt:round+302000,
 officialSettlementAudit:{resolved:true}}]});
const sig=(round,dir,at=round+2100,method='DEEPSEEK_SINGLE_CALL_5S')=>
 buildFastSignal({round,at,tick:{round,at:round+1000,open:100,price:100.2},
 decision:{direction:dir,reason:'live current round only',method},providerModel:'deepseek-flash'});

test('persist timestamp, latency, direction and official win after restart without learner',()=>{
 const dir=mk(),file=path.join(dir,'rounds.ndjson');let now=R+300500;
 try{
  let a=createRoundResultsJournal({file,clock:()=>now});
  assert.equal(a.recordSignal(sig(R,'DOWN')),true);
  assert.equal(a.recordSignal(sig(R,'DOWN')),false);
  assert.equal(a.settle(official(R,'DOWN')),1);
  const s=a.history().summary;
  assert.equal(s.rounds,1);assert.equal(s.wins,1);assert.equal(s.losses,0);
  assert.equal(s.accuracy,100);
  a=createRoundResultsJournal({file,clock:()=>now});
  const row=a.history().records[0];
  assert.equal(row.lockedAt,R+2100);assert.equal(row.latencyMs,2100);
  assert.equal(row.actual,'DOWN');assert.equal(row.hit,true);
  assert.equal(a.history().usedForAnalysis,false);
  assert.equal(a.settle(official(R,'DOWN')),0);
  assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('ignore unverified, premature or mismatched official settlements',()=>{
 const dir=mk(),file=path.join(dir,'results.ndjson');let now=R+300900;
 try{
  const a=createRoundResultsJournal({file,clock:()=>now});
  a.recordSignal(sig(R,'UP'));
  assert.throws(()=>a.settle({...official(R,'UP'),settlementSource:'OTHER_SOURCE'}));
  assert.equal(a.settle({...official(R,'UP'),records:[{roundStartMs:R,productionActual:'UP',settledAt:R+301000}]}),0);
  assert.equal(a.settle(official(R+300000,'DOWN')),0);
  assert.equal(a.history().summary.pending,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('no-signal and unobserved rounds are visible, never counted as losses',()=>{
 const dir=mk(),file=path.join(dir,'results.ndjson');let now=R+6500;
 try{
  const a=createRoundResultsJournal({file,clock:()=>now});
  assert.equal(a.finishRound(R,{observed:true}),true);
  assert.equal(a.finishRound(R+300000,{observed:false}),false);
  now=R+610000;
  assert.equal(a.finishRound(R+300000,{observed:false}),true);
  assert.equal(a.history().summary.noSignal,1);
  assert.equal(a.history().summary.notObserved,1);
  assert.equal(a.history().summary.settled,0);
  assert.equal(a.history().summary.accuracy,null);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('provider keeps exactly one model call; journal is display-only and supports API response',async()=>{
 const dir=mk(),file=path.join(dir,'signal.json');let now=R+700;let calls=0,officialCalls=0;
 const fetcher=async url=>{
  if(url==='http://unit/feed')return {ok:true,json:async()=>({ok:true,readOnly:true,symbol:'BTCUSDT',
   latest:{roundStartMs:R,eventMs:now,lastPrice:100.4,roundOpenPrice:100,marketFeedConnected:true}})};
  if(url==='http://unit/ai'){calls++;return {ok:true,json:async()=>({choices:[{message:{content:'{"direction":"UP"}'}}]})};}
  if(url==='http://unit/official'){officialCalls++;return {ok:true,json:async()=>official(R,'DOWN')};}
  throw Error('UNEXPECTED_URL');
 };
 try{
  const p=createFastProductionProvider({env:{LLM_STATE_FILE:file,DEEPSEEK_API_KEY:'test',
   ADAPTIVE15_MARKET_URL:'http://unit/feed',DEEPSEEK_API_URL:'http://unit/ai',
   DEEPSEEK_OFFICIAL_STATS_URL:'http://unit/official'},clock:()=>now,fetcher});
  await p.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(officialCalls,0);
  assert.equal(p.status().maxCallsPerRound,1);
  assert.equal(p.status().learningDisabled,true);
  assert.equal(p.status().statisticsDisabled,true);
  assert.equal(p.roundResults().records[0].direction,'UP');
  now=R+305000;
  await p.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(officialCalls,1);
  assert.equal(p.roundResults().records.find(x=>x.round===R).hit,false);
  assert.equal(p.roundResults().summary.losses,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
