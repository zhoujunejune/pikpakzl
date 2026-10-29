import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
const start=wrapper.indexOf('  async function guardianRetryMissingSignal(');
const tail='\n  }\n\n  // Overlap independent signal revalidation';
const end=wrapper.indexOf(tail,start);
assert.ok(start>=0 && end>start,'GUARDIAN_RECHECK_HELPER_MISSING');
const body=wrapper.slice(start,end+4);
const retry=vm.runInNewContext(body+'\n guardianRetryMissingSignal;',{Promise,setTimeout});
const sleep=async()=>{};

test('missing live signal retries twice at most and accepts independently re-read lock',async()=>{
  let n=0;
  const locked={status:'LOCKED',round:1793287200000,direction:'UP',signalId:'immutable'};
  const delays=[];
  const result=await retry(async()=>++n===2?locked:null,null,()=>true,async ms=>delays.push(ms));
  assert.equal(result.signal,locked);
  assert.equal(result.retries,2);
  assert.deepEqual(delays,[160,260]);
});

test('an existing but conflicting signal is never retried or replaced',async()=>{
  const conflicting={status:'LOCKED',direction:'DOWN',signalId:'different'};
  let reads=0;
  const result=await retry(async()=>{reads++;return null;},conflicting,()=>true,sleep);
  assert.equal(result.signal,conflicting);
  assert.equal(reads,0);
});

test('disabled follow or expired order window prevents retries',async()=>{
  let reads=0;
  const result=await retry(async()=>{reads++;return {};},null,()=>false,sleep);
  assert.equal(result.signal,null);
  assert.equal(result.retries,0);
  assert.equal(reads,0);
});

test('if the order is disabled while sleeping, no further read occurs',async()=>{
  let enabled=true,reads=0;
  const result=await retry(async()=>{reads++;return {};},null,()=>enabled,async()=>{enabled=false});
  assert.equal(result.signal,null);
  assert.equal(result.retries,0);
  assert.equal(reads,0);
});

test('production path still requires immutable Guardian identity, quote and round gates',()=>{
  const i=wrapper.indexOf('  if (!selectedSignalMatches(p) || !current || current.status');
  assert.ok(i>0);
  const block=wrapper.slice(i,i+1000);
  for(const clause of ['current.signalId!==p.signalId','current.executionEligible!==true',
    'current.direction!==p.productionSignal','String(current.round) !== String(p.round)',
    'pendingOrderMatchesProduction(p,current)'])
    assert.ok(block.includes(clause),clause);
  assert.ok(wrapper.includes("getSignal({forceHttp:true})"));
  assert.ok(wrapper.includes("orderSubmitWindowOpen(p.round,Date.now(),p.signalModelChoice)"));
  assert.ok(wrapper.includes("guardianQuoteGate(current,quote,{now:Date.now()})"));
});
