import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 BASE_MODEL,NOVICE_MODEL,DYNAMIC_MODEL,EDGE_MODEL,MODEL_CHOICE_KEY,ORDER_SIGNAL_MODELS,
 snapshot,selectionPermitsRound,selectedSignalMatches,validateNoviceSignal,validateDynamicEntrySignal,validateEdgeSignal,
 setModelSelection,invalidate,retryableRejectedOrderPost,MAX_ORDER_SUBMIT_ATTEMPTS
} from './production-signal-choice.mjs';

const ROUND=1792166400000;
const good=(at=ROUND+6500)=>({
 ok:true,readOnly:true,orders:false,productionIntegration:false,model:NOVICE_MODEL,inputVersion:'RSI_ONLY_14_V1',
 generatedAt:at-40,
 latest:{model:NOVICE_MODEL,inputVersion:'RSI_ONLY_14_V1',rsi:37,round:ROUND,direction:'DOWN',status:'LOCKED',
   lockedAt:ROUND+5190,marketSnapshotAt:ROUND+5150,score:-.42}
});
test('strict closed model whitelist and read-only shadow trust boundary',()=>{
 assert.deepEqual(ORDER_SIGNAL_MODELS.map(x=>x.id),[BASE_MODEL,EDGE_MODEL]);
 assert.ok(!ORDER_SIGNAL_MODELS.some(x=>x.id===NOVICE_MODEL||x.id===DYNAMIC_MODEL));
 assert.equal(MODEL_CHOICE_KEY,'trade-control:order-signal-choice:v1');
 assert.equal(validateNoviceSignal(good(),ROUND+6500).ok,true);
 for(const changed of [
  {orders:true},{readOnly:false},{productionIntegration:true},{model:BASE_MODEL},
  {latest:{...good().latest,round:ROUND-300000}},
  {latest:{...good().latest,status:'NO_DATA_FALLBACK'}},
  {latest:{...good().latest,status:'PENDING'}},
  {latest:{...good().latest,direction:'WAIT'}},
  {latest:{...good().latest,lockedAt:ROUND+8000}},
  {latest:{...good().latest,marketSnapshotAt:ROUND-1000}},
  {latest:{...good().latest,score:null}},
  {inputVersion:'MIXED_7_FACTORS'},
  {latest:{...good().latest,inputVersion:'MIXED_7_FACTORS'}},
  {latest:{...good().latest,direction:'UP',rsi:37}},
  {generatedAt:ROUND-10000}
 ])assert.equal(validateNoviceSignal({...good(),...changed},ROUND+6500).ok,false,
   JSON.stringify(changed));
 assert.equal(validateNoviceSignal(good(),ROUND+16000).ok,false);
 assert.equal(validateNoviceSignal(null,ROUND+6500).ok,false);
});
test('every selection change invalidates pre-existing orders and current round',()=>{
 const first={ready:true,model:BASE_MODEL,revision:'rev1',effectiveAfterRound:null};
 const changed={ready:true,model:NOVICE_MODEL,revision:'rev2',effectiveAfterRound:ROUND};
 const pending={round:ROUND,signalModelChoice:BASE_MODEL,signalModelChoiceRevision:'rev1'};
 assert.equal(selectionPermitsRound(ROUND,first),true);
 assert.equal(selectionPermitsRound(ROUND,changed),false);
 assert.equal(selectionPermitsRound(ROUND+300000,changed),true);
 assert.equal(selectedSignalMatches(pending,first),true);
 assert.equal(selectedSignalMatches(pending,changed),false);
 assert.equal(selectedSignalMatches({...pending,round:ROUND+300000},changed),false);
 assert.equal(selectedSignalMatches({round:ROUND+300000,signalModelChoice:NOVICE_MODEL,
   signalModelChoiceRevision:'rev2'},changed),true);
 invalidate();
 assert.equal(snapshot().ready,false);
 assert.equal(selectionPermitsRound(ROUND+300000),false);
});
test('invalid model cannot modify Redis or the production configuration',async()=>{
 await assert.rejects(()=>setModelSelection('TRAINING_INTERNAL_UNUSED','revision'),/INVALID_MODEL_CHOICE/);
 await assert.rejects(()=>setModelSelection(BASE_MODEL,''),/INVALID_EXPECTED_REVISION/);
 await assert.rejects(()=>setModelSelection(NOVICE_MODEL,'any-valid-revision'),/INVALID_MODEL_CHOICE/);
 await assert.rejects(()=>setModelSelection(DYNAMIC_MODEL,'any-valid-revision'),/INVALID_MODEL_CHOICE/);
});
test('production implementation contains actual source switching, PIN and final order guards',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const index=read('./index.mjs'),wrapper=read('./wrapper.mjs'),panel=read('./panel-stats-shell.mjs');
 assert.match(index,/\/api\/order-signal-model/);
 assert.match(index,/setModelSelection\(body\.model,body\.expectedRevision\)/);
 assert.match(index,/if\(!pinOK\(body\.pin\)\)/);
 assert.match(index,/NOVICE_LOCAL_URL/);
 assert.match(index,/validateNoviceSignal\(body\)/);
 assert.match(index,/\[NOVICE_MODEL,BASE_MODEL,DYNAMIC_MODEL,EDGE_MODEL\]\.includes\(choice\.model\)/);
 assert.match(index,/RSI_INPUT_VERSION/);
 assert.match(index,/railway_rsi14_readonly/);
 assert.match(index,/rawDirection:verified.direction,randomFlipApplied:false/);
 assert.match(index,/signalOutputMode:'RSI14_DIRECT_V1'/);
 assert.ok(index.includes("signalRandomFlipApplied: signal?.status==='LOCKED'?false:null"));
 assert.doesNotMatch(index,/applyRandomSignalFlip|shouldFlipSignal/);
 assert.match(index,/if\(signalOverride && choice\.model!==BASE_MODEL\)return/);
 assert.match(index,/startAfterRound=currentRoundMs\(\)/);
 assert.match(index,/signalModelChoice:choice\.model/);
 assert.match(wrapper,/selectedSignalMatches\(p\)/);
 assert.match(wrapper,/refreshModelSelection\(\)/);
 assert.match(wrapper,/rejectExpiredOrderWindow\(p, 'before_place_order'\)/);
 assert.match(panel,/id="orderSignalModelSelect"/);
 assert.match(panel,/saveOrderModelChoice/);
 assert.match(panel,/chosenModelName/);
});

test('API status and UI resolve actual selected order model rather than missing legacy field',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const index=read('./index.mjs'),ui=read('./panel-stats-shell.mjs');
 const api=index.slice(index.indexOf("if (req.method === 'GET' && url.pathname === '/api/status')"));
 assert.match(api,/orderSignalModel:modelSelectionSnapshot\(\)\.model/);
 assert.match(api,/orderSignalModelReady:modelSelectionSnapshot\(\)\.ready/);
 assert.match(ui,/chosenModelName\(chosenOrderModel\)/);
 assert.doesNotMatch(ui,/chosenModelName\(j\.orderSignalModel\)/);
 assert.doesNotMatch(ui,/if\(j\.orderSignalModel===/);
});

test('dynamic signal is selectable only for real frozen, fresh in-round entry',()=>{
 const at=ROUND+132000,entryAt=ROUND+124000;
 const valid={
   ok:true,model:DYNAMIC_MODEL,readOnly:true,orders:false,productionIntegration:false,
   statsScope:'STRICT_FORWARD_VIRTUAL_ENTRIES_OFFICIAL_RESOLUTION_ONLY',
   generatedAt:at-50,health:{marketError:null},timed:{lastGoodDataAt:at-250},
   latest:{model:DYNAMIC_MODEL,round:ROUND,entry:{direction:'DOWN',at:entryAt,
      marketAt:entryAt-350,score:-0.3,strength:0.29,modelVersion:'HEURISTIC_V2_ADAPTIVE_GATE'}}
 };
 assert.equal(validateDynamicEntrySignal(valid,at).ok,true);
 const invalid=[
  {orders:true},{readOnly:false},{productionIntegration:true},{model:NOVICE_MODEL},
  {generatedAt:at-7000},{health:{marketError:'STALE_OR_INCOMPLETE_LIVE_INPUT'}},
  {timed:{lastGoodDataAt:at-10000}},
  {latest:{...valid.latest,round:ROUND-300000}},
  {latest:{...valid.latest,entry:null}},
  {latest:{...valid.latest,entry:{...valid.latest.entry,direction:'WAIT'}}},
  {latest:{...valid.latest,entry:{...valid.latest.entry,at:ROUND-1000}}},
  {latest:{...valid.latest,entry:{...valid.latest.entry,marketAt:at+500}}},
  {latest:{...valid.latest,entry:{...valid.latest.entry,score:NaN}}},
 ];
 for(const fields of invalid)assert.equal(validateDynamicEntrySignal({...valid,...fields},at).ok,false,JSON.stringify(fields));
 assert.equal(validateDynamicEntrySignal(valid,entryAt+45001).ok,false);
 assert.equal(validateDynamicEntrySignal(valid,ROUND+285000).ok,false);
});
test('dynamic selector honors PIN, next round and unchanged direction mapping',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const backend=read('./index.mjs'),wrapper=read('./wrapper.mjs'),panel=read('./panel-stats-shell.mjs');
 assert.match(backend,/DYNAMIC_LOCAL_URL/);
 assert.match(backend,/validateDynamicEntrySignal\(await response\.json\(\)\)/);
 assert.match(backend,/if\(choice\.model===DYNAMIC_MODEL&&signal\.upstreamModel!==DYNAMIC_MODEL\)return/);
 assert.match(wrapper,/DYNAMIC_ORDER_DEADLINE_MS = 285000/);
 assert.match(wrapper,/current\.signalId!==p\.signalId/);
 assert.doesNotMatch(panel,/<option value="DYNAMIC_ENTRY_5M_SHADOW_V1">/);
 assert.doesNotMatch(panel,/<option value="NOVICE_MIX_LOW_V1">/);
 assert.doesNotMatch(panel,/dynamicEntryShadow\.start\(\)/);
 assert.match(panel,/<option value="EDGE_5M_V1">/);
 assert.match(panel,/renderDynamicRoundStats/);
 assert.match(panel,/renderDynamicPrimary/);
 assert.match(panel,/saveOrderModelChoice/);
});

test('order attempts enforce one real POST per round and no blind retries',()=>{
 assert.equal(MAX_ORDER_SUBMIT_ATTEMPTS,1);
 const accepted=(reason,status=400)=>({ok:false,status,data:{msg:reason}});
 for(const reason of ['QUOTE_EXPIRED','INVALID_QUOTE','PRICE_CHANGED','REQUOTE_REQUIRED','SLIPPAGE_EXCEEDED'])
   assert.equal(retryableRejectedOrderPost(accepted(reason)),true,reason);
 for(const request of [
   {ok:true,status:200,data:{}},
   {ok:false,network:true,status:0,data:{msg:'QUOTE_EXPIRED'}},
   {ok:false,status:0,data:{msg:'QUOTE_EXPIRED'}},
   {ok:false,status:500,data:{msg:'QUOTE_EXPIRED'}},
   {ok:false,status:502,data:{msg:'PRICE_CHANGED'}},
   {ok:false,status:451,data:{msg:'QUOTE_EXPIRED'}},
   {ok:false,status:403,data:{msg:'PRICE_CHANGED'}},
   accepted('Service unavailable from a restricted location'),
   accepted('INSUFFICIENT_BALANCE'),accepted('UNAUTHORIZED'),
   accepted('Generic order failure'),accepted('NOT_ENOUGH_FUNDS'),
   {ok:false,status:429,data:{msg:'QUOTE_EXPIRED'}}
 ]) assert.equal(retryableRejectedOrderPost(request),false,JSON.stringify(request));
});

test('retry in actual server always takes a fresh quote and a Redis POST slot',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const backend=read('./index.mjs'),wrapper=read('./wrapper.mjs'),choice=read('./production-signal-choice.mjs');
 assert.match(backend,/claimOrderSubmitAttempt,closeOrderSubmitRound,releaseRejectedOrderSubmitAttempt,retryableRejectedOrderPost/);
 assert.match(wrapper,/retryableRejectedOrderPost\(call\)/);
 assert.match(wrapper,/orderPostClaim\.attempt<MAX_ORDER_SUBMIT_ATTEMPTS/);
 assert.match(wrapper,/const nextQuote=await getFreshQuote\(intent\)/);
 assert.match(wrapper,/placeBody\.quoteId=quote\.quoteId/);
 assert.match(wrapper,/currentRetry\.signalId!==p\.signalId/);
 assert.match(wrapper,/claimOrderSubmitAttempt\(p\.round\)/);
 assert.match(wrapper,/closeOrderSubmitRound\(p\.round,'UNKNOWN'\)/);
 assert.match(wrapper,/closeOrderSubmitRound\(p\.round,'SUBMITTED'\)/);
 assert.match(wrapper,/releaseRejectedOrderSubmitAttempt\(p\.round,orderPostClaim\.attempt\)/);
 assert.match(choice,/IN_FLIGHT:/);
 assert.match(choice,/CLAIM_POST_SCRIPT/);
 assert.match(choice,/redis\.call\('INCR',KEYS\[1\]\)/);
});


test('EDGE fourth model never reuses old predictions and rejects uncalibrated execution',()=>{
 const now=ROUND+6400;
 const baseline={ok:true,model:EDGE_MODEL,inputVersion:'EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1',
   readOnly:true,orders:false,productionIntegration:false,
   statsScope:'EDGE5_CAUSAL_OFFICIAL_RESOLUTION_ONLY',generatedAt:now-50,
   health:{marketError:null},training:{ready:false,calibrationReady:false,samples:0,version:null},
   latest:{round:ROUND,status:'LOCKED',direction:'UP',lockedAt:ROUND+6000,
     marketAt:ROUND+5800,score:0.18,inputVersion:'EDGE5_REAL_ORDERBOOK_FLOW_BASIS_V1',
     modelVersion:'EDGE5_UNCALIBRATED_PROBE',calibrationReady:false,
     executionEligible:false,modelProbability:null}};
 const observing=validateEdgeSignal(baseline,now);
 assert.equal(observing.ok,true);assert.equal(observing.executionEligible,false);
 assert.equal(observing.modelProbability,null);
 for(const patch of [{orders:true},{readOnly:false},{latest:{...baseline.latest,round:ROUND-300000}},
   {latest:{...baseline.latest,lockedAt:ROUND+8000}},
   {latest:{...baseline.latest,marketAt:ROUND+10000}},
   {generatedAt:now-5000}]){
   assert.equal(validateEdgeSignal({...baseline,...patch},now).ok,false,JSON.stringify(patch));
 }
 const modelVersion='EDGE5_OFFICIAL_5000_'+(ROUND-300000);
 const ready={...baseline,training:{ready:true,calibrationReady:true,samples:5000,version:modelVersion},
  latest:{...baseline.latest,modelVersion,modelProbability:.68,
   calibrationReady:true,executionEligible:true}};
 assert.equal(validateEdgeSignal(ready,now).executionEligible,true);
 assert.equal(validateEdgeSignal({...ready,health:{marketError:'BYBIT_FRESH_TRADES_UNAVAILABLE'}},now).executionEligible,true);
 assert.equal(validateEdgeSignal({...ready,latest:{...ready.latest,modelProbability:.45}},now).ok,false);
});
test('EDGE quote gating is independent of previous three model paths',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const wrapper=read('./wrapper.mjs'),panel=read('./panel-stats-shell.mjs'),service=read('./edge-5m-service.mjs');
 assert.match(wrapper,/if \(p\.signalModelChoice===EDGE_MODEL\)/);
 assert.match(wrapper,/EDGE_ORDER_DEADLINE_MS = 8000/);
 assert.doesNotMatch(wrapper,/EDGE5_NOT_CALIBRATED/);
 assert.match(wrapper,/EDGE5_QUOTE_INVALID/);
 assert.match(panel,/<option value="EDGE_5M_V1">/);
 assert.match(panel,/renderEdgePrimary/);
 assert.match(panel,/renderEdgeRoundStats/);
 assert.match(service,/verifiedOfficialRoundDirections/);
 assert.doesNotMatch(service,/signedPost|place-order-bundle/);
});
