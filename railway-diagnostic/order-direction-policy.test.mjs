import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 ORDER_DIRECTION_POLICY,PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE,ORDER_SOURCES,
 applyDirectionSettings,directionSettingsSnapshot,validateDirectionModes,
 orderDirectionForProduction,mappedOrderSignal,pendingOrderMatchesProduction
} from './order-direction-policy.mjs';

const round=1791897600000;
const locked=(direction,source)=>({status:'LOCKED',round,direction,source});
function setModes(modes,revision='test-a'){
 return applyDirectionSettings({modes:{
  [PRIMARY_SOURCE]:'FORWARD',[RESCUE_SOURCE]:'FORWARD',
  [LOW_CONFIDENCE_SOURCE]:'FORWARD',...modes},revision,updatedAt:null});
}
function ready(signal){
 const m=mappedOrderSignal(signal);
 return {round:signal.round,signal:m.orderSignal,
  productionSignal:m.productionSignal,productionSource:m.productionSource,
  orderSignal:m.orderSignal,action:m.action,mappingMode:m.mappingMode,
  orderDirectionPolicy:m.mappingPolicy};
}
test('all three default to forward UP/DOWN',()=>{
 setModes({});
 for(const source of ORDER_SOURCES)for(const direction of ['UP','DOWN']){
  const live=locked(direction,source),m=mappedOrderSignal(live);
  assert.equal(m.orderSignal,direction);
  assert.equal(m.mappingMode,'FORWARD');
  assert.equal(pendingOrderMatchesProduction(ready(live),live),true);
 }
});
test('each independent reverse toggle is respected for UP/DOWN',()=>{
 for(let i=0;i<ORDER_SOURCES.length;i++){
  const source=ORDER_SOURCES[i];
  setModes({[source]:'INVERSE'},'test-'+i);
  for(const direction of ['UP','DOWN']){
   const live=locked(direction,source),m=mappedOrderSignal(live);
   assert.equal(m.orderSignal,direction==='UP'?'DOWN':'UP');
   assert.equal(m.mappingMode,'INVERSE');
   assert.equal(pendingOrderMatchesProduction(ready(live),live),true);
  }
  for(const other of ORDER_SOURCES.filter(x=>x!==source)){
   assert.equal(mappedOrderSignal(locked('UP',other)).orderSignal,'UP');
  }
 }
});
test('pending quote invalidated after switch even if same side',()=>{
 setModes({},'rev1');
 const live=locked('UP',PRIMARY_SOURCE),pending=ready(live);
 setModes({},'rev2');
 assert.equal(pendingOrderMatchesProduction(pending,live),false);
});
test('pending quote invalidated when inverse replaces forward',()=>{
 setModes({},'rev1');
 const live=locked('DOWN',LOW_CONFIDENCE_SOURCE),pending=ready(live);
 setModes({[LOW_CONFIDENCE_SOURCE]:'INVERSE'},'rev2');
 assert.equal(mappedOrderSignal(live).orderSignal,'UP');
 assert.equal(pendingOrderMatchesProduction(pending,live),false);
});
test('historical policy and mismatched source/order rejected',()=>{
 setModes({},'rev3');
 const live=locked('UP',PRIMARY_SOURCE),pending=ready(live);
 for(const patch of [
  {orderDirectionPolicy:'SOURCE_AWARE_SELECTIVE8_V1'},
  {orderDirectionPolicy:'FORWARD_ONLY_SELECTIVE8_V2'},
  {productionSource:RESCUE_SOURCE},{signal:'DOWN'},
  {action:'BUY_DOWN'},{mappingMode:'INVERSE'},{round:round+300000}
 ])assert.equal(pendingOrderMatchesProduction({...pending,...patch},live),false);
});
test('invalid source, mode and WAIT do not create orders',()=>{
 setModes({});
 for(const direction of ['WAIT',null,'','up'])assert.equal(orderDirectionForProduction(direction,PRIMARY_SOURCE),null);
 assert.equal(mappedOrderSignal({status:'WAIT',round,direction:'UP',source:PRIMARY_SOURCE}).orderSignal,null);
 assert.throws(()=>validateDirectionModes({[PRIMARY_SOURCE]:'INVERSE'}));
 assert.throws(()=>validateDirectionModes({[PRIMARY_SOURCE]:'FORWARD',[RESCUE_SOURCE]:'FORWARD',[LOW_CONFIDENCE_SOURCE]:'AUTO'}));
 assert.equal(ORDER_DIRECTION_POLICY,'SOURCE_MODE_3WAY_V3');
});
test('PIN API, runtime checks, dashboard controls and Redis persistence integrated',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 const source=fs.readFileSync(new URL('./order-direction-policy.mjs',import.meta.url),'utf8');
 assert.match(index,/setDirectionMode\(body.source,body.mode\)/);
 assert.match(index,/pinOK\(body.pin\)/);
 assert.match(index,/mapping\.mappingPolicy/);
 assert.match(wrapper,/p.orderDirectionPolicy !== directionSettingsSnapshot\(\).policy/);
 assert.match(wrapper,/pendingOrderMatchesProduction\(p,current\)/);
 assert.match(shell,/directionModeChoices/);
 assert.match(shell,/setDirectionModeFromUI/);
 assert.match(source,/db.set\(ORDER_MODE_REDIS_KEY/);
 assert.equal(directionSettingsSnapshot().ready,true);
});
