import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FROZEN_VIP75_VERSION,PINNED_WEIGHT_FINGERPRINT,inspectFrozenVip75Artifact,createFrozenVip75Fast8Probe } from './vip75-frozen8-probe.mjs';

function fixture(){
  return {schemaVersion:3,version:'INDEPENDENT_DIRECTION_REGIME_ADAPTIVE_V3',
    model:{version:FROZEN_VIP75_VERSION,trainingSamples:718,selectedTrainingWindow:320,halfLife:180,
      l2:0.12,regimeBlend:0.3,featureKeys:Array.from({length:22},(_,i)=>'f'+i),
      weights:Array(23).fill(0),regimeWeights:{TREND:Array(23).fill(0),RANGE:Array(23).fill(0)}}};
}
function withArtifact(obj,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vip75-frozen8-'));
  try{const file=path.join(dir,'state.json');fs.writeFileSync(file,JSON.stringify(obj));return fn(file);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('requires exact immutable trained weights, not only version name and parameters',()=>{
  withArtifact(fixture(),file=>{
    const result=inspectFrozenVip75Artifact(file);
    assert.equal(result.ready,false);
    assert.equal(result.reason,'FROZEN_WEIGHT_FINGERPRINT_MISMATCH');
    assert.equal(PINNED_WEIGHT_FINGERPRINT.length,64);
  });
});
test('rejects modified training parameters, truncated weights and replacement model',()=>{
  const mismatched=fixture();mismatched.model.l2=0.025;
  withArtifact(mismatched,file=>assert.equal(inspectFrozenVip75Artifact(file).reason,'FROZEN_PARAMETER_MISMATCH'));
  const invalid=fixture();invalid.model.weights=[1,2,3];
  withArtifact(invalid,file=>assert.equal(inspectFrozenVip75Artifact(file).reason,'FROZEN_WEIGHTS_MISSING_OR_INVALID'));
  const newer=fixture();newer.model.version=FROZEN_VIP75_VERSION+'_RETRAINED';
  withArtifact(newer,file=>assert.equal(inspectFrozenVip75Artifact(file).reason,'FROZEN_VERSION_NOT_CURRENT_ARTIFACT'));
});
test('refuses to manufacture a VIP75 prediction without correct original weights',()=>{
  withArtifact(fixture(),file=>{
    const engine=createFrozenVip75Fast8Probe({file});
    assert.equal(engine.load().ready,false);
    const t=1800000000000;
    const facts={regimeScore:0.2,currentScore:0.5,microScore:0.2,currentTrendScore:0.4};
    assert.equal(engine.observe({round:t,facts},t+2000),null);
    assert.equal(engine.decision(t),null);
    assert.equal(engine.report().hasCandidate,false);
    assert.equal(engine.observe({round:t+300000,facts},t+300000+8001),null);
  });
});
