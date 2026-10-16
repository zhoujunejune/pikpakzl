import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rsi, features, prospectiveStats, train, baseline, probability} from './src/model.mjs';
test('indicators reject missing history and statistics exclude gaps',()=>{
 assert.equal(features([],[],100),null);
 assert.equal(rsi(Array.from({length:40},(_,i)=>100+i)),100);
 const s=prospectiveStats([{direction:'UP',actual:'UP',status:'SETTLED'},{direction:'DOWN',actual:'UP',status:'SETTLED'},{direction:null,status:'DATA_GAP'}]);
 assert.equal(s.overall.accuracy,.5);assert.equal(s.overall.samples,2);assert.equal(s.dataGaps,1);
 assert.equal(train([]).reason,'INSUFFICIENT_SETTLED_ROUNDS');
});

test('the BASELINE scoring weights remain unchanged',()=>{
  const x=[0.4,-0.25,0.15,0.6,-0.2,0.35,0,0,0,0];
  const fixed=[0,.27,.32,.27,.35,.18,.25,0,0,0,0];
  assert.ok(Math.abs(baseline(x)-probability(fixed,x))<1e-12);
});
test('Cloudflare production uses only BASELINE and never trains or promotes',()=>{
  const source=readFileSync(new URL('./src/index.mjs',import.meta.url),'utf8');
  assert.match(source,/const FIXED_MODEL='BASELINE'/);
  assert.match(source,/const p=f\\?baseline\\(f\\.vector\\):null/);
  assert.match(source,/s\\.weights=null/);
  assert.match(source,/trainingEnabled:false/);
  assert.match(source,/model:FIXED_MODEL/);
  assert.doesNotMatch(source,/\\btrain\\s*\\(/);
  assert.doesNotMatch(source,/\\bprobability\\s*\\(/);
  assert.doesNotMatch(source,/out\\.adopted/);
});
