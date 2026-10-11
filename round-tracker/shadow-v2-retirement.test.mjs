import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShadowV2Engine } from './shadow-v2.mjs';

const ENGINE_VERSION = 'ROLLING_GBDT_REGIME_PROGRESSIVE_V2_2';

function makeCandidate(hits, n) {
  return {
    modelVersion:'shadow-v2-gbdt-test',
    engineVersion:ENGINE_VERSION,
    threshold:0.5,
    observations:Array.from({length:n}, (_,i)=>({
      roundStartMs:(i+1)*300000,
      probability:0.9,
      actual:i<hits?'UP':'DOWN',
    })),
  };
}

function loadFixture(candidate) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-v2-retire-'));
  const file=path.join(dir,'registry.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion:1,
    lastTrainRound:1791728700000,
    candidates:[candidate],
  }));
  const client=createShadowV2Engine({file,forwardTarget:60,log:()=>{}});
  client.load();
  return {dir,file,client};
}

test('completed 68.3% forward candidate is deleted without leaving a registry record',()=>{
  const {dir,file,client}=loadFixture(makeCandidate(41,60));
  try {
    assert.equal(client.stats().candidates.length,0);
    const stored=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.deepEqual(stored.candidates,[]);
    assert.equal(stored.lastTrainRound,1791728700000);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('forward-qualified candidate and immature candidate are preserved',()=>{
  for (const candidate of [makeCandidate(43,60),makeCandidate(10,19)]) {
    const {dir,client}=loadFixture(candidate);
    try { assert.equal(client.stats().candidates.length,1); }
    finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }
});
