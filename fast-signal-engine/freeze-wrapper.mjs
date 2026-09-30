import fs from 'node:fs';

const sourcePath = new URL('./index.mjs', import.meta.url);
let source = fs.readFileSync(sourcePath, 'utf8');

const stateMarker = "let candidateDirection = 'WAIT';\nlet candidateTicks = 0;";
if (!source.includes(stateMarker)) throw new Error('FREEZE_STATE_MARKER_NOT_FOUND');
source = source.replace(
  stateMarker,
  `${stateMarker}\nlet frozenRoundStart = null;\nlet frozenDirection = 'WAIT';\nlet frozenScore = 0;\nlet frozenConfidence = 0;\nlet frozenAt = null;`
);

const directionBlock = `  const direction = nextCandidate !== 'WAIT' && candidateTicks >= CONFIRM_TICKS ? nextCandidate : 'WAIT';\n  const confidence = direction === 'WAIT' ? 0 : Number(Math.min(0.99, Math.abs(score)).toFixed(4));\n  const round = roundInfo(now);`;
if (!source.includes(directionBlock)) throw new Error('FREEZE_DIRECTION_MARKER_NOT_FOUND');
source = source.replace(
  directionBlock,
  `  const rawDirection = nextCandidate !== 'WAIT' && candidateTicks >= CONFIRM_TICKS ? nextCandidate : 'WAIT';\n  const rawConfidence = rawDirection === 'WAIT' ? 0 : Number(Math.min(0.99, Math.abs(score)).toFixed(4));\n  const round = roundInfo(now);\n\n  if (frozenRoundStart !== round.start) {\n    frozenRoundStart = round.start;\n    frozenDirection = 'WAIT';\n    frozenScore = 0;\n    frozenConfidence = 0;\n    frozenAt = null;\n  }\n\n  if (frozenDirection === 'WAIT' && (rawDirection === 'UP' || rawDirection === 'DOWN')) {\n    frozenDirection = rawDirection;\n    frozenScore = Number(score.toFixed(6));\n    frozenConfidence = rawConfidence;\n    frozenAt = now;\n    console.log(JSON.stringify({\n      event: 'round_signal_frozen',\n      round: round.start,\n      direction: frozenDirection,\n      score: frozenScore,\n      confidence: frozenConfidence,\n      at: new Date(frozenAt).toISOString(),\n    }));\n  }\n\n  const direction = frozenDirection;\n  const confidence = direction === 'WAIT' ? 0 : frozenConfidence;`
);

const signalBlock = `    score: Number(score.toFixed(6)),\n    confidence,\n    generatedAt: now,\n    reason: direction === 'WAIT' && nextCandidate !== 'WAIT' ? 'CONFIRMING_DIRECTION' : reason,`;
if (!source.includes(signalBlock)) throw new Error('FREEZE_SIGNAL_MARKER_NOT_FOUND');
source = source.replace(
  signalBlock,
  `    score: direction === 'WAIT' ? Number(score.toFixed(6)) : frozenScore,\n    confidence,\n    generatedAt: direction === 'WAIT' ? now : frozenAt,\n    reason: direction === 'WAIT'\n      ? (nextCandidate !== 'WAIT' ? 'CONFIRMING_DIRECTION' : reason)\n      : 'ROUND_SIGNAL_FROZEN',`
);

const factsMarker = `      micropriceBps: Number(micropriceBps.toFixed(4)),`;
if (!source.includes(factsMarker)) throw new Error('FREEZE_FACTS_MARKER_NOT_FOUND');
source = source.replace(
  factsMarker,
  `${factsMarker}\n      liveCandidateDirection: rawDirection,\n      liveScore: Number(score.toFixed(6)),\n      frozenDirection,\n      frozenAt,`
);

const configMarker = `      staleMs: STALE_MS,`;
if (!source.includes(configMarker)) throw new Error('FREEZE_CONFIG_MARKER_NOT_FOUND');
source = source.replace(
  configMarker,
  `${configMarker}\n      freezePolicy: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',`
);

const bootMarker = `    event: 'fast_signal_engine_started',`;
if (!source.includes(bootMarker)) throw new Error('FREEZE_BOOT_MARKER_NOT_FOUND');
source = source.replace(
  bootMarker,
  `${bootMarker}\n    freezePolicy: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',`
);

console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));

const runtimePath = new URL('./.freeze-runtime-index.mjs', import.meta.url);
fs.writeFileSync(runtimePath, source, 'utf8');
await import(runtimePath.href + '?v=' + Date.now());
