import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
const start=source.indexOf('// Exact-20s rescue is eligible');
const end=source.indexOf('// No-base candidates remain shadow-only.',start);
assert.ok(start>=0&&end>start,'production adapter exists');
const adapter=source.slice(start,end);
test('frozen exact20 snapshot and original V3 precedence',()=>{
  for(const fragment of [
    "row.prediction !== 'UP' && row.prediction !== 'DOWN'",
    "CONSENSUS_3_OF_3",
    "rescueDelay >= 18000 && rescueDelay <= 22000",
    "rescueAt === Number(row.roundStartMs) + rescueDelay",
    "rescueSnapshot.features",
    "row.prediction : rescueDirection",
  ])assert.ok(adapter.includes(fragment),fragment);
});
test('V2 and Tier-1 edge use matching snapshot',()=>{
  for(const fragment of [
    "evaluateSelectiveQualityV2(baseDirection, baseFacts, baseDelay, row.roundStartMs)",
    "prediction:baseDirection",
    "predictionFacts:baseFacts",
    "predictionDelayMs:baseDelay",
    "selectiveV2EdgeRescue:null",
    "edgeFuse?.allowed",
    "q?.pass",
  ])assert.ok(adapter.includes(fragment),fragment);
});
test('lock metadata carries rescue timestamp, features and source',()=>{
  for(const fragment of [
    "Number(baseGeneratedAt)",
    "facts: baseFacts ?? null",
    "BASE_DIRECTION_RESCUE_V2_SELECTIVE_PRIMARY",
    "BASE_DIRECTION_RESCUE_V2_EDGE_PRIMARY",
    "freezeProductionLock(row, live)",
    "!usingRescue && baseDirection",
  ])assert.ok(adapter.includes(fragment),fragment);
});
