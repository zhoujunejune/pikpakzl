import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
process.env.DUAL5_TEST='1';
const {complimentaryTokens,bestAsk,calcPair,exactOrderResult,validateAmounts,validFundingSource,nextScanDelayMs}=await import('./binance_dual5_pairs.mjs');
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
 assert.equal(nextScanDelayMs(start+250),700);
 assert.equal(nextScanDelayMs(start+14999),700);
 assert.equal(nextScanDelayMs(start+15000),3000);
 assert.equal(nextScanDelayMs(start+59000),3000);
 assert.equal(nextScanDelayMs(start+60000),19000);
 assert.equal(nextScanDelayMs(start+299900),180);
 assert.equal(nextScanDelayMs(start+299990),90);
});
test('accelerated scanning leaves the conservative pair-profitability gate intact',()=>{
 const p=calcPair({minReceive:w(1.8),feeAmount:w(0.01)},
  {minReceive:w(2.5),feeAmount:w(0.01)},1,1);
 assert.equal(p.feasible,false);
});

test('live dual5 attempts valid paired quotes without blocking on pair-profit estimate',()=>{
 const src=readFileSync(new URL('./binance_dual5_pairs.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/if\(raw>=1-2\*fee-MIN_EDGE\/3\.2\)/);
 assert.doesNotMatch(src,/if\(!estimate\.feasible\)/);
 assert.doesNotMatch(src,/if\(!reassess\.feasible/);
 assert.doesNotMatch(src,/INSUFFICIENT_TOP_OF_BOOK_DEPTH/);
 assert.match(src,/if\(!estimate\.ok\).*INVALID_PAIR_QUOTES/);
 assert.match(src,/if\(!reassess\.ok \|\| Number\(down\.expireAt\)/);
 assert.match(src,/if\(!config\.armed\).*return/);
 assert.match(src,/config\.lastOrderRound=round/);
 assert.match(src,/UNHEDGED_OR_UNKNOWN_STOPPED/);
 assert.match(src,/OTHER_BOT_ACTIVE_BLOCK_PAIR/);
 assert.match(src,/risk:config\.risk/);
 assert.match(src,/bookFor\(topic,pair\.up\),bookFor\(topic,pair\.down\),walletInfo\(\)/);
});

test('funding mode supports only prediction wallet MPC and exchange spot CEX',()=>{
 assert.equal(validFundingSource('MPC'),true);
 assert.equal(validFundingSource('CEX'),true);
 for(const bad of ['SPOT','FUNDING','AUTO','',null,undefined,1])
  assert.equal(validFundingSource(bad),false);
 const src=readFileSync(new URL('./binance_dual5_pairs.mjs',import.meta.url),'utf8');
 const page=readFileSync(new URL('./binance_dual5_dashboard.html',import.meta.url),'utf8');
 assert.match(src,/fundingSource:validFundingSource\(d\.fundingSource\)\?d\.fundingSource:'MPC'/);
 assert.match(src,/req\.url==='\/api\/funding'/);
 assert.match(src,/STOP_TRADING_BEFORE_FUNDING_EDIT/);
 assert.match(src,/PENDING_ORDER_PREVENTS_FUNDING_CHANGE/);
 assert.match(src,/quoteFor\(topic,pair\.up,wallet,config\.amounts\.UP,config\.fundingSource\)/);
 assert.match(src,/quoteFor\(topic,pair\.down,wallet,config\.amounts\.DOWN,config\.fundingSource\)/);
 assert.match(src,/const fundingSource=config\.fundingSource/);
 assert.match(src,/place\(wallet,topic,q1,fundingSource\)/);
 assert.match(src,/place\(wallet,topic,down,fundingSource\)/);
 assert.match(src,/quoteFor\(topic,pair\.down,wallet,orderAmounts\.DOWN,fundingSource\)/);
 assert.match(src,/fundingSource\}/);
 assert.doesNotMatch(src,/feeRateBps:topic.feeRateBps\|\|200,fundingSource:'MPC'/);
 assert.match(page,/id="fundingSource"/);
 assert.match(page,/id="fundingSave"/);
 assert.match(page,/api\/dual5-funding/);
});

test('no late buy after the opening 15 seconds and no unverified second leg',()=>{
 const src=readFileSync(new URL('./binance_dual5_pairs.mjs',import.meta.url),'utf8');
 assert.match(src,/const ENTRY_WINDOW_MS=15000,CONFIRM_WINDOW_MS=12000/);
 assert.match(src,/if\(Date\.now\(\)-round>ENTRY_WINDOW_MS\)/);
 assert.match(src,/if\(now-round>ENTRY_WINDOW_MS\)/);
 assert.match(src,/orderId:String\(id\),offset:0,limit:100/);
 assert.match(src,/String\(x\.marketTopicId\)===String\(topic\.marketTopicId\)/);
 assert.match(src,/Number\(x\?\.filledShareQty\)>0/);
 assert.match(src,/lastSeen=matches\[0\]\?\.status/);
 assert.match(src,/record\.phase='UP_ZERO_FILL_CONFIRMED'/);
 assert.match(src,/delete config\.tracked\[config\.legs\.UP\.marketTopicId/);
 assert.match(src,/DOWN_ZERO_FILL_CONFIRMED_UP_FILLED_MANUAL_REVIEW/);
 assert.match(src,/config\.legs\.UP=\{\.\.\.config\.legs\.UP,orderId:String\(up\.orderId\)/);
 assert.match(src,/if\(!u\|\|u\.shares<=0\)throw Error\('UP_FILL_UNVERIFIED_STOP_NO_SECOND'\)/);
 assert.match(src,/UNHEDGED_OR_UNKNOWN_STOPPED/);
});

test('exact Binance FAILED zero-fill is terminal and never proof of a fill',()=>{
 const topic={marketTopicId:'7586769'};
 const id='26102700001999631125';
 const match={orderId:id,marketTopicId:7586769,status:'FAILED',filledUsdtAmount:'0',filledShareQty:'0'};
 assert.deepEqual(exactOrderResult([match],id,topic),{
  orderId:id,status:'FAILED',shares:0,spent:0,terminalZeroFill:true});
 assert.equal(exactOrderResult([match],id,{marketTopicId:1111}),null);
 assert.equal(exactOrderResult([match],'another-order',topic),null);
 assert.equal(exactOrderResult([{...match,status:'PENDING'}],id,topic),null);
 assert.equal(exactOrderResult([{...match,filledUsdtAmount:'1'}],id,topic),null);
 const partial={...match,status:'FAILED',filledShareQty:'0.5',filledUsdtAmount:'0.4'};
 assert.deepEqual(exactOrderResult([partial],id,topic),{
  orderId:id,status:'FAILED',shares:0.5,spent:0.4,terminalZeroFill:false});
});
