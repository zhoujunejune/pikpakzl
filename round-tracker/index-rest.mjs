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
const OFFICIAL_RESOLUTION_WAIT_MS = Math.max(10000, Number(process.env.OFFICIAL_RESOLUTION_WAIT_MS || 60000));
const SHADOW_MODEL_SCHEMA_VERSION = 1;
const SHADOW_MODEL_FILE = String(process.env.SHADOW_MODEL_FILE || `${HISTORY_FILE}.shadow-model.json`);

const rounds = new Map();
let signalPollBusy = false;
let settleBusy = false;
let lastSignalPollAt = 0;
let lastSignalOkAt = 0;
let lastSignalError = null;
let lastSettlementOkAt = 0;
let lastSettlementError = null;
let shadowModel = null;
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
  if (
    forward.length >= SHADOW_FORWARD_MIN_SAMPLES &&
    shadowModelMetrics.forwardAccuracy >= Number(shadowModel.validationAccuracy || 0) - 0.03 &&
    shadowModelMetrics.forwardBrier <= Number(shadowModel.validationBrier || 1) + 0.03
  ) {
    shadowModelMetrics.status = 'FORWARD_VALIDATED_CANDIDATE';
  }
}

function maybeTrainShadowModel() {
  const labeled = Array.from(rounds.values())
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
  saveShadowModelArtifact();
  log('shadow_model_trained', shadowModelMetrics);
}

function calibrateProbability(direction, score, excludeRound = null) {
  const dir = String(direction || '').toUpperCase();
  const strength = Math.abs(Number(score));
  const all = Array.from(rounds.values()).filter(r =>
    r.roundStartMs !== excludeRound &&
    r.result && (r.result === 'HIT' || r.result === 'MISS') &&
    r.prediction === dir &&
    Number.isFinite(Number(r.predictionScore))
  );
  let sample = Number.isFinite(strength)
    ? all.filter(r => Math.abs(Math.abs(Number(r.predictionScore)) - strength) <= CALIBRATION_BAND)
    : all;
  if (sample.length < CALIBRATION_MIN_SAMPLES) sample = all;
  if (sample.length < CALIBRATION_MIN_SAMPLES) {
    return { probability:null, samples:sample.length, calibrated:false };
  }
  const hits = sample.filter(r => r.result === 'HIT').length;
  // Beta(2,2) smoothing avoids extreme 0/1 estimates on modest samples.
  const probability = (hits + 2) / (sample.length + 4);
  return {
    probability:Number(probability.toFixed(4)),
    samples:sample.length,
    calibrated:true,
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
      modelProbability: null,
      calibrationSamples: 0,
      calibrationReady: false,
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
      row.predictedAt = Number(live.generatedAt || Date.now());
      row.predictionDelayMs = Math.max(0, row.predictedAt - row.roundStartMs);
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
        maybeTrainShadowModel();
        updateShadowForwardMetrics();
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
    },
    records: records.slice(0, 100),
  };
}

loadHistory();
loadShadowModelArtifact();
maybeTrainShadowModel();
updateShadowForwardMetrics();
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

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/round-stats')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload()));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}).listen(PORT, '0.0.0.0', () => {
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
    shadowObserveMs: SHADOW_OBSERVE_MS,
    shadowTrainMinSamples: SHADOW_TRAIN_MIN_SAMPLES,
    shadowForwardMinSamples: SHADOW_FORWARD_MIN_SAMPLES,
    shadowModelFile: SHADOW_MODEL_FILE,
    shadowModelSchemaVersion: SHADOW_MODEL_SCHEMA_VERSION,
    officialResolutionWaitMs: OFFICIAL_RESOLUTION_WAIT_MS,
  });
});
