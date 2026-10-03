import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 3000);
const SYMBOL = String(process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const SIGNAL_ORIGIN = String(process.env.SIGNAL_ORIGIN || 'https://signal-diagnostic-v3-production.up.railway.app').replace(/\/+$/, '');
const POLL_MS = Math.max(100, Number(process.env.SIGNAL_POLL_MS || 200));
const SETTLE_POLL_MS = Math.max(500, Number(process.env.ROUND_SETTLE_POLL_MS || 1000));
const HISTORY_LIMIT = Math.max(20, Number(process.env.ROUND_HISTORY_LIMIT || 200));
const HISTORY_FILE = process.env.ROUND_HISTORY_FILE || '/tmp/round-history.json';
const MARKET_DATA_BASE = String(process.env.BINANCE_MARKET_DATA_BASE || 'https://data-api.binance.vision').replace(/\/+$/, '');
const STATS_VERSION = String(process.env.ROUND_STATS_VERSION || 'REGIME_LAYER_V6_5M');
const STATS_START_MS = Math.max(0, Number(process.env.ROUND_STATS_START_MS || 0));
const CALIBRATION_MIN_SAMPLES = Math.max(20, Number(process.env.CALIBRATION_MIN_SAMPLES || 100));
const SHADOW_OBSERVE_MS = Math.max(10000, Number(process.env.SHADOW_OBSERVE_MS || 15000));
const SHADOW_TRAIN_MIN_SAMPLES = Math.max(100, Number(process.env.SHADOW_TRAIN_MIN_SAMPLES || 300));
const SHADOW_FORWARD_MIN_SAMPLES = Math.max(30, Number(process.env.SHADOW_FORWARD_MIN_SAMPLES || 60));
const CALIBRATION_BAND = Math.max(0.05, Number(process.env.CALIBRATION_SCORE_BAND || 0.15));
const CALIBRATION_RECENT_SHORT = Math.max(20, Number(process.env.CALIBRATION_RECENT_SHORT || 40));
const CALIBRATION_RECENT_LONG = Math.max(CALIBRATION_RECENT_SHORT, Number(process.env.CALIBRATION_RECENT_LONG || 80));
const CALIBRATION_HALF_LIFE = Math.max(10, Number(process.env.CALIBRATION_HALF_LIFE || 40));
const OFFICIAL_RESOLUTION_WAIT_MS = Math.max(10000, Number(process.env.OFFICIAL_RESOLUTION_WAIT_MS || 60000));
const SHADOW_MODEL_SCHEMA_VERSION = 2;
const SHADOW_CANDIDATE_FILE = String(process.env.SHADOW_CANDIDATE_FILE || `${HISTORY_FILE}.shadow-candidate.json`);
const SHADOW_MODEL_FILE = String(process.env.SHADOW_MODEL_FILE || `${HISTORY_FILE}.shadow-model.json`);
const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_DIR = String(process.env.ROUND_ARCHIVE_DIR || `${HISTORY_FILE}.archive`).replace(/\/+$/, '');
const LOCK_QUALITY_SHADOW_VERSION = 'LOCK_QUALITY_SHADOW_V1';
const LOCK_QUALITY_SHADOW_START_MS = 1790926200000; // 2026-10-02T07:30:00Z forward-only experiment start
const LOCK_QUALITY_PRED_SUPPORT_MIN = 0.10;
const LOCK_QUALITY_CURRENT_SCORE_MIN = 0.65;
const LOCK_QUALITY_BALANCED_CURRENT_SCORE_MIN = 0.50;
const LOCK_QUALITY_MAX_DELAY_MS = 22000;
const LOCK_QUALITY_REJECT_ABSORPTION = true;

const rounds = new Map();
let signalPollBusy = false;
let settleBusy = false;
let lastSignalPollAt = 0;
let lastSignalOkAt = 0;
let lastSignalError = null;
let lastSettlementOkAt = 0;
let lastSettlementError = null;
let shadowModel = null;
let shadowCandidate = null;
let shadowCandidateMetrics = null;
const archivedRoundIds = new Set();
let archiveMetrics = {
  records: 0,
  files: 0,
  backfilled: 0,
  lastArchivedAt: null,
  lastArchiveError: null,
};
let shadowModelMetrics = {
  status: 'COLLECTING',
  trainedSamples: 0,
  validationSamples: 0,
  forwardSamples: 0,
  validationAccuracy: null,
  validationBrier: null,
  baselineAccuracy: null,
  baselineBrier: null,
  forwardAccuracy: null,
  forwardBrier: null,
  trainedAt: null,
  modelVersion: null,
  sampleStartRound: null,
  sampleEndRound: null,
  trainEndRound: null,
  validationStartRound: null,
  validationEndRound: null,
};

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, service: 'round-tracker', at: new Date().toISOString(), ...extra }));
}

function saveHistory() {
  try {
    const data = Array.from(rounds.values())
      .sort((a, b) => a.roundStartMs - b.roundStartMs)
      .slice(-HISTORY_LIMIT);
    const temp = `${HISTORY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
    fs.renameSync(temp, HISTORY_FILE);
  } catch (e) {
    log('history_save_failed', { error: e?.message || String(e) });
  }
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const item of parsed.slice(-HISTORY_LIMIT)) {
      const start = Number(item?.roundStartMs);
      if (Number.isFinite(start) && start >= STATS_START_MS) rounds.set(String(start), item);
    }
    log('history_loaded', { records: rounds.size, file: HISTORY_FILE });
  } catch (e) {
    if (e?.code !== 'ENOENT') log('history_load_failed', { error: e?.message || String(e) });
  }
}

function trimHistory() {
  if (rounds.size <= HISTORY_LIMIT) return;
  const keys = Array.from(rounds.keys()).sort((a, b) => Number(a) - Number(b));
  while (keys.length > HISTORY_LIMIT) rounds.delete(keys.shift());
}


function archiveFileForRound(roundStartMs) {
  const d = new Date(Number(roundStartMs));
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${ARCHIVE_DIR}/v6-rounds-${year}-${month}.jsonl`;
}

function listArchiveFiles() {
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    return fs.readdirSync(ARCHIVE_DIR)
      .filter(name => /^v6-rounds-\d{4}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map(name => `${ARCHIVE_DIR}/${name}`);
  } catch (e) {
    archiveMetrics.lastArchiveError = e?.message || String(e);
    log('round_archive_list_failed', { error: archiveMetrics.lastArchiveError });
    return [];
  }
}

function loadArchiveIndex() {
  archivedRoundIds.clear();
  const files = listArchiveFiles();
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const start = Number(row?.roundStartMs);
          if (Number.isFinite(start) && start >= STATS_START_MS && row?.settledAt) {
            archivedRoundIds.add(String(start));
          }
        } catch {
          // A partial final line from an interrupted append is ignored safely.
        }
      }
    } catch (e) {
      archiveMetrics.lastArchiveError = e?.message || String(e);
      log('round_archive_read_failed', { file, error: archiveMetrics.lastArchiveError });
    }
  }
  archiveMetrics.records = archivedRoundIds.size;
  archiveMetrics.files = files.length;
  log('round_archive_index_loaded', {
    dir: ARCHIVE_DIR,
    records: archiveMetrics.records,
    files: archiveMetrics.files,
  });
}

function archiveSettledRow(row, reason = 'settlement') {
  const start = Number(row?.roundStartMs);
  const key = String(start);
  if (!Number.isFinite(start) || start < STATS_START_MS || !row?.settledAt || row?.result === 'PENDING') {
    return false;
  }
  if (archivedRoundIds.has(key)) return false;

  const file = archiveFileForRound(start);
  let fd = null;
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const record = {
      ...row,
      archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
      archivedAt: Date.now(),
    };
    fd = fs.openSync(file, 'a');
    fs.writeSync(fd, JSON.stringify(record) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    archivedRoundIds.add(key);
    archiveMetrics.records = archivedRoundIds.size;
    archiveMetrics.files = listArchiveFiles().length;
    archiveMetrics.lastArchivedAt = record.archivedAt;
    archiveMetrics.lastArchiveError = null;
    if (reason === 'startup_backfill') archiveMetrics.backfilled += 1;
    return true;
  } catch (e) {
    archiveMetrics.lastArchiveError = e?.message || String(e);
    log('round_archive_append_failed', {
      round: start,
      file,
      reason,
      error: archiveMetrics.lastArchiveError,
    });
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function backfillArchiveFromActiveHistory() {
  let added = 0;
  const settled = Array.from(rounds.values())
    .filter(r => r?.settledAt && r?.result !== 'PENDING')
    .sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  for (const row of settled) {
    if (archiveSettledRow(row, 'startup_backfill')) added += 1;
  }
  log('round_archive_backfill_complete', {
    added,
    archivedRecords: archiveMetrics.records,
    activeRecords: rounds.size,
  });
}

function readArchiveRows() {
  const byRound = new Map();
  for (const file of listArchiveFiles()) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const start = Number(row?.roundStartMs);
          if (Number.isFinite(start) && start >= STATS_START_MS && row?.settledAt) {
            byRound.set(String(start), row);
          }
        } catch {
          // Ignore malformed/partial lines; valid rows remain usable.
        }
      }
    } catch (e) {
      log('round_archive_training_read_failed', { file, error: e?.message || String(e) });
    }
  }
  return Array.from(byRound.values());
}

function shadowTrainingRows() {
  const active = Array.from(rounds.values());
  // Until the active 1000-round window can evict old samples, preserve the
  // exact existing training path so adding archival cannot change model inputs.
  if (archivedRoundIds.size < HISTORY_LIMIT) return active;

  const merged = new Map();
  for (const row of readArchiveRows()) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }
  // Active rows override archived copies because they are the freshest version.
  for (const row of active) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }
  return Array.from(merged.values());
}


function saveShadowModelArtifact() {
  if (!shadowModel?.weights) return;
  try {
    const artifact = {
      schemaVersion: SHADOW_MODEL_SCHEMA_VERSION,
      statsVersion: STATS_VERSION,
      featureKeys: SHADOW_FEATURE_KEYS,
      shadowObserveMs: SHADOW_OBSERVE_MS,
      shadowTrainMinSamples: SHADOW_TRAIN_MIN_SAMPLES,
      shadowForwardMinSamples: SHADOW_FORWARD_MIN_SAMPLES,
      savedAt: Date.now(),
      model: shadowModel,
      metrics: shadowModelMetrics,
    };
    const temp = `${SHADOW_MODEL_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(artifact), 'utf8');
    fs.renameSync(temp, SHADOW_MODEL_FILE);
    log('shadow_model_artifact_saved', {
      file: SHADOW_MODEL_FILE,
      modelVersion: shadowModel.modelVersion ?? null,
      trainedAt: shadowModel.trainedAt ?? null,
      lastTrainRound: shadowModel.lastTrainRound ?? null,
    });
  } catch (e) {
    log('shadow_model_artifact_save_failed', { error: e?.message || String(e) });
  }
}

function loadShadowModelArtifact() {
  try {
    const artifact = JSON.parse(fs.readFileSync(SHADOW_MODEL_FILE, 'utf8'));
    const model = artifact?.model;
    const featureKeysMatch =
      Array.isArray(artifact?.featureKeys) &&
      artifact.featureKeys.length === SHADOW_FEATURE_KEYS.length &&
      artifact.featureKeys.every((key, index) => key === SHADOW_FEATURE_KEYS[index]);
    const weightsValid =
      Array.isArray(model?.weights) &&
      model.weights.length === SHADOW_FEATURE_KEYS.length + 1 &&
      model.weights.every(Number.isFinite);
    if (
      Number(artifact?.schemaVersion) !== SHADOW_MODEL_SCHEMA_VERSION ||
      artifact?.statsVersion !== STATS_VERSION ||
      !featureKeysMatch ||
      !weightsValid ||
      !Number.isFinite(Number(model?.trainedAt)) ||
      !Number.isFinite(Number(model?.lastTrainRound))
    ) {
      log('shadow_model_artifact_rejected', {
        file: SHADOW_MODEL_FILE,
        reason: 'INCOMPATIBLE_OR_INVALID_ARTIFACT',
        schemaVersion: artifact?.schemaVersion ?? null,
        statsVersion: artifact?.statsVersion ?? null,
      });
      return false;
    }
    shadowModel = {
      ...model,
      weights: model.weights.map(Number),
      featureKeys: SHADOW_FEATURE_KEYS,
    };
    if (artifact?.metrics && typeof artifact.metrics === 'object') {
      shadowModelMetrics = { ...shadowModelMetrics, ...artifact.metrics };
    }
    log('shadow_model_artifact_loaded', {
      file: SHADOW_MODEL_FILE,
      modelVersion: shadowModel.modelVersion ?? null,
      trainedAt: shadowModel.trainedAt,
      lastTrainRound: shadowModel.lastTrainRound,
      trainedSamples: shadowModel.trainedSamples ?? null,
      validationSamples: shadowModel.validationSamples ?? null,
    });
    return true;
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      log('shadow_model_artifact_load_failed', { error: e?.message || String(e) });
    }
    return false;
  }
}


function saveShadowCandidateArtifact() {
  if (!shadowCandidate?.weights) return;
  try {
    const artifact = {
      schemaVersion: SHADOW_MODEL_SCHEMA_VERSION,
      statsVersion: STATS_VERSION,
      featureKeys: SHADOW_FEATURE_KEYS,
      savedAt: Date.now(),
      model: shadowCandidate,
      metrics: shadowCandidateMetrics,
    };
    const temp = `${SHADOW_CANDIDATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(artifact), 'utf8');
    fs.renameSync(temp, SHADOW_CANDIDATE_FILE);
  } catch (e) {
    log('shadow_candidate_artifact_save_failed', { error: e?.message || String(e) });
  }
}

function loadShadowCandidateArtifact() {
  try {
    const artifact = JSON.parse(fs.readFileSync(SHADOW_CANDIDATE_FILE, 'utf8'));
    const model = artifact?.model;
    const valid = Number(artifact?.schemaVersion) === SHADOW_MODEL_SCHEMA_VERSION &&
      artifact?.statsVersion === STATS_VERSION &&
      Array.isArray(model?.weights) &&
      model.weights.length === SHADOW_FEATURE_KEYS.length + 1 &&
      model.weights.every(Number.isFinite) &&
      Number.isFinite(Number(model?.trainedAt));
    if (!valid) return false;
    shadowCandidate = { ...model, weights: model.weights.map(Number), featureKeys: SHADOW_FEATURE_KEYS };
    shadowCandidateMetrics = artifact?.metrics || null;
    log('shadow_candidate_artifact_loaded', {
      modelVersion: shadowCandidate.modelVersion,
      trainedAt: shadowCandidate.trainedAt,
    });
    return true;
  } catch (e) {
    if (e?.code !== 'ENOENT') log('shadow_candidate_artifact_load_failed', { error: e?.message || String(e) });
    return false;
  }
}

function candidatePredict(facts) {
  if (!shadowCandidate?.weights) return null;
  const x = shadowVector(facts);
  if (!x) return null;
  let z = shadowCandidate.weights[0];
  for (let j = 0; j < x.length; j += 1) z += shadowCandidate.weights[j + 1] * x[j];
  return sigmoid(z);
}

function candidateForwardRows() {
  if (!shadowCandidate?.trainedAt) return [];
  return Array.from(rounds.values()).filter(r =>
    Number(r.shadowCandidateTrainedAt) === Number(shadowCandidate.trainedAt) &&
    Number.isFinite(Number(r.shadowCandidateProbability)) &&
    (r.actual === 'UP' || r.actual === 'DOWN')
  );
}

function candidateForwardSummary() {
  const forward = candidateForwardRows();
  let shadowHits = 0, shadowBrier = 0, v6Hits = 0, v6Brier = 0, v6N = 0, v6BrierN = 0;
  for (const r of forward) {
    const yUp = r.actual === 'UP' ? 1 : 0;
    const p = Number(r.shadowCandidateProbability);
    shadowHits += (p >= 0.5 ? 'UP' : 'DOWN') === r.actual ? 1 : 0;
    shadowBrier += (p - yUp) ** 2;
    if (r.prediction === 'UP' || r.prediction === 'DOWN') {
      v6N += 1;
      v6Hits += r.prediction === r.actual ? 1 : 0;
      if (Number.isFinite(Number(r.modelProbability))) {
        const v6UpP = r.prediction === 'UP' ? Number(r.modelProbability) : 1 - Number(r.modelProbability);
        v6Brier += (v6UpP - yUp) ** 2;
        v6BrierN += 1;
      }
    }
  }
  return {
    shadowN: forward.length,
    shadowAccuracy: forward.length ? Number((shadowHits / forward.length).toFixed(4)) : null,
    shadowBrier: forward.length ? Number((shadowBrier / forward.length).toFixed(4)) : null,
    v6N,
    v6Accuracy: v6N ? Number((v6Hits / v6N).toFixed(4)) : null,
    v6BrierN,
    v6Brier: v6BrierN ? Number((v6Brier / v6BrierN).toFixed(4)) : null,
    comparable: forward.length >= SHADOW_FORWARD_MIN_SAMPLES && v6N >= SHADOW_FORWARD_MIN_SAMPLES,
  };
}

function maybePromoteShadowCandidate(trained, latestRound) {
  const passed = trained.validationAccuracy > trained.baselineAccuracy + 0.03 &&
    trained.validationBrier < trained.baselineBrier;
  if (!passed) return false;

  if (!shadowCandidate) {
    shadowCandidate = { ...trained, lastTrainRound: latestRound };
    shadowCandidateMetrics = {
      status: 'FORWARD_COLLECTING',
      validationAccuracy: Number(trained.validationAccuracy.toFixed(4)),
      validationBrier: Number(trained.validationBrier.toFixed(4)),
      baselineAccuracy: Number(trained.baselineAccuracy.toFixed(4)),
      baselineBrier: Number(trained.baselineBrier.toFixed(4)),
      trainedAt: trained.trainedAt,
      modelVersion: trained.modelVersion,
    };
    saveShadowCandidateArtifact();
    log('shadow_candidate_frozen', shadowCandidateMetrics);
    return true;
  }

  const forward = candidateForwardSummary();
  if (!forward.comparable) return false;

  // Do not silently replace a validated candidate. Keep it frozen so its
  // 60+ forward sample evidence remains interpretable across retraining.
  return false;
}



const SHADOW_FEATURE_KEYS = [
  'regimeScore',
  'currentScore',
  'microScore',
  'currentTrendScore',
  'normalizedMomentum15s',
  'normalizedMomentum30s',
  'normalizedMomentum60s',
  'normalizedMomentum180s',
  'normalizedMomentum300s',
  'tradePressure15s',
  'tradePressure60s',
  'ofiNormalized5s',
  'rangePosition180',
  'predictionMarketUpMidCentered',
  'absorptionRisk',
];

function shadowVector(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const upMid = Number(facts.predictionMarketUpMid);
  const values = [
    Number(facts.regimeScore),
    Number(facts.currentScore),
    Number(facts.microScore),
    Number(facts.currentTrendScore),
    Number(facts.normalizedMomentum15s),
    Number(facts.normalizedMomentum30s),
    Number(facts.normalizedMomentum60s),
    Number(facts.normalizedMomentum180s),
    Number(facts.normalizedMomentum300s),
    Number(facts.tradePressure15s),
    Number(facts.tradePressure60s),
    Number(facts.ofiNormalized5s),
    Number(facts.rangePosition180),
    Number.isFinite(upMid) ? (upMid - 0.5) * 2 : 0,
    facts.absorptionRisk ? 1 : 0,
  ].map(v => Number.isFinite(v) ? Math.max(-3, Math.min(3, v)) : 0);
  return values;
}

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function trainLogistic(rows) {
  const samples = rows.map(r => {
    const x = shadowVector(r.shadowFacts);
    const y = r.actual === 'UP' ? 1 : r.actual === 'DOWN' ? 0 : null;
    return x && y !== null ? { x, y, roundStartMs: Number(r.roundStartMs) } : null;
  }).filter(Boolean);
  if (samples.length < SHADOW_TRAIN_MIN_SAMPLES) return null;

  const split = Math.max(1, Math.floor(samples.length * 0.8));
  const train = samples.slice(0, split);
  const valid = samples.slice(split);
  if (valid.length < 20) return null;

  const w = new Array(SHADOW_FEATURE_KEYS.length + 1).fill(0);
  const lr = 0.06;
  const l2 = 0.01;
  for (let epoch = 0; epoch < 220; epoch += 1) {
    const grad = new Array(w.length).fill(0);
    for (const s of train) {
      let z = w[0];
      for (let j = 0; j < s.x.length; j += 1) z += w[j + 1] * s.x[j];
      const e = sigmoid(z) - s.y;
      grad[0] += e;
      for (let j = 0; j < s.x.length; j += 1) grad[j + 1] += e * s.x[j];
    }
    const n = train.length || 1;
    w[0] -= lr * grad[0] / n;
    for (let j = 1; j < w.length; j += 1) {
      w[j] -= lr * (grad[j] / n + l2 * w[j]);
    }
  }

  const evalRows = (arr) => {
    let hit = 0;
    let brier = 0;
    for (const s of arr) {
      let z = w[0];
      for (let j = 0; j < s.x.length; j += 1) z += w[j + 1] * s.x[j];
      const p = sigmoid(z);
      hit += (p >= 0.5 ? 1 : 0) === s.y ? 1 : 0;
      brier += (p - s.y) * (p - s.y);
    }
    return {
      accuracy: arr.length ? hit / arr.length : null,
      brier: arr.length ? brier / arr.length : null,
    };
  };

  const prevalence = train.reduce((sum, x) => sum + x.y, 0) / train.length;
  const baselineClass = prevalence >= 0.5 ? 1 : 0;
  const baselineAccuracy = valid.filter(x => x.y === baselineClass).length / valid.length;
  const baselineBrier = valid.reduce((sum, x) => sum + (prevalence - x.y) ** 2, 0) / valid.length;
  const validation = evalRows(valid);

  const trainedAt = Date.now();
  return {
    weights: w,
    featureKeys: SHADOW_FEATURE_KEYS,
    trainedAt,
    modelVersion: `shadow-v6-${trainedAt}`,
    trainedSamples: train.length,
    validationSamples: valid.length,
    validationAccuracy: validation.accuracy,
    validationBrier: validation.brier,
    baselineAccuracy,
    baselineBrier,
    sampleStartRound: samples[0]?.roundStartMs ?? null,
    sampleEndRound: samples[samples.length - 1]?.roundStartMs ?? null,
    trainEndRound: train[train.length - 1]?.roundStartMs ?? null,
    validationStartRound: valid[0]?.roundStartMs ?? null,
    validationEndRound: valid[valid.length - 1]?.roundStartMs ?? null,
  };
}

function shadowPredict(facts) {
  if (!shadowModel?.weights) return null;
  const x = shadowVector(facts);
  if (!x) return null;
  let z = shadowModel.weights[0];
  for (let j = 0; j < x.length; j += 1) z += shadowModel.weights[j + 1] * x[j];
  return sigmoid(z);
}

function updateShadowForwardMetrics() {
  // Forward validation must follow the frozen candidate, not the rolling model.
  // The rolling shadow model retrains every 20 rounds, so counting against it
  // resets forwardSamples to zero on every retrain and can never accumulate a
  // stable 60-round forward window.
  if (shadowCandidate?.trainedAt) {
    const forward = candidateForwardSummary();
    shadowModelMetrics.forwardSamples = forward.shadowN;
    shadowModelMetrics.forwardAccuracy = forward.shadowAccuracy;
    shadowModelMetrics.forwardBrier = forward.shadowBrier;

    if (forward.shadowN < SHADOW_FORWARD_MIN_SAMPLES) {
      shadowModelMetrics.status = 'FORWARD_COLLECTING';
      return;
    }

    const validationAccuracy = Number(shadowCandidateMetrics?.validationAccuracy);
    const validationBrier = Number(shadowCandidateMetrics?.validationBrier);
    const accuracyPass =
      Number.isFinite(forward.shadowAccuracy) &&
      Number.isFinite(validationAccuracy) &&
      forward.shadowAccuracy >= validationAccuracy - 0.03;
    const brierPass =
      Number.isFinite(forward.shadowBrier) &&
      Number.isFinite(validationBrier) &&
      forward.shadowBrier <= validationBrier + 0.03;

    shadowModelMetrics.status =
      accuracyPass && brierPass
        ? 'FORWARD_VALIDATED_CANDIDATE'
        : 'FORWARD_VALIDATION_FAILED';
    return;
  }

  // Fallback before any candidate has passed validation and been frozen.
  if (!shadowModel?.trainedAt) return;
  const forward = Array.from(rounds.values()).filter(r =>
    Number(r.shadowModelTrainedAt) === Number(shadowModel.trainedAt) &&
    Number.isFinite(Number(r.shadowProbability)) &&
    (r.actual === 'UP' || r.actual === 'DOWN')
  );
  if (!forward.length) {
    shadowModelMetrics.forwardSamples = 0;
    shadowModelMetrics.forwardAccuracy = null;
    shadowModelMetrics.forwardBrier = null;
    return;
  }
  let hits = 0;
  let brier = 0;
  for (const r of forward) {
    const p = Number(r.shadowProbability);
    const y = r.actual === 'UP' ? 1 : 0;
    hits += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) * (p - y);
  }
  shadowModelMetrics.forwardSamples = forward.length;
  shadowModelMetrics.forwardAccuracy = Number((hits / forward.length).toFixed(4));
  shadowModelMetrics.forwardBrier = Number((brier / forward.length).toFixed(4));
}


function shadowStatsPayload() {
  updateShadowForwardMetrics();
  const all = Array.from(rounds.values()).sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  const decided = all.filter(r =>
    (r.result === 'HIT' || r.result === 'MISS') &&
    (r.prediction === 'UP' || r.prediction === 'DOWN')
  );
  const summarize = rows => {
    const hits = rows.filter(r => r.result === 'HIT').length;
    const misses = rows.filter(r => r.result === 'MISS').length;
    return {
      n: rows.length,
      hits,
      misses,
      accuracy: rows.length ? Number((hits / rows.length).toFixed(4)) : null,
    };
  };
  const byDirection = rows => ({
    up: summarize(rows.filter(r => r.prediction === 'UP')),
    down: summarize(rows.filter(r => r.prediction === 'DOWN')),
  });

  const forward = all.filter(r =>
    Number(r.shadowModelTrainedAt) === Number(shadowModel?.trainedAt) &&
    Number.isFinite(Number(r.shadowProbability)) &&
    (r.actual === 'UP' || r.actual === 'DOWN')
  );
  let shadowHits = 0, shadowBrier = 0;
  let v6Hits = 0, v6Brier = 0, v6BrierN = 0;
  for (const r of forward) {
    const yUp = r.actual === 'UP' ? 1 : 0;
    const sp = Number(r.shadowProbability);
    shadowHits += (sp >= 0.5 ? 'UP' : 'DOWN') === r.actual ? 1 : 0;
    shadowBrier += (sp - yUp) ** 2;

    if (r.prediction === 'UP' || r.prediction === 'DOWN') {
      v6Hits += r.prediction === r.actual ? 1 : 0;
      if (Number.isFinite(Number(r.modelProbability))) {
        const hitY = r.prediction === r.actual ? 1 : 0;
        const vp = Number(r.modelProbability);
        v6Brier += (vp - hitY) ** 2;
        v6BrierN += 1;
      }
    }
  }
  const v6ForwardN = forward.filter(r => r.prediction === 'UP' || r.prediction === 'DOWN').length;
  const shadowAccuracy = forward.length ? shadowHits / forward.length : null;
  const v6Accuracy = v6ForwardN ? v6Hits / v6ForwardN : null;
  const sBrier = forward.length ? shadowBrier / forward.length : null;
  const vBrier = v6BrierN ? v6Brier / v6BrierN : null;

  return {
    ok: true,
    generatedAt: Date.now(),
    statsVersion: STATS_VERSION,
    v6: {
      total: summarize(decided),
      last40: { ...summarize(decided.slice(-40)), ...byDirection(decided.slice(-40)) },
      last80: { ...summarize(decided.slice(-80)), ...byDirection(decided.slice(-80)) },
    },
    shadow: {
      ...shadowModelMetrics,
      forwardMetricScope: shadowCandidate ? 'FROZEN_CANDIDATE' : 'LATEST_RETRAINED_MODEL',
      forwardTargetSamples: SHADOW_FORWARD_MIN_SAMPLES,
      forwardRemainingSamples: Math.max(0, SHADOW_FORWARD_MIN_SAMPLES - Number(shadowModelMetrics.forwardSamples || 0)),
      frozenCandidate: shadowCandidate ? {
        modelVersion: shadowCandidate.modelVersion,
        trainedAt: shadowCandidate.trainedAt,
        validation: shadowCandidateMetrics,
        forwardComparison: candidateForwardSummary(),
      } : null,
      artifactExists: Boolean(shadowModel?.weights),
      forwardComparison: {
        shadowN: forward.length,
        shadowAccuracy: shadowAccuracy === null ? null : Number(shadowAccuracy.toFixed(4)),
        shadowBrier: sBrier === null ? null : Number(sBrier.toFixed(4)),
        v6N: v6ForwardN,
        v6Accuracy: v6Accuracy === null ? null : Number(v6Accuracy.toFixed(4)),
        v6BrierN,
        v6Brier: vBrier === null ? null : Number(vBrier.toFixed(4)),
        accuracyDelta: shadowAccuracy === null || v6Accuracy === null ? null : Number((shadowAccuracy - v6Accuracy).toFixed(4)),
        brierDelta: sBrier === null || vBrier === null ? null : Number((sBrier - vBrier).toFixed(4)),
        comparable: forward.length >= SHADOW_FORWARD_MIN_SAMPLES && v6ForwardN >= SHADOW_FORWARD_MIN_SAMPLES,
      },
    },
    archive: {
      records: archiveMetrics.records,
      files: archiveMetrics.files,
      lastArchivedAt: archiveMetrics.lastArchivedAt,
      lastArchiveError: archiveMetrics.lastArchiveError,
    },
  };
}

function maybeTrainShadowModel() {
  const labeled = shadowTrainingRows()
    .filter(r => r.shadowFacts && (r.actual === 'UP' || r.actual === 'DOWN'))
    .sort((a,b) => a.roundStartMs - b.roundStartMs);
  if (labeled.length < SHADOW_TRAIN_MIN_SAMPLES) {
    shadowModelMetrics.status = 'COLLECTING';
    shadowModelMetrics.trainedSamples = labeled.length;
    return;
  }

  const latestRound = labeled[labeled.length - 1]?.roundStartMs || 0;
  const lastTrainRound = Number(shadowModel?.lastTrainRound || 0);
  if (shadowModel && latestRound - lastTrainRound < 20 * 300000) {
    updateShadowForwardMetrics();
    return;
  }

  const trained = trainLogistic(labeled);
  if (!trained) return;
  shadowModel = { ...trained, lastTrainRound: latestRound };
  shadowModelMetrics = {
    status:
      trained.validationAccuracy > trained.baselineAccuracy + 0.03 &&
      trained.validationBrier < trained.baselineBrier
        ? 'SHADOW_VALIDATION_PASSED'
        : 'SHADOW_VALIDATION_NOT_BETTER_THAN_BASELINE',
    trainedSamples: trained.trainedSamples,
    validationSamples: trained.validationSamples,
    forwardSamples: 0,
    validationAccuracy: Number(trained.validationAccuracy.toFixed(4)),
    validationBrier: Number(trained.validationBrier.toFixed(4)),
    baselineAccuracy: Number(trained.baselineAccuracy.toFixed(4)),
    baselineBrier: Number(trained.baselineBrier.toFixed(4)),
    forwardAccuracy: null,
    forwardBrier: null,
    trainedAt: trained.trainedAt,
    modelVersion: trained.modelVersion,
    sampleStartRound: trained.sampleStartRound,
    sampleEndRound: trained.sampleEndRound,
    trainEndRound: trained.trainEndRound,
    validationStartRound: trained.validationStartRound,
    validationEndRound: trained.validationEndRound,
  };
  maybePromoteShadowCandidate(trained, latestRound);
  updateShadowForwardMetrics();
  saveShadowModelArtifact();
  const candidateForward = candidateForwardSummary();
  log('shadow_model_trained', {
    ...shadowModelMetrics,
    forwardMetricScope: shadowCandidate ? 'FROZEN_CANDIDATE' : 'LATEST_RETRAINED_MODEL',
    forwardTargetSamples: SHADOW_FORWARD_MIN_SAMPLES,
    candidateForwardSamples: candidateForward.shadowN,
    candidateForwardAccuracy: candidateForward.shadowAccuracy,
    candidateForwardBrier: candidateForward.shadowBrier,
  });
}

function lockPredictionSupport(direction, facts) {
  const upMid = Number(facts?.predictionMarketUpMid);
  if (!Number.isFinite(upMid)) return null;
  const support = direction === 'UP' ? upMid - 0.5 : direction === 'DOWN' ? 0.5 - upMid : null;
  return Number.isFinite(support) ? support : null;
}

function evaluateLockQuality(direction, facts, delayMs, currentMin = LOCK_QUALITY_CURRENT_SCORE_MIN) {
  const support = lockPredictionSupport(direction, facts);
  const currentAbs = Math.abs(Number(facts?.currentScore));
  const delay = Number(delayMs);
  const absorption = facts?.absorptionRisk === true;
  const reasons = [];
  let eligible = true;

  if (!Number.isFinite(support)) { eligible = false; reasons.push('MISSING_PREDICTION_SUPPORT'); }
  if (!Number.isFinite(currentAbs)) { eligible = false; reasons.push('MISSING_CURRENT_SCORE'); }
  if (!Number.isFinite(delay)) { eligible = false; reasons.push('MISSING_LOCK_DELAY'); }

  if (Number.isFinite(support) && support < LOCK_QUALITY_PRED_SUPPORT_MIN) reasons.push('PREDICTION_SUPPORT_LT_0_10');
  if (Number.isFinite(currentAbs) && currentAbs < currentMin) reasons.push('CURRENT_SCORE_TOO_WEAK');
  if (Number.isFinite(delay) && delay >= LOCK_QUALITY_MAX_DELAY_MS) reasons.push('LOCK_TOO_LATE');
  if (LOCK_QUALITY_REJECT_ABSORPTION && absorption) reasons.push('ABSORPTION_RISK');

  const pass = eligible && reasons.length === 0;
  return {
    version: LOCK_QUALITY_SHADOW_VERSION,
    eligible,
    pass,
    decision: eligible ? (pass ? 'PASS' : 'REJECT') : 'UNAVAILABLE',
    reasons,
    predictionSupport: Number.isFinite(support) ? Number(support.toFixed(4)) : null,
    currentScoreAbs: Number.isFinite(currentAbs) ? Number(currentAbs.toFixed(4)) : null,
    lockDelayMs: Number.isFinite(delay) ? delay : null,
    absorptionRisk: absorption,
    thresholds: {
      predictionSupportMin: LOCK_QUALITY_PRED_SUPPORT_MIN,
      currentScoreMin: currentMin,
      maxDelayMs: LOCK_QUALITY_MAX_DELAY_MS,
      rejectAbsorption: LOCK_QUALITY_REJECT_ABSORPTION,
    },
  };
}

function summarizeLockQuality(rows, currentMin = LOCK_QUALITY_CURRENT_SCORE_MIN) {
  const decided = rows.filter(r => (r.result === 'HIT' || r.result === 'MISS') && (r.prediction === 'UP' || r.prediction === 'DOWN'));
  const evaluated = decided.map(r => ({ row:r, q:evaluateLockQuality(r.prediction, r.predictionFacts, r.predictionDelayMs, currentMin) }));
  const eligible = evaluated.filter(x => x.q.eligible);
  const pass = eligible.filter(x => x.q.pass);
  const reject = eligible.filter(x => !x.q.pass);
  const hits = arr => arr.filter(x => x.row.result === 'HIT').length;
  const reasonCounts = {};
  for (const x of reject) for (const reason of x.q.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  const passHits = hits(pass);
  const rejectHits = hits(reject);
  return {
    decidedRows: decided.length,
    eligibleRows: eligible.length,
    passRows: pass.length,
    passHits,
    passMisses: pass.length - passHits,
    passAccuracy: pass.length ? Number((passHits / pass.length).toFixed(4)) : null,
    passCoverageOfEligible: eligible.length ? Number((pass.length / eligible.length).toFixed(4)) : null,
    rejectRows: reject.length,
    rejectHits,
    rejectMisses: reject.length - rejectHits,
    rejectAccuracy: reject.length ? Number((rejectHits / reject.length).toFixed(4)) : null,
    unavailableRows: evaluated.length - eligible.length,
    rejectReasons: reasonCounts,
  };
}

function calibrateProbability(direction, score, excludeRound = null) {
  const dir = String(direction || '').toUpperCase();
  const strength = Math.abs(Number(score));
  const all = Array.from(rounds.values()).filter(r =>
    r.roundStartMs !== excludeRound &&
    r.result && (r.result === 'HIT' || r.result === 'MISS') &&
    r.prediction === dir &&
    Number.isFinite(Number(r.predictionScore))
  ).sort((a,b) => a.roundStartMs - b.roundStartMs);

  let sample = Number.isFinite(strength)
    ? all.filter(r => Math.abs(Math.abs(Number(r.predictionScore)) - strength) <= CALIBRATION_BAND)
    : all;
  if (sample.length < CALIBRATION_MIN_SAMPLES) sample = all;
  if (sample.length < CALIBRATION_MIN_SAMPLES) {
    return { probability:null, samples:sample.length, calibrated:false, method:'insufficient_samples' };
  }

  const betaRate = rows => {
    const hits = rows.filter(r => r.result === 'HIT').length;
    return (hits + 2) / (rows.length + 4);
  };
  const recent40 = sample.slice(-CALIBRATION_RECENT_SHORT);
  const recent80 = sample.slice(-CALIBRATION_RECENT_LONG);
  const longRate = betaRate(sample);
  const shortRate = betaRate(recent40);
  const mediumRate = betaRate(recent80);

  // Exponential time decay reacts to regime changes while still using all eligible history.
  let weightedHits = 0, weightedTotal = 0;
  for (let i = 0; i < sample.length; i++) {
    const age = sample.length - 1 - i;
    const w = Math.pow(0.5, age / CALIBRATION_HALF_LIFE);
    weightedTotal += w;
    if (sample[i].result === 'HIT') weightedHits += w;
  }
  const decayRate = (weightedHits + 2) / (weightedTotal + 4);

  // Long history remains a 20% anchor; 80% comes from adaptive recent/decayed evidence.
  const probability = 0.20 * longRate + 0.25 * mediumRate + 0.25 * shortRate + 0.30 * decayRate;
  return {
    probability:Number(probability.toFixed(4)),
    samples:sample.length,
    calibrated:true,
    method:'adaptive_blend_v2',
    components:{
      long:Number(longRate.toFixed(4)),
      recent40:Number(shortRate.toFixed(4)),
      recent80:Number(mediumRate.toFixed(4)),
      decay:Number(decayRate.toFixed(4)),
      recent40Samples:recent40.length,
      recent80Samples:recent80.length,
      halfLife:CALIBRATION_HALF_LIFE,
    },
  };
}

async function fetchOfficialPredictionResolution(roundStartMs, marketTopicId = null) {
  try {
    let u = SIGNAL_ORIGIN + '/api/prediction-resolution?round=' + encodeURIComponent(String(roundStartMs));
    if (marketTopicId) u += '&marketTopicId=' + encodeURIComponent(String(marketTopicId));
    const r = await fetch(u, { cache:'no-store', signal:AbortSignal.timeout(5000) });
    if (!r.ok) return { ok:false, resolved:false, error:'HTTP_' + r.status };
    return await r.json();
  } catch (e) {
    return { ok:false, resolved:false, error:e?.message || String(e) };
  }
}

function ensureRound(roundStartMs) {
  const start = Number(roundStartMs);
  const key = String(start);
  let row = rounds.get(key);
  if (!row) {
    row = {
      roundStartMs: start,
      roundEndMs: start + 300000 - 1,
      prediction: 'WAIT',
      predictionScore: null,
      predictionConfidence: null,
      predictionFacts: null,
      shadowObservedAt: null,
      shadowFacts: null,
      shadowProbability: null,
      shadowModelTrainedAt: null,
      shadowCandidateProbability: null,
      shadowCandidateTrainedAt: null,
      modelProbability: null,
      calibrationSamples: 0,
      calibrationReady: false,
      calibrationMethod: null,
      calibrationComponents: null,
      lockQualityShadow: null,
      predictedAt: null,
      predictionDelayMs: null,
      actual: null,
      actualSource: null,
      resolutionEvidence: null,
      predictionMarketTopicId: null,
      openPrice: null,
      closePrice: null,
      settledAt: null,
      result: 'PENDING',
      source: STATS_VERSION,
      settleAttempts: 0,
      nextSettleAt: 0,
    };
    rounds.set(key, row);
    trimHistory();
  }
  return row;
}

function ensureCurrentRound() {
  const now = Date.now();
  const start = Math.floor(now / 300000) * 300000;
  if (start < STATS_START_MS) return;
  ensureRound(start);
}

async function pollSignal() {
  ensureCurrentRound();
  if (signalPollBusy) return;
  signalPollBusy = true;
  lastSignalPollAt = Date.now();
  try {
    const r = await fetch(`${SIGNAL_ORIGIN}/api/local-predictions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1200, POLL_MS * 5)),
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    const json = await r.json();
    const live = json?.live;
    if (!live?.round) return;
    if (Number(live.round) < STATS_START_MS) return;
    lastSignalOkAt = Date.now();
    lastSignalError = null;

    const row = ensureRound(Number(live.round));
    const liveFacts = live?.facts && typeof live.facts === 'object' ? live.facts : null;
    const elapsedMs = Date.now() - row.roundStartMs;
    if (!row.shadowObservedAt && liveFacts && elapsedMs >= SHADOW_OBSERVE_MS) {
      row.shadowObservedAt = Date.now();
      row.shadowFacts = liveFacts;
      const shadowP = shadowPredict(liveFacts);
      row.shadowProbability = Number.isFinite(shadowP) ? Number(shadowP.toFixed(6)) : null;
      row.shadowModelTrainedAt = shadowModel?.trainedAt ?? null;
      const candidateP = candidatePredict(liveFacts);
      row.shadowCandidateProbability = Number.isFinite(candidateP) ? Number(candidateP.toFixed(6)) : null;
      row.shadowCandidateTrainedAt = shadowCandidate?.trainedAt ?? null;
      saveHistory();
    }
    const liveTopicId = liveFacts?.predictionMarketTopicId ?? null;
    if (!row.predictionMarketTopicId && liveTopicId) {
      row.predictionMarketTopicId = liveTopicId;
      saveHistory();
    }
    const direction = live?.status === 'LOCKED' ? live?.signal?.direction : null;
    if (!row.predictedAt && (direction === 'UP' || direction === 'DOWN')) {
      row.prediction = direction;
      row.predictionScore = Number.isFinite(Number(live?.signal?.score)) ? Number(live.signal.score) : null;
      row.predictionConfidence = Number.isFinite(Number(live?.signal?.confidence)) ? Number(live.signal.confidence) : null;
      row.predictionFacts = live?.facts && typeof live.facts === 'object' ? live.facts : null;
      row.predictionMarketTopicId = row.predictionFacts?.predictionMarketTopicId ?? null;
      const cal = calibrateProbability(direction, row.predictionScore, row.roundStartMs);
      row.modelProbability = cal.probability;
      row.calibrationSamples = cal.samples;
      row.calibrationReady = cal.calibrated;
      row.calibrationMethod = cal.method || null;
      row.calibrationComponents = cal.components || null;
      row.predictedAt = Number(live.generatedAt || Date.now());
      row.predictionDelayMs = Math.max(0, row.predictedAt - row.roundStartMs);
      row.lockQualityShadow = evaluateLockQuality(direction, row.predictionFacts, row.predictionDelayMs);
      row.source = live.model || row.source;
      saveHistory();
      log('round_prediction_locked', {
        round: row.roundStartMs,
        prediction: row.prediction,
        score: row.predictionScore,
        confidence: row.predictionConfidence,
        modelProbability: row.modelProbability,
        calibrationSamples: row.calibrationSamples,
        predictionDelayMs: row.predictionDelayMs,
        predictionMarketUpMid: row.predictionFacts?.predictionMarketUpMid ?? null,
        lockQualityShadowDecision: row.lockQualityShadow?.decision ?? null,
        lockQualityShadowReasons: row.lockQualityShadow?.reasons ?? [],
        lockQualityPredictionSupport: row.lockQualityShadow?.predictionSupport ?? null,
        lockQualityCurrentScoreAbs: row.lockQualityShadow?.currentScoreAbs ?? null,
      });
    }
  } catch (e) {
    lastSignalError = e?.message || String(e);
  } finally {
    signalPollBusy = false;
  }
}

async function fetchRealKline(roundStartMs) {
  const u = new URL('/api/v3/klines', MARKET_DATA_BASE);
  u.searchParams.set('symbol', SYMBOL);
  u.searchParams.set('interval', '5m');
  u.searchParams.set('startTime', String(roundStartMs));
  u.searchParams.set('limit', '1');
  const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`KLINE_HTTP_${r.status}`);
  const json = await r.json();
  const k = Array.isArray(json) ? json[0] : null;
  if (!Array.isArray(k) || Number(k[0]) !== Number(roundStartMs)) throw new Error('KLINE_NOT_READY');
  const open = Number(k[1]);
  const close = Number(k[4]);
  const closeTime = Number(k[6]);
  if (![open, close, closeTime].every(Number.isFinite)) throw new Error('KLINE_INVALID');
  if (Date.now() <= closeTime) throw new Error('KLINE_NOT_CLOSED');
  return { open, close, closeTime };
}

async function settlePendingRounds() {
  if (settleBusy) return;
  settleBusy = true;
  try {
    const now = Date.now();
    const pending = Array.from(rounds.values())
      .filter(r => !r.actual && now > r.roundEndMs + 1200 && now >= Number(r.nextSettleAt || 0))
      .sort((a, b) => a.roundStartMs - b.roundStartMs)
      .slice(0, 3);

    for (const row of pending) {
      row.settleAttempts = Number(row.settleAttempts || 0) + 1;
      try {
        const afterCloseMs = Math.max(0, Date.now() - (row.roundEndMs + 1));
        const official = await fetchOfficialPredictionResolution(row.roundStartMs, row.predictionMarketTopicId);
        let k = null;

        if (official?.resolved && (official.direction === 'UP' || official.direction === 'DOWN')) {
          row.actual = official.direction;
          row.actualSource = 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION';
          row.resolutionEvidence = official.evidence ?? null;
          row.predictionMarketTopicId = official.marketTopicId ?? row.predictionMarketTopicId;
          try { k = await fetchRealKline(row.roundStartMs); } catch {}
        } else {
          if (afterCloseMs < OFFICIAL_RESOLUTION_WAIT_MS) {
            throw new Error('PREDICTION_RESOLUTION_PENDING');
          }
          k = await fetchRealKline(row.roundStartMs);
          row.actual = k.close > k.open ? 'UP' : k.close < k.open ? 'DOWN' : 'FLAT';
          row.actualSource = 'BINANCE_SPOT_KLINE_FALLBACK_AFTER_OFFICIAL_WAIT';
          row.resolutionEvidence = official?.error || official?.status || 'OFFICIAL_NOT_RESOLVED';
        }

        if (k) {
          row.openPrice = k.open;
          row.closePrice = k.close;
          row.roundEndMs = k.closeTime;
        }
        row.settledAt = Date.now();
        row.result = row.prediction === 'UP' || row.prediction === 'DOWN'
          ? (row.actual === row.prediction ? 'HIT' : row.actual === 'FLAT' ? 'FLAT' : 'MISS')
          : 'NO_DECISION';
        row.nextSettleAt = 0;
        lastSettlementOkAt = Date.now();
        lastSettlementError = null;
        saveHistory();
        archiveSettledRow(row);
        maybeTrainShadowModel();
        updateShadowForwardMetrics();
        const candidateForwardProgress = candidateForwardSummary();
        if (
          shadowCandidate &&
          candidateForwardProgress.shadowN > 0 &&
          (
            candidateForwardProgress.shadowN === SHADOW_FORWARD_MIN_SAMPLES ||
            candidateForwardProgress.shadowN % 10 === 0
          )
        ) {
          log('shadow_candidate_forward_progress', {
            modelVersion: shadowCandidate.modelVersion ?? null,
            trainedAt: shadowCandidate.trainedAt ?? null,
            forwardSamples: candidateForwardProgress.shadowN,
            targetSamples: SHADOW_FORWARD_MIN_SAMPLES,
            remainingSamples: Math.max(0, SHADOW_FORWARD_MIN_SAMPLES - candidateForwardProgress.shadowN),
            forwardAccuracy: candidateForwardProgress.shadowAccuracy,
            forwardBrier: candidateForwardProgress.shadowBrier,
            v6Samples: candidateForwardProgress.v6N,
            v6Accuracy: candidateForwardProgress.v6Accuracy,
            comparable: candidateForwardProgress.comparable,
            status: shadowModelMetrics.status,
          });
        }
        log('round_settled', {
          round: row.roundStartMs,
          prediction: row.prediction,
          actual: row.actual,
          result: row.result,
          openPrice: row.openPrice,
          closePrice: row.closePrice,
          settleAttempts: row.settleAttempts,
          source: row.actualSource,
          resolutionEvidence: row.resolutionEvidence,
        });
      } catch (e) {
        lastSettlementError = e?.message || String(e);
        row.nextSettleAt = Date.now() + Math.min(15000, 1500 * row.settleAttempts);
      }
    }
  } finally {
    settleBusy = false;
  }
}

function summary() {
  const records = Array.from(rounds.values()).sort((a, b) => b.roundStartMs - a.roundStartMs);
  const settled = records.filter(r => r.actual === 'UP' || r.actual === 'DOWN');
  const decided = settled.filter(r => r.prediction === 'UP' || r.prediction === 'DOWN');
  const correct = decided.filter(r => r.result === 'HIT').length;
  const wrong = decided.filter(r => r.result === 'MISS').length;
  const noDecision = settled.filter(r => r.result === 'NO_DECISION').length;
  const accuracyPct = decided.length ? Number(((correct / decided.length) * 100).toFixed(2)) : null;
  const coveragePct = settled.length ? Number(((decided.length / settled.length) * 100).toFixed(2)) : null;
  const calibrated = decided.filter(r => Number.isFinite(Number(r.modelProbability)));
  const brierScore = calibrated.length
    ? Number((calibrated.reduce((sum,r) => {
        const y = r.result === 'HIT' ? 1 : 0;
        const p = Number(r.modelProbability);
        return sum + (p - y) * (p - y);
      }, 0) / calibrated.length).toFixed(4))
    : null;
  return {
    totalTrackedRounds: records.length,
    settledRounds: settled.length,
    decidedRounds: decided.length,
    correct,
    wrong,
    noDecision,
    accuracyPct,
    coveragePct,
    calibratedRounds: calibrated.length,
    brierScore,
    calibrationMinSamples: CALIBRATION_MIN_SAMPLES,
    shadowLearning: shadowModelMetrics,
    lockQualityShadow: {
      version: LOCK_QUALITY_SHADOW_VERSION,
      productionEffect: 'NONE_SHADOW_ONLY',
      startMs: LOCK_QUALITY_SHADOW_START_MS,
      strictPolicy: {
        predictionSupportMin: LOCK_QUALITY_PRED_SUPPORT_MIN,
        currentScoreMin: LOCK_QUALITY_CURRENT_SCORE_MIN,
        maxDelayMs: LOCK_QUALITY_MAX_DELAY_MS,
        rejectAbsorption: LOCK_QUALITY_REJECT_ABSORPTION,
      },
      balancedPolicy: {
        predictionSupportMin: LOCK_QUALITY_PRED_SUPPORT_MIN,
        currentScoreMin: LOCK_QUALITY_BALANCED_CURRENT_SCORE_MIN,
        maxDelayMs: LOCK_QUALITY_MAX_DELAY_MS,
        rejectAbsorption: LOCK_QUALITY_REJECT_ABSORPTION,
      },
      retrospectiveStrict: summarizeLockQuality(decided, LOCK_QUALITY_CURRENT_SCORE_MIN),
      retrospectiveBalanced: summarizeLockQuality(decided, LOCK_QUALITY_BALANCED_CURRENT_SCORE_MIN),
      forwardStrict: summarizeLockQuality(decided.filter(r => Number(r.roundStartMs) >= LOCK_QUALITY_SHADOW_START_MS), LOCK_QUALITY_CURRENT_SCORE_MIN),
      forwardBalanced: summarizeLockQuality(decided.filter(r => Number(r.roundStartMs) >= LOCK_QUALITY_SHADOW_START_MS), LOCK_QUALITY_BALANCED_CURRENT_SCORE_MIN),
    },
    archive: {
      enabled: true,
      dir: ARCHIVE_DIR,
      records: archiveMetrics.records,
      files: archiveMetrics.files,
      backfilled: archiveMetrics.backfilled,
      lastArchivedAt: archiveMetrics.lastArchivedAt,
      lastArchiveError: archiveMetrics.lastArchiveError,
      activeHistoryLimit: HISTORY_LIMIT,
    },
  };
}



function v6FeatureAuditPayload() {
  const merged = new Map();
  for (const row of readArchiveRows()) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }
  for (const row of rounds.values()) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }
  const rows = Array.from(merged.values())
    .filter(r => (r?.result === 'HIT' || r?.result === 'MISS') &&
      (r?.prediction === 'UP' || r?.prediction === 'DOWN') &&
      r?.predictionFacts && typeof r.predictionFacts === 'object')
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const hit = r => r.result === 'HIT';
  const rate = a => a.length ? Number((a.filter(hit).length / a.length).toFixed(4)) : null;
  const desc = a => ({ n:a.length, hits:a.filter(hit).length, accuracy:rate(a) });
  const support = r => lockPredictionSupport(r.prediction, r.predictionFacts);
  const current = r => Math.abs(Number(r.predictionFacts?.currentScore));
  const absScore = r => Math.abs(Number(r.predictionScore));
  const delay = r => Number(r.predictionDelayMs);
  const conf = r => Number(r.predictionConfidence);
  const pmUsable = r => Number.isFinite(Number(r.predictionFacts?.predictionMarketUpMid));
  const absorption = r => r.predictionFacts?.absorptionRisk === true;
  const alignment = r => String(r.predictionFacts?.alignment || 'UNKNOWN');
  const volatility = r => String(r.predictionFacts?.volatilityRegime || 'UNKNOWN');
  const regime = r => String(r.predictionFacts?.regimeDirection || 'UNKNOWN');

  const bin = (name, getter, edges) => edges.map((edge,i) => {
    const lo=edge[0], hi=edge[1];
    const a=rows.filter(r => {
      const v=getter(r);
      return Number.isFinite(v) && v >= lo && (hi == null || v < hi);
    });
    return {label:name+':' + lo + '-' + (hi==null?'inf':hi), ...desc(a)};
  });

  const byCat = (name,getter) => {
    const vals=[...new Set(rows.map(getter))];
    return vals.map(v => ({label:name+':' + v, ...desc(rows.filter(r=>getter(r)===v))}));
  };

  const candidates = [
    {name:'current>=0.40', fn:r=>current(r)>=0.40},
    {name:'current>=0.50', fn:r=>current(r)>=0.50},
    {name:'current>=0.60', fn:r=>current(r)>=0.60},
    {name:'current>=0.65', fn:r=>current(r)>=0.65},
    {name:'support>=0.025', fn:r=>Number.isFinite(support(r))&&support(r)>=0.025},
    {name:'support>=0.05', fn:r=>Number.isFinite(support(r))&&support(r)>=0.05},
    {name:'support>=0.10', fn:r=>Number.isFinite(support(r))&&support(r)>=0.10},
    {name:'current>=0.50 & support>=0.025', fn:r=>current(r)>=0.50&&Number.isFinite(support(r))&&support(r)>=0.025},
    {name:'current>=0.60 & support>=0.025', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025},
    {name:'current>=0.60 & support>=0.05', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.05},
    {name:'current>=0.65 & support>=0.05', fn:r=>current(r)>=0.65&&Number.isFinite(support(r))&&support(r)>=0.05},
    {name:'current>=0.65 & support>=0.10', fn:r=>current(r)>=0.65&&Number.isFinite(support(r))&&support(r)>=0.10},
    {name:'current>=0.60 & support>=0.025 & delay<15s & !absorption', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&delay(r)<15000&&!absorption(r)},
    {name:'current>=0.60 & support>=0.025 & delay<22s', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&delay(r)<22000},
    {name:'current>=0.60 & support>=0.025 & !absorption', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&!absorption(r)},
    {name:'current>=0.60 & support>=0.025 & delay<22s & !absorption', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&delay(r)<22000&&!absorption(r)},
    {name:'current>=0.60 & support>=0.025 & absScore<0.70', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&absScore(r)<0.70},
    {name:'current>=0.60 & support>=0.025 & delay<22s & !absorption & absScore<0.70', fn:r=>current(r)>=0.60&&Number.isFinite(support(r))&&support(r)>=0.025&&delay(r)<22000&&!absorption(r)&&absScore(r)<0.70},
    {name:'current>=0.65 & support>=0.05 & delay<18s & !absorption', fn:r=>current(r)>=0.65&&Number.isFinite(support(r))&&support(r)>=0.05&&delay(r)<18000&&!absorption(r)},
  ];

  const evalSlice = (a, fn) => {
    const kept=a.filter(fn);
    return {n:kept.length,hits:kept.filter(hit).length,accuracy:rate(kept),coverage:a.length?Number((kept.length/a.length).toFixed(4)):null};
  };
  const split=Math.floor(rows.length*0.70);
  const train=rows.slice(0,split);
  const holdout=rows.slice(split);
  const candidateStats=candidates.map(x=>({
    name:x.name,
    all:evalSlice(rows,x.fn),
    train:evalSlice(train,x.fn),
    holdout:evalSlice(holdout,x.fn),
    last80:evalSlice(rows.slice(-80),x.fn),
    last40:evalSlice(rows.slice(-40),x.fn),
  }));

  return {
    ok:true,
    rows:rows.length,
    baseline:{
      all:desc(rows), train:desc(train), holdout:desc(holdout),
      last80:desc(rows.slice(-80)), last40:desc(rows.slice(-40)), last20:desc(rows.slice(-20))
    },
    featureBins:[
      ...bin('currentAbs',current,[[0,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,null]]),
      ...bin('support',support,[[-1,0],[0,0.025],[0.025,0.05],[0.05,0.10],[0.10,0.15],[0.15,null]]),
      ...bin('absScore',absScore,[[0,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,null]]),
      ...bin('confidence',conf,[[0,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,null]]),
      ...bin('delayMs',delay,[[0,12000],[12000,15000],[15000,18000],[18000,22000],[22000,null]]),
      ...byCat('alignment',alignment),
      ...byCat('volatility',volatility),
      ...byCat('regime',regime),
      {label:'absorption:false',...desc(rows.filter(r=>!absorption(r)))},
      {label:'absorption:true',...desc(rows.filter(r=>absorption(r)))},
      {label:'predictionMarket:available',...desc(rows.filter(pmUsable))},
      {label:'predictionMarket:missing',...desc(rows.filter(r=>!pmUsable(r)))},
    ],
    candidateStats,
  };
}

function calibrationBacktestPayload() {
  const merged = new Map();
  for (const row of readArchiveRows()) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }
  for (const row of rounds.values()) {
    const start = Number(row?.roundStartMs);
    if (Number.isFinite(start)) merged.set(String(start), row);
  }

  const comparable = Array.from(merged.values())
    .filter(r =>
      (r?.result === 'HIT' || r?.result === 'MISS') &&
      (r?.prediction === 'UP' || r?.prediction === 'DOWN') &&
      Number.isFinite(Number(r?.predictionConfidence)) &&
      Number.isFinite(Number(r?.modelProbability))
    )
    .sort((a, b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const summarize = rows => {
    let hits = 0, rawBrier = 0, calibratedBrier = 0;
    let rawAbsError = 0, calibratedAbsError = 0;
    let directionChanges = 0;
    for (const r of rows) {
      const y = r.result === 'HIT' ? 1 : 0;
      const rawP = Math.max(0, Math.min(1, Number(r.predictionConfidence)));
      const calP = Math.max(0, Math.min(1, Number(r.modelProbability)));
      if (y === 1) hits += 1;
      rawBrier += (rawP - y) ** 2;
      calibratedBrier += (calP - y) ** 2;
      rawAbsError += Math.abs(rawP - y);
      calibratedAbsError += Math.abs(calP - y);
      // modelProbability is P(the locked V6 direction is correct), not P(UP),
      // so calibration does not replace/flip the locked production direction.
      if (r.calibratedPrediction && r.calibratedPrediction !== r.prediction) directionChanges += 1;
    }
    const n = rows.length;
    const rawB = n ? rawBrier / n : null;
    const calB = n ? calibratedBrier / n : null;
    return {
      n,
      hits,
      misses: n - hits,
      directionAccuracy: n ? Number((hits / n).toFixed(4)) : null,
      rawConfidenceBrier: n ? Number(rawB.toFixed(4)) : null,
      calibratedProbabilityBrier: n ? Number(calB.toFixed(4)) : null,
      brierDelta: n ? Number((calB - rawB).toFixed(4)) : null,
      brierImprovementPct: n && rawB > 0 ? Number((((rawB - calB) / rawB) * 100).toFixed(2)) : null,
      rawMeanAbsoluteProbabilityError: n ? Number((rawAbsError / n).toFixed(4)) : null,
      calibratedMeanAbsoluteProbabilityError: n ? Number((calibratedAbsError / n).toFixed(4)) : null,
      directionChanges,
      directionAccuracyDelta: 0,
    };
  };

  const methodCounts = {};
  for (const r of comparable) {
    const method = String(r.calibrationMethod || 'unknown');
    methodCounts[method] = (methodCounts[method] || 0) + 1;
  }
  const currentMethodRows = comparable.filter(r => r.calibrationMethod === 'adaptive_blend_v2');

  return {
    ok: true,
    service: 'binance-round-tracker',
    analysis: 'V6_RAW_CONFIDENCE_VS_STORED_CALIBRATED_PROBABILITY_SAME_ROUNDS',
    note: 'Calibration changes confidence/probability of the locked V6 direction, not the locked UP/DOWN direction. Therefore direction hit rate is identical by design; Brier measures probability-quality change.',
    fields: {
      rawProbability: 'predictionConfidence',
      calibratedProbability: 'modelProbability',
      outcome: 'result HIT=1 MISS=0',
      direction: 'prediction',
    },
    calibration: {
      currentMethod: 'adaptive_blend_v2',
      minSamples: CALIBRATION_MIN_SAMPLES,
      recentShort: CALIBRATION_RECENT_SHORT,
      recentLong: CALIBRATION_RECENT_LONG,
      halfLife: CALIBRATION_HALF_LIFE,
    },
    methodCounts,
    comparableRows: comparable.length,
    mixedHistory: {
      last40: summarize(comparable.slice(-40)),
      last80: summarize(comparable.slice(-80)),
      all: summarize(comparable),
    },
    currentMethodOnly: {
      comparableRows: currentMethodRows.length,
      last40: summarize(currentMethodRows.slice(-40)),
      last80: summarize(currentMethodRows.slice(-80)),
      all: summarize(currentMethodRows),
    },
  };
}

function payload() {
  const records = Array.from(rounds.values()).sort((a, b) => b.roundStartMs - a.roundStartMs);
  return {
    ok: true,
    service: 'binance-round-tracker',
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    settlementSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_WITH_SPOT_FALLBACK',
    rule: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
    statsVersion: STATS_VERSION,
    statsStartMs: STATS_START_MS,
    accuracyRule: 'HIT_DIVIDED_BY_DECIDED_SETTLED_ROUNDS',
    summary: summary(),
    health: {
      signalPollMs: POLL_MS,
      settlePollMs: SETTLE_POLL_MS,
      lastSignalPollAt,
      lastSignalOkAt,
      lastSignalError,
      lastSettlementOkAt,
      lastSettlementError,
      marketDataBase: MARKET_DATA_BASE,
      officialResolutionWaitMs: OFFICIAL_RESOLUTION_WAIT_MS,
      calibrationMinSamples: CALIBRATION_MIN_SAMPLES,
      calibrationBand: CALIBRATION_BAND,
      calibrationRecentShort: CALIBRATION_RECENT_SHORT,
      calibrationRecentLong: CALIBRATION_RECENT_LONG,
      calibrationHalfLife: CALIBRATION_HALF_LIFE,
      archiveDir: ARCHIVE_DIR,
      archiveRecords: archiveMetrics.records,
      lastArchiveError: archiveMetrics.lastArchiveError,
      lockQualityShadowVersion: LOCK_QUALITY_SHADOW_VERSION,
      lockQualityShadowStartMs: LOCK_QUALITY_SHADOW_START_MS,
    },
    records: records.slice(0, 100),
  };
}

loadHistory();
loadArchiveIndex();
backfillArchiveFromActiveHistory();
loadShadowModelArtifact();
loadShadowCandidateArtifact();
maybeTrainShadowModel();
updateShadowForwardMetrics();
log('calibration_backtest_snapshot', calibrationBacktestPayload());
log('v6_feature_audit_snapshot', v6FeatureAuditPayload());
ensureCurrentRound();
setInterval(pollSignal, POLL_MS).unref();
setInterval(settlePendingRounds, SETTLE_POLL_MS).unref();
pollSignal();
settlePendingRounds();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const p = payload();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, health: p.health }));
  }

  if (req.method === 'GET' && url.pathname === '/api/calibration-backtest') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(calibrationBacktestPayload()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowStatsPayload()));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/round-stats')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload()));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => {
  const startupForward = candidateForwardSummary();
  log('round_tracker_started', {
    port: PORT,
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    pollMs: POLL_MS,
    settlePollMs: SETTLE_POLL_MS,
    historyLimit: HISTORY_LIMIT,
    marketDataBase: MARKET_DATA_BASE,
    settlementSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_WITH_SPOT_FALLBACK',
    statsVersion: STATS_VERSION,
    statsStartMs: STATS_START_MS,
    calibrationMinSamples: CALIBRATION_MIN_SAMPLES,
    calibrationRecentShort: CALIBRATION_RECENT_SHORT,
    calibrationRecentLong: CALIBRATION_RECENT_LONG,
    calibrationHalfLife: CALIBRATION_HALF_LIFE,
    shadowObserveMs: SHADOW_OBSERVE_MS,
    shadowTrainMinSamples: SHADOW_TRAIN_MIN_SAMPLES,
    shadowForwardMinSamples: SHADOW_FORWARD_MIN_SAMPLES,
    shadowModelFile: SHADOW_MODEL_FILE,
    shadowCandidateFile: SHADOW_CANDIDATE_FILE,
    shadowCandidateModelVersion: shadowCandidate?.modelVersion ?? null,
    shadowForwardMetricScope: shadowCandidate ? 'FROZEN_CANDIDATE' : 'LATEST_RETRAINED_MODEL',
    shadowForwardSamples: startupForward.shadowN,
    shadowForwardTargetSamples: SHADOW_FORWARD_MIN_SAMPLES,
    shadowForwardRemainingSamples: Math.max(0, SHADOW_FORWARD_MIN_SAMPLES - startupForward.shadowN),
    shadowForwardAccuracy: startupForward.shadowAccuracy,
    shadowForwardBrier: startupForward.shadowBrier,
    shadowForwardV6Samples: startupForward.v6N,
    shadowForwardV6Accuracy: startupForward.v6Accuracy,
    shadowForwardComparable: startupForward.comparable,
    shadowForwardStatus: shadowModelMetrics.status,
    shadowModelSchemaVersion: SHADOW_MODEL_SCHEMA_VERSION,
    archiveDir: ARCHIVE_DIR,
    archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
    archivedRecords: archiveMetrics.records,
    officialResolutionWaitMs: OFFICIAL_RESOLUTION_WAIT_MS,
    lockQualityShadowVersion: LOCK_QUALITY_SHADOW_VERSION,
    lockQualityShadowStartMs: LOCK_QUALITY_SHADOW_START_MS,
    lockQualityProductionEffect: 'NONE_SHADOW_ONLY',
  });
});
