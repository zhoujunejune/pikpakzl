import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rsi, features, prospectiveStats,train} from './src/model.mjs';
test('indicators reject missing history and statistics exclude gaps',()=>{
 assert.equal(features([],[],100),null);
 assert.equal(rsi(Array.from({length:40},(_,i)=>100+i)),100);
 const s=prospectiveStats([{direction:'UP',actual:'UP',status:'SETTLED'},{direction:'DOWN',actual:'UP',status:'SETTLED'},{direction:null,status:'DATA_GAP'}]);
 assert.equal(s.overall.accuracy,.5);assert.equal(s.overall.samples,2);assert.equal(s.dataGaps,1);
 assert.equal(train([]).reason,'INSUFFICIENT_SETTLED_ROUNDS');
});
