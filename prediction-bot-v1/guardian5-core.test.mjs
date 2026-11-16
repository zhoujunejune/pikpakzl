import test from 'node:test';
import assert from 'node:assert/strict';
import {roundOf,safeCandidate,parseAI,wilsonLower,evaluateQuote,exitPolicy} from './guardian5-core.mjs';
const round=roundOf(Date.now()),now=round+65000;
function feed(){return {round,observedAt:now-1000,roundOpenPrice:100,lastPrice:100.15,fromOpenPct:0.15,
 dataQuality:{indicatorsReady:true},oneMinute:{atrPct:0.12,rsi14:55,momentum1Pct:0.03,momentum5Pct:0.06},
 fiveMinute:{rsi14:52}}}
test('dynamic candidate uses observed causal data',()=>{const c=safeCandidate(feed(),now);assert.equal(c.direction,'UP');assert(c.strength>0)});
test('stale data fails closed',()=>{const f=feed();f.observedAt=now-16000;assert.equal(safeCandidate(f,now).direction,'WAIT')});
test('cannot enter near settlement',()=>{const f=feed();f.observedAt=round+289000;assert.equal(safeCandidate(f,round+290000).direction,'WAIT')});
test('momentum disagreement gives WAIT',()=>{const f=feed();f.oneMinute.momentum1Pct=-0.02;assert.equal(safeCandidate(f,now).direction,'WAIT')});
test('parse AI rejects invalid output, never treats confidence as win-rate',()=>{assert.equal(parseAI('{"direction":"WAIT","confidence":0.5}').direction,'WAIT');assert.throws(()=>parseAI('{"direction":"BUY"}'));});
test('Wilson lower bound is conservative and sample dependent',()=>{assert(wilsonLower(240,300)<.8);assert.equal(wilsonLower(0,0),null)});
test('no order unless official price, calibrated forward sample and executable quote',()=>{
 const good={probability:.87,quote:{costPerWinningShare:.70},fees:.01,slippage:.01,
 calibration:{samples:400,wilsonLower:.73},remainingMs:100000,hasOfficialFeed:true};
 assert.equal(evaluateQuote(good).eligible,true);
 assert.equal(evaluateQuote({...good,quote:null}).eligible,false);
 assert.equal(evaluateQuote({...good,hasOfficialFeed:false}).eligible,false);
 assert.equal(evaluateQuote({...good,calibration:{samples:20,wilsonLower:.9}}).eligible,false);
 assert.equal(evaluateQuote({...good,probability:.75}).eligible,false);
});
test('net exit quote required; stop-loss and trailing profit evaluated only after real quote',()=>{
 assert.equal(exitPolicy({entryCost:1,currentNetSell:0.89,remainingMs:70000}).action,'SELL');
 assert.equal(exitPolicy({entryCost:1,currentNetSell:1.07,peakNetSell:1.12,remainingMs:70000}).reason,'TRAILING_TAKE_PROFIT');
 assert.equal(exitPolicy({entryCost:1,currentNetSell:null,remainingMs:70000}).action,'WAIT');
});
