import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
const start=source.indexOf('  function guardianQuoteSizeError(q) {');
const end=source.indexOf('\n  const guardianCapacityReason',start);
assert.ok(start>0&&end>start,'V2 quote helper must exist');
const classifier=vm.runInNewContext(source.slice(start,end)+'\n guardianQuoteSizeError;');
const base={ok:false,httpStatus:400,code:-9000,error:'Your order amount is too large. Please decrease it to meet the market threshold.'};
test('Binance market-capacity quote errors are separated and not retried blindly',()=>{
 assert.equal(classifier(base),'BINANCE_MARKET_MAX_AMOUNT');
 assert.equal(classifier({...base,error:'The market lacks enough liquidity for this trade. Please try a smaller amount.'}),'BINANCE_MARKET_LIQUIDITY_INSUFFICIENT');
 assert.equal(classifier({...base,error:'Your order amount is too small'}),'BINANCE_MARKET_MIN_AMOUNT');
 assert.equal(classifier({...base,error:'Unknown market threshold'}),'BINANCE_MARKET_MAX_AMOUNT');
 assert.equal(classifier({...base,error:'Unrecognized exchange rule'}),'BINANCE_MARKET_QUOTE_RULE_REJECTED');
});
test('balance, network, 5xx, non-9000 errors do not masquerade as market limits',()=>{
 for(const x of [{...base,httpStatus:500},{...base,code:-9001},{...base,network:true},
                   {...base,ok:true},{...base,error:'Please ensure your account has enough USDT.'}])
  assert.equal(classifier(x),null);
});
test('order amount stays unchanged, only one quote, failed quote never posts order',()=>{
 const section=source.slice(source.indexOf('  // GUARDIAN_QUOTE_CAPACITY_V2_BEGIN'),source.indexOf('  // GUARDIAN_QUOTE_CAPACITY_V2_END'));
 assert.ok(!section.includes('getFreshQuote('));
 assert.ok(!section.includes('amountIn='));
 assert.ok(!source.includes('for(const pct of [90n,75n])'));
 assert.ok(source.includes("p.blockReason=guardianCapacityReason||'FRESH_QUOTE_FAILED'"));
 assert.ok(source.includes("if(isAuto && !guardianCapacityReason)retryGuardianBeforePost"));
 assert.ok(source.includes("quoteAttempts:1"));
 assert.ok(source.includes('marketQuoteStatus'));
 assert.ok(source.includes("return { status: 502, body: guardianCapacityReason ?"));
});
