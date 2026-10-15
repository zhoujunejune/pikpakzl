import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {summarizeBreakout20Official,OFFICIAL_BREAKOUT20_MODEL,
  OFFICIAL_RESOLUTION_SOURCE} from './breakout20-official-accuracy.mjs';
const start=1792079100000;
const make=(offset,prediction,actual,extra={})=>({
 roundStartMs:start+300000*offset,productionModel:OFFICIAL_BREAKOUT20_MODEL,
 productionModelVersion:OFFICIAL_BREAKOUT20_MODEL,productionPrediction:prediction,
 productionGeneratedAt:start+300000*offset+7100,
 actualSource:actual?'BINANCE_PREDICTION_OFFICIAL_RESOLUTION':null,
 officialDirection:actual??null,actual:actual??null,
 resolutionEvidence:actual?'OFFICIAL_'+actual+':CONFIRMED':null,...extra
});
const canonical=r=>r.actualSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION'&&
  ['UP','DOWN'].includes(r.officialDirection)?r.officialDirection:null;
test('official accuracy follows Railway official settlement only, never spot proxy or old model',()=>{
 const rows=[
 make(0,'UP','DOWN',{spotKlineActual:'UP'}),make(1,'DOWN','DOWN'),
 make(2,'UP',null,{actual:'UP',actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE'}),
 make(3,'DOWN',null,{actual:'DOWN',actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE',resolutionEvidence:'PREDICTION_TOPIC_NOT_FOUND'}),
 make(4,'UP','UP',{productionModel:'MARKET_FUSION_FAST8_V2_PRIOR50_CURRENT50'}),
 make(5,'UP','UP',{productionGeneratedAt:start+300000*5+9000}),
 make(6,'UP','UP',{productionModelVersion:'OLD_MODEL_V0'}),
 ];
 const s=summarizeBreakout20Official(rows,{officialFromRow:canonical,retentionLimit:1000});
 assert.equal(s.source,OFFICIAL_RESOLUTION_SOURCE);
 assert.equal(s.results.rounds,4);
 assert.deepEqual(s.results.overall,{samples:2,hits:1,accuracy:0.5});
 assert.deepEqual(s.results.up,{samples:1,hits:0,accuracy:0});
 assert.deepEqual(s.results.down,{samples:1,hits:1,accuracy:1});
 assert.equal(s.results.pending,2);
 assert.deepEqual(s.results.recent20,{samples:2,hits:1,accuracy:0.5});
 assert.equal(s.recent[0].actual,null);
 assert.equal(s.recent[0].status,'PENDING');
 assert.equal(s.recent[0].pendingReason,'PREDICTION_TOPIC_NOT_FOUND');
 assert.equal(s.recent[2].resolutionEvidence,'OFFICIAL_DOWN:CONFIRMED');
});
test('zero official settlements is null accuracy, not fabricated 0% or spot result',()=>{
 const s=summarizeBreakout20Official([make(0,'UP',null,{actual:'DOWN',
    actualSource:'BINANCE_5M_KLINE_OPEN_CLOSE'})],{officialFromRow:canonical});
 assert.equal(s.results.pending,1);
 assert.deepEqual(s.results.overall,{samples:0,hits:0,accuracy:null});
});
test('official results read-only HTTP route is isolated from production signal selection',()=>{
 const s=fs.readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
 assert.match(s,/url.pathname === '\/api\/breakout20-official-accuracy'/);
 assert.match(s,/officialFromRow:officialDirectionFromRow/);
 assert.match(s,/summarizeBreakout20Official\(rounds.values\(\)/);
 assert.match(s,/return breakout20ProductionSignalPayload/);
});
