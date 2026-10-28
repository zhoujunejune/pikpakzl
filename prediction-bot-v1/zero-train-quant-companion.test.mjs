import test from 'node:test';
import assert from 'node:assert/strict';
import {quantSecondOpinion} from './zero-train-quant-companion.mjs';
import {analysisRequest,makeWindow} from './deepseek-adaptive15-core.mjs';
const R=1792935900000,NOW=R+22000;
function feed(){
 const base=80000;
 const one=Array.from({length:48},(_,i)=>({
  startMs:R-(48-i)*60000,endMs:R-(47-i)*60000-1,
  close:base+i*1.25,closed:true
 }));
 const five=Array.from({length:24},(_,i)=>({
  startMs:R-(24-i)*300000,endMs:R-(23-i)*300000-1,
  close:base+i*4.5,closed:true
 }));
 return {ok:true,readOnly:true,symbol:'BTCUSDT',latest:{
  roundStartMs:R,eventMs:NOW-400,lastPrice:80072,roundOpenPrice:80060,marketFeedConnected:true},
  candles:{'1m':{rows:one},'5m':{rows:five}}};
}
const oracle={
 ok:true,roundStartMs:R,priceFeedProvider:'CHAINLINK',
 priceFeedSymbol:'BTCUSDT',officialPriceObservedAt:R+17000,
 officialStartPrice:80059.995,officialLivePriceAvailable:false,officialLivePrice:null
};
test('genuine 1m and 5m fully closed BTC history produces a strictly untrained advisory',()=>{
 const q=quantSecondOpinion(feed(),NOW,oracle);
 assert.equal(q.available,true);
 assert.equal(q.type,'UNTRAINED_DETERMINISTIC_QUANT_STATISTIC_NOT_AI');
 assert.equal(q.referenceType,'CHAINLINK_OFFICIAL_START_VS_SPOT_NOW');
 assert.equal(q.roundStartMs,R);
 assert.equal(q.noOracleLiveQuote,true);
 assert.ok(['UP','DOWN','NEUTRAL'].includes(q.bias));
 assert.ok(!('winProbability' in q));
 assert.ok(!('orders' in q));
});
test('no future or partial candle leakage',()=>{
 const original=feed(),a=quantSecondOpinion(original,NOW,oracle);
 original.candles['1m'].rows.push({
  startMs:R+60000,endMs:R+119999,close:100,closed:true
 });
 original.candles['1m'].rows.push({
  startMs:R,endMs:R+59999,close:100,closed:false
 });
 assert.deepEqual(quantSecondOpinion(original,NOW,oracle),a);
});
test('stale/wrong round/insufficient history/gappy bars yield no fabricated prediction',()=>{
 const a=feed();a.latest.eventMs=NOW-6000;
 assert.equal(quantSecondOpinion(a,NOW,oracle).available,false);
 const b=feed();b.latest.roundStartMs=R-300000;
 assert.equal(quantSecondOpinion(b,NOW,oracle).available,false);
 const d=feed();d.candles['1m'].rows=d.candles['1m'].rows.slice(-10);
 assert.equal(quantSecondOpinion(d,NOW,oracle).available,false);
 const gap=feed();gap.candles['1m'].rows.splice(38,1);
 assert.equal(quantSecondOpinion(gap,NOW,oracle).reason,'ONE_MINUTE_BAR_GAP');
});
test('missing official reference never fakes a Chainlink quote',()=>{
 const q=quantSecondOpinion(feed(),NOW,null);
 assert.equal(q.available,true);
 assert.equal(q.referenceType,'BINANCE_SPOT_OPEN_VS_SPOT_NOW');
 assert.equal(q.noOracleLiveQuote,true);
});
test('DeepSeek reads cross-check but remains only decision authority',()=>{
 const w=makeWindow(R);
 for(let i=0;i<35;i++)w.prior.push({at:R-112000+i*2500,price:80000,round:R-300000,open:80000});
 w.early.push({at:NOW-500,price:80072,round:R,open:80060});
 const q=quantSecondOpinion(feed(),NOW,oracle);
 const payload=analysisRequest(w,'current',NOW,{quantSecondOpinion:q},{});
 assert.match(payload.messages[0].content,/NOT LightGBM/);
 assert.match(payload.messages[0].content,/must never override fresh DeepSeek reasoning/);
 const provided=JSON.parse(payload.messages[1].content);
 assert.equal(provided.indicators.quantSecondOpinion.type,'UNTRAINED_DETERMINISTIC_QUANT_STATISTIC_NOT_AI');
 assert.equal(provided.officialLiveChainlinkQuote,null);
});
