import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS,validateSettings,parseDecision,parsePortfolioPlan,
  makeMarket,newState,normalizePaperPositions,paperOpen,paperMark,paperFloatingPnL,
  ENGINE_VERSION,MAX_PAPER_POSITIONS} from './engine.mjs';
const NOW=Date.parse('2026-11-11T12:02:20Z');
function candles(ms,n,step){
 const end=Math.floor(NOW/ms)*ms;
 return Array.from({length:n},(_,i)=>({startMs:end-(n-i)*ms,
  close:50000+i*step,high:50030+i*step,low:49970+i*step,volume:100+i}));
}
function market(symbol='BTCUSDT',price=50100){return makeMarket({
 symbol,markPrice:price,markTime:NOW-1000,oneMin:candles(60000,60,2),
 fiveMin:candles(300000,50,6),now:NOW});}
const answer=(action='LONG',symbol='BTCUSDT')=>({
 action,symbol,confidence:.8,horizon:'MEDIUM',
 reason:'根据多个周期的行情趋势判断模拟交易方向并持续研究持仓'});
test('paper-only, three positions maximum, exact settings schema',()=>{
 assert.equal(ENGINE_VERSION,'HAIPAI_GENIUS_PAPER_V144_MULTIPOSITION');
 assert.equal(MAX_PAPER_POSITIONS,3);
 assert.equal(DEFAULT_SETTINGS.enabled,false);
 assert.equal(validateSettings({...DEFAULT_SETTINGS}).leverage,2);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,leverage:125}),/INVALID_leverage/);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,stopLossPct:0.2}),/INVALID_SETTINGS_FIELDS/);
});
test('AI portfolio result validates each symbol and no duplicate',()=>{
 const plan=parsePortfolioPlan({decisions:[answer('HOLD','BTCUSDT'),answer('SHORT','ETHUSDT')]});
 assert.equal(plan.length,2);assert.equal(plan[0].horizon,'MEDIUM');
 assert.throws(()=>parsePortfolioPlan({decisions:[answer(),answer()]}),/AI_DUPLICATE/);
 assert.throws(()=>parsePortfolioPlan({decisions:[{...answer(),symbol:'DOGEUSDT'}]}),/INVALID_AI_SYMBOL/);
 assert.throws(()=>parsePortfolioPlan({decisions:[answer('BUY')]}),/INVALID_AI_DIRECTION/);
 assert.throws(()=>parseDecision({...answer(),horizon:'FOREVER'}),/INVALID_AI_HORIZON/);
});
test('fresh price checks and valid candles',()=>{
 assert.equal(market().trend1m,'UP');
 assert.throws(()=>makeMarket({symbol:'BTCUSDT',markPrice:50100,markTime:NOW-7000,
 oneMin:candles(60000,60,2),fiveMin:candles(300000,50,6),now:NOW}),/STALE_MARK_PRICE/);
});
test('three different coins can be held simultaneously, without duplicate per coin',()=>{
 const s=newState();s.settings.enabled=true;
 assert.equal(paperOpen(s,market(),answer(),NOW).ok,true);
 assert.equal(paperOpen(s,market(),answer(),NOW+1000).reason,'SYMBOL_ALREADY_HELD');
 assert.equal(paperOpen(s,market('ETHUSDT',3400),answer('SHORT','ETHUSDT'),NOW).ok,true);
 assert.equal(paperOpen(s,market('SOLUSDT',210),answer('LONG','SOLUSDT'),NOW).ok,true);
 assert.deepEqual(s.positions.map(p=>p.symbol),['BTCUSDT','ETHUSDT','SOLUSDT']);
 assert.equal(s.positions.length,3);
 assert.equal(paperOpen(s,market(),answer(),NOW).reason,'MAX_THREE_PAPER_POSITIONS');
 assert.equal(s.positions.some(p=>'stop' in p||'takeProfit' in p),false);
});
test('closing one simulated position does not mutate other positions or history',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market(),answer(),NOW);
 paperOpen(s,market('ETHUSDT',3400),answer('SHORT','ETHUSDT'),NOW);
 const otherId=s.positions[1].id;
 assert.equal(paperMark(s,market('BTCUSDT',45000),NOW).ok,false);
 assert.equal(paperMark(s,market('BTCUSDT',56000),NOW).ok,false);
 const result=paperMark(s,market('BTCUSDT',49000),NOW,'AI_CLOSE','AI主动判断趋势结束');
 assert.equal(result.ok,true);assert.equal(result.trade.exitReason,'AI_CLOSE');
 assert.equal(s.positions.length,1);assert.equal(s.positions[0].id,otherId);
 assert.equal(s.closed.length,1);
 assert.equal(paperMark(s,market('BTCUSDT',49000),NOW,'AI_CLOSE').reason,'NO_MATCHING_POSITION');
 assert.equal(paperMark(s,market('ETHUSDT',3400),NOW,'EMERGENCY_STOP').trade.exitReason,'EMERGENCY_STOP');
 assert.equal(s.positions.length,0);assert.equal(s.closed.length,2);
});
test('legacy single position is retained during migration, no stop/TP',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market('ETHUSDT',3500),answer('SHORT','ETHUSDT'),NOW);
 const prev={...s.positions[0],stop:3600,takeProfit:3200};
 const restored={...s,position:prev,positions:[prev]};
 normalizePaperPositions(restored);
 assert.equal(restored.positions[0].id,prev.id);
 assert.equal('stop' in restored.positions[0],false);
 assert.equal('takeProfit' in restored.positions[0],false);
 assert.throws(()=>normalizePaperPositions({...restored,positions:[prev,prev]}),/INVALID_PAPER_POSITION/);
});
test('portfolio floating PnL sums positions, does not fabricate missing quotes',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market(),answer(),NOW);
 paperOpen(s,market('ETHUSDT',3500),answer('SHORT','ETHUSDT'),NOW);
 const one=paperFloatingPnL(s.positions,[{symbol:'BTCUSDT',markPrice:50200,checkedAt:NOW},
   {symbol:'ETHUSDT',markPrice:3400,checkedAt:NOW}],NOW);
 assert.equal(one.complete,true);assert.ok(one.total>0);
 const incomplete=paperFloatingPnL(s.positions,[{symbol:'BTCUSDT',markPrice:50200,checkedAt:NOW}],NOW);
 assert.equal(incomplete.complete,false);
});
test('margin allocation is bounded across multiple concurrent positions',()=>{
 const s=newState({...DEFAULT_SETTINGS,paperBalance:10,marginUsdt:1});s.settings.enabled=true;
 s.balance=1.98;
 assert.equal(paperOpen(s,market(),answer(),NOW).ok,true);
 assert.equal(paperOpen(s,market('ETHUSDT',3500),answer('SHORT','ETHUSDT'),NOW).reason,'INSUFFICIENT_FREE_PAPER_MARGIN');
});
