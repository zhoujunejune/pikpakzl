import test from "node:test";
import assert from "node:assert/strict";
import {reviewCandidate,safetyGate,reviewedResearchSignal,SAMPLE_BREAKEVEN} from "./v7-reversal-review.mjs";
const s=(side="DOWN",r=42,vol=1.2,mom=-0.07)=>({
 strategyVersion:"V6",snapshotAt:123456,quality:"FILTERED_RESEARCH",direction:side,
 evidence:{rsi14:r,volumeRatio:vol,change3mPct:mom}});
const c=(o={})=>({decisionAt:123456,rangePosition20m:0.55,net15mPct:-0.12,
 oppositeWickRatio:0.10,...o});
test("unverified frozen context and base WAIT abstain",()=>{
 assert.equal(reviewCandidate(s(),c({decisionAt:123457})).eventTag,"INVALID_FROZEN_CONTEXT");
 assert.equal(reviewCandidate({...s(),direction:null},c()).eventTag,"BASELINE_WAIT");
});
test("avoid shorting RSI 30-35 and chasing overheated longs",()=>{
 assert.equal(reviewCandidate(s("DOWN",31),c()).eventTag,"RSI_EXHAUSTION");
 assert.equal(reviewCandidate(s("UP",68,1.2,0.06),c({net15mPct:0.12})).eventTag,"RSI_EXHAUSTION");
});
test("momentum and price-rejection screens are independent",()=>{
 assert.equal(reviewCandidate(s("DOWN",42,2.5),c()).eventTag,"IMPULSE_EXHAUSTION");
 assert.equal(reviewCandidate(s("DOWN",42,1.2,-0.17),c()).eventTag,"IMPULSE_EXHAUSTION");
 assert.equal(reviewCandidate(s(),c({oppositeWickRatio:0.50})).eventTag,"REJECTION_WICK");
 assert.equal(reviewCandidate(s(),c({rangePosition20m:0.08})).eventTag,"RANGE_EDGE");
 assert.equal(reviewCandidate(s(),c({net15mPct:0.01})).eventTag,"NO_LONGER_TREND");
});
test("pass means research candidate, never real order nor confidence estimate",()=>{
 let x=reviewCandidate(s(),c());assert.equal(x.direction,"DOWN");
 assert.equal(x.quality,"RESEARCH_CANDIDATE");assert.equal(x.realOrderPlaced,false);
 assert.equal(x.confidence,undefined);
});
test("loss-driven stop prevents repeating V6 3/9 failure",()=>{
 let h=Array.from({length:9},(_,i)=>({direction:"DOWN",proxyHit:i<3}));
 assert.equal(safetyGate(h).rate,1/3);assert.equal(safetyGate(h).allow,false);
 assert.equal(safetyGate(h.slice(0,5)).reason,"INSUFFICIENT_SAMPLES");
 assert.equal(reviewedResearchSignal(s(),c(),h).eventTag,"RESEARCH_SAFETY_STOP");
 assert.equal(SAMPLE_BREAKEVEN,5/9);
});
test("historical rate above threshold still does not establish statistical edge",()=>{
 let h=Array.from({length:10},(_,i)=>({direction:"UP",proxyHit:i<7}));
 assert.equal(safetyGate(h).allow,true);
 assert.match(safetyGate(h).reason,/NOT_VALIDATED/);
});
