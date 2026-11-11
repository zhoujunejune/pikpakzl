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
test('risk controls are bounded and paper-only defaults to disabled',()=>{
 assert.equal(ENGINE_VERSION,'HAIPAI_GENIUS_PAPER_V140_20261111');
 assert.equal(DEFAULT_SETTINGS.enabled,false);
 assert.equal(validateSettings({...DEFAULT_SETTINGS}).leverage,2);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,leverage:125}),/INVALID_leverage/);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,marginUsdt:50}),/MARGIN_OVER_TEN_PERCENT/);
 assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,extra:true}),/INVALID_SETTINGS_FIELDS/);
});
test('LLM response must be checked strictly',()=>{
 assert.equal(parseDecision('{"action":"WAIT","confidence":0.55,"reason":"趋势互相冲突，暂不采取任何操作。"}').action,'WAIT');
 assert.throws(()=>parseDecision('{"action":"BUY","confidence":0.99,"reason":"趋势比较明显"}'),/INVALID_AI_DIRECTION/);
 assert.throws(()=>parseDecision('{"action":"LONG","confidence":100,"reason":"不能自称稳赢"}'),/INVALID_AI_SCORE/);
});
test('mark price and closed candles must be fresh',()=>{
 assert.equal(market().trend1m,'UP');
 assert.throws(()=>makeMarket({symbol:'BTCUSDT',markPrice:50100,markTime:NOW-7000,
  oneMin:candles(60000,60,2),fiveMin:candles(300000,50,6),now:NOW}),/STALE_MARK_PRICE/);
});
test('entry requires user to enable paper mode and applies cooldown',()=>{
 const s=newState(),d={action:'LONG',reason:'趋势确认但不代表盈利',confidence:.76};
 assert.equal(paperOpen(s,market(),d,NOW).ok,false);
 s.settings.enabled=true;
 const x=paperOpen(s,market(),d,NOW);
 assert.equal(x.ok,true);assert.equal(s.position.side,'LONG');
 assert.ok(s.position.stop<s.position.entry);
 assert.ok(s.position.takeProfit>s.position.entry);
 assert.equal(paperOpen(s,market(),d,NOW).reason,'NOT_ARMED_OR_ALREADY_OPEN');
});
test('paper take-profit stop-loss and emergency-stop accounting',()=>{
 const s=newState();s.settings.enabled=true;
 paperOpen(s,market(),{action:'LONG',reason:'仅模拟风险收益的价格方向',confidence:.72},NOW);
 assert.equal(paperMark(s,market(),NOW).ok,false);
 const x=paperMark(s,{...market(49400),checkedAt:NOW},NOW);
 assert.equal(x.ok,true);assert.equal(x.trade.exitReason,'STOP_LOSS');
 assert.equal(x.trade.paper,true);assert.ok(x.trade.netPnl<0);
 assert.equal(s.position,null);assert.equal(s.closed.length,1);
 assert.equal(paperOpen(s,market(),{action:'LONG',reason:'仅模拟研究方向',confidence:.8},NOW+1000).reason,'COOLDOWN');
 const v=newState();v.settings.enabled=true;
 paperOpen(v,market(),{action:'SHORT',reason:'仅模拟开仓执行逻辑',confidence:.7},NOW);
 assert.equal(paperMark(v,market(),NOW,true).trade.exitReason,'EMERGENCY_STOP');
});