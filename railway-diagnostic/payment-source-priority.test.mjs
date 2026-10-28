import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_PRIORITY, predictionWalletPayment, eligibleSpotFallback, explicitMpcInsufficient } from './payment-source-priority.mjs';
const balances=(spot,enabled=true)=>({ok:true,items:[
 {accountType:'FUNDING',enabled:true,availableBalanceDisplay:'100.00'},
 {accountType:'SPOT',enabled,availableBalanceDisplay:String(spot)}
]});
test('Prediction MPC always first regardless of Spot or Funding balance',()=>{
 assert.deepEqual(PAYMENT_PRIORITY,['MPC','SPOT']);
 assert.deepEqual(predictionWalletPayment(),{displayAccount:'Prediction Wallet',accountType:'SPOT',fundingSource:'MPC'});
});
test('Spot fallback only when enabled and independently sufficient',()=>{
 assert.deepEqual(eligibleSpotFallback(balances(4),1),{displayAccount:'SPOT',accountType:'SPOT',fundingSource:'CEX'});
 assert.equal(eligibleSpotFallback(balances(0.2),1),null);
 assert.equal(eligibleSpotFallback(balances(10,false),1),null);
 assert.equal(eligibleSpotFallback({ok:false,items:balances(10).items},1),null);
 assert.equal(eligibleSpotFallback({ok:true,items:[{accountType:'FUNDING',enabled:true,availableBalanceDisplay:'9'}]},1),null);
 assert.equal(eligibleSpotFallback(balances(10),NaN),null);
});
test('Fallback only on explicit MPC 4xx insufficient-funds rejection',()=>{
 for(const msg of ['Account has insufficient balance for requested action','Not enough funds','余额不足']){
  assert.equal(explicitMpcInsufficient({ok:false,status:400,data:{msg}}),true,msg);
 }
 for(const call of [
  {ok:false,status:0,network:true,error:'insufficient balance'},
  {ok:false,status:500,data:{msg:'insufficient balance'}},
  {ok:false,status:451,data:{msg:'insufficient balance'}},
  {ok:false,status:400,data:{msg:'invalid signature'}},
  {ok:false,status:400,data:{msg:'quote expired'}},
  {ok:true,status:200,data:{msg:'insufficient balance'}},
 ]){
  assert.equal(explicitMpcInsufficient(call),false,JSON.stringify(call));
 }
});
