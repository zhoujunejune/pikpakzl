import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from 'redis';
import {
 PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE,ORDER_MODE_REDIS_KEY,LEGACY_ORDER_MODE_REDIS_KEY,
 hydrateDirectionSettings,refreshDirectionSettings,setDirectionMode,directionSettingsSnapshot,
 mappedOrderSignal,closeDirectionSettingsConnection
} from './order-direction-policy.mjs';

// Only connect to the disposable Redis service explicitly provided by CI.
const testURL=process.env.FAST8_REDIS_TEST_URL;
test('Redis v3→v4 migration, restart persistence, stale-revision prevention and fail-closed', {
 skip:!testURL?'FAST8_REDIS_TEST_URL not provided':''
}, async()=>{
 const admin=createClient({url:testURL});
 process.env.SIGNAL_REDIS_URL=testURL;
 await admin.connect();
 try{
  await admin.del([ORDER_MODE_REDIS_KEY,LEGACY_ORDER_MODE_REDIS_KEY]);
  const legacy={modes:{
   [PRIMARY_SOURCE]:'FORWARD',
   [RESCUE_SOURCE]:'INVERSE',
   [LOW_CONFIDENCE_SOURCE]:'INVERSE'
  },revision:'old-rev',updatedAt:null};
  await admin.set(LEGACY_ORDER_MODE_REDIS_KEY,JSON.stringify(legacy));
  const initial=await hydrateDirectionSettings();
  assert.equal(initial.ready,true);
  assert.deepEqual(initial.modes[RESCUE_SOURCE],{UP:'INVERSE',DOWN:'INVERSE'});
  assert.deepEqual(initial.modes[PRIMARY_SOURCE],{UP:'FORWARD',DOWN:'FORWARD'});
  assert.ok(await admin.get(ORDER_MODE_REDIS_KEY));

  const before=initial.revision;
  const after=await setDirectionMode(PRIMARY_SOURCE,'UP','INVERSE',before,1791897600000);
  assert.equal(after.modes[PRIMARY_SOURCE].UP,'INVERSE');
  assert.equal(after.modes[PRIMARY_SOURCE].DOWN,'FORWARD');
  assert.equal(after.modes[RESCUE_SOURCE].UP,'INVERSE');
  assert.equal(after.effectiveAfterRound,1791897600000);
  await assert.rejects(
   setDirectionMode(PRIMARY_SOURCE,'DOWN','OFF',before,1791897600000),
   /DIRECTION_REVISION_CONFLICT/
  );
  const persisted=JSON.parse(await admin.get(ORDER_MODE_REDIS_KEY));
  assert.equal(persisted.revision,after.revision);
  assert.equal(persisted.modes[PRIMARY_SOURCE].DOWN,'FORWARD');

  // A second controller (or restarted service) observes persisted state.
  await refreshDirectionSettings();
  assert.equal(directionSettingsSnapshot().revision,after.revision);
  const off=await setDirectionMode(PRIMARY_SOURCE,'UP','OFF',after.revision,1791897900000);
  assert.equal(off.modes[PRIMARY_SOURCE].UP,'OFF');
  assert.equal(mappedOrderSignal({status:'LOCKED',round:1791898200000,
    source:PRIMARY_SOURCE,direction:'UP'}).orderSignal,null);
  assert.equal(mappedOrderSignal({status:'LOCKED',round:1791898200000,
    source:PRIMARY_SOURCE,direction:'DOWN'}).orderSignal,'DOWN');

  await admin.set(ORDER_MODE_REDIS_KEY,'{"modes":{},"revision":"corrupt"}');
  await assert.rejects(refreshDirectionSettings(),/INVALID_/);
  assert.equal(directionSettingsSnapshot().ready,false);
  await admin.del([ORDER_MODE_REDIS_KEY,LEGACY_ORDER_MODE_REDIS_KEY]);
  await assert.rejects(refreshDirectionSettings(),/DIRECTION_CONFIGURATION_MISSING/);
  assert.equal(directionSettingsSnapshot().ready,false);
 }finally{
  await closeDirectionSettingsConnection();
  await admin.del([ORDER_MODE_REDIS_KEY,LEGACY_ORDER_MODE_REDIS_KEY]);
  await admin.quit();
 }
});
