// Paper-only opportunity proposals based on contemporaneous market structure.
// They do NOT place orders. Every proposal requires explicit AI agreement.
const finite=Number.isFinite;
const symbols=['BTCUSDT','ETHUSDT','SOLUSDT'];
const round=(x,n=3)=>Number(x.toFixed(n));
export function deriveOpportunityCandidates(markets,microBySymbol={},higherBySymbol={},now=Date.now()){
  if(!Array.isArray(markets))return [];
  const proposals=[];
  for(const m of markets){
    if(!symbols.includes(m?.symbol)||!finite(m.markPrice)||m.markPrice<=0||
        !finite(m.checkedAt)||now-m.checkedAt<0||now-m.checkedAt>8000)continue;
    const micro=microBySymbol[m.symbol]||{};
    const sample=micro.trades?.w30;
    const frames=higherBySymbol[m.symbol]||{};
    if(!frames.complete||!frames.frames?.['15m']||!frames.frames?.['1h']||
        !frames.frames?.['4h']||!frames.frames?.['1d']||!frames.frames?.['1w'])continue;
    if(!sample||!finite(sample.buyRatio)||!finite(sample.changePct)||
        !finite(sample.ageMs)||sample.ageMs>4500||!finite(sample.tradeEvents)||
        sample.tradeEvents<12)continue;
    const h=frames.frames,shortRsi=Number(h['15m'].rsi14);
    const base={symbol:m.symbol,horizon:'SHORT',
      origin:'STRUCTURED_MARKET_CANDIDATE_REQUIRES_AI_APPROVAL',
      marketAgeMs:now-m.checkedAt};
    const signal=(action,type,description,strength)=>{
      proposals.push({...base,action,signalType:type,
        evidenceStrength:round(strength,4),reason:description});
    };
    // Follow an already established short-term move, without requiring daily
    // and weekly agreement for every SHORT-horizon research candidate.
    if(m.trend1m==='UP'&&m.trend5m==='UP'&&sample.buyRatio>=.64&&
        sample.changePct>=.018&&h['15m'].bias!=='DOWN'){
      signal('LONG','SHORT_MOMENTUM','1分钟与5分钟趋势向上，近30秒主动买量及价格动量同向，候选由AI独立复核',sample.buyRatio-.5+sample.changePct);
    }else if(m.trend1m==='DOWN'&&m.trend5m==='DOWN'&&sample.buyRatio<=.36&&
        sample.changePct<=-.018&&h['15m'].bias!=='UP'){
      signal('SHORT','SHORT_MOMENTUM','1分钟与5分钟趋势向下，近30秒主动卖量及价格动量同向，候选由AI独立复核',.5-sample.buyRatio-sample.changePct);
    // A possible reversal after short-horizon exhaustion may be worth an
    // explicit review, but RSI alone is insufficient.
    }else if(m.trend1m==='DOWN'&&m.trend5m==='UP'&&finite(shortRsi)&&
        shortRsi>=72&&sample.buyRatio<=.34&&sample.changePct<0){
      signal('SHORT','OVERBOUGHT_REVERSAL','15分钟相对高位且1分钟转弱，近30秒主动卖单及价格下跌确认，逆向候选须AI复核',.5-sample.buyRatio-sample.changePct);
    }else if(m.trend1m==='UP'&&m.trend5m==='DOWN'&&finite(shortRsi)&&
        shortRsi<=28&&sample.buyRatio>=.66&&sample.changePct>0){
      signal('LONG','OVERSOLD_REVERSAL','15分钟相对低位且1分钟转强，近30秒主动买单及价格上涨确认，逆向候选须AI复核',sample.buyRatio-.5+sample.changePct);
    }
  }
  return proposals.sort((a,b)=>b.evidenceStrength-a.evidenceStrength);
}
