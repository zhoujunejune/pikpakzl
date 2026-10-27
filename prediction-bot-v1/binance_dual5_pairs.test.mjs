import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DUAL5_TEST='1';
const {complimentaryTokens,bestAsk,calcPair}=await import('./binance_dual5_pairs.mjs');
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
