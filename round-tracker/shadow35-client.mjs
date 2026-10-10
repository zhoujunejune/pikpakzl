import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { summarizeShadow35Validation } from './shadow35-validation.mjs';

export const SHADOW35_VERSION = 'LOCK_QUALITY_SELECTIVE_V7_5';
// This is a naming change: replay the existing prospective experiment rather
// than resetting its calendar, samples, immutable decisions or frozen model.
const JOURNAL_VERSIONS = new Set([SHADOW35_VERSION, 'SHADOW35_PROBABILITY_V1']);
const ROUND_MS = 300000;
const DEADLINE_MS = 35000;
const FORWARD_MS = 30 * 86400000;
const CHECKPOINTS = [15000, 20000, 25000, 30000, 35000];
const FEATURE_KEYS = [
  'currentScore', 'currentTrendScore', 'microScore', 'regimeScore', 'regimeAgreement',
  'liveScore', 'distanceFromOpenBps', 'normalizedMomentum5s', 'normalizedMomentum15s',
  'normalizedMomentum30s', 'normalizedMomentum60s', 'normalizedMomentum180s',
  'normalizedMomentum300s', 'tradePressure15s', 'tradePressure60s', 'ofiNormalized5s',
  'rangePosition180', 'predictionMarketUpMid', 'tradeCount5s', 'tradeCount15s',
  'vol5sRms60', 'vol5sRms300', 'spreadBps', 'absorptionRisk',
];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const direction = value => value === 'UP' || value === 'DOWN';

function runPython(action, input) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('./shadow35-model.py', import.meta.url));
    const child = spawn('python3', [script, action], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), action === 'train' ? 120000 : 10000);
    child.stdout.on('data', chunk => {
      if (output.length < 1048576) output += chunk.toString();
      else child.kill('SIGKILL');
    });
    // Do not expose arbitrary child output or configuration in HTTP stats/logs.
    child.stderr.resume();
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    child.on('error', () => finish(new Error('PYTHON_START_FAILED')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0) return finish(new Error('PYTHON_PROCESS_FAILED'));
      const line = output.split('\n').findLast(x => x.startsWith('SHADOW35_RESULT='));
      try {
        if (!line) throw new Error();
        finish(null, JSON.parse(line.slice('SHADOW35_RESULT='.length)));
      } catch { finish(new Error('PYTHON_RESULT_INVALID')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createShadow35Client({ dir = '/data/shadow35', log = () => {},
  clock = Date.now, runner = runPython, minRounds = 300 } = {}) {
  const eventsFile = path.join(dir, 'events.jsonl');
  const modelDir = path.join(dir, 'models');
  const rows = new Map();
  let collectionStart = null;
  let finalizeCursor = null;
  let model = null;
  let trainingBusy = false;
  let lastTrainingCount = 0;
  let lastTraining = null;
  let lastError = null;
  let journalReady = false;
  let queue = Promise.resolve();

  function rowState(start) {
    if (!rows.has(start)) rows.set(start, { snapshots: new Map(), decision: null, final: null, settlement: null });
    return rows.get(start);
  }
  function apply(event) {
    if (event.type === 'collection_started') {
      collectionStart = event.roundStartMs;
      finalizeCursor = collectionStart;
    } else if (event.type === 'model_registered') model = event;
    else if (event.type === 'training_attempt') {
      lastTrainingCount = event.settledRounds;
      lastTraining = { status: 'TRAINING', attemptedAt: event.attemptedAt, settledRounds: event.settledRounds };
    } else if (event.type === 'training_result') {
      lastTraining = { ...lastTraining, status: event.status, completedAt: event.completedAt };
    }
    else if (finite(event.roundStartMs)) {
      const state = rowState(event.roundStartMs);
      if (event.type === 'snapshot') state.snapshots.set(event.checkpointMs, event);
      if (event.type === 'decision' && !state.decision) state.decision = event;
      if (event.type === 'round_final') state.final = event;
      if (event.type === 'settlement') state.settlement = event;
    }
  }
  function append(event) {
    const saved = { schemaVersion: 1, version: SHADOW35_VERSION, ...event };
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(saved) + '\n', 'utf8');
      apply(saved);
      if (lastError === 'JOURNAL_WRITE_FAILED') lastError = null;
      return true;
    } catch {
      lastError = 'JOURNAL_WRITE_FAILED';
      log('shadow35_error', { reason: lastError });
      return false;
    }
  }
  function load() {
    journalReady = false;
    try {
      fs.mkdirSync(modelDir, { recursive: true });
      if (fs.existsSync(eventsFile)) {
        const body = fs.readFileSync(eventsFile, 'utf8');
        const lines = body.split('\n');
        // A crash can leave an incomplete last append. Remove that partial tail
        // before any new event is appended, while rejecting corrupt full records.
        if (lines.at(-1) !== '') {
          const lastNewline = body.lastIndexOf('\n');
          fs.truncateSync(eventsFile, Buffer.byteLength(body.slice(0, lastNewline + 1)));
          lines.pop();
        }
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (!JOURNAL_VERSIONS.has(event.version) || event.schemaVersion !== 1) continue;
          apply(event);
        }
      }
      if (collectionStart === null && !append({ type: 'collection_started', roundStartMs: Math.ceil(clock() / ROUND_MS) * ROUND_MS })) return false;
      while (rowState(finalizeCursor).final) finalizeCursor += ROUND_MS;
      journalReady = true;
      if (lastTraining?.status === 'TRAINING' && !model) {
        append({ type: 'training_result', status: 'TRAINING_INTERRUPTED', completedAt: clock() });
      }
      return true;
    } catch {
      lastError = 'JOURNAL_LOAD_FAILED';
      log('shadow35_error', { reason: lastError });
      return false;
    }
  }
  function finalizeThrough(now) {
    if (finalizeCursor === null) return;
    while (finalizeCursor + DEADLINE_MS < now) {
      const state = rowState(finalizeCursor);
      if (!state.final) {
        const saved = append({ type: 'round_final', roundStartMs: finalizeCursor,
          deadlineAt: finalizeCursor + DEADLINE_MS, finalizedAt: now,
          direction: state.decision?.direction || 'WAIT',
          reason: state.decision ? null : state.snapshots.size ? 'NO_ELIGIBLE_PREDICTION_BY_35S' : 'NO_SNAPSHOT_COLLECTED',
          modelVersion: state.decision?.modelVersion || model?.modelVersion || null });
        if (!saved) break;
      }
      finalizeCursor += ROUND_MS;
    }
  }
  function snapshotFor(row, live, checkpointMs, now, missed) {
    const facts = live?.facts || {};
    const sourceAt = live?.factsCalculatedAt;
    const start = row.roundStartMs;
    const reasons = [];
    const windowStart = checkpointMs === DEADLINE_MS ? 34000 : checkpointMs;
    if (missed) reasons.push('CHECKPOINT_MISSED');
    if (direction(row.actual) || row.settledAt != null) reasons.push('ROUND_ALREADY_SETTLED');
    if (live?.round !== start) reasons.push('SOURCE_ROUND_MISMATCH');
    if (!finite(sourceAt)) reasons.push('MISSING_SOURCE_TIMESTAMP');
    else {
      if (sourceAt > now) reasons.push('FUTURE_SOURCE_TIMESTAMP');
      if (Math.floor(sourceAt / ROUND_MS) * ROUND_MS !== start) reasons.push('SOURCE_TIME_ROUND_MISMATCH');
      // Upstream evaluations precede HTTP receipt by a small transport delay.
      if (now - sourceAt > 1000 || sourceAt < start + windowStart - 1000) reasons.push('STALE_FEATURE_SNAPSHOT');
    }
    if (!finite(facts.depthAgeMs) || facts.depthAgeMs < 0 || facts.depthAgeMs > 1500) reasons.push('DEPTH_STALE_OR_MISSING');
    if (!finite(facts.lastAggTradeAgeMs) || facts.lastAggTradeAgeMs < 0 || facts.lastAggTradeAgeMs > 12000 || facts.tradeStreamStalled === true) reasons.push('TRADE_STALE_OR_MISSING');
    if (!finite(facts.predictionMarketBookAgeMs) || facts.predictionMarketBookAgeMs < 0 || facts.predictionMarketBookAgeMs > 5000) reasons.push('PM_BOOK_STALE_OR_MISSING');
    if (facts.predictionMarketMappingReliable !== true) reasons.push('PM_MAPPING_UNRELIABLE');
    if (facts.predictionMarketRoundAligned !== true) reasons.push('PM_ROUND_NOT_ALIGNED');
    if (facts.predictionMarketRound !== start) reasons.push('PM_SOURCE_ROUND_MISMATCH');
    if (!finite(facts.predictionMarketTopicStartDate) || Math.abs(facts.predictionMarketTopicStartDate - start) > 30000 ||
        !finite(facts.predictionMarketTopicEndDate) || Math.abs(facts.predictionMarketTopicEndDate - (start + ROUND_MS)) > 30000) reasons.push('PM_TOPIC_TIME_MISMATCH');
    if (!finite(facts.predictionMarketUpMid) || facts.predictionMarketUpMid < 0 || facts.predictionMarketUpMid > 1) reasons.push('PM_MID_INVALID');
    if (finite(facts.predictionMarketUpdateTimestampMs) && facts.predictionMarketUpdateTimestampMs > now) reasons.push('FUTURE_PM_TIMESTAMP');
    if (now > start + DEADLINE_MS) reasons.push('OBSERVATION_AFTER_DEADLINE');
    const features = Object.fromEntries(FEATURE_KEYS.map(key => [key,
      key === 'absorptionRisk' ? (facts[key] === true ? 1 : facts[key] === false ? 0 : null)
        : finite(facts[key]) ? facts[key] : null]));
    if (['currentScore', 'currentTrendScore', 'microScore', 'liveScore', 'distanceFromOpenBps'].some(key => features[key] === null)) reasons.push('CORE_FEATURES_MISSING');
    return { type: 'snapshot', roundStartMs: start, checkpointMs, observedAt: now,
      factsCalculatedAt: finite(sourceAt) ? sourceAt : null,
      features: missed ? {} : features, valid: reasons.length === 0,
      reasons: [...new Set(reasons)],
      baseDirection: direction(live?.signal?.direction) ? live.signal.direction : null };
  }
  async function infer(snapshot, frozenModel) {
    const state = rowState(snapshot.roundStartMs);
    if (state.decision) return;
    if (clock() > snapshot.roundStartMs + DEADLINE_MS) {
      append({ type: 'prediction', roundStartMs: snapshot.roundStartMs,
        checkpointMs: snapshot.checkpointMs, modelVersion: frozenModel.modelVersion,
        completedAt: clock(), reason: 'PREDICTION_STARTED_AFTER_DEADLINE' });
      return;
    }
    try {
      const result = await runner('predict', { modelPath: frozenModel.modelPath, snapshot,
        features: snapshot.features, checkpointMs: snapshot.checkpointMs });
      const completedAt = clock();
      let reason = null;
      if (completedAt > snapshot.roundStartMs + DEADLINE_MS) reason = 'PREDICTION_COMPLETED_AFTER_DEADLINE';
      else if (completedAt < snapshot.observedAt) reason = 'PREDICTION_COMPLETED_BEFORE_OBSERVATION';
      else if (!result?.ok || !finite(result.probability) || result.probability < 0 || result.probability > 1 || result.modelVersion !== frozenModel.modelVersion) reason = 'INVALID_MODEL_PREDICTION';
      else if (Math.max(result.probability, 1 - result.probability) < frozenModel.threshold) reason = 'CALIBRATED_PROBABILITY_BELOW_THRESHOLD';
      if (lastError === 'MODEL_PREDICTION_FAILED' && result?.ok && finite(result.probability) &&
          result.probability >= 0 && result.probability <= 1 && result.modelVersion === frozenModel.modelVersion) lastError = null;
      append({ type: 'prediction', roundStartMs: snapshot.roundStartMs, checkpointMs: snapshot.checkpointMs,
        modelVersion: frozenModel.modelVersion, completedAt,
        probability: finite(result?.probability) ? result.probability : null, reason });
      if (!reason && !state.decision) append({ type: 'decision', roundStartMs: snapshot.roundStartMs,
        checkpointMs: snapshot.checkpointMs, factsCalculatedAt: snapshot.factsCalculatedAt,
        observedAt: snapshot.observedAt, completedAt, modelVersion: frozenModel.modelVersion,
        direction: result.probability >= 0.5 ? 'UP' : 'DOWN', probability: result.probability,
        threshold: frozenModel.threshold, productionEffect: 'NONE_SHADOW_ONLY' });
    } catch {
      lastError = 'MODEL_PREDICTION_FAILED';
      append({ type: 'prediction', roundStartMs: snapshot.roundStartMs,
        checkpointMs: snapshot.checkpointMs, modelVersion: frozenModel.modelVersion,
        completedAt: clock(), reason: lastError });
    }
    finalizeThrough(clock());
  }
  function observe(row, live, now = clock()) {
    if (!journalReady || collectionStart === null || !finite(now) || !finite(row?.roundStartMs)) return;
    finalizeThrough(now);
    const currentStart = Math.floor(now / ROUND_MS) * ROUND_MS;
    // A delayed/cross-round upstream packet cannot supply features to the current round.
    if (row.roundStartMs !== currentStart) row = { roundStartMs: currentStart };
    const start = row.roundStartMs;
    if (start < collectionStart || start % ROUND_MS !== 0 || now < start) return;
    const elapsed = now - start;
    const state = rowState(start);
    for (const checkpointMs of CHECKPOINTS) {
      if (state.snapshots.has(checkpointMs)) continue;
      const windowStart = checkpointMs === DEADLINE_MS ? 34000 : checkpointMs;
      const windowEnd = checkpointMs === DEADLINE_MS ? DEADLINE_MS : checkpointMs + 1000;
      if (elapsed < windowStart) continue;
      const snapshot = snapshotFor(row, live, checkpointMs, now, elapsed > windowEnd);
      if (!append(snapshot)) continue;
      if (snapshot.valid && !state.decision && model && start >= model.forwardStartMs && start < model.frozenUntilMs) {
        const frozenModel = model;
        queue = queue.then(() => infer(snapshot, frozenModel));
      }
    }
  }
  function settle(row) {
    if (!journalReady || collectionStart === null || !finite(row?.roundStartMs) || row.roundStartMs < collectionStart ||
        !direction(row.actual) || row.actualSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' ||
        !String(row.resolutionEvidence || '').startsWith('OFFICIAL_' + row.actual + ':') ||
        !String(row.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC') ||
        !finite(row.settledAt) || row.settledAt < row.roundStartMs + ROUND_MS || row.settledAt > clock()) return false;
    const prior = rowState(row.roundStartMs).settlement;
    if (prior?.actual === row.actual && prior?.resolutionEvidence === row.resolutionEvidence) return false;
    return append({ type: 'settlement', roundStartMs: row.roundStartMs, actual: row.actual,
      settledAt: row.settledAt, actualSource: row.actualSource, resolutionEvidence: row.resolutionEvidence,
      recordedAt: clock() });
  }
  function labeledValidRounds() {
    return [...rows.values()].filter(state => state.settlement && [...state.snapshots.values()].some(x => x.valid)).length;
  }
  async function maybeTrain() {
    const count = labeledValidRounds();
    // Once registered, keep this version for the complete forward experiment.
    // Retraining or promotion requires a separate explicitly configured experiment.
    const recovering = lastTraining?.status === 'TRAINING_INTERRUPTED';
    if (!journalReady || trainingBusy || model || count < minRounds || (!recovering && lastTrainingCount && count - lastTrainingCount < 20)) return null;
    trainingBusy = true;
    if (!append({ type: 'training_attempt', settledRounds: count, attemptedAt: clock() })) {
      trainingBusy = false; return null;
    }
    try {
      const result = await runner('train', { eventsFile, modelDir, asOf: clock(), minRounds,
        targetAccuracy: 0.8, targetCoverage: 0.45 });
      if (!result?.ok || !['CANDIDATE_REGISTERED', 'FROZEN_CANDIDATE_EXISTS'].includes(result.status)) {
        const status = typeof result?.status === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.status) ? result.status : 'INVALID_TRAINING_RESULT';
        append({ type: 'training_result', status, completedAt: clock() });
        return null;
      }
      const completedAt = clock();
      const modelPath = typeof result.modelPath === 'string' ? path.resolve(result.modelPath) : '';
      if (!modelPath.startsWith(path.resolve(modelDir) + path.sep) || !finite(result.trainedAt) || result.trainedAt > completedAt ||
          !finite(result.threshold) || result.threshold < 0.5 || result.threshold > 0.99 || typeof result.modelVersion !== 'string') {
        lastError = 'TRAINED_MODEL_METADATA_INVALID';
        append({ type: 'training_result', status: lastError, completedAt });
        return null;
      }
      const forwardStartMs = Math.ceil(completedAt / ROUND_MS) * ROUND_MS;
      const registration = { type: 'model_registered', modelVersion: result.modelVersion,
        modelPath, trainedAt: result.trainedAt, threshold: result.threshold,
        qualification: result.qualification || 'UNMET', trainingStatus: result.trainingStatus || null,
        holdout: result.holdout || null, trainingRounds: count, registeredAt: completedAt,
        forwardStartMs, frozenUntilMs: forwardStartMs + FORWARD_MS, productionEffect: 'NONE_SHADOW_ONLY' };
      if (!append(registration)) return null;
      append({ type: 'training_result', status: result.status, completedAt });
      if (['MODEL_TRAINING_FAILED', 'TRAINED_MODEL_METADATA_INVALID'].includes(lastError)) lastError = null;
      log('shadow35_model_registered', { modelVersion: model.modelVersion, qualification: model.qualification,
        forwardStartMs: model.forwardStartMs, frozenUntilMs: model.frozenUntilMs, productionEffect: 'NONE_SHADOW_ONLY' });
      return registration;
    } catch {
      lastError = 'MODEL_TRAINING_FAILED';
      append({ type: 'training_result', status: lastError, completedAt: clock() });
      return null;
    }
    finally { trainingBusy = false; }
  }
  function stats(now = clock()) {
    const all = [...rows.entries()];
    const snapshots = all.flatMap(([, state]) => [...state.snapshots.values()]);
    const blockers = {};
    for (const snapshot of snapshots) for (const reason of snapshot.reasons) blockers[reason] = (blockers[reason] || 0) + 1;
    const validSnapshots = snapshots.filter(x => x.valid);
    const lastValidSnapshotAt = validSnapshots.reduce((latest, x) => Math.max(latest, x.observedAt), 0) || null;
    const validation = summarizeShadow35Validation({ model, rows: all, now, lastError });
    return { ok: journalReady && lastError === null, generatedAtMs: now, version: SHADOW35_VERSION,
      productionEffect: 'NONE_SHADOW_ONLY', autoPromotion: false, deadlineMs: DEADLINE_MS,
      checkpointsMs: CHECKPOINTS, finalCheckpointCollectionMs: [34000, 35000], collectionStartMs: collectionStart,
      status: !model ? trainingBusy ? 'TRAINING' : lastTraining && labeledValidRounds() >= minRounds ? 'TRAINING_BLOCKED' : 'COLLECTING_TRAINING_DATA' : now >= model.frozenUntilMs ? 'FORWARD_COMPLETE_REVIEW_REQUIRED' : 'FROZEN_FORWARD_VALIDATION',
      snapshotCount: snapshots.length, validSnapshotCount: validSnapshots.length,
      recordedRounds: all.filter(([, state]) => state.snapshots.size || state.final).length,
      finalizedRounds: all.filter(([, state]) => state.final).length,
      labeledTrainingRounds: labeledValidRounds(), requiredTrainingRounds: minRounds,
      remainingTrainingRounds: Math.max(0, minRounds - labeledValidRounds()), trainingBusy, lastError,
      training: { ...lastTraining, nextAttemptAtTrainingRounds: model ? null : Math.max(minRounds,
        lastTraining?.status === 'TRAINING_INTERRUPTED' ? labeledValidRounds() : lastTrainingCount ? lastTrainingCount + 20 : minRounds) },
      health: { journalReady, lastValidSnapshotAt, lastValidSnapshotAgeMs: lastValidSnapshotAt === null ? null : Math.max(0, now - lastValidSnapshotAt) },
      blockers, model: model ? { modelVersion: model.modelVersion, trainedAt: model.trainedAt,
        threshold: model.threshold, qualification: model.qualification, trainingStatus: model.trainingStatus,
        holdout: model.holdout, forwardStartMs: model.forwardStartMs, frozenUntilMs: model.frozenUntilMs } : null,
      forward: validation };
  }
  return { load, observe, settle, maybeTrain, stats, idle: () => queue };
}
