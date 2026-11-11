import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS,validateSettings,parseDecision,makeMarket,newState,
  paperOpen,paperMark,ENGINE_VERSION} from './engine.mjs';
const NOW=Date.parse('2026-11-11T07:30:20.000Z');
function candles(ms,n,step){
 const end=Math.floor(NOW/ms)*ms;
 return Array.from({length:n},(_,i)=>({startMs:end-(n-i)*ms,
  close:50000+i*step,high:50030+i*step,low:49970+i*step,volume:100+i}));
}
function market(price=50100){return makeMarket({symbol:'BTCUSDT',markPrice:price,markTime:NOW-1000,
 oneMin:candles(60000,60,2),fiveMin:candles(300000,50,6),now:NOW});}
const answer=(action='LONG',symbol='BTCUSDT')=>({action,symbol,confidence:.8,reason:'根据当前行情判断模拟交易方向并自主决定平仓'});
test('strict paper-only settings without TP/SL controls',()=>{
 assert.equal(ENGINE_VERSION,'HAIPAI_GENIUS_PAPER_V142_AI_EXIT_ONLY');
 assert.equal(DEFAULT_SETTINGS.enabled,false);
 assert.equal(validateSettings({...DEFAULT_SETTINGS}).leverage,2);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,leverage:125}),/INVALID_leverage/);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,marginUsdt:50}),/MARGIN_OVER_TEN_PERCENT/);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,stopLossPct:0.2}),/INVALID_SETTINGS_FIELDS/);
});
test('LLM response accepts only known action and valid confidence',()=>{
 assert.equal(parseDecision('{"action":"WAIT","confidence":0.55,"reason":"趋势互相冲突，暂不采取任何操作。"}').action,'WAIT');
 assert.equal(parseDecision({...answer('CLOSE'),confidence:.9}).action,'CLOSE');
 assert.throws(()=>parseDecision({...answer(),action:'BUY'}),/INVALID_AI_DIRECTION/);
 assert.throws(()=>parseDecision({...answer(),confidence:100}),/INVALID_AI_SCORE/);
 assert.throws(()=>parseDecision({...answer(),symbol:'DOGEUSDT'}),/INVALID_AI_SYMBOL/);
});
test('fresh prices and contiguous candles required',()=>{
 assert.equal(market().trend1m,'UP');
 assert.throws(()=>makeMarket({symbol:'BTCUSDT',markPrice:50100,markTime:NOW-7000,
  oneMin:candles(60000,60,2),fiveMin:candles(300000,50,6),now:NOW}),/STALE_MARK_PRICE/);
});
test('AI-directed entry has no fixed stop or take-profit',()=>{
 const s=newState();
 assert.equal(paperOpen(s,market(),answer(),NOW).ok,false);
 s.settings.enabled=true;
 assert.equal(paperOpen(s,market(),answer(),NOW).ok,true);
 assert.equal(s.position.side,'LONG');
 assert.equal(Object.hasOwn(s.position,'stop'),false);
 assert.equal(Object.hasOwn(s.position,'takeProfit'),false);
 assert.equal(paperOpen(s,market(),answer(),NOW).reason,'NOT_ARMED_OR_ALREADY_OPEN');
});
test('extreme favorable/adverse price moves NEVER auto-close',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market(),answer(),NOW);
 const left=paperMark(s,{...market(45000),checkedAt:NOW},NOW);
 const right=paperMark(s,{...market(56000),checkedAt:NOW},NOW);
 assert.equal(left.ok,false);
 assert.equal(right.ok,false);
 assert.equal(s.position.side,'LONG');
 assert.equal(s.closed.length,0);
});
test('only AI CLOSE or explicit emergency stop can close a simulated position',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market(),answer(),NOW);
 const close=paperMark(s,{...market(49000),checkedAt:NOW},NOW,'AI_CLOSE','AI判断风险增加，选择结束持仓');
 assert.equal(close.ok,true);
 assert.equal(close.trade.exitReason,'AI_CLOSE');
 assert.equal(close.trade.aiExitReason,'AI判断风险增加，选择结束持仓');
 assert.equal(close.trade.netPnl<0,true);
 assert.equal(s.position,null);
 assert.equal(paperOpen(s,market(),answer(),NOW+1000).reason,'COOLDOWN');
 const e=newState();e.settings.enabled=true;
 paperOpen(e,market(),answer('SHORT'),NOW);
 assert.equal(paperMark(e,market(),NOW,'EMERGENCY_STOP').trade.exitReason,'EMERGENCY_STOP');
});
test('AI may choose any supported market',()=>{
 const s=newState();s.settings.enabled=true;
 const eth={...market(3400),symbol:'ETHUSDT'};
 assert.equal(paperOpen(s,eth,answer('LONG','ETHUSDT'),NOW).ok,true);
 assert.equal(s.position.symbol,'ETHUSDT');
});
