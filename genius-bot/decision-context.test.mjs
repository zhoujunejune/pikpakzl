import test from 'node:test';
import assert from 'node:assert/strict';
import {newState,paperOpen,paperMark,DEFAULT_SETTINGS,PAPER_FEE_RATE,PAPER_SLIPPAGE_RATE} from './engine.mjs';
import {summarizeClosedTrades,estimatedEntryCosts,assessPositions} from './decision-context.mjs';
const NOW=Date.parse('2026-11-11T14:00:00Z');
const trade=(symbol,netPnl,reason='AI_CLOSE')=>({symbol,netPnl,paper:true,exitReason:reason,
  side:'LONG',horizon:'MEDIUM',openedAt:NOW-600000,closedAt:NOW,
  aiExitReason:'AI认为中期结构已经发生实质性变化'});
test('history review separates net wins/losses by symbol; never presents estimates as facts',()=>{
  const x=summarizeClosedTrades([trade('BTCUSDT',-3),trade('SOLUSDT',2),
    trade('BTCUSDT',-1),trade('ETHUSDT',4),trade('BTCUSDT',1)]);
  assert.equal(x.sampleSize,5);
  assert.equal(x.overall.wins,3);assert.equal(x.overall.losses,2);
  assert.equal(x.overall.winRatePct,60);
  assert.equal(x.overall.realizedNetPnlUsdt,3);
  assert.equal(x.bySymbol.BTCUSDT.realizedNetPnlUsdt,-3);
  assert.equal(summarizeClosedTrades([]).overall.winRatePct,null);
  assert.equal(summarizeClosedTrades([trade('DOGEUSDT',100)]).sampleSize,0);
  assert.ok(x.lastTrades[0].aiExitReason.length>6);
});
test('cost context matches paper engine fee and slippage with 50x 30USDT example',()=>{
  const x=estimatedEntryCosts({marginUsdt:30,leverage:50});
  assert.equal(x.estimatedNotionalUsdt,1500);
  assert.equal(x.approximateRoundTripCostUsdt,2.4);
  assert.equal(x.approximateUnderlyingBreakEvenMovePct,0.16);
  assert.equal(PAPER_FEE_RATE,.0005);assert.equal(PAPER_SLIPPAGE_RATE,.0003);
  assert.equal(estimatedEntryCosts({marginUsdt:0,leverage:50}),null);
});
test('held positions expose modeled NET PnL not just gross; missing/stale quotes stay unavailable',()=>{
  const s=newState({...DEFAULT_SETTINGS,enabled:true,leverage:50,marginUsdt:30});
  const m={symbol:'BTCUSDT',markPrice:50000,checkedAt:NOW};
  const result=paperOpen(s,m,{action:'LONG',symbol:'BTCUSDT',reason:'回测模拟',confidence:.7},NOW);
  assert.equal(result.ok,true);
  const flat=assessPositions(s.positions,[m],NOW)[0];
  assert.equal(flat.marketDataFresh,true);
  assert.ok(flat.unrealizedGrossPnlUsdt<0);
  assert.ok(flat.estimatedNetPnlIfClosedUsdt<0);
  assert.ok(Math.abs(flat.estimatedNetPnlIfClosedUsdt)>Math.abs(flat.unrealizedGrossPnlUsdt));
  const good=assessPositions(s.positions,[{...m,markPrice:50400}],NOW)[0];
  assert.ok(good.estimatedNetPnlIfClosedUsdt>0);
  const stale=assessPositions(s.positions,[{...m,checkedAt:NOW-20000}],NOW)[0];
  assert.equal(stale.marketDataFresh,false);
  assert.equal(stale.estimatedNetPnlIfClosedUsdt,null);
  assert.equal(assessPositions(s.positions,[],NOW)[0].marketDataFresh,false);
});
test('manual emergency and AI CLOSE remain the only execution exit mechanisms',()=>{
  const s=newState({...DEFAULT_SETTINGS,enabled:true});
  const m={symbol:'BTCUSDT',markPrice:50000,checkedAt:NOW};
  assert.equal(paperOpen(s,m,{action:'LONG',symbol:'BTCUSDT',reason:'模拟'},NOW).ok,true);
  assert.equal(paperMark(s,m,NOW).reason,'AI_HOLD');
  assert.equal(paperMark(s,m,NOW,'AI_CLOSE','AI分析后主动平仓').ok,true);
  assert.equal(s.closed[0].exitReason,'AI_CLOSE');
});
