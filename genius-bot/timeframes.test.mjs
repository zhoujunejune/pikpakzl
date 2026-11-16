import test from 'node:test';
import assert from 'node:assert/strict';
import {TIMEFRAMES,summarizeTimeframe,higherTimeframesComplete} from './timeframes.mjs';
const NOW=Date.parse('2026-11-11T11:37:00Z');
function candles(ms,n=121,step=1){
  const end=Math.floor(NOW/ms)*ms;
  return Array.from({length:n},(_,i)=>{
    const close=10000+i*step;
    const at=end-(n-i-1)*ms;
    return [at,String(close-0.25),String(close+10),String(close-10),String(close),'500',at+ms-1];
  });
}
test('high timeframes cover medium and long contexts and reject stale inputs',()=>{
  const frames={};
  for(const [interval,{ms}] of Object.entries(TIMEFRAMES)){
    const m=summarizeTimeframe(candles(ms),interval,NOW);
    frames[interval]=m;
    assert.equal(m.interval,interval);
    assert.equal(m.bias,'UP');
    assert.ok(m.ema9>m.ema21&&m.ema21>m.ema55);
    assert.ok(m.atrPct14>0);
    assert.equal(m.bars,120);
    assert.ok(m.lastClosedAt<=NOW);
    const old=candles(ms).map(x=>[x[0]-ms*5,...x.slice(1)]);
    assert.throws(()=>summarizeTimeframe(old,interval,NOW),/STALE_/);
    const gap=candles(ms);gap[20]=[gap[20][0]-ms,...gap[20].slice(1)];
    assert.throws(()=>summarizeTimeframe(gap,interval,NOW),/INVALID_/);
  }
  assert.equal(higherTimeframesComplete(frames),true);
  delete frames['1d'];
  assert.equal(higherTimeframesComplete(frames),false);
});
test('incomplete, unclosed or invalid candles must not fabricate long-term context',()=>{
 const ms=TIMEFRAMES['4h'].ms;
 assert.throws(()=>summarizeTimeframe(candles(ms,20),'4h',NOW),/INSUFFICIENT/);
 assert.throws(()=>summarizeTimeframe([], '2h', NOW),/UNSUPPORTED/);
 const invalid=candles(ms);invalid[75][4]='not-a-price';
 assert.throws(()=>summarizeTimeframe(invalid,'4h',NOW),/INVALID_/);
});
