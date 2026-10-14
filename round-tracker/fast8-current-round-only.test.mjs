import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFast8Engine} from './fast8-engine.mjs';
import {ROUND_MS,LOCK_MS} from './fast8-model.mjs';
import {EXTERNAL_RESEARCH_VERSION} from './external-btc5m-fast8-shadow.mjs';
import {marketRoundClock,minuteOpenAligned} from '../fast-signal-engine/market-round-clock.mjs';

const R=1791800100000;
const PREV=R-ROUND_MS;
function facts(sign=1){
  return {
    regimeScore:0.6*sign, predictionMarketUpMid:sign>0?0.85:0.15,
    depthAgeMs:50,lastAggTradeAgeMs:50,
    predictionMarketMappingReliable:true,predictionMarketRoundAligned:true,
    predictionMarketRound:R,predictionMarketBookAgeMs:90,
    predictionMarketUpdateTimestampMs:R+800
  };
}
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fast8-current-only-'));
  let now=R-60000;
  const published=[];
  const engine=createFast8Engine({dir,clock:()=>now,publish:d=>published.push(d)});
  assert.equal(engine.load(),true);
  t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true})});
  return {dir,engine,published,time:value=>{now=value}};
}
function capture(f,{round=R,sourceAt=R+950,receivedAt=R+1000,at=R+1050,data=facts(1)}={}){
  f.time(at);
  return f.engine.capture({round,factsCalculatedAt:sourceAt,facts:data},receivedAt);
}
test('no previous-minute snapshot can become a new-round prediction',t=>{
  const f=fixture(t);
  assert.equal(capture(f,{round:PREV,sourceAt:R-59500,
    receivedAt:R-59450,at:R-59400,data:{...facts(-1),
      predictionMarketRound:PREV,predictionMarketUpdateTimestampMs:R-59600}}),true);
  f.time(R-500);
  assert.equal(f.engine.stats().nextRoundPreparation,null);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick();
  assert.equal(d.inputProvenance,'NO_SNAPSHOT');
  assert.equal(d.maxEventTimeMs,null);
  assert.equal(d.externalResearch.preparation,null);
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.featureCount,0);
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.fallback,true);
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.preparationUsed,false);
  assert.equal(d.preparationSampleCount,0);
  assert.ok(['UP','DOWN'].includes(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction));
  assert.equal(f.published.length,1);
});
test('fresh current-round regime alone locks without quote or prewarm',t=>{
  const f=fixture(t);
  assert.equal(capture(f),true);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick();
  const r=d.externalResearch;
  assert.equal(r.version,EXTERNAL_RESEARCH_VERSION);
  assert.equal(d.inputProvenance,'ALIGNED_CURRENT_ROUND');
  assert.equal(d.maxEventTimeMs,R+950);
  assert.equal(r.fullQuality,true);
  assert.equal(r.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
  assert.equal(r.predictions.FLOW_BOOK_PROXY_V1.featureCount,1);
  assert.equal(r.predictions.FLOW_BOOK_PROXY_V1.preWeight,0);
  assert.equal(r.preparation,null);
  assert.equal(f.published.length,1);
  f.time(R+6000);
  assert.equal(f.engine.tick().externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
});
test('missing PM quote cannot affect valid regime-only direction or quality',t=>{
  const f=fixture(t);
  const data={...facts(-1),predictionMarketRound:PREV};
  assert.equal(capture(f,{data}),true);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick(),v=d.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
  assert.equal(v.direction,'DOWN');
  assert.equal(v.featureCount,1);
  assert.equal(v.fallback,false);
  assert.equal(d.externalResearch.fullQuality,true);
  assert.ok(d.dataQuality.includes('PM_MISSING_OR_UNALIGNED'));
  assert.deepEqual(d.externalResearch.dataQuality,[]);
  assert.equal(v.preparationUsed,false);
});
test('true post-boundary data with stale upstream round LABEL remains allowed but old PM price is rejected',t=>{
  const f=fixture(t);
  const data={...facts(1),predictionMarketRound:PREV,
    predictionMarketUpdateTimestampMs:R-500,depthAgeMs:80,lastAggTradeAgeMs:60};
  assert.equal(capture(f,{round:PREV,sourceAt:R+700,receivedAt:R+750,at:R+800,data}),true);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick(),v=d.externalResearch.predictions.FLOW_BOOK_PROXY_V1;
  assert.equal(d.inputProvenance,'FRESH_SPOT_PRIOR_ROUND_METADATA');
  assert.equal(d.maxEventTimeMs,R+700);
  assert.equal(v.featureCount,1);
  assert.equal(v.direction,'UP');
  assert.equal(d.externalResearch.fullQuality,false);
  assert.equal(d.preparationUsed,false);
  assert.ok(d.dataQuality.includes('CROSS_ROUND_FRESH_SPOT_BRIDGE'));
});
test('old metadata without a truly post-boundary source is rejected',t=>{
  const f=fixture(t);
  f.time(R+1000);
  assert.equal(f.engine.capture({round:PREV,factsCalculatedAt:R-10,
    facts:{...facts(-1),predictionMarketRound:PREV}},R+900),false);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick();
  assert.equal(d.inputProvenance,'NO_SNAPSHOT');
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.fallback,true);
});
test('aligned current-round data replaces a provisional delayed-label bridge',t=>{
  const f=fixture(t);
  assert.equal(capture(f,{round:PREV,sourceAt:R+400,receivedAt:R+450,at:R+500,
    data:{...facts(-1),predictionMarketRound:PREV,depthAgeMs:70,lastAggTradeAgeMs:80}}),true);
  assert.equal(capture(f),true);
  f.time(R+LOCK_MS+10);
  const d=f.engine.tick();
  assert.equal(d.inputProvenance,'ALIGNED_CURRENT_ROUND');
  assert.equal(d.maxEventTimeMs,R+950);
  assert.equal(d.externalResearch.fullQuality,true);
  assert.equal(d.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'UP');
});
test('late shadow checkpoints compare same current-only V9 model without rewriting the live lock',t=>{
  const f=fixture(t);
  assert.equal(capture(f,{data:facts(-1)}),true);
  f.time(R+LOCK_MS+10);
  const locked=f.engine.tick();
  assert.equal(locked.externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
  f.time(R+LOCK_MS+35);
  assert.equal(f.engine.acknowledge(R,R+LOCK_MS+30),true);
  assert.equal(capture(f,{sourceAt:R+3990,receivedAt:R+4030,at:R+4100,
    data:{...facts(1),predictionMarketUpdateTimestampMs:R+3900}}),true);
  assert.equal(capture(f,{sourceAt:R+5980,receivedAt:R+6030,at:R+6100,
    data:{...facts(1),predictionMarketUpdateTimestampMs:R+5880}}),true);
  assert.equal(f.engine.tick().externalResearch.predictions.FLOW_BOOK_PROXY_V1.direction,'DOWN');
  const records=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const shadows=records.filter(x=>x.type==='checkpoint'&&x.roundStartMs===R);
  assert.deepEqual(shadows.map(x=>x.checkpointMs),[4000,6000]);
  assert.ok(shadows.every(x=>x.modelVersion===EXTERNAL_RESEARCH_VERSION));
  assert.ok(shadows.every(x=>x.productionEffect==='TIMING_SHADOW_ONLY'));
});
test('five-minute round clock still validates new boundary without prior contract open',()=>{
  const before=marketRoundClock(R-1,PREV);
  assert.equal(before.start,PREV);
  const crossed=marketRoundClock(R+200,PREV);
  assert.equal(crossed.start,R);
  assert.equal(crossed.roundOpenAligned,false);
  assert.equal(marketRoundClock(R+1200,R).roundOpenAligned,true);
  assert.equal(minuteOpenAligned(R+300,R-60000),false);
  assert.equal(minuteOpenAligned(R+300,R),true);
});
