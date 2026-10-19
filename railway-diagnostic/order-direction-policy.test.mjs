import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 ORDER_DIRECTION_POLICY,PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE,ORDER_SOURCES,
 ORDER_MODE_REDIS_KEY,LEGACY_ORDER_MODE_REDIS_KEY,
 applyDirectionSettings,directionSettingsSnapshot,validateDirectionModes,migrateLegacyModes,
 orderDirectionForProduction,mappedOrderSignal,pendingOrderMatchesProduction,invalidateDirectionSettings
} from './order-direction-policy.mjs';

const round=1791897600000;
const locked=(direction,source,more={})=>({status:'LOCKED',round,direction,source,...more});
const base=()=>Object.fromEntries(ORDER_SOURCES.map(s=>[s,{UP:'FORWARD',DOWN:'FORWARD'}]));
function setModes(modes={},revision='test-a',extra={}){
 const full=base();
 for(const [source,part] of Object.entries(modes))full[source]={...full[source],...part};
 return applyDirectionSettings({modes:full,revision,updatedAt:null,...extra});
}
function ready(signal){
 const m=mappedOrderSignal(signal);
 return {round:signal.round,signal:m.orderSignal,
  productionSignal:m.productionSignal,productionSource:m.productionSource,
  orderSignal:m.orderSignal,action:m.action,mappingMode:m.mappingMode,
  orderDirectionPolicy:m.mappingPolicy};
}

test('AC01-04: six independently configurable source/side cells map forward or inverse',()=>{
 for(const source of ORDER_SOURCES)for(const direction of ['UP','DOWN'])for(const mode of ['FORWARD','INVERSE']){
  setModes({[source]:{[direction]:mode}},'rev-'+source.slice(0,3)+direction+mode);
  const live=locked(direction,source),m=mappedOrderSignal(live);
  assert.equal(m.orderSignal,mode==='INVERSE'?(direction==='UP'?'DOWN':'UP'):direction);
  assert.equal(m.action,'BUY_'+m.orderSignal);
  assert.equal(m.mappingMode,mode);
  assert.equal(pendingOrderMatchesProduction(ready(live),live),true);
  for(const other of ORDER_SOURCES.filter(x=>x!==source))
   assert.equal(mappedOrderSignal(locked(direction,other)).orderSignal,direction);
  const opposite=direction==='UP'?'DOWN':'UP';
  assert.equal(mappedOrderSignal(locked(opposite,source)).orderSignal,opposite);
 }
});
test('AC05-07: OFF cancels preparation without suppressing the original LOCKED prediction',()=>{
 for(const source of ORDER_SOURCES)for(const side of ['UP','DOWN']){
  setModes({[source]:{[side]:'OFF'}});
  const m=mappedOrderSignal(locked(side,source));
  assert.equal(m.productionSignal,side);assert.equal(m.orderSignal,null);
  assert.equal(m.action,null);assert.equal(m.mappingMode,'OFF');
  assert.equal(pendingOrderMatchesProduction({...ready(locked(side,source)),signal:side},
    locked(side,source)),false);
  assert.equal(mappedOrderSignal(locked(side==='UP'?'DOWN':'UP',source)).action,
    'BUY_'+(side==='UP'?'DOWN':'UP'));
 }
});
test('AC08: migration preserves each legacy source selection for BOTH UP and DOWN',()=>{
 const legacy={[PRIMARY_SOURCE]:'INVERSE',[RESCUE_SOURCE]:'FORWARD',[LOW_CONFIDENCE_SOURCE]:'INVERSE'};
 const migrated=migrateLegacyModes(legacy);
 assert.deepEqual(migrated[PRIMARY_SOURCE],{UP:'INVERSE',DOWN:'INVERSE'});
 assert.deepEqual(migrated[RESCUE_SOURCE],{UP:'FORWARD',DOWN:'FORWARD'});
 assert.deepEqual(migrated[LOW_CONFIDENCE_SOURCE],{UP:'INVERSE',DOWN:'INVERSE'});
 assert.throws(()=>migrateLegacyModes({[PRIMARY_SOURCE]:'INVERSE'}),/INVALID_/);
 assert.equal(ORDER_MODE_REDIS_KEY,'trade-control:direction-mode:v4');
 assert.equal(LEGACY_ORDER_MODE_REDIS_KEY,'trade-control:direction-mode:v3');
});
test('AC09: pending order is invalidated when revision changes even if mapping is identical',()=>{
 setModes({},'rev1');const live=locked('UP',PRIMARY_SOURCE),p=ready(live);
 setModes({},'rev2');assert.equal(pendingOrderMatchesProduction(p,live),false);
});
test('AC09: pending order is invalidated when switch turns a side OFF or INVERSE',()=>{
 setModes({},'rev1');const live=locked('DOWN',LOW_CONFIDENCE_SOURCE),p=ready(live);
 setModes({[LOW_CONFIDENCE_SOURCE]:{DOWN:'OFF'}},'rev2');
 assert.equal(pendingOrderMatchesProduction(p,live),false);
 setModes({[LOW_CONFIDENCE_SOURCE]:{DOWN:'INVERSE'}},'rev3');
 assert.equal(mappedOrderSignal(live).orderSignal,'UP');
 assert.equal(pendingOrderMatchesProduction(p,live),false);
});
test('wrong source, wrong side, WAIT, display-only and unknown source cannot order',()=>{
 setModes({});
 const live=locked('UP',PRIMARY_SOURCE),p=ready(live);
 for(const patch of [
  {orderDirectionPolicy:'SOURCE_MODE_3WAY_V3:rev'},{productionSource:RESCUE_SOURCE},
  {signal:'DOWN'},{action:'BUY_DOWN'},{mappingMode:'INVERSE'},{round:round+300000}
 ])assert.equal(pendingOrderMatchesProduction({...p,...patch},live),false);
 for(const dir of ['WAIT',null,'','up'])assert.equal(orderDirectionForProduction(dir,PRIMARY_SOURCE),null);
 assert.equal(mappedOrderSignal({status:'WAIT',round,direction:'UP',source:PRIMARY_SOURCE}).orderSignal,null);
 assert.equal(mappedOrderSignal(locked('UP','UNKNOWN_SOURCE')).orderSignal,null);
 const displayOnly=locked('DOWN',LOW_CONFIDENCE_SOURCE,{executionEligible:false});
 assert.equal(mappedOrderSignal(displayOnly).orderSignal,null);
 assert.equal(pendingOrderMatchesProduction(ready(displayOnly),displayOnly),false);
});
test('configuration validation is strict, snapshots are immutable copies, and fail-closed is explicit',()=>{
 setModes({[PRIMARY_SOURCE]:{UP:'INVERSE'}},'good',{effectiveAfterRound:round});
 assert.equal(ORDER_DIRECTION_POLICY,'SOURCE_SIDE_3WAY_V4');
 assert.equal(directionSettingsSnapshot().effectiveAfterRound,round);
 const x=directionSettingsSnapshot();x.modes[PRIMARY_SOURCE].UP='OFF';
 assert.equal(directionSettingsSnapshot().modes[PRIMARY_SOURCE].UP,'INVERSE');
 assert.throws(()=>validateDirectionModes({[PRIMARY_SOURCE]:{UP:'FORWARD',DOWN:'FORWARD'}}),/INVALID_/);
 assert.throws(()=>validateDirectionModes({...base(),[PRIMARY_SOURCE]:{UP:'AUTO',DOWN:'FORWARD'}}),/INVALID_/);
 assert.throws(()=>validateDirectionModes({...base(),[PRIMARY_SOURCE]:{UP:'FORWARD',DOWN:'FORWARD',OTHER:'OFF'}}),/INVALID_/);
 assert.throws(()=>applyDirectionSettings({modes:base(),revision:'bad!',updatedAt:null}),/INVALID_REVISION/);
 invalidateDirectionSettings();
 assert.equal(mappedOrderSignal(locked('UP',PRIMARY_SOURCE)).orderSignal,null);
 assert.equal(directionSettingsSnapshot().ready,false);
});
test('PIN API, Redis CAS, v3 migration, dashboard controls and pre-submit refresh integrated',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 const source=fs.readFileSync(new URL('./order-direction-policy.mjs',import.meta.url),'utf8');
 assert.match(index,/setDirectionMode\(body.source,body.direction,body.mode,body.expectedRevision/);
 assert.match(index,/pinOK\(null,req\)/);
 assert.match(index,/process\.env\.ZL_OUTER_AUTH_ONLY!==['"]true['"]/);
 assert.match(shell,/\['FORWARD','INVERSE','OFF'\]\.map/);
 assert.match(index,/mapping\.mappingPolicy/);
 assert.match(index,/effectiveAfterRound/);
 assert.match(wrapper,/await refreshDirectionSettings\(\)/);
 assert.match(wrapper,/pendingOrderMatchesProduction\(p,current\)/);
 assert.match(shell,/directionModeChoices/);
 assert.match(shell,/data-dir-side/);
 assert.match(shell,/setDirectionModeFromUI/);
 assert.match(source,/db\.eval\(CAS_SCRIPT/);
 assert.match(source,/db\.set\(ORDER_MODE_REDIS_KEY,proposed,\{NX:true\}\)/);
});
