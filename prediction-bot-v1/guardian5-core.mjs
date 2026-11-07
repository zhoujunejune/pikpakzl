// GUARDIAN 5M V1: strict, read-only decision and risk policy.
// No Binance order-writing endpoint exists anywhere in this module.
export const MODEL='ZL_GUARDIAN_5M_V1';
export const ROUND_MS=300000;
export const roundOf=t=>Math.floor(t/ROUND_MS)*ROUND_MS;
const number=v=>typeof v==='number'&&Number.isFinite(v);
const finitePositive=v=>number(v)&&v>0;
export function wilsonLower(hits,total,z=1.96){
 if(!Number.isSafeInteger(hits)||!Number.isSafeInteger(total)||total<1||hits<0||hits>total)return null;
 const p=hits/total,d=1+z*z/total;
 return (p+z*z/(2*total)-z*Math.sqrt((p*(1-p)+z*z/(4*total))/total))/d;
}
export function safeCandidate(f,now=Date.now()){
 const end=roundOf(now)+ROUND_MS;
 const wait=(reason)=>({direction:'WAIT',reason,round:roundOf(now),observedAt:f?.observedAt??null});
 if(!f||f.round!==roundOf(now)||!Number.isSafeInteger(f.observedAt)||now-f.observedAt>10000||f.observedAt>now+300)return wait('行情过期或轮次不匹配');
 if(end-now<25000)return wait('结算临近，无法保障下单和平仓时间');
 if(!finitePositive(f.roundOpenPrice)||!finitePositive(f.lastPrice))return wait('价格数据缺失');
 if(f.dataQuality?.indicatorsReady!==true)return wait('分钟K线尚不足以计算风险');
 const one=f.oneMinute||{},five=f.fiveMinute||{};
 if(!number(one.atrPct)||!number(one.rsi14)||!number(one.momentum1Pct)||!number(one.momentum5Pct)||!number(f.fromOpenPct))return wait('指标不足');
 // Signal strength is NOT calibrated probability. Avoid calling it win-rate.
 const distanceBps=f.fromOpenPct*100,atrBps=Math.max(1,one.atrPct*100);
 const direction=distanceBps>0?'UP':distanceBps<0?'DOWN':'WAIT';
 if(direction==='WAIT'||Math.abs(distanceBps)<Math.max(6,atrBps*0.38))return wait('离结算分界价过近');
 if(Math.abs(distanceBps)>220)return wait('价格异常或波动剧烈');
 if(atrBps>135)return wait('短期波动过高');
 if((direction==='UP'&&one.momentum1Pct<=0)||(direction==='DOWN'&&one.momentum1Pct>=0))return wait('短期动能和方向冲突');
 if((direction==='UP'&&one.momentum5Pct<=0)||(direction==='DOWN'&&one.momentum5Pct>=0))return wait('五分钟动能和方向冲突');
 if(one.rsi14>82||one.rsi14<18)return wait('超买超卖极端区间');
 const strength=Math.min(1,Math.abs(distanceBps)/Math.max(atrBps,10));
 return {direction,round:f.round,observedAt:f.observedAt,remainingSec:Math.floor((end-now)/1000),
  strength,reason:'价差、ATR和1/5分钟动能同向；尚非校准胜率',
  evidence:{distanceBps:Number(distanceBps.toFixed(2)),atrBps:Number(atrBps.toFixed(2)),rsi14:one.rsi14,
   momentum1Pct:one.momentum1Pct,momentum5Pct:one.momentum5Pct,fiveMinuteRSI:five.rsi14??null}};
}
export function parseAI(raw){
 const s=String(raw||'').trim();
 let o;
 try{o=JSON.parse(s)}catch{const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<=a)throw Error('INVALID_AI_JSON');o=JSON.parse(s.slice(a,b+1));}
 if(!o||!['UP','DOWN','WAIT'].includes(o.direction))throw Error('INVALID_AI_DIRECTION');
 const confidence=number(o.confidence)&&o.confidence>=0&&o.confidence<=1?o.confidence:null;
 return {direction:o.direction,confidence,reason:String(o.reason||'无理由').slice(0,200)};
}
export function evaluateQuote({probability=null,quote=null,fees=0,slippage=0,calibration=null,remainingMs=0,hasOfficialFeed=false}={}){
 if(!hasOfficialFeed)return {eligible:false,reason:'OFFICIAL_PRICE_FEED_NOT_VERIFIED'};
 if(!calibration||calibration.samples<300||calibration.wilsonLower<0.70)return {eligible:false,reason:'NOT_VALIDATED_ON_FORWARD_SAMPLES'};
 if(!number(probability)||probability<0||probability>1)return {eligible:false,reason:'CALIBRATED_PROBABILITY_MISSING'};
 if(!quote||!finitePositive(quote.costPerWinningShare)||quote.costPerWinningShare>=1)return {eligible:false,reason:'REAL_TRADABLE_QUOTE_MISSING'};
 if(!number(fees)||fees<0||!number(slippage)||slippage<0)return {eligible:false,reason:'INVALID_COSTS'};
 if(remainingMs<25000)return {eligible:false,reason:'INSUFFICIENT_EXIT_WINDOW'};
 const netCost=quote.costPerWinningShare+fees+slippage;
 const edge=probability-netCost;
 if(edge<0.05)return {eligible:false,reason:'NET_EDGE_BELOW_5PP',edge};
 return {eligible:true,reason:'CALIBRATED_VALUE_POSITIVE',edge};
}
export function exitPolicy({entryCost,currentNetSell,peakNetSell,remainingMs,edgeStillPresent=true}={}){
 if(!finitePositive(entryCost)||!number(currentNetSell)||currentNetSell<0)return {action:'WAIT',reason:'REAL_EXIT_QUOTE_REQUIRED'};
 const pnl=(currentNetSell-entryCost)/entryCost;
 const peak=number(peakNetSell)?(peakNetSell-entryCost)/entryCost:null;
 if(remainingMs<12000)return {action:edgeStillPresent?'HOLD_TO_SETTLEMENT':'SELL_IF_EXECUTABLE',reason:'NEAR_SETTLEMENT',pnl};
 if(pnl<=-0.10)return {action:'SELL',reason:'EMERGENCY_STOP_LOSS',pnl};
 if(!edgeStillPresent&&pnl<0)return {action:'SELL',reason:'PREDICTIVE_EDGE_LOST',pnl};
 if(peak!==null&&peak>=0.08&&peak-pnl>=0.04)return {action:'SELL',reason:'TRAILING_TAKE_PROFIT',pnl};
 return {action:'HOLD',reason:'NO_EXIT_TRIGGER',pnl};
}
