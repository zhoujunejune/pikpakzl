import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DUAL5_TEST='1';
const {complimentaryTokens,bestAsk,calcPair,validateAmounts,nextScanDelayMs}=await import('./binance_dual5_pairs.mjs');
test('pair two actual complementary tokens in exactly the same outcome market',()=>{
 const topic={markets:[{marketId:12,title:'BTC Price 5m UP?',outcomes:[
  {name:'YES',tokenId:'UP_1'},{name:'NO',tokenId:'DOWN_1'}]}]};
 const p=complimentaryTokens(topic);
 assert.equal(p.up.tokenId,'UP_1');assert.equal(p.down.tokenId,'DOWN_1');
 assert.equal(p.up.marketId,p.down.marketId);
});
test('cannot mistake two unrelated YES markets for a complementary hedge',()=>{
 const t={markets:[{marketId:12,title:'UP',outcomes:[{name:'YES',tokenId:'12'}]},
  {marketId:13,title:'DOWN',outcomes:[{name:'YES',tokenId:'13'}]}]};
 assert.equal(complimentaryTokens(t),null);
});
test('no mapping if markets ambiguous or missing one side',()=>{
 assert.equal(complimentaryTokens({markets:[]}),null);
 assert.equal(complimentaryTokens({markets:[{marketId:3,title:'UP',outcomes:[{name:'YES',tokenId:'1'}]}]}),null);
});
test('orderbook uses cheapest available ask, not midprice',()=>{
 assert.deepEqual(bestAsk({asks:[{price:'0.53',size:'20'},{price:'0.49',size:'3'}]}),
  {price:0.49,size:3});
 assert.equal(bestAsk({asks:[]}),null);
});
const w=n=>(BigInt(Math.round(n*1e6))*10n**12n).toString();
test('paired payout bounded by smaller side and actual USDT fees',()=>{
 let p=calcPair({minReceive:w(3.6),feeAmount:w(0.02)},
  {minReceive:w(3.6),feeAmount:w(0.02)},1.6);
 assert.equal(p.ok,true);assert.equal(p.feasible,true);
 assert.ok(p.conservativeNet>0.08);
});
test('an extra cheap side never compensates mismatched shares',()=>{
 const x=calcPair({minReceive:w(1.9),feeAmount:w(.04)},
  {minReceive:w(8),feeAmount:w(.02)},1.6);
 assert.equal(x.feasible,false);
});
test('two seemingly cheap prices fail after high fees and slippage allowance',()=>{
 const x=calcPair({minReceive:w(3.23),feeAmount:w(.02)},
  {minReceive:w(3.24),feeAmount:w(.02)},1.6);
 assert.equal(x.feasible,false);
});

test('default owner selection 1 USDT on UP and 1 USDT on DOWN passes conservative net calc',()=>{
 const both=calcPair({minReceive:w(2.30),feeAmount:w(0.01)},
  {minReceive:w(2.40),feeAmount:w(0.01)},1,1);
 assert.equal(both.amountUp,1);
 assert.equal(both.amountDown,1);
 assert.equal(both.feasible,true);
 assert.equal(both.conservativeNet,0.255);
});
test('unequal 1 USDT UP and 2 USDT DOWN amounts use both spends in payout floor',()=>{
 const p=calcPair({minReceive:w(4),feeAmount:w(0.01)},
  {minReceive:w(4),feeAmount:w(0.01)},1,2);
 assert.equal(p.conservativeNet,0.955);
 assert.equal(p.amountUp,1);assert.equal(p.amountDown,2);
 const q=calcPair({minReceive:w(4),feeAmount:w(0.01)},
  {minReceive:w(4),feeAmount:w(0.01)},2,2);
 assert.equal(q.feasible,false);
});
test('matching spent dollars on different prices does not imply paired profit',()=>{
 const a=calcPair({minReceive:w(1/0.60),feeAmount:w(0.01)},
  {minReceive:w(1/0.40),feeAmount:w(0.01)},1,1);
 assert.equal(a.feasible,false);
 assert.equal(a.pairedShares<2,true);
});
test('owner can set independent integer or 2-decimal side amounts, no daily budget in amount input',()=>{
 assert.equal(validateAmounts({UP:1,DOWN:1}),true);
 assert.equal(validateAmounts({UP:1.01,DOWN:2.55}),true);
 assert.equal(validateAmounts({UP:3,DOWN:1.5}),true);
 for(const input of [{UP:0,DOWN:1},{UP:1,DOWN:NaN},{UP:1.001,DOWN:2},
                     {UP:'1',DOWN:1},{UP:1,DOWN:1001}])
  assert.equal(validateAmounts(input),false);
});

test('fast scan prioritizes the start of each 5-minute round, then backs off',()=>{
 const start=1760000000000-(1760000000000%300000);
 assert.equal(nextScanDelayMs(start+250),2000);
 assert.equal(nextScanDelayMs(start+14999),2000);
 assert.equal(nextScanDelayMs(start+15000),5000);
 assert.equal(nextScanDelayMs(start+59000),5000);
 assert.equal(nextScanDelayMs(start+60000),19000);
 assert.equal(nextScanDelayMs(start+299900),350);
});
test('accelerated scanning leaves the conservative pair-profitability gate intact',()=>{
 const p=calcPair({minReceive:w(1.8),feeAmount:w(0.01)},
  {minReceive:w(2.5),feeAmount:w(0.01)},1,1);
 assert.equal(p.feasible,false);
});
