import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostflipAccumulator,POSTFLIP_START_ROUND,POSTFLIP_STATS_VERSION,
 DIRECT_STATS_SCOPE,nextFullRound} from './postflip-official-stats.mjs';
import {BASE_MODEL,NOVICE_MODEL,RSI_INPUT_VERSION} from './production-signal-choice.mjs';

const t=POSTFLIP_START_ROUND;
test('new direct-accuracy ledger rejects pre-cutover data and reports exact version',()=>{
 const start=nextFullRound(t+90000);
 assert.equal(start,t+300000);
 const a=createPostflipAccumulator([],start);
 assert.equal(a.ingest(BASE_MODEL,t,'UP','UP',{lockedAt:t+5000}),false);
 assert.equal(a.ingest(BASE_MODEL,start,'UP','UP',{lockedAt:start+5200}),true);
 const r=a.view(BASE_MODEL);
 assert.equal(r.resetAt,start);
 assert.equal(r.statsVersion,POSTFLIP_STATS_VERSION);
 assert.equal(r.statsScope,DIRECT_STATS_SCOPE);
 assert.equal(r.signalOutputMode,'RSI14_DIRECT_V1');
 assert.equal(r.results.overall.samples,1);
 assert.equal(r.recent[0].emitted,'UP');
 assert.equal(r.recent[0].raw,'UP');
 assert.equal(r.recent[0].flipped,false);
 assert.equal(r.recent[0].inputVersion,RSI_INPUT_VERSION);
});
test('UP and DOWN are never randomized: every direct emitted direction equals RSI input',()=>{
 const a=createPostflipAccumulator();
 let hits=0;
 for(let i=0;i<200;i++){
   const raw=i%2?'DOWN':'UP',actual=i%3?'UP':'DOWN',round=t+i*300000;
   assert.equal(a.ingest(BASE_MODEL,round,raw,actual,{lockedAt:round+5300}),true);
   hits+=Number(raw===actual);
 }
 const stats=a.view(BASE_MODEL);
 assert.equal(stats.results.overall.samples,200);
 assert.equal(stats.results.overall.hits,hits);
 assert.equal(stats.results.up.samples,100);
 assert.equal(stats.results.down.samples,100);
 assert.equal(stats.results.recent20.samples,20);
 assert.equal(stats.results.recent100.samples,100);
 assert.ok(stats.recent.every(r=>r.flipped===false&&r.emitted===r.raw));
});
test('persisted storage rejects prior random-flip and wrong RSI-input versions',()=>{
 const previous={model:BASE_MODEL,round:t,raw:'UP',emitted:'DOWN',
  flipped:true,inputVersion:RSI_INPUT_VERSION,actual:'UP',eligible:true,lockedAt:t+5400};
 const mixed={...previous,raw:'DOWN',emitted:'DOWN',flipped:false,inputVersion:'MIXED_MODEL'};
 assert.equal(createPostflipAccumulator([previous,mixed]).dump().length,0);
});
test('duplicate rounds, late official settlements and restarts never double count',()=>{
 const a=createPostflipAccumulator();
 assert.equal(a.ingest(NOVICE_MODEL,t,'DOWN',null,{lockedAt:t+5100}),true);
 assert.equal(a.ingest(NOVICE_MODEL,t,'DOWN',null,{lockedAt:t+5100}),false);
 assert.equal(a.view(NOVICE_MODEL).results.pending,1);
 assert.equal(a.ingest(NOVICE_MODEL,t,'DOWN','UP',{lockedAt:t+5100}),true);
 assert.equal(a.ingest(NOVICE_MODEL,t,'DOWN','UP',{lockedAt:t+5100}),false);
 const b=createPostflipAccumulator(a.dump());
 assert.equal(b.view(NOVICE_MODEL).results.overall.samples,1);
 assert.equal(b.ingest(NOVICE_MODEL,t,'UP','UP',{lockedAt:t+5100}),false);
 assert.throws(()=>b.ingest(NOVICE_MODEL,t,'DOWN','DOWN',{lockedAt:t+5100}),/OFFICIAL_SETTLEMENT_CONFLICT/);
});
test('immutable 8-second lock and official final result required for counted hit',()=>{
 const a=createPostflipAccumulator();
 assert.equal(a.ingest(BASE_MODEL,t,'UP',null,{lockedAt:t+8000}),false);
 assert.equal(a.ingest(BASE_MODEL,t,'UP',null,{lockedAt:t+1000}),true);
 assert.equal(a.view(BASE_MODEL).results.overall.samples,0);
 assert.equal(a.view(BASE_MODEL).results.pending,1);
 assert.equal(a.view(NOVICE_MODEL).results.overall.samples,0);
 assert.equal(a.view(NOVICE_MODEL).results.overall.accuracy,null);
});
