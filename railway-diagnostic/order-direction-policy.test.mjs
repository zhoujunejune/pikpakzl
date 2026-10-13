import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inverseOrderDirection,mappedOrderSignal,pendingOrderMatchesProduction,ORDER_DIRECTION_POLICY} from './order-direction-policy.mjs';

const round=1791897600000;
const locked=(direction)=>({status:'LOCKED',round,direction});
const ready=(dir)=>{const m=mappedOrderSignal(locked(dir));return {round,
  productionSignal:m.productionSignal,orderSignal:m.orderSignal,
  signal:m.orderSignal,action:m.action,orderDirectionPolicy:m.mappingPolicy};
};

test('locked UP produces BUY_DOWN while preserving original UP',()=>{
 const m=mappedOrderSignal(locked('UP'));
 assert.deepEqual(m,{productionSignal:'UP',orderSignal:'DOWN',action:'BUY_DOWN',mappingPolicy:ORDER_DIRECTION_POLICY});
 assert.equal(inverseOrderDirection('UP'),'DOWN');
 assert.equal(pendingOrderMatchesProduction(ready('UP'),locked('UP')),true);
});
test('locked DOWN produces BUY_UP while preserving original DOWN',()=>{
 const m=mappedOrderSignal(locked('DOWN'));
 assert.deepEqual(m,{productionSignal:'DOWN',orderSignal:'UP',action:'BUY_UP',mappingPolicy:ORDER_DIRECTION_POLICY});
 assert.equal(inverseOrderDirection('DOWN'),'UP');
 assert.equal(pendingOrderMatchesProduction(ready('DOWN'),locked('DOWN')),true);
});
test('no WAIT or unknown signal is silently interpreted as an order',()=>{
 for(const direction of ['WAIT','',null,'BUY_UP','up']){
  assert.equal(inverseOrderDirection(direction),null);
  assert.equal(mappedOrderSignal(locked(direction)).orderSignal,null);
 }
 assert.equal(mappedOrderSignal({status:'WAIT',round,direction:'UP'}).orderSignal,null);
 assert.equal(mappedOrderSignal(null).orderSignal,null);
});
test('submission refuses mismatching round, original direction, token action or policy',()=>{
 const p=ready('UP');
 assert.equal(pendingOrderMatchesProduction(p,{...locked('UP'),round:round+300000}),false);
 assert.equal(pendingOrderMatchesProduction(p,locked('DOWN')),false);
 assert.equal(pendingOrderMatchesProduction({...p,signal:'UP'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,action:'BUY_UP'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderSignal:'UP'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction({...p,orderDirectionPolicy:'OLD'},locked('UP')),false);
 assert.equal(pendingOrderMatchesProduction(p,{...locked('UP'),status:'WAIT'}),false);
});
test('live prepare token mapping and auto-submit both use the same inverse policy',()=>{
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
