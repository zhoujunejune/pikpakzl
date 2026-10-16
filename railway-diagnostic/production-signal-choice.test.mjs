import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 BASE_MODEL,NOVICE_MODEL,MODEL_CHOICE_KEY,ORDER_SIGNAL_MODELS,
 snapshot,selectionPermitsRound,selectedSignalMatches,validateNoviceSignal,
 setModelSelection,invalidate
} from './production-signal-choice.mjs';

const ROUND=1792166400000;
const good=(at=ROUND+6500)=>({
 ok:true,readOnly:true,orders:false,productionIntegration:false,model:NOVICE_MODEL,
 generatedAt:at-40,
 latest:{model:NOVICE_MODEL,round:ROUND,direction:'DOWN',status:'LOCKED',
   lockedAt:ROUND+5190,marketSnapshotAt:ROUND+5150,score:-.42}
});
test('strict closed model whitelist and read-only shadow trust boundary',()=>{
 assert.deepEqual(ORDER_SIGNAL_MODELS.map(x=>x.id),[BASE_MODEL,NOVICE_MODEL]);
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
 await assert.rejects(()=>setModelSelection(NOVICE_MODEL,''),/INVALID_EXPECTED_REVISION/);
});
test('production implementation contains actual source switching, PIN and final order guards',()=>{
 const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
 const index=read('./index.mjs'),wrapper=read('./wrapper.mjs'),panel=read('./panel-stats-shell.mjs');
 assert.match(index,/\/api\/order-signal-model/);
 assert.match(index,/setModelSelection\(body\.model,body\.expectedRevision\)/);
 assert.match(index,/if\(!pinOK\(body\.pin\)\)/);
 assert.match(index,/NOVICE_LOCAL_URL/);
 assert.match(index,/validateNoviceSignal\(await r\.json\(\)\)/);
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
