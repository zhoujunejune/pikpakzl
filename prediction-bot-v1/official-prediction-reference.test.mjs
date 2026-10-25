import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOfficialReference,createOfficialReferenceServer}
 from './official-prediction-reference.mjs';
import {makeWindow,collect,analysisRequest} from './deepseek-adaptive15-core.mjs';
const R=1792934100000;
const TOPIC={marketTopicId:7457416,symbol:'BTCUSDT',startDate:R,endDate:R+300000,
 status:'REGISTERED',variantData:{type:'UP_DOWN',startPrice:'80424.895',endPrice:null,
 priceFeedProvider:'CHAINLINK',priceFeedId:'0x0003ef42b4d20a19409a187c39670a6f5be7ce17fc78c290d25eb45bbf769d37',
 priceFeedSymbol:'BTCUSDT'}};
test('valid signed-current-round market detail yields start-only read-only reference',()=>{
 const r=validateOfficialReference(TOPIC,R,R+5000);
 assert.equal(r.ok,true);
 assert.equal(r.officialStartPrice,80424.895);
 assert.equal(r.officialLivePrice,null);
 assert.equal(r.officialLivePriceAvailable,false);
 assert.equal(r.priceFeedProvider,'CHAINLINK');
 assert.equal(r.marketTopicId,7457416);
 assert.equal(r.officialPriceObservedAt,R+5000);
 assert.ok(!('officialEndPrice' in r));
});
test('reject wrong round, resolved topics, invalid start price, provider and symbol',()=>{
 assert.equal(validateOfficialReference(TOPIC,R+300000,R+300000+5000),null);
 assert.equal(validateOfficialReference({...TOPIC,status:'RESOLVED'},R,R+5000),null);
 assert.equal(validateOfficialReference({...TOPIC,symbol:'ETHUSDT'},R,R+5000),null);
 assert.equal(validateOfficialReference({...TOPIC,variantData:{...TOPIC.variantData,startPrice:null}},R,R+5000),null);
 assert.equal(validateOfficialReference({...TOPIC,variantData:{...TOPIC.variantData,priceFeedProvider:'BINANCE'}},R,R+5000),null);
 assert.equal(validateOfficialReference({...TOPIC,variantData:{...TOPIC.variantData,priceFeedSymbol:'ETHUSDT'}},R,R+5000),null);
 assert.equal(validateOfficialReference(TOPIC,R,R-1),null);
});
test('signed GET market list and detail only, exact-round cached, no orders or future quotes',async()=>{
 let now=R+12000;
 const seen=[];
 const server=createOfficialReferenceServer({clock:()=>now,env:{
  BINANCE_PREDICTION_API_KEY:'fixture-readonly',
  BINANCE_PREDICTION_API_SECRET:'fixture-readonly-secret'
 },fetcher:async(url,opt)=>{
  const u=new URL(url);seen.push({path:u.pathname,method:opt.method||'GET'});
  assert.equal(opt.headers['X-MBX-APIKEY'],'fixture-readonly');
  assert.ok(u.searchParams.get('signature'));
  if(u.pathname.endsWith('/market/list'))return {ok:true,json:async()=>({data:{marketTopics:[
   {...TOPIC,startDate:R-300000,endDate:R},
   {marketTopicId:TOPIC.marketTopicId,startDate:R,endDate:R+300000,symbol:'BTCUSDT'}]}})};
  if(u.pathname.endsWith('/market/detail'))return {ok:true,json:async()=>({data:TOPIC})};
  throw Error('UNEXPECTED_REMOTE_ENDPOINT');
 }});
 const one=await server.reference(R);
 assert.equal(one.ok,true);
 assert.equal(one.officialStartPrice,80424.895);
 assert.equal((await server.reference(R)).ok,true);
 assert.equal(seen.length,2);
 assert.ok(seen.every(s=>s.method==='GET'&&s.path.includes('/market/')));
 assert.ok(seen.every(s=>!s.path.includes('place-order')&&!s.path.includes('trade')));
 now=R+40001;
 assert.equal((await server.reference(R)).ok,true);
 now=R+45000;
 assert.equal((await server.reference(R)).ok,false);
});
test('DeepSeek current prompt keeps official reference distinct from spot live price',()=>{
 const w=makeWindow(R);
 for(let n=0;n<35;n++){
  w.prior.push({round:R-300000,at:R-115000+n*2500,price:80400,open:80400});
 }
 w.early.push({round:R,at:R+17000,price:80427,open:80424.9});
 const evidence=validateOfficialReference(TOPIC,R,R+5000);
 const req=analysisRequest(w,'current',R+18000,
 {lastPrice:80427,roundOpenPrice:80424.9,officialReference:evidence},{});
 const prompt=req.messages[1].content;
 assert.equal(JSON.parse(prompt).officialPredictionReference.officialStartPrice,80424.895);
 assert.equal(JSON.parse(prompt).officialLiveChainlinkQuote,null);
 assert.match(req.messages[0].content,/never falsely label spot prices as Chainlink/);
 assert.match(req.messages[0].content,/do not infer a missing Chainlink reference/);
 assert.equal(req.reasoning_effort,'high');
 assert.equal(req.thinking.type,'enabled');
});
