import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFastSignal,createFastProductionProvider} from './deepseek-single5-production.mjs';
const round=1792626900000;

test('fast signal must be within 5s and use current round snapshot',()=>{
 assert.throws(()=>buildFastSignal({
  round,at:round+5000,tick:{round,at:round+4999,open:5,price:6},
  decision:{direction:'UP'},providerModel:'deepseek-flash'}),/INVALID_FIVE_SECOND_REAL_SIGNAL/);
 const output=buildFastSignal({
  round,at:round+2300,tick:{round,at:round+2000,open:100,price:100.1},
  decision:{direction:'UP',reason:'live price',method:'DEEPSEEK_SINGLE_CALL_5S'},
  providerModel:'deepseek-flash'});
 assert.equal(output.latest.direction,'UP');
 assert.equal(output.latest.lockedAt,round+2300);
 assert.equal(output.latest.decisionMethod,'DEEPSEEK_SINGLE_CALL_5S');
 assert.equal(output.latest.confidenceIsCalibrated,false);
});

function marketResponse(at,price=100.1){
 return {ok:true,readOnly:true,symbol:'BTCUSDT',
  latest:{eventMs:at,roundStartMs:round,lastPrice:price,
   roundOpenPrice:100,marketFeedConnected:true}};
}

test('one DeepSeek request per round; no historical input, learning or stats',async()=>{
 let now=round+650;
 let aiCalls=0;
 let request;
 const fetcher=async (url,opts={})=>{
  if(url==='http://mock/feed')return {ok:true,json:async()=>marketResponse(now)};
  assert.equal(url,'http://mock/ai');
  aiCalls++;request=JSON.parse(opts.body);
  return {ok:true,json:async()=>({
   choices:[{message:{content:'{"direction":"DOWN","reason":"market price"}'}}],
   usage:{total_tokens:42}})};
 };
 const p=createFastProductionProvider({env:{
  DEEPSEEK_API_KEY:'local-test-only',DEEPSEEK_MODEL:'deepseek-flash',
  ADAPTIVE15_MARKET_URL:'http://mock/feed',DEEPSEEK_API_URL:'http://mock/ai',
  LLM_STATE_FILE:'/tmp/zl-fast5-smoke-model-no-real-orders.json'},
  clock:()=>now,fetcher});
 try{
  await p.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(aiCalls,1);
  assert.equal(request.thinking.type,'disabled');
  assert.equal(request.messages.length,2);
  assert.doesNotMatch(JSON.stringify(request),/historicalFeedbackRounds|settlementCases|pastWinRate|trainingSamples/);
  const state=p.status();
  assert.equal(state.learningDisabled,true);
  assert.equal(state.trainingDisabled,true);
  assert.equal(state.statisticsDisabled,true);
  assert.equal(state.aiTokens,42);
  assert.equal(state.maxCallsPerRound,1);
  assert.equal(state.signal?.latest.direction,'DOWN');
  await p.tick();
  assert.equal(aiCalls,1);
 }finally{
  const {unlinkSync}=await import('node:fs');
  try{unlinkSync('/tmp/zl-fast5-smoke-model-no-real-orders.json')}catch{}
 }
});

test('5s deadline with invalid market data returns unavailable, never fake AI success',async()=>{
 let now=round+900;
 const p=createFastProductionProvider({env:{
  DEEPSEEK_API_KEY:'local-test-only',ADAPTIVE15_MARKET_URL:'http://mock/feed'},
  clock:()=>now,fetcher:async()=>({ok:true,json:async()=>({ok:false})})});
 await p.tick();
 now=round+5000;
 assert.equal(p.status().roundDecision.status,'UNAVAILABLE');
 assert.equal(p.status().signal,null);
 assert.equal(p.status().maxCallsPerRound,1);
});

test('real-price-only fallback is explicitly labelled as non-DeepSeek',async()=>{
 let now=round+900;
 const output='/tmp/zl-fast5-smoke-fallback-no-real-orders.json';
 const p=createFastProductionProvider({env:{
  ADAPTIVE15_MARKET_URL:'http://mock/feed',LLM_STATE_FILE:output},
  clock:()=>now,fetcher:async()=>({ok:true,json:async()=>marketResponse(now)})});
 try{
  await p.tick();
  now=round+4600;
  await p.tick();
  const state=p.status();
  assert.equal(state.signal?.latest.direction,'UP');
  assert.equal(state.signal?.latest.decisionMethod,'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK');
  assert.equal(state.analysisModelCalls,1);
  assert.equal(state.decisionWindowEndMs-round,5000);
 }finally{
  const {unlinkSync}=await import('node:fs');
  try{unlinkSync(output)}catch{}
 }
});
