// Research context for PAPER-ONLY model decisions. No thresholds, stops, or orders.
import {PAPER_FEE_RATE,PAPER_SLIPPAGE_RATE} from './engine.mjs';
const round=(n,d=4)=>Number(n.toFixed(d));
const finite=Number.isFinite;
const symbols=['BTCUSDT','ETHUSDT','SOLUSDT'];
function summarize(rows){
  const wins=rows.filter(x=>x.netPnl>0);
  const losses=rows.filter(x=>x.netPnl<0);
  const grossWins=wins.reduce((s,x)=>s+x.netPnl,0);
  const grossLosses=-losses.reduce((s,x)=>s+x.netPnl,0);
  return {trades:rows.length,wins:wins.length,losses:losses.length,
    breakeven:rows.length-wins.length-losses.length,
    winRatePct:rows.length?round(100*wins.length/rows.length,2):null,
    realizedNetPnlUsdt:round(rows.reduce((s,x)=>s+x.netPnl,0)),
    averageNetPnlUsdt:rows.length?round(rows.reduce((s,x)=>s+x.netPnl,0)/rows.length):null,
    grossProfitUsdt:round(grossWins),grossLossUsdt:round(grossLosses),
    profitFactor:grossLosses>0?round(grossWins/grossLosses,3):null};
}
export function summarizeClosedTrades(closed=[],limit=40){
  const records=(Array.isArray(closed)?closed:[])
    .filter(x=>x&&finite(x.netPnl)&&symbols.includes(x.symbol))
    .slice(0,Math.max(0,Math.min(100,limit)));
  const bySymbol=Object.fromEntries(symbols.map(symbol=>[
    symbol,summarize(records.filter(x=>x.symbol===symbol))]));
  const lastTrades=records.slice(0,12).map(x=>({
    symbol:x.symbol,side:x.side,horizon:x.horizon||'UNSPECIFIED',
    netPnlUsdt:round(x.netPnl),exitReason:x.exitReason||'UNKNOWN',
    heldMinutes:finite(x.closedAt)&&finite(x.openedAt)?
      round(Math.max(0,x.closedAt-x.openedAt)/60000,1):null,
    aiExitReason:typeof x.aiExitReason==='string'?x.aiExitReason.slice(0,120):null
  }));
  return {sampleSize:records.length,overall:summarize(records),bySymbol,lastTrades,
    notes:'仅最近样本的模拟交易净盈亏；样本小可能偶然，过去表现不保证未来收益。'};
}
export function estimatedEntryCosts(settings){
  const margin=Number(settings?.marginUsdt),leverage=Number(settings?.leverage);
  if(!finite(margin)||margin<=0||!finite(leverage)||leverage<=0)return null;
  const notional=margin*leverage;
  return {marginUsdt:margin,leverage,estimatedNotionalUsdt:round(notional,2),
    simulatedOneWayFeePct:round(100*PAPER_FEE_RATE,4),
    simulatedOneWaySlippagePct:round(100*PAPER_SLIPPAGE_RATE,4),
    approximateRoundTripCostUsdt:round(notional*2*(PAPER_FEE_RATE+PAPER_SLIPPAGE_RATE),4),
    approximateUnderlyingBreakEvenMovePct:round(200*(PAPER_FEE_RATE+PAPER_SLIPPAGE_RATE),4),
    caveat:'按模拟引擎双边交易费与滑点估算，不含资金费/强平及真实成交差异。'};
}
export function assessPositions(positions=[],markets=[],now=Date.now()){
  const quoteBySymbol=new Map((Array.isArray(markets)?markets:[])
    .filter(m=>symbols.includes(m?.symbol)).map(m=>[m.symbol,m]));
  return (Array.isArray(positions)?positions:[]).map(p=>{
    const q=quoteBySymbol.get(p.symbol);
    const valid=q&&finite(q.markPrice)&&q.markPrice>0&&finite(q.checkedAt)&&
      now-q.checkedAt>=0&&now-q.checkedAt<=10000;
    const base={symbol:p.symbol,side:p.side,entry:p.entry,qty:p.qty,
      marginUsdt:p.marginUsdt,leverage:p.leverage,
      horizon:p.horizon||'UNSPECIFIED',
      heldSeconds:finite(p.openedAt)?Math.max(0,Math.floor((now-p.openedAt)/1000)):null,
      openedAt:p.openedAt,markPrice:valid?q.markPrice:null,
      marketDataFresh:Boolean(valid),unrealizedGrossPnlUsdt:null,
      estimatedNetPnlIfClosedUsdt:null,estimatedExitCostUsdt:null};
    if(!valid||!finite(p.qty)||p.qty<=0||!finite(p.entry)||p.entry<=0||
        !['LONG','SHORT'].includes(p.side))return base;
    const sign=p.side==='LONG'?1:-1;
    const executionClose=q.markPrice*(1-sign*PAPER_SLIPPAGE_RATE);
    const openFee=finite(p.openFee)?p.openFee:p.qty*p.entry*PAPER_FEE_RATE;
    const closeFee=executionClose*p.qty*PAPER_FEE_RATE;
    const gross=sign*(q.markPrice-p.entry)*p.qty;
    const net=sign*(executionClose-p.entry)*p.qty-openFee-closeFee;
    return {...base,unrealizedGrossPnlUsdt:round(gross),
      estimatedNetPnlIfClosedUsdt:round(net),
      estimatedExitCostUsdt:round(Math.abs(q.markPrice-executionClose)*p.qty+closeFee)};
  });
}
