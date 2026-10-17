import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostflipAccumulator,POSTFLIP_START_ROUND,POSTFLIP_STATS_VERSION} from './postflip-official-stats.mjs';
import {BASE_MODEL,NOVICE_MODEL} from './production-signal-choice.mjs';
import {applyRandomSignalFlip} from './signal-random-flip.mjs';

const t=POSTFLIP_START_ROUND;
const sample=(model,round,raw='UP',actual=null)=>({model,round,raw,actual,
 lockedAt:round+5200,eligible:true});
test('new ledger starts at first complete post-deploy round; old historical rows stay out',()=>{
 const a=createPostflipAccumulator();
 assert.equal(a.ingest(BASE_MODEL,t-300000,'UP','UP',{lockedAt:t-300000+5100}),false);
 assert.equal(a.ingest(BASE_MODEL,t,'UP','UP',{lockedAt:t+5200}),true);
 const r=a.view(BASE_MODEL);
 assert.equal(r.resetAt,t);
 assert.equal(r.statsVersion,POSTFLIP_STATS_VERSION);
 assert.equal(r.results.overall.samples,1);
 assert.equal(r.recent.length,1);
});
test('recomputes official accuracy from emitted direction, not raw or order inverse',()=>{
 const a=createPostflipAccumulator();
 let hit=0;
 for(let i=0;i<200;i++){
  const raw=i%2?'DOWN':'UP',actual=raw,round=t+i*300000;
  assert.equal(a.ingest(BASE_MODEL,round,raw,actual,{lockedAt:round+5200}),true);
  const emitted=applyRandomSignalFlip({status:'LOCKED',round,direction:raw},BASE_MODEL).direction;
  hit+=Number(emitted===actual);
 }
 const stats=a.view(BASE_MODEL);
 assert.equal(stats.results.overall.samples,200);
 assert.equal(stats.results.overall.hits,hit);
 assert.equal(stats.results.up.samples+stats.results.down.samples,200);
 assert.equal(stats.results.recent20.samples,20);
 assert.equal(stats.results.recent100.samples,100);
 assert.equal(stats.recent[0].raw,'DOWN');
});
test('duplicate rounds, late final resolution and restarts cannot double count',()=>{
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
test('8-second immutable lock is a strict requirement; unseen or missing official results never count as hits',()=>{
 const a=createPostflipAccumulator();
 assert.equal(a.ingest(BASE_MODEL,t,'UP',null,{lockedAt:t+8000}),false);
 assert.equal(a.ingest(BASE_MODEL,t,'UP',null,{lockedAt:t+1000}),true);
 assert.equal(a.view(BASE_MODEL).results.overall.samples,0);
 assert.equal(a.view(BASE_MODEL).results.pending,1);
 assert.equal(a.view(NOVICE_MODEL).results.overall.samples,0);
 assert.equal(a.view(NOVICE_MODEL).results.overall.accuracy,null);
});
