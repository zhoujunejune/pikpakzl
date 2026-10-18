import test from 'node:test';
import assert from 'node:assert/strict';
import {bybitMarket} from './provider-market.mjs';
import {EDGE_MODEL,INPUT_VERSION,MIN_TRAINING_ROUNDS,MIN_FIT_ROUNDS,roundAt,extractFeatures,
  scoreDirection,trainOnOfficial,summarize} from './edge-core.mjs';
const ROUND=1792166400000;
const t=ROUND+6000;
const trail=[
 {at:t-8000,spotPrice:70000,perpPrice:70008},
 {at:t-6500,spotPrice:70002,perpPrice:70014},
 {at:t-4000,spotPrice:70003,perpPrice:70018},
 {at:t-2200,spotPrice:70004,perpPrice:70020}
];
const observation={
 spotPrice:70010,perpPrice:70025,spotAt:t-100,perpAt:t-70,
 bids:Array.from({length:5},(_,i)=>[70000-i,2.5]),
 asks:Array.from({length:5},(_,i)=>[70011+i,1.5]),
 trades:[
  {T:t-900,q:'0.2',m:false},{T:t-780,q:'0.4',m:false},
  {T:t-510,q:'0.1',m:true},{T:t-340,q:'0.2',m:false}
 ]};
test('all five causal features require real synchronized book, trades, spot and perp',()=>{
 const f=extractFeatures(observation,trail,t);
 assert.equal(EDGE_MODEL,'EDGE_5M_V1');
 assert.equal(f.inputVersion,INPUT_VERSION);
 assert.equal(f.values.length,5);
 assert.equal(f.round,roundAt(t));
 assert.ok(f.values.every(Number.isFinite));
 for(const patch of [{bids:[]},{trades:[]},{spotAt:t-9000},
   {perpAt:t+2000},{perpPrice:null}]){
   const source={...observation,...patch};
   // The invalid-perp-price case must NOT synthesize a midpoint.
   assert.equal(extractFeatures(source,trail,t),null,JSON.stringify(patch));
 }
 assert.equal(extractFeatures(observation,[],t),null);
});
test('valid inputs produce a direction independently of statistical calibration',()=>{
 const features=extractFeatures(observation,trail,t);
 const raw=scoreDirection(features,null);
 assert.ok(['UP','DOWN'].includes(raw.direction));
 assert.equal(raw.calibrationReady,false);
 assert.equal(raw.executionEligible,true);
 assert.equal(raw.modelProbability,null);
 const calibrated=scoreDirection(features,{weights:[0,1,0,0,0,0],
   calibration:[0,1],calibrationReady:true});
 assert.equal(calibrated.executionEligible,true);
 assert.ok(calibrated.modelProbability>=.5&&calibrated.modelProbability<=1);
});
test('training cannot borrow predictions from unverified or un-settled rounds',()=>{
 assert.equal(MIN_TRAINING_ROUNDS,5000);
 assert.equal(MIN_FIT_ROUNDS,30);
 const probe=extractFeatures(observation,trail,t);
 const rows=[{round:ROUND,direction:'UP',probe,actual:'UP',
   settledAt:ROUND+300000+100},{round:ROUND+300000,direction:'UP',probe,
   actual:null,settledAt:null}];
 const result=trainOnOfficial(rows);
 assert.equal(result.status,'COLLECTING');
 assert.equal(result.samples,1);
 assert.equal(result.calibrationReady,false);
 assert.equal(summarize(rows).overall.samples,1);
});

test('30 verified rounds allow provisional training without fake probability',()=>{
 const rows=Array.from({length:MIN_FIT_ROUNDS},(_,i)=>{
  const round=ROUND+i*300000;
  return {round,direction:i%2?'UP':'DOWN',actual:i%3?'UP':'DOWN',
   probe:{inputVersion:INPUT_VERSION,at:round+4000,
     values:[Math.sin(i*.07),Math.cos(i*.11),Math.sin(i*.13),i%5/5,.2]},
   settledAt:round+300001};
 });
 const fit=trainOnOfficial(rows);
 assert.equal(fit.samples,MIN_FIT_ROUNDS);
 assert.equal(fit.status,'PROVISIONAL_TRAINED');
 assert.equal(fit.model.weights.length,6);
 assert.equal(fit.calibrationReady,false);
 const p=scoreDirection(rows.at(-1).probe,fit.model);
 assert.ok(['UP','DOWN'].includes(p.direction));
 assert.equal(p.modelProbability,null);
 assert.equal(p.executionEligible,true);
});

test('BYBIT trade adapter retries second host when first returns stale spot trades',async()=>{
 const prior=globalThis.fetch,now=Date.now();
 const ticks={time:now-90,retCode:0,result:{list:[{lastPrice:'72000'}]}};
 const book={retCode:0,result:{ts:now-90,b:Array.from({length:5},(_,i)=>[String(72000-i),'1']),a:Array.from({length:5},(_,i)=>[String(72001+i),'1'])}};
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes('/market/orderbook?'))return new Response(JSON.stringify(book));
  if(url.includes('/market/tickers?'))return new Response(JSON.stringify(url.includes('category=linear')?
    {time:now-90,retCode:0,result:{list:[{lastPrice:'72010'}]}}:ticks));
  if(url.includes('/market/recent-trade?')){
   const stale=url.startsWith('https://api.bybit.com');
   return new Response(JSON.stringify({retCode:0,result:{list:Array.from({length:4},(_,i)=>({
      time:stale?now-12000:now-150,q:'1',size:'0.02',side:i%2?'Sell':'Buy'}))}}));
  }
  throw Error('unexpected request '+url);
 };
 try{
  const m=await bybitMarket();
  assert.equal(m.venue,'BYBIT');
  assert.equal(m.trades.length,4);
  assert.match(m.providers.trades,/api.bytick.com.*category=spot/);
  assert.ok(m.trades.every(t=>t.T>=now-3500));
 }finally{globalThis.fetch=prior}
});
