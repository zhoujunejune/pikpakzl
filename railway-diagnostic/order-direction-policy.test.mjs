import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyDirectionMode,orderDirectionForProduction,mappedOrderSignal,pendingOrderMatchesProduction,
  ORDER_DIRECTION_POLICY,LOW_CONFIDENCE_SOURCE,PRIMARY_SOURCE,RESCUE_SOURCE}
  from './order-direction-policy.mjs';

const round=1791897600000;
const locked=(direction,source)=>({status:'LOCKED',round,direction,source});
const ready=(direction,source)=>{
  const m=mappedOrderSignal(locked(direction,source));
  return {round,signal:m.orderSignal,productionSignal:m.productionSignal,
    productionSource:m.productionSource,orderSignal:m.orderSignal,
    action:m.action,mappingMode:m.mappingMode,orderDirectionPolicy:m.mappingPolicy};
};
for(const source of [PRIMARY_SOURCE,RESCUE_SOURCE]){
 for(const dir of ['UP','DOWN']){
  test(source+' / '+dir+' uses forward order direction',()=>{
    const m=mappedOrderSignal(locked(dir,source));
    assert.equal(m.orderSignal,dir);
    assert.equal(m.action,'BUY_'+dir);
    assert.equal(m.mappingMode,'FORWARD');
    assert.equal(m.productionSource,source);
    assert.equal(pendingOrderMatchesProduction(ready(dir,source),locked(dir,source)),true);
  });
 }
}
for(const dir of ['UP','DOWN']){
 test('low-confidence '+dir+' uses forward direction; reverse trading suspended',()=>{
   const m=mappedOrderSignal(locked(dir,LOW_CONFIDENCE_SOURCE));
   assert.equal(m.orderSignal,dir);
   assert.equal(m.action,'BUY_'+dir);
   assert.equal(m.mappingMode,'FORWARD');
   assert.equal(pendingOrderMatchesProduction(ready(dir,LOW_CONFIDENCE_SOURCE),
      locked(dir,LOW_CONFIDENCE_SOURCE)),true);
 });
}
test('no WAIT or invalid direction can become an order',()=>{
 for(const direction of ['WAIT','',null,'BUY_UP','up']){
   assert.equal(orderDirectionForProduction(direction,LOW_CONFIDENCE_SOURCE),null);
   assert.equal(mappedOrderSignal(locked(direction,LOW_CONFIDENCE_SOURCE)).orderSignal,null);
 }
 assert.equal(mappedOrderSignal({status:'WAIT',round,direction:'UP',source:PRIMARY_SOURCE}).orderSignal,null);
 assert.equal(mappedOrderSignal(null).orderSignal,null);
});
test('quote token is bound to round, source, original direction, action and policy',()=>{
 const p=ready('UP',PRIMARY_SOURCE),l=locked('UP',PRIMARY_SOURCE);
 assert.equal(pendingOrderMatchesProduction(p,{...l,round:round+300000}),false);
 assert.equal(pendingOrderMatchesProduction(p,locked('DOWN',PRIMARY_SOURCE)),false);
 assert.equal(pendingOrderMatchesProduction(p,locked('UP',RESCUE_SOURCE)),false);
 assert.equal(pendingOrderMatchesProduction({...p,productionSource:LOW_CONFIDENCE_SOURCE},l),false);
 assert.equal(pendingOrderMatchesProduction({...p,action:'BUY_DOWN'},l),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderSignal:'DOWN'},l),false);
 assert.equal(pendingOrderMatchesProduction({...p,mappingMode:'INVERSE'},l),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderDirectionPolicy:'OLD'},l),false);
 assert.equal(pendingOrderMatchesProduction(p,{...l,status:'WAIT'}),false);
});
test('old global-inverse pending tokens cannot be confirmed under new source-aware policy',()=>{
 const old={...ready('UP',PRIMARY_SOURCE),signal:'DOWN',orderSignal:'DOWN',
  action:'BUY_DOWN',mappingMode:'INVERSE',orderDirectionPolicy:'INVERT_PRODUCTION_UP_DOWN_V2'};
 assert.equal(pendingOrderMatchesProduction(old,locked('UP',PRIMARY_SOURCE)),false);
 assert.equal(ORDER_DIRECTION_POLICY,'SOURCE_SWITCH_SELECTIVE8_V3');
});
test('unknown sources default to forward direction',()=>{
 assert.equal(mappedOrderSignal(locked('UP','OTHER_LOCKED_SOURCE')).orderSignal,'UP');
});
test('both prepare and confirm use mapping and source-aware policy; UI presents mode',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 assert.match(index,/prepareIntent\(\{\.\.\.signal,direction:mapping\.orderSignal\}\)/);
 assert.match(index,/action: mapping\.action/);
 assert.match(index,/productionSource: mapping\.productionSource/);
 assert.match(index,/mappingMode: mapping\.mappingMode/);
 assert.match(index,/!pendingOrderMatchesProduction\(p,current\)/);
 assert.match(wrapper,/!pendingOrderMatchesProduction\(p,current\)/);
 assert.match(index,/id="orderDirection"/);
 assert.match(shell,/id="activeFast8OrderDirection"/);
});

test('old low-confidence inverse pending token is rejected after forward-only switch',()=>{
 const live=locked('UP',LOW_CONFIDENCE_SOURCE);
 const stale={...ready('UP',LOW_CONFIDENCE_SOURCE), signal:'DOWN',orderSignal:'DOWN',
  action:'BUY_DOWN',mappingMode:'INVERSE',orderDirectionPolicy:'SOURCE_AWARE_SELECTIVE8_V1'};
 assert.equal(pendingOrderMatchesProduction(stale,live),false);
 assert.equal(mappedOrderSignal(live).orderSignal,'UP');
 assert.equal(mappedOrderSignal(live).mappingMode,'FORWARD');
});

for(const source of [PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE]){
 for(const direction of ['UP','DOWN']){
  test(source+' can independently map '+direction+' forward or inverse',()=>{
   assert.equal(applyDirectionMode(direction,'FORWARD'),direction);
   assert.equal(applyDirectionMode(direction,'INVERSE'),direction==='UP'?'DOWN':'UP');
   assert.equal(applyDirectionMode(direction,'WAIT'),null);
  });
 }
}
test('PIN-protected Redis switch, revision invalidation, and frontend selectors are wired',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const storage=fs.readFileSync(new URL('./order-direction-config.mjs',import.meta.url),'utf8');
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 assert.match(index,/POST' && url.pathname === '\/api\/order-direction-config'/);
 assert.match(index,/pinOK\(body.pin\)/);
 assert.match(index,/mapping.mappingPolicy !== activeOrderDirectionPolicy\(\)/);
 assert.match(index,/directionPolicyWriteInFlight/);
 assert.match(index,/pendingAction=null; \/\/ Invalidate all earlier/);
 assert.match(wrapper,/directionPolicyWriteInFlight/);
 assert.match(storage,/await db.set\(DIRECTION_REDIS_KEY/);
 assert.match(storage,/revision:current.revision\+1/);
 assert.match(shell,/id="directionModeControls"/);
 assert.match(shell,/data-direction-source/);
 assert.match(shell,/cfg.policyVersion/);
});
test('an earlier pending order with another direction policy revision is rejected',()=>{
 const p=ready('UP',PRIMARY_SOURCE);
 assert.equal(pendingOrderMatchesProduction({...p,orderDirectionPolicy:p.orderDirectionPolicy+':old'},
   locked('UP',PRIMARY_SOURCE)),false);
});
