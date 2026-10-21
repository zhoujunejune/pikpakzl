import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const core=await import(pathToFileURL(process.env.PATCHED_CORE_PATH));
const round=1792600200000;
function windowFixture(){
 const w=core.makeWindow(round);
 for(let i=0;i<5;i++)w.prior.push({at:round-50000+i*6000,round:round-300000,price:68000+i,open:67500});
 for(let i=0;i<3;i++)w.early.push({at:round+1000+i*3000,round,price:68008+i,open:68008});
 return w;
}
const verified={ok:true,source:'SIGNED_BINANCE_PREDICTION_CURRENT_ROUND_BUY_QUOTE_PREVIEW',
 round,generatedAt:round+7000,UP:{chance:.57,at:round+7000,expireAt:round+20000},
 DOWN:{chance:.46,at:round+6800,expireAt:round+19000},
 assumedCostBuffer:.02,minRequiredEdge:.015,quoteOnly:true};
test('live round quote and official experience are passed to same model call',()=>{
 const w=windowFixture();
 const x=core.analysisRequest(w,'current',round+8000,{}, {samples:100},verified);
 const body=JSON.parse(x.messages[1].content);
 assert.equal(body.verifiedBinanceExecutableQuotes.UP.chance,.57);
 assert.equal(body.verifiedBinanceExecutableQuotes.DOWN.chance,.46);
 assert.equal(body.verifiedHistoricalExperience.samples,100);
 assert.equal(x.model,'deepseek-flash');
});
test('a pre-round model call cannot view a current-round executable quote',()=>{
 const w=windowFixture();
 const x=core.analysisRequest(w,'initial',round-35000,{}, {samples:100},verified);
 assert.equal(JSON.parse(x.messages[1].content).verifiedBinanceExecutableQuotes,null);
});
test('model opinion is separate from UP/DOWN and not an order authorization',()=>{
 const w=windowFixture(), raw=JSON.stringify({
 direction:'UP',confidence:.59,continueAnalysis:false,reason:'trend',risk:'price risk',
 tradeOpinion:'NO_TRADE',tradeReason:'quote too expensive'});
 const decoded=core.decodeAnalysis(raw,round,round+8000,'current');
 decoded.tradeQuoteEvidence=verified;
 core.registerAnalysis(w,decoded);
 const ret=core.finalize(w,round+8500,{});
 assert.equal(ret.latest.direction,'UP');
 assert.equal(ret.latest.aiTradeOpinion,'NO_TRADE');
 assert.equal(ret.latest.aiQuoteUpChance,.57);
 assert.equal(ret.latest.aiTradeReason,'quote too expensive');
 assert.equal(ret.orders,false);
});
test('missing model trade opinion stays unavailable and cannot fabricate quote',()=>{
 const decoded=core.decodeAnalysis(JSON.stringify({
 direction:'DOWN',confidence:.7,reason:'price action'}),round,round+4000,'current');
 assert.equal(decoded.tradeOpinion,'UNAVAILABLE');
});
