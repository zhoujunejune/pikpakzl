import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWindow,marketTick,collect,decodeAnalysis,registerAnalysis,
 analysisRequest,finalize,historyPolicy,windowStatus} from './deepseek-adaptive15-core.mjs';
const round=1800000300000;
function tick(at,price,open=67000){
 const r=Math.floor(at/300000)*300000;
 return marketTick({ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{roundStartMs:r,eventMs:at,lastPrice:price,
  roundOpenPrice:open,marketFeedConnected:true}},at);
}
function ready(){
 const w=makeWindow(round);
 for(let i=0;i<120;i++)
  collect(w,tick(round-120000+i*1000,67000+i*.2,66000));
 for(let i=0;i<13;i++)
  collect(w,tick(round+i*1000,68000+i*1.2,68000));
 return w;
}
function analysis(phase,dir='UP',confidence=.75,at=round-50000){
 return decodeAnalysis(JSON.stringify({direction:dir,confidence,
  reason:'market data reviewed',risk:'basis risk'}),round,at,phase);
}
test('15s lock, corrected open, two DeepSeek analyses and strict no late direction',()=>{
 const w=ready();
 registerAnalysis(w,analysis('initial'));
 registerAnalysis(w,analysis('review','UP',.8,round-20000));
 const x=finalize(w,round+12400);
 assert.equal(x.latest.direction,'UP');
 assert.equal(x.latest.selectedAnalysis,'review');
 assert.equal(x.latest.earlySamples,13);
 assert.ok(x.generatedAt<round+15000);
 assert.equal(x.orders,false);
 assert.throws(()=>finalize(w,round+14000),/ALREADY_LOCKED/);
 assert.equal(windowStatus(w,round+16000).missed,false);
});
test('second review can reverse earlier DeepSeek opinion using real new data',()=>{
 const w=ready();
 registerAnalysis(w,analysis('initial','DOWN',.71));
 registerAnalysis(w,analysis('review','UP',.8,round-15000));
 const x=finalize(w,round+12000);
 assert.equal(x.latest.firstAnalysis,'DOWN');
 assert.equal(x.latest.reviewAnalysis,'UP');
 assert.equal(x.latest.direction,'UP');
});
test('second review WAIT skips instead of manufacturing a signal',()=>{
 const w=ready();
 registerAnalysis(w,analysis('initial','UP'));
 registerAnalysis(w,analysis('review','WAIT',.5,round-15000));
 const x=finalize(w,round+12000);
 assert.equal(x.ok,false);assert.equal(x.skip,true);
 assert.equal(x.reason,'DEEPSEEK_CHOSE_WAIT');
 assert.equal(w.final,null);
});
test('no preanalysis or low confidence can abstain without mandatory UP/DOWN',()=>{
 const w=ready();
 assert.throws(()=>finalize(w,round+12000),/MISSING_DEEPSEEK_ANALYSIS/);
 registerAnalysis(w,analysis('initial','UP',.4));
 const result=finalize(w,round+12000);
 assert.equal(result.skip,true);
 assert.equal(result.reason,'LOW_MODEL_CONFIDENCE');
});
test('officially settled poor direction increases selective threshold, never inverses direction',()=>{
 const feedback={samples:70,upSamples:35,upHistoricalAccuracy:.42,
 downSamples:35,downHistoricalAccuracy:.64};
 const policy=historyPolicy(feedback);
 assert.equal(policy.confidencePenalty.UP,.1);
 assert.equal(policy.confidencePenalty.DOWN,0);
 const w=ready();registerAnalysis(w,analysis('review','UP',.59,round-20000));
 const x=finalize(w,round+12000,feedback);
 assert.equal(x.skip,true);
 assert.equal(x.reason,'LOW_MODEL_CONFIDENCE');
});
test('old official data with too few samples cannot change decision threshold',()=>{
 const p=historyPolicy({samples:20,upSamples:8,upHistoricalAccuracy:.1});
 assert.equal(p.confidencePenalty.UP,0);
 assert.equal(p.adapted,false);
});
test('inconsistent market or stale tick and unknown future opening rejected',()=>{
 const x={ok:true,readOnly:true,symbol:'BTCUSDT',
 latest:{roundStartMs:round,eventMs:round-10000,lastPrice:67000,
  roundOpenPrice:67000,marketFeedConnected:true}};
 assert.throws(()=>marketTick(x,round),/STALE_OR_INVALID_MARKET/);
 const y=ready();y.early.at(-1).open=70000;
 registerAnalysis(y,analysis('initial'));
 assert.throws(()=>finalize(y,round+14000),/INCOHERENT_OPEN_PRICE/);
});
test('analysis sees only causal observations, prior model review and official experience',()=>{
 const w=ready();registerAnalysis(w,analysis('initial'));
 const p=analysisRequest(w,'review',round-15000,{marketAgeMs:600},
  {usable:true,samples:80,upHistoricalAccuracy:.58});
 const data=JSON.parse(p.messages[1].content);
 assert.equal(data.targetRound,round);
 assert.equal(data.phase,'review');
 assert.equal(data.priorModelAnalysis.direction,'UP');
 assert.equal(data.verifiedHistoricalExperience.samples,80);
 assert.equal(data.waitAllowed,true);
 assert.equal(data.priorTwoMinuteTicks.every(x=>x.at<round),true);
 assert.throws(()=>analysisRequest(w,'initial',round+1000),/ANALYSIS_OUTSIDE/);
});
test('new round finalization cannot pass the strict 15-second boundary',()=>{
 const w=ready();registerAnalysis(w,analysis('initial'));
 assert.throws(()=>finalize(w,round+15000),/NOT_IN_15S_LOCK_WINDOW/);
});
