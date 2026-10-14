import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orderDirectionForProduction,mappedOrderSignal,pendingOrderMatchesProduction,ORDER_DIRECTION_POLICY} from './order-direction-policy.mjs';

const round=1791897600000;
const locked=(direction)=>({status:'LOCKED',round,direction});
const ready=(dir)=>{const m=mappedOrderSignal(locked(dir));return {round,
  productionSignal:m.productionSignal,orderSignal:m.orderSignal,
  signal:m.orderSignal,action:m.action,orderDirectionPolicy:m.mappingPolicy};
};

test('locked UP produces BUY_UP with the same production direction',()=>{
 const m=mappedOrderSignal(locked('UP'));
 assert.deepEqual(m,{productionSignal:'UP',orderSignal:'UP',action:'BUY_UP',mappingPolicy:ORDER_DIRECTION_POLICY});
 assert.equal(orderDirectionForProduction('UP'),'UP');
 assert.equal(pendingOrderMatchesProduction(ready('UP'),locked('UP')),true);
});
test('locked DOWN produces BUY_DOWN with the same production direction',()=>{
 const m=mappedOrderSignal(locked('DOWN'));
 assert.deepEqual(m,{productionSignal:'DOWN',orderSignal:'DOWN',action:'BUY_DOWN',mappingPolicy:ORDER_DIRECTION_POLICY});
 assert.equal(orderDirectionForProduction('DOWN'),'DOWN');
 assert.equal(pendingOrderMatchesProduction(ready('DOWN'),locked('DOWN')),true);
});
test('no WAIT or unknown signal is silently interpreted as an order',()=>{
 for(const direction of ['WAIT','',null,'BUY_UP','up']){
  assert.equal(orderDirectionForProduction(direction),null);
  assert.equal(mappedOrderSignal(locked(direction)).orderSignal,null);
 }
 assert.equal(mappedOrderSignal({status:'WAIT',round,direction:'UP'}).orderSignal,null);
 assert.equal(mappedOrderSignal(null).orderSignal,null);
});
test('submission refuses mismatching round, original direction, token action or policy',()=>{
 const p=ready('UP');
 assert.equal(pendingOrderMatchesProduction(p,{...locked('UP'),round:round+300000}),false);
 assert.equal(pendingOrderMatchesProduction(p,locked('DOWN')),false);
 assert.equal(pendingOrderMatchesProduction({...p,signal:'DOWN'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,action:'BUY_DOWN'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderSignal:'DOWN'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderDirectionPolicy:'OLD'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction(p,{...locked('UP'),status:'WAIT'}),false);
});
test('legacy reversed intent must not be submitted after returning to normal mode',()=>{
 const old={...ready('UP'),orderSignal:'DOWN',signal:'DOWN',action:'BUY_DOWN',
  orderDirectionPolicy:'INVERT_PRODUCTION_UP_DOWN_V1'};
 assert.equal(pendingOrderMatchesProduction(old,locked('UP')),false);
 assert.equal(ready('UP').orderSignal,ready('UP').productionSignal);
 assert.equal(ready('DOWN').orderSignal,ready('DOWN').productionSignal);
 assert.equal(ORDER_DIRECTION_POLICY,'FOLLOW_PRODUCTION_DIRECTION_V1');
});
test('live prepare token mapping and auto-submit both use the same normal policy',()=>{
 const index=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 assert.match(index,/prepareIntent\(\{\.\.\.signal,direction:mapping\.orderSignal\}\)/);
 assert.match(index,/action: mapping\.action/);
 assert.match(index,/!pendingOrderMatchesProduction\(p,current\)/);
 assert.match(wrapper,/!pendingOrderMatchesProduction\(p,current\)/);
 assert.match(wrapper,/text\('orderDirection',j\.orderSignal/);
 assert.match(index,/id="orderDirection"/);
 assert.match(shell,/id="activeFast8OrderDirection"/);
});
