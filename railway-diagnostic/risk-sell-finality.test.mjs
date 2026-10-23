import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySubmittedRiskSellOrder,safeToRetryUnfilledSubmitted} from './risk-sell-finality.mjs';
const id='ORDER-888';
const sell={orderId:id,side:'SELL',status:'FAILED',filledShareQty:'0.00',
  filledUsdtAmount:'0.00',fillPercentage:'0.00'};

test('known Binance orderId that FAILED and explicitly filled zero is recheck eligible',()=>{
  assert.equal(classifySubmittedRiskSellOrder(sell,id),'FAILED_EXPLICIT_ZERO');
  assert.equal(safeToRetryUnfilledSubmitted({
    historyResult:{ok:true,data:{orders:[sell]}},
    activeResult:{ok:true,data:{orders:[]}},
    orderId:id,originalShares:'12.0',currentShares:12
  }),true);
});
test('wrong orderId, wrong side, or missing 0-fill proof never auto resubmits',()=>{
  assert.equal(classifySubmittedRiskSellOrder({...sell,orderId:'OTHER'},id),'NOT_EXACT_ORDER');
  assert.equal(classifySubmittedRiskSellOrder({...sell,side:'BUY'},id),'NOT_EXACT_ORDER');
  assert.equal(classifySubmittedRiskSellOrder({orderId:id,side:'SELL',status:'FAILED'},id),'UNVERIFIED');
  for(const v of [undefined,'0.4','-1','NaN']){
   const x={...sell,filledShareQty:v};
   if(v===undefined){delete x.filledUsdtAmount;delete x.fillPercentage;}
   assert.notEqual(classifySubmittedRiskSellOrder(x,id),'FAILED_EXPLICIT_ZERO');
  }
});
test('partial execution or contradictory stale history never permits a duplicate SELL',()=>{
 for(const status of ['FAILED','REJECTED','PARTIALLY_FILLED','OPEN','CLOSED']){
  const x={...sell,status,filledShareQty:'0.01'};
  assert.notEqual(classifySubmittedRiskSellOrder(x,id),'FAILED_EXPLICIT_ZERO');
 }
 const fail={ok:true,data:{orders:[sell]}};
 const active={ok:true,data:{orders:[{...sell,status:'SUBMITTED'}]}};
 assert.equal(safeToRetryUnfilledSubmitted({historyResult:fail,activeResult:active,
   orderId:id,originalShares:12,currentShares:12}),false);
 assert.equal(safeToRetryUnfilledSubmitted({historyResult:fail,activeResult:{ok:false},
   orderId:id,originalShares:12,currentShares:12}),false);
 assert.equal(safeToRetryUnfilledSubmitted({historyResult:fail,activeResult:{ok:true,data:{orders:[]}},
   orderId:id,originalShares:12,currentShares:8}),false);
 assert.equal(safeToRetryUnfilledSubmitted({historyResult:fail,activeResult:{ok:true,data:{orders:[]}},
   orderId:'DIFFERENT',originalShares:12,currentShares:12}),false);
});
test('confirmed Binance actual FILLED distinguished from mere submission',()=>{
 assert.equal(classifySubmittedRiskSellOrder({...sell,status:'FILLED',filledShareQty:'12'},id),'FILLED');
 assert.equal(classifySubmittedRiskSellOrder({...sell,status:'CLOSED',filledShareQty:'12'},id),'FILLED');
 assert.equal(classifySubmittedRiskSellOrder({...sell,status:'SUBMITTED'},id),'PENDING');
 assert.equal(classifySubmittedRiskSellOrder({...sell,status:'CLOSED'},id),'UNVERIFIED');
});
