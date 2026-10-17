import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source=readFileSync(fileURLToPath(new URL('./index-rest.mjs',import.meta.url)),'utf8');
test('pause flag scoped to 8-second production routes, reversible for legacy mode',()=>{
  assert.match(source,/const PAUSE_NONPROD_SHADOWS = \[FAST8_MODE, SELECTIVE_V2_FAST8_MODE, MARKET_FUSION_FAST8_MODE, BREAKOUT20_MODE\]\.includes\(PRODUCTION_SIGNAL_SOURCE_MODE\)/);
  assert.match(source,/process\.env\.PAUSE_NONPROD_SHADOWS \|\| '1'/);
  assert.match(source,/if \(PAUSE_NONPROD_SHADOWS\) \{\s*\/\/ Retain topic hints/);
  assert.match(source,/if \(!PAUSE_NONPROD_SHADOWS\) \{\s*loadShadowModelArtifact\(\)/);
  assert.match(source,/if \(!PAUSE_NONPROD_SHADOWS\) \{\s*loadShadowCandidateArtifact\(\)/);
});
test('FAST8 and official settlements still run independent of shadow pause',()=>{
  const observe=source.indexOf('fast8.observe(live, Date.now());');
  const pauseReturn=source.indexOf('if (PAUSE_NONPROD_SHADOWS) {\n      // Retain topic hints');
  assert.ok(observe>=0 && pauseReturn>observe,'FAST8 must observe before shadows are skipped');
  assert.match(source,/\bfast8\.start\(\);/);
  assert.match(source,/\bfast8\.settle\(row\);/);
  assert.match(source,/\bapplyOfficialSettlement\(row, direction, evidence, Date\.now\(\)\);/);
  assert.match(source,/\barchiveSettledRow\(row, archiveReason\)/);
  assert.match(source,/\bsetInterval\(settlePendingRounds, SETTLE_POLL_MS\)/);
  assert.match(source,/\bsetInterval\(pollSignal, POLL_MS\)/);
  assert.match(source,/\bfast8ProductionReadiness\(/);
});
test('nonproduction training and observation remain gated but code and artifacts are retained',()=>{
  assert.match(source,/if \(!PAUSE_NONPROD_SHADOWS\) \{\s*maybeTrainShadowModel\(\);/);
  assert.match(source,/if \(!PAUSE_NONPROD_SHADOWS\) \{\s*settleShadowForwardRegistry\(row\);/);
  assert.match(source,/if \(!PAUSE_NONPROD_SHADOWS\) \{\s*log\('shadow35_training_status'/);
  assert.match(source,/modelArtifactsPreserved:true, fast8TrainingActive:true/);
  assert.doesNotMatch(source,/\bfs\.rmSync\(SHADOW_V3_DIR/);
});
