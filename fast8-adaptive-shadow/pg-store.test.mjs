import test from 'node:test';
import assert from 'node:assert/strict';
import {PgEventStore} from './pg-store.mjs';
test('database is mandatory without an injected test client',()=>{
  assert.throws(()=>new PgEventStore({connectionString:'',client:null}),/POSTGRES_CONNECTION_REQUIRED/);
});
test('immutable shadow events are committed to PostgreSQL and can be replayed after restart',async()=>{
  const entries=[],calls=[];
  const fake={on(){},async connect(){calls.push('connect')},
    async query(sql,params=[]){
      calls.push(sql.split(' ')[0]);
      if(sql.startsWith('INSERT')){entries.push(JSON.parse(params[1]));return {rows:[]};}
      if(sql.startsWith('SELECT'))return {rows:entries.map(event=>({event}))};
      return {rows:[]};
    },
    async end(){calls.push('end')}};
  const store=new PgEventStore({client:fake});
  await store.open();
  const prediction={schemaVersion:1,policy:'ZL_FAST8_ADAPTIVE_SHADOW_V1',
    type:'decision',round:1791787800000,signal:'UP'};
  await store.append(prediction);
  assert.deepEqual(await store.replay('ZL_FAST8_ADAPTIVE_SHADOW_V1'),[prediction]);
  assert.ok(calls.includes('INSERT'));
  await store.close();assert.equal(calls.at(-1),'end');
});
