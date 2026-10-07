import http from 'node:http';
import fs from 'node:fs';
import { createShadowV2Engine } from './shadow-v2.mjs';
import { createShadowV3Client } from './shadow-v3-client.mjs';
import { createNoBaseSpecialistClient } from './no-base-specialist-client.mjs';
import { createShadowV4Client } from './shadow-v4-client.mjs';
import { createShadowV5Client } from './shadow-v5-client.mjs';
import { createShadowV7Client } from './shadow-v7-client.mjs';
import { createAdaptiveGateShadow } from './adaptive-gate-shadow.mjs';
import { createPreLockAdaptiveShadow } from './prelock-adaptive-shadow.mjs';
import { createEdgeRescueExpansion } from './edge-rescue-expansion.mjs';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';

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
const SHADOW_PRODUCTION_MODEL_VERSION = String(process.env.SHADOW_PRODUCTION_MODEL_VERSION || '').trim();
const PRODUCTION_MIN_FORWARD_SAMPLES = Math.max(20, Number(process.env.PRODUCTION_MIN_FORWARD_SAMPLES || 20));
const PRODUCTION_MIN_FORWARD_ACCURACY = Math.max(0.5, Math.min(1, Number(process.env.PRODUCTION_MIN_FORWARD_ACCURACY || 0.65)));
const CALIBRATION_BAND = Math.max(0.05, Number(process.env.CALIBRATION_SCORE_BAND || 0.15));
const CALIBRATION_RECENT_SHORT = Math.max(20, Number(process.env.CALIBRATION_RECENT_SHORT || 40));
const CALIBRATION_RECENT_LONG = Math.max(CALIBRATION_RECENT_SHORT, Number(process.env.CALIBRATION_RECENT_LONG || 80));
const CALIBRATION_HALF_LIFE = Math.max(10, Number(process.env.CALIBRATION_HALF_LIFE || 40));
const OFFICIAL_RESOLUTION_WAIT_MS = Math.max(10000, Number(process.env.OFFICIAL_RESOLUTION_WAIT_MS || 60000));
const SHADOW_MODEL_SCHEMA_VERSION = 2;
const SHADOW_CANDIDATE_FILE = String(process.env.SHADOW_CANDIDATE_FILE || `${HISTORY_FILE}.shadow-candidate.json`);
const SHADOW_MODEL_FILE = String(process.env.SHADOW_MODEL_FILE || `${HISTORY_FILE}.shadow-model.json`);
const SHADOW_ROLLING_FORWARD_FILE = String(process.env.SHADOW_ROLLING_FORWARD_FILE || `${HISTORY_FILE}.shadow-rolling-forward.json`);
const SHADOW_FORWARD_REGISTRY_FILE = String(process.env.SHADOW_FORWARD_REGISTRY_FILE || `${HISTORY_FILE}.shadow-forward-registry.json`);
const SHADOW_FORWARD_REGISTRY_MAX = Math.max(3, Number(process.env.SHADOW_FORWARD_REGISTRY_MAX || 12));
const SHADOW_V2_FILE = String(process.env.SHADOW_V2_FILE || `${HISTORY_FILE}.shadow-v2.json`);
const SHADOW_V3_DIR = String(process.env.SHADOW_V3_DIR || '/data/shadow-v3');
const SHADOW_V3_TRAIN_EVERY_ROUNDS = Math.max(10, Number(process.env.SHADOW_V3_TRAIN_EVERY_ROUNDS || 20));
const SHADOW_V3_TRAIN_TIME_BUDGET = Math.max(30, Number(process.env.SHADOW_V3_TRAIN_TIME_BUDGET || 75));
const NO_BASE_SPECIALIST_DIR = String(process.env.NO_BASE_SPECIALIST_DIR || '/data/no-base-specialist');
const NO_BASE_SPECIALIST_MIN_SAMPLES = Math.max(80, Number(process.env.NO_BASE_SPECIALIST_MIN_SAMPLES || 120));
const NO_BASE_SPECIALIST_FORWARD_TARGET = Math.max(30, Number(process.env.NO_BASE_SPECIALIST_FORWARD_TARGET || 60));
const NO_BASE_SPECIALIST_TRAIN_EVERY_ROUNDS = Math.max(10, Number(process.env.NO_BASE_SPECIALIST_TRAIN_EVERY_ROUNDS || 20));
const NO_BASE_SPECIALIST_TRAIN_TIME_BUDGET = Math.max(30, Number(process.env.NO_BASE_SPECIALIST_TRAIN_TIME_BUDGET || 60));
const NO_BASE_SPECIALIST_OBSERVE_MS = Math.min(22000, Math.max(18000, Number(process.env.NO_BASE_SPECIALIST_OBSERVE_MS || 20000)));
const SHADOW_V4_DIR = String(process.env.SHADOW_V4_DIR || '/data/shadow-v4');
const SHADOW_V4_TRAIN_EVERY_ROUNDS = Math.max(20, Number(process.env.SHADOW_V4_TRAIN_EVERY_ROUNDS || 120));
const SHADOW_V5_DIR = String(process.env.SHADOW_V5_DIR || '/data/shadow-v5');
const SHADOW_V5_TRAIN_EVERY_ROUNDS = Math.max(20, Number(process.env.SHADOW_V5_TRAIN_EVERY_ROUNDS || 120));
const SHADOW_V7_DIR = String(process.env.SHADOW_V7_DIR || '/data/shadow-v7');
const SHADOW_V7_TRAIN_EVERY_ROUNDS = Math.max(20, Number(process.env.SHADOW_V7_TRAIN_EVERY_ROUNDS || 120));
const ADAPTIVE_GATE_SHADOW_FILE = String(process.env.ADAPTIVE_GATE_SHADOW_FILE || `${HISTORY_FILE}.adaptive-gate-shadow-v1.json`);
const ADAPTIVE_GATE_FORWARD_TARGET = Math.max(30, Number(process.env.ADAPTIVE_GATE_FORWARD_TARGET || 60));
const PRELOCK_ADAPTIVE_SHADOW_FILE = String(process.env.PRELOCK_ADAPTIVE_SHADOW_FILE || `${HISTORY_FILE}.prelock-adaptive-shadow-v1.json`);
const PRELOCK_ADAPTIVE_FORWARD_TARGET = Math.max(30, Number(process.env.PRELOCK_ADAPTIVE_FORWARD_TARGET || 60));
const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_DIR = String(process.env.ROUND_ARCHIVE_DIR || `${HISTORY_FILE}.archive`).replace(/\/+$/, '');
const LOCK_QUALITY_SHADOW_VERSION = 'LOCK_QUALITY_SHADOW_V1';
const LOCK_QUALITY_SHADOW_START_MS = 1790926200000; // 2026-10-02T07:30:00Z forward-only experiment start
const LOCK_QUALITY_PRED_SUPPORT_MIN = 0.10;
const LOCK_QUALITY_CURRENT_SCORE_MIN = 0.65;
const LOCK_QUALITY_BALANCED_CURRENT_SCORE_MIN = 0.50;
const LOCK_QUALITY_MAX_DELAY_MS = 22000;
const LOCK_QUALITY_REJECT_ABSORPTION = true;
const LOCK_QUALITY_V2_VERSION = 'LOCK_QUALITY_SELECTIVE_V2';
const LOCK_QUALITY_V2_START_MS = Math.max(0, Number(process.env.LOCK_QUALITY_V2_START_MS || 1791180300000));
const LOCK_QUALITY_V2_SUPPORT_MIN = Math.min(0.25, Math.max(0, Number(process.env.LOCK_QUALITY_V2_SUPPORT_MIN || 0.05)));
const LOCK_QUALITY_V2_CURRENT_MIN = Math.min(0.95, Math.max(0.08, Number(process.env.LOCK_QUALITY_V2_CURRENT_MIN || 0.60)));
const LOCK_QUALITY_V2_MAX_DELAY_MS = Math.max(10000, Number(process.env.LOCK_QUALITY_V2_MAX_DELAY_MS || 22000));
const LOCK_QUALITY_V2_DRIFT_RECENT_N = Math.max(10, Number(process.env.LOCK_QUALITY_V2_DRIFT_RECENT_N || 20));
const LOCK_QUALITY_V2_DRIFT_MIN_ACCURACY = Math.max(0.5, Math.min(0.9, Number(process.env.LOCK_QUALITY_V2_DRIFT_MIN_ACCURACY || 0.65)));
const LOCK_QUALITY_V2_RECOVERY_ACCURACY = Math.max(LOCK_QUALITY_V2_DRIFT_MIN_ACCURACY, Math.min(0.95, Number(process.env.LOCK_QUALITY_V2_RECOVERY_ACCURACY || 0.70)));
const SELECTIVE_V2_NO_BASE_SHADOW_VERSION = 'SELECTIVE_V2_NO_BASE_CONSENSUS_SHADOW_V1';
const SELECTIVE_V2_NO_BASE_SHADOW_START_MS = Math.max(0, Number(process.env.SELECTIVE_V2_NO_BASE_SHADOW_START_MS || 1791297900000));
const SELECTIVE_V2_NO_BASE_FORWARD_TARGET = Math.max(30, Number(process.env.SELECTIVE_V2_NO_BASE_FORWARD_TARGET || 60));
const SELECTIVE_V2_NO_BASE_CONTEST_VERSION = 'SELECTIVE_V2_NO_BASE_CONTEST_V2';
const SELECTIVE_V2_NO_BASE_CONTEST_TARGET = 60;
const SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_MIN_SAMPLES = 20;
const SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_ACCURACY = 0.65;
const SELECTIVE_V2_NO_BASE_CONTEST_REVIEW_ACCURACY = 0.75;
const SELECTIVE_V2_NO_BASE_CONTEST_CONFIGS = [
  { id:'BALANCED_65_70_PM03', currentMin:0.65, trendMin:0.70, pmMargin:0.03, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'PM05_65_70',          currentMin:0.65, trendMin:0.70, pmMargin:0.05, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'PM08_65_70',          currentMin:0.65, trendMin:0.70, pmMargin:0.08, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'CURRENT70_70_PM03',   currentMin:0.70, trendMin:0.70, pmMargin:0.03, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'TREND80_65_PM03',     currentMin:0.65, trendMin:0.80, pmMargin:0.03, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'MICRO_65_70_PM03',    currentMin:0.65, trendMin:0.70, pmMargin:0.03, requireMicroAgree:true,  requireMomentumAgree:false },
  { id:'MOM30_65_70_PM03',    currentMin:0.65, trendMin:0.70, pmMargin:0.03, requireMicroAgree:false, requireMomentumAgree:true  },
  { id:'BOTH_65_70_PM03',     currentMin:0.65, trendMin:0.70, pmMargin:0.03, requireMicroAgree:true,  requireMomentumAgree:true  },
];

const SELECTIVE_V2_HP_SHADOW_VERSION = 'SELECTIVE_V2_HIGH_PRECISION_SHADOW_V1';
const SELECTIVE_V2_HP_SHADOW_START_MS = Math.max(0, Number(process.env.SELECTIVE_V2_HP_SHADOW_START_MS || 1791362700000));
const SELECTIVE_V2_HP_FORWARD_TARGET = Math.max(30, Number(process.env.SELECTIVE_V2_HP_FORWARD_TARGET || 60));
const SELECTIVE_V2_HP_REVIEW_ACCURACY = 0.75;
const SELECTIVE_V2_HP_PROMOTE_ACCURACY = 0.80;
const SELECTIVE_V2_HP_CONFIGS = [
  // Recent settled replay favored prediction-support as the strongest discriminator.
  // These candidates are fixed before forward collection starts; no historical row
  // is allowed to become a strict-forward sample retroactively.
  { id:'HP_S18_C60_D18', supportMin:0.18, currentMin:0.60, maxDelayMs:18000 },
  { id:'HP_S15_C70_D18', supportMin:0.15, currentMin:0.70, maxDelayMs:18000 },
  { id:'HP_S15_C60_D15', supportMin:0.15, currentMin:0.60, maxDelayMs:15000 },
  { id:'HP_S18_C65_D18', supportMin:0.18, currentMin:0.65, maxDelayMs:18000 },
  { id:'HP_S20_C60_D18', supportMin:0.20, currentMin:0.60, maxDelayMs:18000 },
];

const SELECTIVE_V2_EDGE_RESCUE_VERSION = 'SELECTIVE_V2_EDGE_RESCUE_V1';
const SELECTIVE_V2_EDGE_RESCUE_START_MS = Math.max(0, Number(process.env.SELECTIVE_V2_EDGE_RESCUE_START_MS || 1791368700000));
const SELECTIVE_V2_EDGE_RESCUE_CONFIG = {
  supportMin:0.08,
  currentMin:0.60,
  scoreMin:0.45,
  maxDelayMs:20000,
  rejectAbsorption:true,
};
// Accuracy-first fuse: stop production rescue as soon as the first five
// strict-forward eligible outcomes fail to hold 70%. Candidate evaluation
// continues while fused, so the gate can recover automatically when the
// rolling forward quality returns to >=70%.
const SELECTIVE_V2_EDGE_RESCUE_GLOBAL_MIN_SAMPLES = 5;
const SELECTIVE_V2_EDGE_RESCUE_DIRECTION_MIN_SAMPLES = 5;
const SELECTIVE_V2_EDGE_RESCUE_MIN_ACCURACY = 0.70;
const SELECTIVE_V2_EDGE_RESCUE_MAX_MISS_STREAK = 3;

// Forward-only expansion lanes. They only observe rounds that Tier-1 Edge Rescue
// still rejects, so their strict-forward results measure genuinely incremental
// coverage rather than duplicating the current rescue layer.
const SELECTIVE_V2_EDGE_EXPANSION_VERSION = 'SELECTIVE_V2_EDGE_EXPANSION_SHADOW_V1';
const SELECTIVE_V2_EDGE_EXPANSION_START_MS = Math.max(
  0,
  Number(process.env.SELECTIVE_V2_EDGE_EXPANSION_START_MS || 1791385200000)
);
const SELECTIVE_V2_EDGE_EXPANSION_CONFIGS = [
  { id:'T2_SUPPORT_06', relaxationRank:1, supportMin:0.06, currentMin:0.60, scoreMin:0.45, maxDelayMs:20000, rejectAbsorption:true },
  { id:'T2_CURRENT_055', relaxationRank:2, supportMin:0.08, currentMin:0.55, scoreMin:0.45, maxDelayMs:20000, rejectAbsorption:true },
  { id:'T2_SCORE_040', relaxationRank:3, supportMin:0.08, currentMin:0.60, scoreMin:0.40, maxDelayMs:20000, rejectAbsorption:true },
  { id:'T2_DELAY_22', relaxationRank:4, supportMin:0.08, currentMin:0.60, scoreMin:0.45, maxDelayMs:22000, rejectAbsorption:true },
  { id:'T3_COMBINED', relaxationRank:5, supportMin:0.06, currentMin:0.55, scoreMin:0.40, maxDelayMs:22000, rejectAbsorption:true },
];

const WAIT_RESCUE_SHADOW_VERSION = 'WAIT_RESCUE_SHADOW_V1';
const WAIT_RESCUE_SHADOW_START_MS = Math.max(0, Number(process.env.WAIT_RESCUE_SHADOW_START_MS || 1791354300000));
const WAIT_RESCUE_FORWARD_TARGET = Math.max(30, Number(process.env.WAIT_RESCUE_FORWARD_TARGET || 60));
const WAIT_RESCUE_RETIRE_MIN_SAMPLES = 20;
const WAIT_RESCUE_RETIRE_ACCURACY = 0.65;
const WAIT_RESCUE_REVIEW_ACCURACY = 0.70;
const WAIT_RESCUE_MIN_INCREMENTAL_COVERAGE = 0.03;
const WAIT_RESCUE_OBSERVE_DELAYS_MS = [10000, 15000, 20000];
const WAIT_RESCUE_CONFIGS = [
  { id:'SAFE_R75_T50_PM03', currentMin:0.75, trendMin:0.50, pmMargin:0.03, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'SAFE_R75_T50_PM05', currentMin:0.75, trendMin:0.50, pmMargin:0.05, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'SAFE_R75_T60_PM03', currentMin:0.75, trendMin:0.60, pmMargin:0.03, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'SAFE_R75_T60_PM05', currentMin:0.75, trendMin:0.60, pmMargin:0.05, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'SAFE_R75_T50_PM03_MICRO', currentMin:0.75, trendMin:0.50, pmMargin:0.03, scoreMin:null, distanceMinBps:null, requireMicroAgree:true,  requireMomentumAgree:false },
  { id:'SAFE_R75_T50_PM03_MOM',   currentMin:0.75, trendMin:0.50, pmMargin:0.03, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:true  },
  { id:'EXP_R60_T60_PM12', currentMin:0.60, trendMin:0.60, pmMargin:0.12, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
  { id:'EXP_R60_T70_PM10', currentMin:0.60, trendMin:0.70, pmMargin:0.10, scoreMin:null, distanceMinBps:null, requireMicroAgree:false, requireMomentumAgree:false },
];


const SIGNAL_REDIS_URL = String(process.env.SIGNAL_REDIS_URL || '').trim();
const SIGNAL_REDIS_CHANNEL = String(process.env.SIGNAL_REDIS_CHANNEL || 'binance:prediction:lock:v1');
const SIGNAL_REDIS_LATEST_KEY = String(process.env.SIGNAL_REDIS_LATEST_KEY || 'binance:prediction:lock:latest');
const SIGNAL_REDIS_STREAM = String(process.env.SIGNAL_REDIS_STREAM || 'binance:prediction:lock:events');
const SIGNAL_REDIS_STREAM_MAXLEN = Math.max(100, Number(process.env.SIGNAL_REDIS_STREAM_MAXLEN || 2000));
const SIGNAL_MODEL_NAME = String(process.env.SIGNAL_MODEL_NAME || 'SITE_LOCK_MODEL_V1');
const SIGNAL_WS_PATH = String(process.env.SIGNAL_WS_PATH || '/ws/locked-signal');



let signalRedisPublisher = null;
let signalRedisConnectPromise = null;
let signalRedisConnected = false;
let signalRedisLastError = null;
let latestSignalEnvelope = null;
let lastPublishedSignalId = null;
const signalWsClients = new Set();
const signalWss = new WebSocketServer({ noServer: true });

function buildLockedSignalEnvelope(row, live) {
  const round = Number(row?.roundStartMs ?? live?.round);
  const direction = String(row?.productionPrediction ?? live?.signal?.direction ?? '').toUpperCase();
  if (!Number.isFinite(round) || (direction !== 'UP' && direction !== 'DOWN')) return null;
  const lockedAt = Number(row?.productionLockedAt ?? live?.productionLockedAt ?? Date.now());
  const generatedAt = Number(row?.productionGeneratedAt ?? live?.generatedAt ?? lockedAt);
  return {
    schemaVersion: 1,
    signalId: SIGNAL_MODEL_NAME + ':' + round,
    model: SIGNAL_MODEL_NAME,
    status: 'LOCKED',
    symbol: SYMBOL,
    round,
    direction,
    lockedAt,
    generatedAt,
    score: Number.isFinite(Number(row?.productionScore ?? live?.signal?.score))
      ? Number(row?.productionScore ?? live?.signal?.score)
      : null,
    confidence: Number.isFinite(Number(row?.productionConfidence ?? live?.signal?.confidence))
      ? Number(row?.productionConfidence ?? live?.signal?.confidence)
      : null,
    modelProbability: Number.isFinite(Number(live?.signal?.modelProbability))
      ? Number(live.signal.modelProbability)
      : (Number.isFinite(Number(row?.productionConfidence)) ? Number(row.productionConfidence) : null),
    source: 'SITE_PRODUCTION_LOCK',
    upstreamSource: row?.productionSource ?? live?.source ?? null,
    upstreamModel: row?.productionModel ?? live?.model ?? null,
    productionPolicy: live?.productionPolicy || productionPolicyName(),
    immutable: true,
  };
}

function broadcastLockedSignal(envelope) {
  if (!envelope) return;
  const data = JSON.stringify({ type: 'locked_signal', signal: envelope });
  let delivered = 0;
  for (const ws of signalWsClients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(data);
      delivered += 1;
    } catch {}
  }
  log('locked_signal_websocket_broadcast', {
    signalId: envelope.signalId,
    round: envelope.round,
    direction: envelope.direction,
    clients: delivered,
  });
}

async function ensureSignalRedisPublisher() {
  if (!SIGNAL_REDIS_URL) return null;
  if (signalRedisPublisher?.isReady) return signalRedisPublisher;
  if (!signalRedisPublisher) {
    signalRedisPublisher = createClient({ url: SIGNAL_REDIS_URL });
    signalRedisPublisher.on('error', err => {
      signalRedisConnected = false;
      signalRedisLastError = err?.message || String(err);
      log('locked_signal_redis_error', { error: signalRedisLastError });
    });
    signalRedisPublisher.on('ready', () => {
      signalRedisConnected = true;
      signalRedisLastError = null;
      log('locked_signal_redis_ready', { channel: SIGNAL_REDIS_CHANNEL });
    });
    signalRedisPublisher.on('end', () => {
      signalRedisConnected = false;
    });
  }
  if (!signalRedisConnectPromise) {
    signalRedisConnectPromise = signalRedisPublisher.connect()
      .catch(err => {
        signalRedisConnected = false;
        signalRedisLastError = err?.message || String(err);
        log('locked_signal_redis_connect_failed', { error: signalRedisLastError });
        return null;
      })
      .finally(() => { signalRedisConnectPromise = null; });
  }
  await signalRedisConnectPromise;
  return signalRedisPublisher?.isReady ? signalRedisPublisher : null;
}

async function persistAndPublishLockedSignal(envelope) {
  const client = await ensureSignalRedisPublisher();
  if (!client || !envelope) return false;
  const body = JSON.stringify(envelope);
  try {
    await client.set(SIGNAL_REDIS_LATEST_KEY, body, { EX: 900 });
    const subscribers = await client.publish(SIGNAL_REDIS_CHANNEL, body);
    await client.sendCommand([
      'XADD',
      SIGNAL_REDIS_STREAM,
      'MAXLEN',
      '~',
      String(SIGNAL_REDIS_STREAM_MAXLEN),
      '*',
      'payload',
      body,
    ]);
    log('locked_signal_redis_published', {
      signalId: envelope.signalId,
      round: envelope.round,
      direction: envelope.direction,
      subscribers,
      stream: SIGNAL_REDIS_STREAM,
    });
    return true;
  } catch (err) {
    signalRedisLastError = err?.message || String(err);
    log('locked_signal_redis_publish_failed', {
      signalId: envelope.signalId,
      error: signalRedisLastError,
    });
    return false;
  }
}

function emitLockedSignal(row, live) {
  const envelope = buildLockedSignalEnvelope(row, live);
  if (!envelope) return null;
  latestSignalEnvelope = envelope;
  if (lastPublishedSignalId === envelope.signalId) return envelope;
  lastPublishedSignalId = envelope.signalId;
  broadcastLockedSignal(envelope);
  void persistAndPublishLockedSignal(envelope);
  return envelope;
}

signalWss.on('connection', ws => {
  signalWsClients.add(ws);
  if (latestSignalEnvelope) {
    try {
      ws.send(JSON.stringify({ type: 'snapshot', signal: latestSignalEnvelope }));
    } catch {}
  }
  ws.on('close', () => signalWsClients.delete(ws));
  ws.on('error', () => signalWsClients.delete(ws));
});

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
let rollingForwardTracker = {
  schemaVersion: 1,
  modelVersion: null,
  trainedAt: null,
  observations: [],
};
let shadowForwardRegistry = { schemaVersion: 1, candidates: [] };
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

const shadowV2 = createShadowV2Engine({
  file: SHADOW_V2_FILE,
  minSamples: SHADOW_TRAIN_MIN_SAMPLES,
  forwardTarget: SHADOW_FORWARD_MIN_SAMPLES,
  maxCandidates: 10,
  log,
});

const shadowV3 = createShadowV3Client({
  historyFile: HISTORY_FILE,
  dir: SHADOW_V3_DIR,
  minSamples: SHADOW_TRAIN_MIN_SAMPLES,
  forwardTarget: SHADOW_FORWARD_MIN_SAMPLES,
  maxCandidates: 8,
  trainEveryRounds: SHADOW_V3_TRAIN_EVERY_ROUNDS,
  trainTimeBudget: SHADOW_V3_TRAIN_TIME_BUDGET,
  protectedModelVersion: SHADOW_PRODUCTION_MODEL_VERSION.startsWith('shadow-v3-automl-')
    ? SHADOW_PRODUCTION_MODEL_VERSION
    : null,
  log,
});

const noBaseSpecialist = createNoBaseSpecialistClient({
  historyFile: HISTORY_FILE,
  dir: NO_BASE_SPECIALIST_DIR,
  minSamples: NO_BASE_SPECIALIST_MIN_SAMPLES,
  forwardTarget: NO_BASE_SPECIALIST_FORWARD_TARGET,
  maxCandidates: 6,
  trainEveryRounds: NO_BASE_SPECIALIST_TRAIN_EVERY_ROUNDS,
  trainTimeBudget: NO_BASE_SPECIALIST_TRAIN_TIME_BUDGET,
  log,
});

const shadowV4 = createShadowV4Client({
  historyFile: HISTORY_FILE,
  dir: SHADOW_V4_DIR,
  minSamples: SHADOW_TRAIN_MIN_SAMPLES,
  forwardTarget: SHADOW_FORWARD_MIN_SAMPLES,
  maxCandidates: 4,
  trainEveryRounds: SHADOW_V4_TRAIN_EVERY_ROUNDS,
  log,
});

const shadowV5 = createShadowV5Client({
  historyFile: HISTORY_FILE,
  dir: SHADOW_V5_DIR,
  minSamples: SHADOW_TRAIN_MIN_SAMPLES,
  forwardTarget: SHADOW_FORWARD_MIN_SAMPLES,
  maxCandidates: 4,
  trainEveryRounds: SHADOW_V5_TRAIN_EVERY_ROUNDS,
  log,
});

const shadowV7 = createShadowV7Client({
  historyFile: HISTORY_FILE,
  dir: SHADOW_V7_DIR,
  minSamples: SHADOW_TRAIN_MIN_SAMPLES,
  forwardTarget: SHADOW_FORWARD_MIN_SAMPLES,
  maxCandidates: 4,
  trainEveryRounds: SHADOW_V7_TRAIN_EVERY_ROUNDS,
  log,
});

const adaptiveGateShadow = createAdaptiveGateShadow({
  file: ADAPTIVE_GATE_SHADOW_FILE,
  minTrainSamples: 180,
  forwardTarget: ADAPTIVE_GATE_FORWARD_TARGET,
  currentMin: LOCK_QUALITY_V2_CURRENT_MIN,
  supportMin: LOCK_QUALITY_V2_SUPPORT_MIN,
  maxDelayMs: LOCK_QUALITY_V2_MAX_DELAY_MS,
  edgeCurrentMin: 0.52,
  edgeSupportMin: 0.02,
  edgeMaxDelayMs: 26000,
  targetAccuracy: 0.72,
  log,
});

const preLockAdaptiveShadow = createPreLockAdaptiveShadow({
  file: PRELOCK_ADAPTIVE_SHADOW_FILE,
  minTrainSamples: 300,
  forwardTarget: PRELOCK_ADAPTIVE_FORWARD_TARGET,
  targetAccuracy: 0.72,
  minHoldoutPasses: 12,
  log,
});

const edgeRescueExpansion = createEdgeRescueExpansion({
  version: SELECTIVE_V2_EDGE_EXPANSION_VERSION,
  startMs: SELECTIVE_V2_EDGE_EXPANSION_START_MS,
  configs: SELECTIVE_V2_EDGE_EXPANSION_CONFIGS,
  lockPredictionSupport,
  minSamples: 20,
  targetSamples: 60,
  targetAccuracy: 0.75,
  recentWindow: 10,
  recentAccuracy: 0.70,
  directionMinSamples: 5,
  directionRecentWindow: 6,
  directionAccuracy: 0.70,
  maxMissStreak: 2,
  minIncrementalCoverage: 0.02,
  retireMinSamples: 20,
  retireAccuracy: 0.65,
  log,
  onPersist: saveHistory,
});

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

function settlementDirectionFromPrices(openPrice, closePrice) {
  const open = Number(openPrice);
  const close = Number(closePrice);
  if (![open, close].every(Number.isFinite)) return null;
  return close > open ? 'UP' : close < open ? 'DOWN' : 'FLAT';
}

function officialDirectionFromRow(row) {
  const explicit = String(row?.officialDirection || '').toUpperCase();
  if (explicit === 'UP' || explicit === 'DOWN') return explicit;

  const evidence = String(row?.resolutionEvidence || '').toUpperCase();
  const m = evidence.match(/^OFFICIAL_(UP|DOWN)(?::|$)/);
  if (m) return m[1];

  if (
    row?.actualSource === 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' &&
    (row?.actual === 'UP' || row?.actual === 'DOWN')
  ) {
    return row.actual;
  }
  return null;
}

function applyOfficialSettlement(row, direction, evidence = null, settledAt = Date.now()) {
  if (!row || (direction !== 'UP' && direction !== 'DOWN')) return false;
  row.actual = direction;
  row.actualSource = 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION';
  row.officialDirection = direction;
  if (evidence) row.resolutionEvidence = evidence;
  row.settledAt = settledAt;
  row.result = row.prediction === 'UP' || row.prediction === 'DOWN'
    ? (direction === row.prediction ? 'HIT' : 'MISS')
    : 'NO_DECISION';

  row.productionActual = direction;
  row.productionResult = row.productionPrediction === 'UP' || row.productionPrediction === 'DOWN'
    ? (direction === row.productionPrediction ? 'HIT' : 'MISS')
    : 'NO_DECISION';
  row.productionSettledAt = settledAt;
  row.nextSettleAt = 0;
  return true;
}

function normalizeHistoricalSettlement(row) {
  if (!row || typeof row !== 'object') return row;

  const official = officialDirectionFromRow(row);
  if (official) {
    const beforeActual = row.actual;
    const beforeSource = row.actualSource;
    const beforeProductionActual = row.productionActual;
    applyOfficialSettlement(
      row,
      official,
      row.resolutionEvidence || `OFFICIAL_${official}:PERSISTED_EVIDENCE`,
      row.settledAt || row.productionSettledAt || Date.now()
    );
    if (
      beforeActual !== official ||
      beforeSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' ||
      beforeProductionActual !== official
    ) {
      row.needsOfficialArchiveCorrection = true;
    }
    return row;
  }

  // Never treat a historical spot-kline label as a Prediction Market truth label.
  // If no official UP/DOWN evidence is persisted, make it pending and re-resolve it.
  if (
    row.actualSource === 'BINANCE_5M_KLINE_OPEN_CLOSE' ||
    row.actual === 'FLAT' ||
    row.productionActual === 'FLAT'
  ) {
    row.actual = null;
    row.actualSource = null;
    row.result = 'PENDING';
    row.productionActual = null;
    row.productionResult = 'PENDING';
    row.settledAt = null;
    row.productionSettledAt = null;
    row.settleAttempts = 0;
    row.nextSettleAt = 0;
    row.needsOfficialArchiveCorrection = true;
  }
  return row;
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    let repaired = 0;
    for (const item of parsed.slice(-HISTORY_LIMIT)) {
      const start = Number(item?.roundStartMs);
      if (!Number.isFinite(start) || start < STATS_START_MS) continue;
      const beforeActual = item?.actual;
      const beforeResult = item?.result;
      const beforeProductionActual = item?.productionActual;
      const beforeProductionResult = item?.productionResult;
      const normalized = normalizeHistoricalSettlement({ ...item });
      if (
        normalized?.actual !== beforeActual ||
        normalized?.result !== beforeResult ||
        normalized?.productionActual !== beforeProductionActual ||
        normalized?.productionResult !== beforeProductionResult
      ) repaired += 1;
      rounds.set(String(start), normalized);
    }
    if (repaired > 0) {
      saveHistory();
      log('history_settlement_labels_repaired', {
        repaired,
        source: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
      });
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
  const forceCorrection = reason === 'official_correction';
  if (archivedRoundIds.has(key) && !forceCorrection) return false;

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
  let corrected = 0;
  for (const row of settled) {
    if (row?.needsOfficialArchiveCorrection) {
      if (archiveSettledRow(row, 'official_correction')) {
        corrected += 1;
        row.needsOfficialArchiveCorrection = false;
        row.officialArchiveCorrectedAt = Date.now();
      }
    } else if (archiveSettledRow(row, 'startup_backfill')) {
      added += 1;
    }
  }
  if (corrected > 0) saveHistory();
  log('round_archive_backfill_complete', {
    added,
    corrected,
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
          const row = normalizeHistoricalSettlement(JSON.parse(line));
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
    const modelVersion = String(model?.modelVersion || '');
    const registered = shadowForwardRegistry.candidates.some(c => c.modelVersion === modelVersion);
    const configuredProduction = Boolean(SHADOW_PRODUCTION_MODEL_VERSION) &&
      SHADOW_PRODUCTION_MODEL_VERSION === modelVersion;
    if (!registered && !configuredProduction) {
      try { fs.unlinkSync(SHADOW_CANDIDATE_FILE); } catch {}
      shadowCandidate = null;
      shadowCandidateMetrics = null;
      log('shadow_candidate_artifact_deleted_as_retired', {
        modelVersion: modelVersion || null,
        trainedAt: model?.trainedAt ?? null,
        reason: 'NOT_IN_ACTIVE_FORWARD_REGISTRY',
      });
      return false;
    }
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



function saveShadowForwardRegistry() {
  try {
    const temp = `${SHADOW_FORWARD_REGISTRY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(shadowForwardRegistry), 'utf8');
    fs.renameSync(temp, SHADOW_FORWARD_REGISTRY_FILE);
  } catch (e) {
    log('shadow_forward_registry_save_failed', { error: e?.message || String(e) });
  }
}

function loadShadowForwardRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHADOW_FORWARD_REGISTRY_FILE, 'utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.candidates)) return false;
    shadowForwardRegistry = parsed;
    deleteRetiredShadowForwardCandidates();
    log('shadow_forward_registry_loaded', {
      candidates: shadowForwardRegistry.candidates.length,
      active: shadowForwardRegistry.candidates.filter(c => candidateRegistrySummary(c).forwardSamples < SHADOW_FORWARD_MIN_SAMPLES).length,
    });
    return true;
  } catch (e) {
    if (e?.code !== 'ENOENT') log('shadow_forward_registry_load_failed', { error: e?.message || String(e) });
    return false;
  }
}

function candidateRegistrySummary(c) {
  const settled = (c?.observations || []).filter(x =>
    (x.actual === 'UP' || x.actual === 'DOWN') && Number.isFinite(Number(x.probability))
  );
  let hits = 0, brier = 0, up = 0, down = 0, maxErrors = 0, streak = 0;
  for (const x of settled) {
    const p = Number(x.probability);
    const pred = p >= 0.5 ? 'UP' : 'DOWN';
    const y = x.actual === 'UP' ? 1 : 0;
    if (pred === 'UP') up += 1; else down += 1;
    if (pred === x.actual) streak = 0; else { streak += 1; maxErrors = Math.max(maxErrors, streak); }
    hits += pred === x.actual ? 1 : 0;
    brier += (p - y) ** 2;
  }
  const recentResults = settled.slice(-20).map(x => {
    const p = Number(x.probability);
    const prediction = p >= 0.5 ? 'UP' : 'DOWN';
    return {
      roundStartMs: Number(x.roundStartMs),
      observedAt: x.observedAt ?? null,
      settledAt: x.settledAt ?? null,
      probability: Number(p.toFixed(6)),
      prediction,
      actual: x.actual,
      result: prediction === x.actual ? 'HIT' : 'MISS',
    };
  });
  return {
    modelVersion: c?.modelVersion ?? null,
    trainedAt: c?.trainedAt ?? null,
    forwardSamples: settled.length,
    targetSamples: SHADOW_FORWARD_MIN_SAMPLES,
    remainingSamples: Math.max(0, SHADOW_FORWARD_MIN_SAMPLES - settled.length),
    hits,
    misses: settled.length - hits,
    forwardAccuracy: settled.length ? Number((hits / settled.length).toFixed(4)) : null,
    forwardBrier: settled.length ? Number((brier / settled.length).toFixed(4)) : null,
    validationAccuracy: c?.validationAccuracy ?? null,
    validationBrier: c?.validationBrier ?? null,
    baselineAccuracy: c?.baselineAccuracy ?? null,
    baselineBrier: c?.baselineBrier ?? null,
    upPredictions: up,
    downPredictions: down,
    maxConsecutiveErrors: maxErrors,
    recentResults,
    status: settled.length < SHADOW_FORWARD_MIN_SAMPLES ? 'COLLECTING' :
      (hits / settled.length >= 0.75 ? 'FORWARD_GATE_MET' : 'FORWARD_VALIDATION_FAILED'),
  };
}

function deleteRetiredShadowForwardCandidates() {
  const removed = [];
  shadowForwardRegistry.candidates = shadowForwardRegistry.candidates.filter(c => {
    const s = candidateRegistrySummary(c);
    const retired = s.forwardSamples >= 20 &&
      Number.isFinite(Number(s.forwardAccuracy)) &&
      Number(s.forwardAccuracy) < 0.65;
    if (!retired) return true;
    removed.push({
      modelVersion: c.modelVersion,
      trainedAt: c.trainedAt ?? null,
      forwardSamples: s.forwardSamples,
      hits: s.hits,
      misses: s.misses,
      forwardAccuracy: s.forwardAccuracy,
      wasProductionModel: c.modelVersion === SHADOW_PRODUCTION_MODEL_VERSION,
      reason: 'STRICT_FORWARD_BELOW_65_AFTER_20',
    });
    return false;
  });
  if (removed.length) {
    saveShadowForwardRegistry();
    log('shadow_retired_models_deleted', {
      count: removed.length,
      retentionAccuracy: 0.65,
      retentionMinSamples: 20,
      models: removed,
    });
  }
  return removed;
}

function shadowForwardRegistrySummary() {
  return shadowForwardRegistry.candidates
    .map(candidateRegistrySummary)
    .sort((a,b) => Number(b.trainedAt) - Number(a.trainedAt));
}

function registerShadowForwardCandidate(model) {
  if (!model?.weights || !model?.modelVersion || !Number.isFinite(Number(model?.trainedAt))) return;
  if (shadowForwardRegistry.candidates.some(c => c.modelVersion === model.modelVersion)) return;
  shadowForwardRegistry.candidates.push({
    modelVersion: model.modelVersion,
    trainedAt: Number(model.trainedAt),
    weights: model.weights.map(Number),
    validationAccuracy: Number.isFinite(Number(model.validationAccuracy)) ? Number(model.validationAccuracy.toFixed(4)) : null,
    validationBrier: Number.isFinite(Number(model.validationBrier)) ? Number(model.validationBrier.toFixed(4)) : null,
    baselineAccuracy: Number.isFinite(Number(model.baselineAccuracy)) ? Number(model.baselineAccuracy.toFixed(4)) : null,
    baselineBrier: Number.isFinite(Number(model.baselineBrier)) ? Number(model.baselineBrier.toFixed(4)) : null,
    observations: [],
  });
  shadowForwardRegistry.candidates.sort((a,b) => Number(a.trainedAt) - Number(b.trainedAt));
  while (shadowForwardRegistry.candidates.length > SHADOW_FORWARD_REGISTRY_MAX) {
    const removable = shadowForwardRegistry.candidates.findIndex(c =>
      candidateRegistrySummary(c).forwardSamples >= SHADOW_FORWARD_MIN_SAMPLES
    );
    if (removable < 0) break;
    shadowForwardRegistry.candidates.splice(removable, 1);
  }
  saveShadowForwardRegistry();
  log('shadow_forward_candidate_registered', {
    modelVersion: model.modelVersion,
    trainedAt: model.trainedAt,
    candidates: shadowForwardRegistry.candidates.length,
    targetSamples: SHADOW_FORWARD_MIN_SAMPLES,
  });
}

function observeShadowForwardRegistry(row, facts) {
  if (!facts) return;
  let changed = false;
  for (const c of shadowForwardRegistry.candidates) {
    const summary = candidateRegistrySummary(c);
    if (summary.forwardSamples >= SHADOW_FORWARD_MIN_SAMPLES) continue;
    if (Number(row?.roundStartMs) < Number(c.trainedAt)) continue;
    if (c.observations.some(x => Number(x.roundStartMs) === Number(row.roundStartMs))) continue;
    const x = shadowVector(facts);
    if (!x || !Array.isArray(c.weights)) continue;
    let z = c.weights[0];
    for (let j = 0; j < x.length; j += 1) z += c.weights[j + 1] * x[j];
    const p = sigmoid(z);
    if (!Number.isFinite(p)) continue;
    c.observations.push({
      roundStartMs: Number(row.roundStartMs),
      observedAt: Date.now(),
      modelVersion: c.modelVersion,
      trainedAt: Number(c.trainedAt),
      probability: Number(p.toFixed(6)),
      direction: p >= 0.5 ? 'UP' : 'DOWN',
      actual: null,
      settledAt: null,
    });
    changed = true;
  }
  if (changed) saveShadowForwardRegistry();
}

function settleShadowForwardRegistry(row) {
  if (row?.actual !== 'UP' && row?.actual !== 'DOWN') return;
  let changed = false;
  const progress = [];
  for (const c of shadowForwardRegistry.candidates) {
    const x = c.observations.find(o => Number(o.roundStartMs) === Number(row.roundStartMs));
    if (!x || x.actual === 'UP' || x.actual === 'DOWN') continue;
    x.actual = row.actual;
    x.settledAt = row.settledAt ?? Date.now();
    changed = true;
    const summary = candidateRegistrySummary(c);
    if (summary.forwardSamples === SHADOW_FORWARD_MIN_SAMPLES || summary.forwardSamples % 10 === 0) progress.push(summary);
  }
  if (changed) {
    saveShadowForwardRegistry();
    deleteRetiredShadowForwardCandidates();
  }
  for (const summary of progress) log('shadow_forward_candidate_progress', summary);
}

let legacyOfficialRevalidation = { active:false, total:0, startedAt:null, completedAt:null };

function invalidateLegacyWinnerFlagSettlements() {
  const affected = new Set();
  const preexistingPending = new Set();
  const now = Date.now();

  for (const row of rounds.values()) {
    const evidence = String(row?.resolutionEvidence || '');
    const start = Number(row?.roundStartMs);
    if (!Number.isFinite(start)) continue;

    if (evidence === 'REVALIDATING_LEGACY_OUTCOME_WINNER_FLAG' && !row?.actual) {
      preexistingPending.add(String(start));
      continue;
    }

    if (
      row?.actualSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' ||
      evidence.includes('STRICT_ROUND_ALIGNED_TOPIC')
    ) continue;

    row.legacyOfficialDirectionBeforeRevalidation =
      row.actual === 'UP' || row.actual === 'DOWN' ? row.actual : null;
    row.legacyResolutionEvidenceBeforeRevalidation = evidence;
    row.legacyRevalidationRequestedAt = now;
    row.actual = null;
    row.actualSource = null;
    row.officialDirection = null;
    row.result = 'PENDING';
    row.productionActual = null;
    row.productionResult = 'PENDING';
    row.settledAt = null;
    row.productionSettledAt = null;
    row.settleAttempts = 0;
    row.nextSettleAt = 0;
    row.resolutionEvidence = 'REVALIDATING_LEGACY_OUTCOME_WINNER_FLAG';
    row.needsOfficialArchiveCorrection = true;
    affected.add(String(start));
  }

  const allPending = new Set([...preexistingPending, ...affected]);
  if (!allPending.size) return 0;

  let registryLabelsReset = 0;
  for (const candidate of shadowForwardRegistry.candidates) {
    for (const obs of candidate.observations || []) {
      if (!allPending.has(String(Number(obs.roundStartMs)))) continue;
      if (obs.actual === 'UP' || obs.actual === 'DOWN') {
        obs.actual = null;
        obs.settledAt = null;
        registryLabelsReset += 1;
      }
    }
  }

  const shadowV2LabelsReset = shadowV2.invalidateRounds(allPending);
  const shadowV3LabelsReset = shadowV3.invalidateRounds(allPending);
  legacyOfficialRevalidation = {
    active:true,
    total:allPending.size,
    startedAt:now,
    completedAt:null,
  };
  if (affected.size) saveHistory();
  saveShadowForwardRegistry();
  log('legacy_official_settlement_revalidation_started', {
    rounds:allPending.size,
    newlyInvalidated:affected.size,
    resumedPending:preexistingPending.size,
    registryLabelsReset,
    shadowV2LabelsReset,
    shadowV3LabelsReset,
    parser:'BINANCE_VARIANT_PRICE_STRICT_ROUND_ALIGNED_TOPIC',
  });
  return allPending.size;
}

const AUTHORITATIVE_SETTLED_HISTORY_OVERRIDES = new Map([
  ['1791102000000', { direction:'UP', marketTopicId:6374907, source:'BINANCE_SETTLED_HISTORY_FINAL_OUTCOME' }],
  ['1791102300000', { direction:'DOWN', marketTopicId:6374910, source:'BINANCE_SETTLED_HISTORY_FINAL_OUTCOME' }],
]);

function applyAuthoritativeSettledHistoryOverrides() {
  let corrected = 0;
  let registryCorrected = 0;
  for (const [roundKey, truth] of AUTHORITATIVE_SETTLED_HISTORY_OVERRIDES.entries()) {
    const row = rounds.get(roundKey);
    if (!row) continue;
    const before = row.actual === 'UP' || row.actual === 'DOWN' ? row.actual : row.legacyOfficialDirectionBeforeRevalidation;
    applyOfficialSettlement(
      row,
      truth.direction,
      `OFFICIAL_${truth.direction}:${truth.source}:STRICT_ROUND_ALIGNED_TOPIC`,
      row.settledAt || Date.now()
    );
    row.predictionMarketTopicId = truth.marketTopicId;
    if ((before === 'UP' || before === 'DOWN') && before !== truth.direction) {
      row.officialDirectionCorrectedFrom = before;
      row.officialDirectionCorrectedAt = Date.now();
    }
    row.needsOfficialArchiveCorrection = true;
    corrected += 1;

    for (const candidate of shadowForwardRegistry.candidates) {
      const obs = (candidate.observations || []).find(o => String(Number(o.roundStartMs)) === roundKey);
      if (!obs) continue;
      if (obs.actual !== truth.direction) {
        obs.actual = truth.direction;
        obs.settledAt = row.settledAt || Date.now();
        registryCorrected += 1;
      }
    }
    shadowV2.settle(row);
    shadowV3.settle(row);
    noBaseSpecialist.settle(row);
    archiveSettledRow(row, 'settled_history_final_outcome_correction');
    log('authoritative_settled_history_override_applied', {
      round:Number(roundKey),
      direction:truth.direction,
      marketTopicId:truth.marketTopicId,
      productionPrediction:row.productionPrediction ?? null,
      productionResult:row.productionResult ?? null,
    });
  }
  if (corrected) saveHistory();
  if (registryCorrected) saveShadowForwardRegistry();
  return { corrected, registryCorrected };
}

function legacyOfficialRevalidationRemaining() {
  return Array.from(rounds.values()).filter(row =>
    row?.resolutionEvidence === 'REVALIDATING_LEGACY_OUTCOME_WINNER_FLAG' &&
    !row?.actual
  ).length;
}

function maybeFinalizeLegacyOfficialRevalidation() {
  if (!legacyOfficialRevalidation.active) return false;
  const remaining = legacyOfficialRevalidationRemaining();
  if (remaining > 0) return false;

  legacyOfficialRevalidation.active = false;
  legacyOfficialRevalidation.completedAt = Date.now();
  const changed = Array.from(rounds.values()).filter(row =>
    (row?.officialDirectionCorrectedFrom === 'UP' || row?.officialDirectionCorrectedFrom === 'DOWN') &&
    String(row?.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC')
  ).length;

  // Force only the rolling/background model to retrain on corrected labels.
  // The explicitly pinned production Shadow candidate is left untouched.
  const previousRollingModelVersion = shadowModel?.modelVersion ?? null;
  shadowModel = null;
  shadowModelMetrics.status = 'RETRAIN_REQUIRED_AFTER_OFFICIAL_LABEL_CORRECTION';
  saveHistory();
  saveShadowForwardRegistry();
  log('legacy_official_settlement_revalidation_complete', {
    total:legacyOfficialRevalidation.total,
    correctedDirections:changed,
    previousRollingModelVersion,
    productionModelUnchanged:shadowCandidate?.modelVersion ?? SHADOW_PRODUCTION_MODEL_VERSION ?? null,
  });
  return true;
}

// Backward-compatible view: latest registered candidate only.
function rollingForwardSummary() {
  const latest = shadowForwardRegistrySummary()[0];
  return latest || {
    modelVersion: null, trainedAt: null, forwardSamples: 0,
    targetSamples: SHADOW_FORWARD_MIN_SAMPLES, remainingSamples: SHADOW_FORWARD_MIN_SAMPLES,
    forwardAccuracy: null, forwardBrier: null, validationAccuracy: null, validationBrier: null,
  };
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r][col];
      if (Math.abs(factor) < 1e-14) continue;
      for (let j = col; j <= n; j += 1) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function recoverPinnedShadowFromHistory(modelVersion) {
  const m = String(modelVersion || '').match(/^shadow-v6-(\d+)$/);
  const trainedAt = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(trainedAt)) return null;

  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r?.shadowCandidateTrainedAt) === trainedAt &&
      Number.isFinite(Number(r?.shadowCandidateProbability)) &&
      r?.shadowFacts
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const dim = SHADOW_FEATURE_KEYS.length + 1;
  if (rows.length < Math.max(40, dim * 2)) {
    log('shadow_production_recovery_insufficient_history', {
      modelVersion,
      trainedAt,
      rows: rows.length,
      required: Math.max(40, dim * 2),
    });
    return null;
  }

  const xtx = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const xty = new Array(dim).fill(0);
  const samples = [];
  for (const row of rows) {
    const vec = shadowVector(row.shadowFacts);
    if (!vec) continue;
    const p0 = Number(row.shadowCandidateProbability);
    if (!Number.isFinite(p0)) continue;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, p0));
    const y = Math.log(p / (1 - p));
    const x = [1, ...vec];
    samples.push({ x, p });
    for (let i = 0; i < dim; i += 1) {
      xty[i] += x[i] * y;
      for (let j = 0; j < dim; j += 1) xtx[i][j] += x[i] * x[j];
    }
  }

  if (samples.length < Math.max(40, dim * 2)) return null;
  for (let i = 0; i < dim; i += 1) xtx[i][i] += 1e-8;
  const weights = solveLinearSystem(xtx, xty);
  if (!weights || weights.length !== dim || !weights.every(Number.isFinite)) {
    log('shadow_production_recovery_solve_failed', { modelVersion, trainedAt, samples: samples.length });
    return null;
  }

  let squared = 0;
  let maxAbsError = 0;
  for (const s of samples) {
    let z = weights[0];
    for (let j = 0; j < s.x.length - 1; j += 1) z += weights[j + 1] * s.x[j + 1];
    const pred = sigmoid(z);
    const err = Math.abs(pred - s.p);
    squared += err * err;
    if (err > maxAbsError) maxAbsError = err;
  }
  const rmse = Math.sqrt(squared / samples.length);
  if (rmse > 0.002 || maxAbsError > 0.02) {
    log('shadow_production_recovery_quality_failed', {
      modelVersion, trainedAt, samples: samples.length, rmse, maxAbsError,
    });
    return null;
  }

  const recovered = {
    weights,
    featureKeys: SHADOW_FEATURE_KEYS,
    trainedAt,
    modelVersion,
    lastTrainRound: rows[0]?.roundStartMs ?? trainedAt,
    recoveredFromHistory: true,
    recoverySamples: samples.length,
    recoveryRmse: Number(rmse.toFixed(8)),
    recoveryMaxAbsError: Number(maxAbsError.toFixed(8)),
  };
  log('shadow_production_model_recovered', {
    modelVersion,
    trainedAt,
    recoverySamples: samples.length,
    recoveryRmse: recovered.recoveryRmse,
    recoveryMaxAbsError: recovered.recoveryMaxAbsError,
  });
  return recovered;
}

function productionUsesShadowV3() {
  return Boolean(
    SHADOW_PRODUCTION_MODEL_VERSION &&
    SHADOW_PRODUCTION_MODEL_VERSION.startsWith('shadow-v3-automl-')
  );
}

function productionUsesSelectiveV2() {
  return SHADOW_PRODUCTION_MODEL_VERSION === LOCK_QUALITY_V2_VERSION;
}

function pinnedShadowV3Candidate() {
  if (!productionUsesShadowV3()) return null;
  const c = shadowV3.getCandidate(SHADOW_PRODUCTION_MODEL_VERSION);
  const s = c?.summary || null;
  if (!c || !s) return null;
  if (Number(s.forwardSamples || 0) < PRODUCTION_MIN_FORWARD_SAMPLES) return null;
  if (!Number.isFinite(Number(s.forwardAccuracy)) || Number(s.forwardAccuracy) < PRODUCTION_MIN_FORWARD_ACCURACY) return null;
  return c;
}

function qualifiedShadowV6Candidate() {
  if (!shadowCandidate?.modelVersion || !shadowCandidate?.weights) return null;
  const reg = shadowForwardRegistry.candidates.find(c => c.modelVersion === shadowCandidate.modelVersion);
  if (!reg) return null;
  const s = candidateRegistrySummary(reg);
  if (Number(s.forwardSamples || 0) < PRODUCTION_MIN_FORWARD_SAMPLES) return null;
  if (!Number.isFinite(Number(s.forwardAccuracy)) || Number(s.forwardAccuracy) < PRODUCTION_MIN_FORWARD_ACCURACY) return null;
  return { candidate: shadowCandidate, summary: s };
}

function productionPolicyName() {
  if (productionUsesSelectiveV2()) {
    return 'IMMUTABLE_FIRST_LOCK_SELECTIVE_V2';
  }
  if (productionUsesShadowV3()) {
    return pinnedShadowV3Candidate()
      ? 'IMMUTABLE_FIRST_LOCK_PINNED_SHADOW_V3_AUTOML_65_GATE'
      : 'QUALIFIED_MODEL_65_GATE_WAIT';
  }
  if (qualifiedShadowV6Candidate()) {
    return 'IMMUTABLE_FIRST_LOCK_QUALIFIED_SHADOW_V6_65_GATE';
  }
  return 'QUALIFIED_MODEL_65_GATE_WAIT';
}

function applyPinnedProductionShadow() {
  if (!SHADOW_PRODUCTION_MODEL_VERSION) return false;

  if (productionUsesSelectiveV2()) {
    const s = selectiveQualityV2Summary();
    log('lock_quality_selective_v2_production_pinned', {
      modelVersion: LOCK_QUALITY_V2_VERSION,
      productionApproved: true,
      approvalSource: 'USER_EXPLICIT',
      forwardRounds: s.forwardRounds,
      forwardSamples: s.forwardSamples,
      hits: s.hits,
      misses: s.misses,
      forwardAccuracy: s.forwardAccuracy,
      coverage: s.coverage,
      thresholds: s.thresholds,
      autoReplacement: false,
    });
    return true;
  }

  if (productionUsesShadowV3()) {
    const v3 = pinnedShadowV3Candidate();
    if (!v3) {
      log('shadow_v3_production_pin_not_available', {
        requestedModelVersion: SHADOW_PRODUCTION_MODEL_VERSION,
      });
      return false;
    }
    log('shadow_v3_production_model_pinned', {
      modelVersion: v3.modelVersion,
      trainedAt: v3.trainedAt,
      estimator: v3.estimator,
      threshold: v3.threshold,
      outerHoldoutAccuracy: v3.outerHoldout?.accuracy ?? null,
      outerHoldoutBaselineAccuracy: v3.outerHoldout?.baselineAccuracy ?? null,
      productionApproved: true,
      approvalMode: 'V3_AUTOML_MODEL_ARTIFACT',
      autoReplacement: false,
    });
    return true;
  }

  const alreadyPinned =
    shadowCandidate?.modelVersion === SHADOW_PRODUCTION_MODEL_VERSION &&
    shadowCandidateMetrics?.productionApproved === true;
  if (alreadyPinned) return true;

  let approvedModel = null;
  let approvalMode = null;
  if (shadowModel?.weights && shadowModel.modelVersion === SHADOW_PRODUCTION_MODEL_VERSION) {
    approvedModel = {
      ...shadowModel,
      weights: shadowModel.weights.map(Number),
      featureKeys: SHADOW_FEATURE_KEYS,
    };
    approvalMode = 'ROLLING_MODEL_ARTIFACT';
  } else {
    const registryModel = shadowForwardRegistry.candidates.find(c =>
      c?.modelVersion === SHADOW_PRODUCTION_MODEL_VERSION &&
      Array.isArray(c?.weights) &&
      c.weights.length === SHADOW_FEATURE_KEYS.length + 1
    );
    if (registryModel) {
      approvedModel = {
        ...registryModel,
        weights: registryModel.weights.map(Number),
        featureKeys: SHADOW_FEATURE_KEYS,
        lastTrainRound: registryModel.lastTrainRound ?? registryModel.trainedAt,
      };
      approvalMode = 'FORWARD_REGISTRY_ARTIFACT';
    } else {
      approvedModel = recoverPinnedShadowFromHistory(SHADOW_PRODUCTION_MODEL_VERSION);
      approvalMode = approvedModel ? 'HISTORICAL_PROBABILITY_RECOVERY' : null;
    }
  }

  if (!approvedModel?.weights) {
    log('shadow_production_pin_not_available', {
      requestedModelVersion: SHADOW_PRODUCTION_MODEL_VERSION,
      loadedRollingModelVersion: shadowModel?.modelVersion ?? null,
      loadedCandidateModelVersion: shadowCandidate?.modelVersion ?? null,
    });
    return false;
  }

  shadowCandidate = approvedModel;
  shadowCandidateMetrics = {
    status: 'MANUALLY_APPROVED_PRODUCTION',
    productionApproved: true,
    approvalSource: 'USER_EXPLICIT',
    approvalMode,
    approvedAt: Date.now(),
    validationAccuracy: Number.isFinite(Number(approvedModel.validationAccuracy))
      ? Number(Number(approvedModel.validationAccuracy).toFixed(4)) : null,
    validationBrier: Number.isFinite(Number(approvedModel.validationBrier))
      ? Number(Number(approvedModel.validationBrier).toFixed(4)) : null,
    baselineAccuracy: Number.isFinite(Number(approvedModel.baselineAccuracy))
      ? Number(Number(approvedModel.baselineAccuracy).toFixed(4)) : null,
    baselineBrier: Number.isFinite(Number(approvedModel.baselineBrier))
      ? Number(Number(approvedModel.baselineBrier).toFixed(4)) : null,
    trainedAt: approvedModel.trainedAt,
    modelVersion: approvedModel.modelVersion,
    recoverySamples: approvedModel.recoverySamples ?? null,
    recoveryRmse: approvedModel.recoveryRmse ?? null,
    recoveryMaxAbsError: approvedModel.recoveryMaxAbsError ?? null,
  };
  saveShadowCandidateArtifact();
  log('shadow_production_model_pinned', {
    modelVersion: shadowCandidate.modelVersion,
    trainedAt: shadowCandidate.trainedAt,
    validationAccuracy: shadowCandidateMetrics.validationAccuracy,
    validationBrier: shadowCandidateMetrics.validationBrier,
    baselineAccuracy: shadowCandidateMetrics.baselineAccuracy,
    baselineBrier: shadowCandidateMetrics.baselineBrier,
    productionApproved: true,
    approvalMode,
    autoReplacement: false,
  });
  return true;
}

function productionShadowApproved() {
  if (productionUsesSelectiveV2()) return true;
  if (productionUsesShadowV3()) {
    return Boolean(pinnedShadowV3Candidate());
  }
  const qualified = qualifiedShadowV6Candidate();
  if (!qualified) return false;
  if (SHADOW_PRODUCTION_MODEL_VERSION) {
    return shadowCandidate.modelVersion === SHADOW_PRODUCTION_MODEL_VERSION;
  }
  return shadowCandidateMetrics?.productionApproved === true ||
    shadowModelMetrics.status === 'FORWARD_VALIDATED_CANDIDATE';
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

function fitWeightedLogistic(samples, config = {}) {
  const lr = Number(config.lr || 0.05);
  const l2 = Number(config.l2 || 0.02);
  const epochs = Math.max(120, Number(config.epochs || 260));
  const halfLife = Math.max(40, Number(config.halfLife || 120));
  const w = new Array(SHADOW_FEATURE_KEYS.length + 1).fill(0);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = new Array(w.length).fill(0);
    let totalWeight = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      const age = samples.length - 1 - i;
      const sampleWeight = Math.pow(0.5, age / halfLife);
      let z = w[0];
      for (let j = 0; j < s.x.length; j += 1) z += w[j + 1] * s.x[j];
      const e = sigmoid(z) - s.y;
      grad[0] += sampleWeight * e;
      for (let j = 0; j < s.x.length; j += 1) grad[j + 1] += sampleWeight * e * s.x[j];
      totalWeight += sampleWeight;
    }
    const denom = totalWeight || 1;
    w[0] -= lr * grad[0] / denom;
    for (let j = 1; j < w.length; j += 1) {
      w[j] -= lr * (grad[j] / denom + l2 * w[j]);
    }
  }
  return w;
}

function evaluateLogisticWeights(weights, samples) {
  let hit = 0;
  let brier = 0;
  for (const s of samples) {
    let z = weights[0];
    for (let j = 0; j < s.x.length; j += 1) z += weights[j + 1] * s.x[j];
    const p = sigmoid(z);
    hit += (p >= 0.5 ? 1 : 0) === s.y ? 1 : 0;
    brier += (p - s.y) * (p - s.y);
  }
  return {
    accuracy: samples.length ? hit / samples.length : null,
    brier: samples.length ? brier / samples.length : null,
  };
}

function walkForwardEvaluate(samples, config) {
  const validationWindow = Math.max(30, Math.min(50, Math.floor(samples.length * 0.08)));
  const folds = 3;
  const firstValidationStart = samples.length - validationWindow * folds;
  if (firstValidationStart < 180) return null;

  const windows = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const validationStart = firstValidationStart + fold * validationWindow;
    const train = samples.slice(0, validationStart);
    const valid = samples.slice(validationStart, validationStart + validationWindow);
    if (train.length < 180 || valid.length < 20) return null;

    const weights = fitWeightedLogistic(train, config);
    const metric = evaluateLogisticWeights(weights, valid);
    const prevalence = train.reduce((sum, x) => sum + x.y, 0) / train.length;
    const baselineClass = prevalence >= 0.5 ? 1 : 0;
    const baselineAccuracy = valid.filter(x => x.y === baselineClass).length / valid.length;
    const baselineBrier = valid.reduce((sum, x) => sum + (prevalence - x.y) ** 2, 0) / valid.length;

    windows.push({
      trainSamples: train.length,
      validationSamples: valid.length,
      validationStartRound: valid[0]?.roundStartMs ?? null,
      validationEndRound: valid[valid.length - 1]?.roundStartMs ?? null,
      accuracy: metric.accuracy,
      brier: metric.brier,
      baselineAccuracy,
      baselineBrier,
    });
  }

  const avg = key => windows.reduce((sum, x) => sum + Number(x[key] || 0), 0) / windows.length;
  const accuracy = avg('accuracy');
  const brier = avg('brier');
  const baselineAccuracy = avg('baselineAccuracy');
  const baselineBrier = avg('baselineBrier');
  const minAccuracy = Math.min(...windows.map(x => x.accuracy));
  const recentAccuracy = windows[windows.length - 1].accuracy;
  const recentBaselineAccuracy = windows[windows.length - 1].baselineAccuracy;

  return {
    windows,
    accuracy,
    brier,
    baselineAccuracy,
    baselineBrier,
    minAccuracy,
    recentAccuracy,
    recentBaselineAccuracy,
    score:
      accuracy * 0.50 +
      recentAccuracy * 0.35 +
      minAccuracy * 0.15 -
      Math.max(0, brier - baselineBrier) * 0.20,
  };
}

function trainLogistic(rows) {
  const samples = rows.map(r => {
    const x = shadowVector(r.shadowFacts);
    const y = r.actual === 'UP' ? 1 : r.actual === 'DOWN' ? 0 : null;
    return x && y !== null ? { x, y, roundStartMs: Number(r.roundStartMs) } : null;
  }).filter(Boolean);
  if (samples.length < SHADOW_TRAIN_MIN_SAMPLES) return null;

  // Optimize only for out-of-time behavior: every validation fold is strictly
  // later than its corresponding training data. Keep the search deliberately
  // small to reduce validation overfitting.
  const configs = [
    { halfLife: 80,  l2: 0.02, lr: 0.05, epochs: 260 },
    { halfLife: 120, l2: 0.02, lr: 0.05, epochs: 260 },
    { halfLife: 180, l2: 0.02, lr: 0.05, epochs: 260 },
    { halfLife: 120, l2: 0.04, lr: 0.05, epochs: 300 },
  ];

  let best = null;
  for (const config of configs) {
    const wf = walkForwardEvaluate(samples, config);
    if (!wf) continue;
    if (!best || wf.score > best.walkForward.score) best = { config, walkForward: wf };
  }
  if (!best) return null;

  // After choosing the hyperparameters using strict past->future folds, train
  // the candidate on all information available at this point. Real quality is
  // still decided only by subsequent strict-forward observations.
  const weights = fitWeightedLogistic(samples, best.config);
  const trainedAt = Date.now();
  const wf = best.walkForward;

  return {
    weights,
    featureKeys: SHADOW_FEATURE_KEYS,
    trainedAt,
    modelVersion: `shadow-v6-${trainedAt}`,
    trainingMethod: 'WALK_FORWARD_RECENCY_V1',
    trainingConfig: best.config,
    trainedSamples: samples.length,
    validationSamples: wf.windows.reduce((sum, x) => sum + x.validationSamples, 0),
    validationAccuracy: wf.accuracy,
    validationBrier: wf.brier,
    baselineAccuracy: wf.baselineAccuracy,
    baselineBrier: wf.baselineBrier,
    walkForwardMinAccuracy: wf.minAccuracy,
    walkForwardRecentAccuracy: wf.recentAccuracy,
    walkForwardRecentBaselineAccuracy: wf.recentBaselineAccuracy,
    walkForwardWindows: wf.windows,
    sampleStartRound: samples[0]?.roundStartMs ?? null,
    sampleEndRound: samples[samples.length - 1]?.roundStartMs ?? null,
    trainEndRound: samples[samples.length - 1]?.roundStartMs ?? null,
    validationStartRound: wf.windows[0]?.validationStartRound ?? null,
    validationEndRound: wf.windows[wf.windows.length - 1]?.validationEndRound ?? null,
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
      rollingModelStrictForward: rollingForwardSummary(),
      shadowForwardCandidates: shadowForwardRegistrySummary(),
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
  if (
    shadowModel &&
    shadowModel.trainingMethod === 'WALK_FORWARD_RECENCY_V1' &&
    latestRound - lastTrainRound < 20 * 300000
  ) {
    updateShadowForwardMetrics();
    return;
  }

  const trained = trainLogistic(labeled);
  if (!trained) return;
  shadowModel = { ...trained, lastTrainRound: latestRound };

  const walkForwardPassed =
    Number.isFinite(Number(trained.validationAccuracy)) &&
    Number.isFinite(Number(trained.baselineAccuracy)) &&
    Number.isFinite(Number(trained.validationBrier)) &&
    Number.isFinite(Number(trained.baselineBrier)) &&
    Number.isFinite(Number(trained.walkForwardRecentAccuracy)) &&
    Number.isFinite(Number(trained.walkForwardRecentBaselineAccuracy)) &&
    Number.isFinite(Number(trained.walkForwardMinAccuracy)) &&
    trained.validationAccuracy >= trained.baselineAccuracy + 0.02 &&
    trained.validationBrier <= trained.baselineBrier &&
    trained.walkForwardRecentAccuracy >= trained.walkForwardRecentBaselineAccuracy &&
    trained.walkForwardMinAccuracy >= 0.50;

  if (walkForwardPassed) {
    registerShadowForwardCandidate(shadowModel);
  } else {
    log('shadow_candidate_rejected_before_forward', {
      modelVersion: trained.modelVersion,
      trainingMethod: trained.trainingMethod,
      walkForwardAccuracy: Number(trained.validationAccuracy.toFixed(4)),
      walkForwardBaselineAccuracy: Number(trained.baselineAccuracy.toFixed(4)),
      walkForwardRecentAccuracy: Number(trained.walkForwardRecentAccuracy.toFixed(4)),
      walkForwardRecentBaselineAccuracy: Number(trained.walkForwardRecentBaselineAccuracy.toFixed(4)),
      walkForwardMinAccuracy: Number(trained.walkForwardMinAccuracy.toFixed(4)),
      walkForwardBrier: Number(trained.validationBrier.toFixed(4)),
      walkForwardBaselineBrier: Number(trained.baselineBrier.toFixed(4)),
    });
  }

  shadowModelMetrics = {
    status: walkForwardPassed
      ? 'SHADOW_WALK_FORWARD_PASSED'
      : 'SHADOW_WALK_FORWARD_REJECTED',
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
  if (walkForwardPassed) maybePromoteShadowCandidate(trained, latestRound);
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

function selectiveV2RecentProductionQuality(excludeRound = null) {
  const settled = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) !== Number(excludeRound) &&
      String(r.productionSource || '').startsWith('LOCK_QUALITY_SELECTIVE_V2') &&
      (r.productionResult === 'HIT' || r.productionResult === 'MISS')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  const recent = settled.slice(-LOCK_QUALITY_V2_DRIFT_RECENT_N);
  const hits = recent.filter(r => r.productionResult === 'HIT').length;
  return {
    samples: recent.length,
    hits,
    misses: recent.length - hits,
    accuracy: recent.length ? hits / recent.length : null,
  };
}


function selectiveV2RecentDirectionQuality(direction, excludeRound = null, recentN = 10) {
  const dir = direction === 'UP' || direction === 'DOWN' ? direction : null;
  if (!dir) return { direction:null, samples:0, hits:0, misses:0, accuracy:null, missStreak:0 };
  const settled = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) !== Number(excludeRound) &&
      r.productionSource === 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY' &&
      r.productionPrediction === dir &&
      (r.productionResult === 'HIT' || r.productionResult === 'MISS')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  const recent = settled.slice(-Math.max(1, Number(recentN) || 10));
  const hits = recent.filter(r => r.productionResult === 'HIT').length;
  let missStreak = 0;
  for (let i = settled.length - 1; i >= 0; i -= 1) {
    if (settled[i].productionResult !== 'MISS') break;
    missStreak += 1;
  }
  return {
    direction: dir,
    samples: recent.length,
    hits,
    misses: recent.length - hits,
    accuracy: recent.length ? hits / recent.length : null,
    missStreak,
  };
}

function selectiveV2AdaptiveThresholds(excludeRound = null) {
  const recent = selectiveV2RecentProductionQuality(excludeRound);
  const allSettled = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) !== Number(excludeRound) &&
      String(r.productionSource || '').startsWith('LOCK_QUALITY_SELECTIVE_V2') &&
      (r.productionResult === 'HIT' || r.productionResult === 'MISS')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));
  const summarizeTail = n => {
    const tail = allSettled.slice(-n);
    const hits = tail.filter(r => r.productionResult === 'HIT').length;
    return {
      samples: tail.length,
      hits,
      misses: tail.length - hits,
      accuracy: tail.length ? hits / tail.length : null,
    };
  };
  const recent10 = summarizeTail(10);
  const recent5 = summarizeTail(5);

  let mode = 'NORMAL';
  let supportMin = LOCK_QUALITY_V2_SUPPORT_MIN;
  let currentMin = LOCK_QUALITY_V2_CURRENT_MIN;
  let maxDelayMs = LOCK_QUALITY_V2_MAX_DELAY_MS;

  if (recent.samples >= LOCK_QUALITY_V2_DRIFT_RECENT_N) {
    if (recent.accuracy < 0.55) {
      mode = 'DRIFT_CRITICAL';
      supportMin = Math.max(supportMin, 0.15);
      currentMin = Math.max(currentMin, 0.75);
      maxDelayMs = Math.min(maxDelayMs, 16000);
    } else if (recent.accuracy < LOCK_QUALITY_V2_DRIFT_MIN_ACCURACY) {
      mode = 'DRIFT_SUPPORT_FOCUS';
      // Settled replay shows predictionSupport is the useful discriminator.
      // Keep current-score and delay broadly unchanged so a weak direction
      // does not unnecessarily suppress the healthy side.
      supportMin = Math.max(supportMin, 0.12);
    } else if (recent.accuracy < LOCK_QUALITY_V2_RECOVERY_ACCURACY) {
      mode = 'RECOVERY_CAUTION';
      supportMin = Math.max(supportMin, 0.08);
      currentMin = Math.max(currentMin, 0.65);
      maxDelayMs = Math.min(maxDelayMs, 20000);
    }
  }

  return {
    mode,
    recent,
    recent10,
    recent5,
    supportMin,
    currentMin,
    maxDelayMs,
  };
}

function evaluateSelectiveQualityV2(direction, facts, delayMs, excludeRound = null) {
  const support = lockPredictionSupport(direction, facts);
  const currentAbs = Math.abs(Number(facts?.currentScore));
  const delay = Number(delayMs);
  const absorption = facts?.absorptionRisk === true;
  const adaptive = selectiveV2AdaptiveThresholds(excludeRound);
  const directionQuality = selectiveV2RecentDirectionQuality(direction, excludeRound, 10);
  const directionRecent5 = selectiveV2RecentDirectionQuality(direction, excludeRound, 5);
  const directionRecent4 = selectiveV2RecentDirectionQuality(direction, excludeRound, 4);

  // Direction-local adaptive guard. UP and DOWN are evaluated independently.
  // A weak side tightens itself automatically; the healthy side is untouched.
  // Thresholds also relax automatically once the recent directional window
  // recovers, because this state is recalculated from settled strict-forward
  // production decisions on every evaluation.
  let effectiveSupportMin = adaptive.supportMin;
  let effectiveCurrentMin = adaptive.currentMin;
  let effectiveMaxDelayMs = adaptive.maxDelayMs;
  let directionalMode = 'NONE';

  if (
    directionQuality.samples >= 10 &&
    Number.isFinite(directionQuality.accuracy) &&
    directionQuality.accuracy < 0.65
  ) {
    effectiveSupportMin = Math.max(effectiveSupportMin, 0.14);
    directionalMode = 'DIRECTION_CAUTION';
  }

  // Fast response: do not wait for 10 same-direction decisions when the latest
  // 4 have already degraded to coin-flip quality or worse.
  if (
    directionRecent4.samples >= 4 &&
    Number.isFinite(directionRecent4.accuracy) &&
    directionRecent4.accuracy <= 0.50
  ) {
    effectiveSupportMin = Math.max(effectiveSupportMin, 0.15);
    effectiveCurrentMin = Math.max(effectiveCurrentMin, 0.65);
    effectiveMaxDelayMs = Math.min(effectiveMaxDelayMs, 20000);
    directionalMode = 'DIRECTION_FAST_GUARD';
  }

  if (
    directionRecent5.samples >= 5 &&
    Number.isFinite(directionRecent5.accuracy) &&
    directionRecent5.accuracy <= 0.40
  ) {
    effectiveSupportMin = Math.max(effectiveSupportMin, 0.18);
    effectiveCurrentMin = Math.max(effectiveCurrentMin, 0.70);
    effectiveMaxDelayMs = Math.min(effectiveMaxDelayMs, 18000);
    directionalMode = 'DIRECTION_FAST_DRIFT';
  }

  // Consecutive errors get an immediate local response even before the rolling
  // accuracy window fully deteriorates.
  if (Number(directionQuality.missStreak || 0) >= 2) {
    effectiveSupportMin = Math.max(effectiveSupportMin, 0.16);
    effectiveCurrentMin = Math.max(effectiveCurrentMin, 0.67);
    effectiveMaxDelayMs = Math.min(effectiveMaxDelayMs, 19000);
    directionalMode = 'DIRECTION_MISS_STREAK_CAUTION';
  }

  if (Number(directionQuality.missStreak || 0) >= 3) {
    effectiveSupportMin = Math.max(effectiveSupportMin, 0.20);
    effectiveCurrentMin = Math.max(effectiveCurrentMin, 0.72);
    effectiveMaxDelayMs = Math.min(effectiveMaxDelayMs, 16000);
    directionalMode = 'DIRECTION_MISS_STREAK_GUARD';
  }

  const reasons = [];
  let eligible = true;

  if (!Number.isFinite(support)) { eligible = false; reasons.push('MISSING_PREDICTION_SUPPORT'); }
  if (!Number.isFinite(currentAbs)) { eligible = false; reasons.push('MISSING_CURRENT_SCORE'); }
  if (!Number.isFinite(delay)) { eligible = false; reasons.push('MISSING_LOCK_DELAY'); }
  if (Number.isFinite(support) && support < effectiveSupportMin) reasons.push('PREDICTION_SUPPORT_BELOW_ADAPTIVE_MIN');
  if (Number.isFinite(currentAbs) && currentAbs < effectiveCurrentMin) reasons.push('CURRENT_SCORE_BELOW_ADAPTIVE_MIN');
  if (Number.isFinite(delay) && delay >= effectiveMaxDelayMs) reasons.push('LOCK_DELAY_ABOVE_ADAPTIVE_MAX');
  if (absorption) reasons.push('ABSORPTION_RISK');

  const pass = eligible && reasons.length === 0;
  return {
    version: LOCK_QUALITY_V2_VERSION,
    eligible,
    pass,
    decision: eligible ? (pass ? direction : 'WAIT') : 'WAIT',
    reasons,
    predictionSupport: Number.isFinite(support) ? Number(support.toFixed(4)) : null,
    currentScoreAbs: Number.isFinite(currentAbs) ? Number(currentAbs.toFixed(4)) : null,
    lockDelayMs: Number.isFinite(delay) ? delay : null,
    absorptionRisk: absorption,
    adaptiveMode: adaptive.mode,
    directionalMode,
    recentProductionQuality: {
      samples: adaptive.recent.samples,
      hits: adaptive.recent.hits,
      misses: adaptive.recent.misses,
      accuracy: Number.isFinite(adaptive.recent.accuracy) ? Number(adaptive.recent.accuracy.toFixed(4)) : null,
    },
    recentDirectionQuality: {
      direction: directionQuality.direction,
      samples: directionQuality.samples,
      hits: directionQuality.hits,
      misses: directionQuality.misses,
      accuracy: Number.isFinite(directionQuality.accuracy) ? Number(directionQuality.accuracy.toFixed(4)) : null,
      missStreak: Number(directionQuality.missStreak || 0),
      recent5: {
        samples: directionRecent5.samples,
        hits: directionRecent5.hits,
        misses: directionRecent5.misses,
        accuracy: Number.isFinite(directionRecent5.accuracy) ? Number(directionRecent5.accuracy.toFixed(4)) : null,
      },
      recent4: {
        samples: directionRecent4.samples,
        hits: directionRecent4.hits,
        misses: directionRecent4.misses,
        accuracy: Number.isFinite(directionRecent4.accuracy) ? Number(directionRecent4.accuracy.toFixed(4)) : null,
      },
    },
    thresholds: {
      predictionSupportMin: effectiveSupportMin,
      currentScoreMin: effectiveCurrentMin,
      maxDelayMs: effectiveMaxDelayMs,
      rejectAbsorption: true,
    },
  };
}

function selectiveQualityV2Summary() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= LOCK_QUALITY_V2_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const evaluated = rows.map(r => {
    const q = r.lockQualitySelectiveV2 ||
      ((r.prediction === 'UP' || r.prediction === 'DOWN')
        ? evaluateSelectiveQualityV2(r.prediction, r.predictionFacts, r.predictionDelayMs)
        : { decision:'WAIT', pass:false, eligible:false, reasons:['NO_BASE_DIRECTION'] });
    const decision = q?.pass && (r.prediction === 'UP' || r.prediction === 'DOWN') ? r.prediction : 'WAIT';
    return { row:r, q, decision };
  });
  const decided = evaluated.filter(x => x.decision === 'UP' || x.decision === 'DOWN');
  const hits = decided.filter(x => x.decision === x.row.actual).length;
  const misses = decided.length - hits;
  const accuracy = decided.length ? hits / decided.length : null;
  const coverage = evaluated.length ? decided.length / evaluated.length : null;
  const recent20 = decided.slice(-20);
  const recentHits = recent20.filter(x => x.decision === x.row.actual).length;
  let status = 'COLLECTING';
  if (decided.length >= 20 && Number.isFinite(accuracy) && accuracy < 0.65) status = 'RETIRED_LOW_ACCURACY';
  else if (evaluated.length >= 40 && Number.isFinite(coverage) && coverage < 0.20) status = 'RETIRED_LOW_COVERAGE';
  else if (decided.length >= 60 && Number.isFinite(accuracy) && accuracy >= 0.70 && coverage >= 0.25) status = 'FORWARD_70_MET';
  else if (decided.length >= 60) status = 'FORWARD_COMPLETE';

  return {
    ok:true,
    modelVersion: LOCK_QUALITY_V2_VERSION,
    productionEffect: productionUsesSelectiveV2() ? 'PRIMARY' : 'NONE_SHADOW_ONLY',
    startMs:LOCK_QUALITY_V2_START_MS,
    forwardRounds:evaluated.length,
    forwardSamples:decided.length,
    waits:evaluated.length-decided.length,
    hits,
    misses,
    forwardAccuracy:decided.length ? Number(accuracy.toFixed(4)) : null,
    coverage:evaluated.length ? Number(coverage.toFixed(4)) : null,
    recent20Accuracy:recent20.length ? Number((recentHits/recent20.length).toFixed(4)) : null,
    thresholds:{
      predictionSupportMin:LOCK_QUALITY_V2_SUPPORT_MIN,
      currentScoreMin:LOCK_QUALITY_V2_CURRENT_MIN,
      maxDelayMs:LOCK_QUALITY_V2_MAX_DELAY_MS,
      rejectAbsorption:true,
    },
    adaptive: selectiveV2AdaptiveThresholds(),
    status,
  };
}



function selectiveV2HighPrecisionCandidateDecision(direction, facts, delayMs, cfg) {
  const reasons = [];
  const support = lockPredictionSupport(direction, facts);
  const currentAbs = Math.abs(Number(facts?.currentScore));
  const delay = Number(delayMs);
  const absorption = facts?.absorptionRisk === true;

  if (direction !== 'UP' && direction !== 'DOWN') reasons.push('NO_BASE_DIRECTION');
  if (!Number.isFinite(support)) reasons.push('MISSING_PREDICTION_SUPPORT');
  if (!Number.isFinite(currentAbs)) reasons.push('MISSING_CURRENT_SCORE');
  if (!Number.isFinite(delay)) reasons.push('MISSING_LOCK_DELAY');
  if (Number.isFinite(support) && support < cfg.supportMin) reasons.push('PREDICTION_SUPPORT_BELOW_HP_MIN');
  if (Number.isFinite(currentAbs) && currentAbs < cfg.currentMin) reasons.push('CURRENT_SCORE_BELOW_HP_MIN');
  if (Number.isFinite(delay) && delay >= cfg.maxDelayMs) reasons.push('LOCK_DELAY_ABOVE_HP_MAX');
  if (absorption) reasons.push('ABSORPTION_RISK');

  const pass = reasons.length === 0;
  return {
    candidateId: cfg.id,
    decision: pass ? direction : 'WAIT',
    pass,
    reasons,
    predictionSupport: Number.isFinite(support) ? Number(support.toFixed(4)) : null,
    currentScoreAbs: Number.isFinite(currentAbs) ? Number(currentAbs.toFixed(4)) : null,
    lockDelayMs: Number.isFinite(delay) ? delay : null,
    thresholds: {
      predictionSupportMin: cfg.supportMin,
      currentScoreMin: cfg.currentMin,
      maxDelayMs: cfg.maxDelayMs,
      rejectAbsorption: true,
    },
  };
}

function evaluateSelectiveV2HighPrecisionShadow(direction, facts, delayMs) {
  return {
    version: SELECTIVE_V2_HP_SHADOW_VERSION,
    evaluatedAt: Date.now(),
    productionEffect: 'NONE_SHADOW_ONLY',
    baseDirection: direction === 'UP' || direction === 'DOWN' ? direction : null,
    candidates: Object.fromEntries(
      SELECTIVE_V2_HP_CONFIGS.map(cfg => [
        cfg.id,
        selectiveV2HighPrecisionCandidateDecision(direction, facts, delayMs, cfg),
      ])
    ),
  };
}

function selectiveV2HighPrecisionShadowSummary() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= SELECTIVE_V2_HP_SHADOW_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const candidates = SELECTIVE_V2_HP_CONFIGS.map(cfg => {
    const observed = rows.filter(r =>
      r.selectiveV2HighPrecisionShadow?.version === SELECTIVE_V2_HP_SHADOW_VERSION
    );
    const decided = observed
      .map(r => ({
        row: r,
        decision: r.selectiveV2HighPrecisionShadow?.candidates?.[cfg.id]?.decision || 'WAIT',
      }))
      .filter(x => x.decision === 'UP' || x.decision === 'DOWN');

    const hits = decided.filter(x => x.decision === x.row.actual).length;
    const misses = decided.length - hits;
    const recent20 = decided.slice(-20);
    const recentHits = recent20.filter(x => x.decision === x.row.actual).length;

    let maxConsecutiveErrors = 0;
    let missStreak = 0;
    for (const x of decided) {
      if (x.decision === x.row.actual) {
        missStreak = 0;
      } else {
        missStreak += 1;
        maxConsecutiveErrors = Math.max(maxConsecutiveErrors, missStreak);
      }
    }

    const accuracy = decided.length ? hits / decided.length : null;
    const recent20Accuracy = recent20.length ? recentHits / recent20.length : null;
    let status = 'FORWARD_COLLECTING';
    if (decided.length >= 20 && Number.isFinite(accuracy) && accuracy < 0.65) {
      status = 'RETIRED_LOW_ACCURACY';
    } else if (
      decided.length >= SELECTIVE_V2_HP_FORWARD_TARGET &&
      Number.isFinite(accuracy) &&
      accuracy >= SELECTIVE_V2_HP_PROMOTE_ACCURACY &&
      recent20.length >= 20 &&
      recent20Accuracy >= SELECTIVE_V2_HP_REVIEW_ACCURACY
    ) {
      status = 'RECOMMENDED_80_FOR_REVIEW';
    } else if (
      decided.length >= SELECTIVE_V2_HP_FORWARD_TARGET &&
      Number.isFinite(accuracy) &&
      accuracy >= SELECTIVE_V2_HP_REVIEW_ACCURACY &&
      recent20.length >= 20 &&
      recent20Accuracy >= SELECTIVE_V2_HP_REVIEW_ACCURACY
    ) {
      status = 'QUALIFIED_75_FOR_REVIEW';
    } else if (
      decided.length >= 20 &&
      Number.isFinite(accuracy) &&
      accuracy >= SELECTIVE_V2_HP_PROMOTE_ACCURACY
    ) {
      status = 'EARLY_80_MET_NEEDS_MORE_SAMPLES';
    }

    return {
      candidateId: cfg.id,
      config: cfg,
      status,
      productionEffect: 'NONE_SHADOW_ONLY',
      strictForwardSamples: decided.length,
      targetSamples: SELECTIVE_V2_HP_FORWARD_TARGET,
      remainingSamples: Math.max(0, SELECTIVE_V2_HP_FORWARD_TARGET - decided.length),
      hits,
      misses,
      forwardAccuracy: decided.length ? Number(accuracy.toFixed(4)) : null,
      recent20Accuracy: recent20.length ? Number(recent20Accuracy.toFixed(4)) : null,
      maxConsecutiveErrors,
      coverage: rows.length ? Number((decided.length / rows.length).toFixed(4)) : null,
    };
  }).sort((a,b) =>
    Number(b.forwardAccuracy || 0) - Number(a.forwardAccuracy || 0) ||
    Number(b.strictForwardSamples || 0) - Number(a.strictForwardSamples || 0)
  );

  const reviewable = candidates.filter(x =>
    (x.status === 'RECOMMENDED_80_FOR_REVIEW' || x.status === 'QUALIFIED_75_FOR_REVIEW')
  );
  return {
    ok: true,
    version: SELECTIVE_V2_HP_SHADOW_VERSION,
    startMs: SELECTIVE_V2_HP_SHADOW_START_MS,
    productionEffect: 'NONE_SHADOW_ONLY',
    productionFrozen: true,
    targetSamples: SELECTIVE_V2_HP_FORWARD_TARGET,
    reviewAccuracy: SELECTIVE_V2_HP_REVIEW_ACCURACY,
    preferredAccuracy: SELECTIVE_V2_HP_PROMOTE_ACCURACY,
    settledRoundsSinceStart: rows.length,
    candidates,
    leader: candidates[0] || null,
    recommendedForReview: reviewable[0] || null,
  };
}


function selectiveV2FilteredWaitRescueBacktest() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= LOCK_QUALITY_V2_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const baseline = rows.map(r => {
    const hasBase = r.prediction === 'UP' || r.prediction === 'DOWN';
    const q = hasBase
      ? (r.lockQualitySelectiveV2 ||
          evaluateSelectiveQualityV2(r.prediction, r.predictionFacts, r.predictionDelayMs, r.roundStartMs))
      : null;
    const decision = hasBase && q?.pass ? r.prediction : 'WAIT';
    return { row:r, q, decision };
  });

  const baseDecided = baseline.filter(x => x.decision === 'UP' || x.decision === 'DOWN');
  const baseHits = baseDecided.filter(x => x.decision === x.row.actual).length;
  const edgeWaits = baseline.filter(x =>
    x.decision === 'WAIT' &&
    (x.row.prediction === 'UP' || x.row.prediction === 'DOWN') &&
    x.row.predictionFacts && typeof x.row.predictionFacts === 'object'
  );

  const supportMins = [0.08,0.10,0.11,0.12,0.13,0.15];
  const currentMins = [0.60,0.65,0.70,0.72,0.75];
  const scoreMins = [0.45,0.55,0.60,0.65];
  const maxDelays = [12000,15000,18000,20000];
  const alignedOptions = [false,true];
  const trendAgreeOptions = [false,true];
  const results = [];

  for (const supportMin of supportMins)
  for (const currentMin of currentMins)
  for (const scoreMin of scoreMins)
  for (const maxDelayMs of maxDelays)
  for (const requireAligned of alignedOptions)
  for (const requireTrendAgree of trendAgreeOptions) {
    let samples=0,hits=0,upSamples=0,upHits=0,downSamples=0,downHits=0;
    for (const x of edgeWaits) {
      const r=x.row, f=r.predictionFacts || {};
      const dir=r.prediction;
      const sign=dir==='UP'?1:-1;
      const support=lockPredictionSupport(dir,f);
      const current=Math.abs(Number(f.currentScore));
      const score=Math.abs(Number(r.predictionScore));
      const delay=Number(r.predictionDelayMs);
      const trend=Number(f.currentTrendScore);
      const alignment=String(f.alignment || '').toUpperCase();
      if (![support,current,score,delay].every(Number.isFinite)) continue;
      if (f.absorptionRisk === true) continue;
      if (support < supportMin) continue;
      if (current < currentMin) continue;
      if (score < scoreMin) continue;
      if (delay > maxDelayMs) continue;
      if (requireAligned && alignment !== 'ALIGNED') continue;
      if (requireTrendAgree && (!Number.isFinite(trend) || sign*trend <= 0)) continue;

      samples += 1;
      if (dir === 'UP') upSamples += 1; else downSamples += 1;
      if (dir === r.actual) {
        hits += 1;
        if (dir === 'UP') upHits += 1; else downHits += 1;
      }
    }
    if (!samples) continue;
    const combinedSamples=baseDecided.length+samples;
    const combinedHits=baseHits+hits;
    results.push({
      supportMin,currentMin,scoreMin,maxDelayMs,requireAligned,requireTrendAgree,
      samples,hits,misses:samples-hits,
      incrementalAccuracy:Number((hits/samples).toFixed(4)),
      up:{samples:upSamples,hits:upHits,accuracy:upSamples?Number((upHits/upSamples).toFixed(4)):null},
      down:{samples:downSamples,hits:downHits,accuracy:downSamples?Number((downHits/downSamples).toFixed(4)):null},
      incrementalCoverage:Number((samples/rows.length).toFixed(4)),
      combinedSamples,
      combinedAccuracy:Number((combinedHits/combinedSamples).toFixed(4)),
      combinedCoverage:Number((combinedSamples/rows.length).toFixed(4)),
    });
  }

  const qualified=results
    .filter(x => x.samples >= 10 && x.incrementalAccuracy >= 0.70 && x.combinedAccuracy >= 0.70)
    .sort((a,b) =>
      b.combinedCoverage-a.combinedCoverage ||
      b.incrementalAccuracy-a.incrementalAccuracy ||
      b.samples-a.samples
    );

  const conservative=results
    .filter(x => x.samples >= 15 && x.incrementalAccuracy >= 0.75 && x.combinedAccuracy >= 0.70)
    .sort((a,b) =>
      b.combinedCoverage-a.combinedCoverage ||
      b.incrementalAccuracy-a.incrementalAccuracy ||
      b.samples-a.samples
    );

  return {
    ok:true,
    analysis:'SELECTIVE_V2_FILTERED_WAIT_RESCUE_BACKTEST',
    productionEffect:'NONE_DIAGNOSTIC_ONLY',
    settledRounds:rows.length,
    baseline:{
      samples:baseDecided.length,
      hits:baseHits,
      misses:baseDecided.length-baseHits,
      accuracy:baseDecided.length?Number((baseHits/baseDecided.length).toFixed(4)):null,
      coverage:rows.length?Number((baseDecided.length/rows.length).toFixed(4)):null,
    },
    baseDirectionFilteredWaits:edgeWaits.length,
    searchSpace:results.length,
    qualifiedCount:qualified.length,
    conservativeCount:conservative.length,
    topQualified:qualified.slice(0,12),
    topConservative:conservative.slice(0,12),
  };
}


function selectiveV2EdgeRescueCandidateDecision(direction, facts, delayMs, predictionScore) {
  const reasons = [];
  const dir = direction === 'UP' || direction === 'DOWN' ? direction : null;
  const support = dir ? lockPredictionSupport(dir, facts) : null;
  const currentAbs = Math.abs(Number(facts?.currentScore));
  const scoreAbs = Math.abs(Number(predictionScore));
  const delay = Number(delayMs);
  const absorption = facts?.absorptionRisk === true;

  if (!dir) reasons.push('NO_BASE_DIRECTION');
  if (!Number.isFinite(support)) reasons.push('MISSING_PREDICTION_SUPPORT');
  if (!Number.isFinite(currentAbs)) reasons.push('MISSING_CURRENT_SCORE');
  if (!Number.isFinite(scoreAbs)) reasons.push('MISSING_BASE_SCORE');
  if (!Number.isFinite(delay)) reasons.push('MISSING_LOCK_DELAY');
  if (absorption) reasons.push('ABSORPTION_RISK');
  if (Number.isFinite(support) && support < SELECTIVE_V2_EDGE_RESCUE_CONFIG.supportMin) reasons.push('SUPPORT_BELOW_EDGE_MIN');
  if (Number.isFinite(currentAbs) && currentAbs < SELECTIVE_V2_EDGE_RESCUE_CONFIG.currentMin) reasons.push('CURRENT_BELOW_EDGE_MIN');
  if (Number.isFinite(scoreAbs) && scoreAbs < SELECTIVE_V2_EDGE_RESCUE_CONFIG.scoreMin) reasons.push('SCORE_BELOW_EDGE_MIN');
  if (Number.isFinite(delay) && delay > SELECTIVE_V2_EDGE_RESCUE_CONFIG.maxDelayMs) reasons.push('DELAY_ABOVE_EDGE_MAX');

  const pass = reasons.length === 0;
  return {
    version:SELECTIVE_V2_EDGE_RESCUE_VERSION,
    evaluatedAt:Date.now(),
    productionEffect:'CONDITIONAL_EDGE_RESCUE',
    decision:pass ? dir : 'WAIT',
    pass,
    reasons,
    facts:{
      predictionSupport:Number.isFinite(support)?Number(support.toFixed(4)):null,
      currentScoreAbs:Number.isFinite(currentAbs)?Number(currentAbs.toFixed(4)):null,
      baseScoreAbs:Number.isFinite(scoreAbs)?Number(scoreAbs.toFixed(4)):null,
      lockDelayMs:Number.isFinite(delay)?delay:null,
      absorptionRisk:absorption,
    },
    thresholds:{...SELECTIVE_V2_EDGE_RESCUE_CONFIG},
  };
}

function selectiveV2EdgeRescueSummary() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= SELECTIVE_V2_EDGE_RESCUE_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r?.selectiveV2EdgeRescue?.version === SELECTIVE_V2_EDGE_RESCUE_VERSION
    )
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));

  const eligible = rows.filter(r =>
    r.selectiveV2EdgeRescue?.decision === 'UP' || r.selectiveV2EdgeRescue?.decision === 'DOWN'
  );

  const summarize = arr => {
    const hits = arr.filter(r => r.selectiveV2EdgeRescue.decision === r.actual).length;
    return {
      samples:arr.length,
      hits,
      misses:arr.length-hits,
      accuracy:arr.length?Number((hits/arr.length).toFixed(4)):null,
    };
  };

  const recent10 = eligible.slice(-10);
  const byDirection = dir => {
    const all = eligible.filter(r => r.selectiveV2EdgeRescue.decision === dir);
    const recent = all.slice(-6);
    let missStreak = 0;
    for (let i=all.length-1;i>=0;i-=1) {
      if (all[i].selectiveV2EdgeRescue.decision === all[i].actual) break;
      missStreak += 1;
    }
    const allStats = summarize(all);
    const recentStats = summarize(recent);
    const fused =
      (recentStats.samples >= SELECTIVE_V2_EDGE_RESCUE_DIRECTION_MIN_SAMPLES &&
       Number.isFinite(recentStats.accuracy) &&
       recentStats.accuracy < SELECTIVE_V2_EDGE_RESCUE_MIN_ACCURACY) ||
      missStreak >= SELECTIVE_V2_EDGE_RESCUE_MAX_MISS_STREAK;
    return {
      ...allStats,
      recent6:recentStats,
      missStreak,
      fused,
      fuseReason:fused
        ? (missStreak >= SELECTIVE_V2_EDGE_RESCUE_MAX_MISS_STREAK
          ? 'DIRECTION_MISS_STREAK'
          : 'DIRECTION_RECENT_ACCURACY_BELOW_70')
        : null,
    };
  };

  const recentStats = summarize(recent10);
  const globalFused =
    recentStats.samples >= SELECTIVE_V2_EDGE_RESCUE_GLOBAL_MIN_SAMPLES &&
    Number.isFinite(recentStats.accuracy) &&
    recentStats.accuracy < SELECTIVE_V2_EDGE_RESCUE_MIN_ACCURACY;

  const up = byDirection('UP');
  const down = byDirection('DOWN');
  const productionRows = rows.filter(r =>
    r.productionSource === 'SELECTIVE_V2_EDGE_RESCUE_PRIMARY' &&
    (r.productionResult === 'HIT' || r.productionResult === 'MISS')
  );
  const productionHits = productionRows.filter(r => r.productionResult === 'HIT').length;

  return {
    ok:true,
    version:SELECTIVE_V2_EDGE_RESCUE_VERSION,
    startMs:SELECTIVE_V2_EDGE_RESCUE_START_MS,
    productionEffect:'CONDITIONAL_EDGE_RESCUE',
    config:{...SELECTIVE_V2_EDGE_RESCUE_CONFIG},
    evaluatedSettledRounds:rows.length,
    eligibleStrictForward:summarize(eligible),
    recent10:recentStats,
    up,
    down,
    fuse:{
      globalFused,
      globalReason:globalFused?'GLOBAL_RECENT_ACCURACY_BELOW_70_EARLY_FUSE':null,
      minGlobalSamples:SELECTIVE_V2_EDGE_RESCUE_GLOBAL_MIN_SAMPLES,
      minDirectionSamples:SELECTIVE_V2_EDGE_RESCUE_DIRECTION_MIN_SAMPLES,
      minAccuracy:SELECTIVE_V2_EDGE_RESCUE_MIN_ACCURACY,
      maxMissStreak:SELECTIVE_V2_EDGE_RESCUE_MAX_MISS_STREAK,
    },
    production:{
      samples:productionRows.length,
      hits:productionHits,
      misses:productionRows.length-productionHits,
      accuracy:productionRows.length?Number((productionHits/productionRows.length).toFixed(4)):null,
    },
  };
}

function selectiveV2EdgeRescueFuseState(direction) {
  const s = selectiveV2EdgeRescueSummary();
  const dir = direction === 'UP' ? s.up : direction === 'DOWN' ? s.down : null;
  if (s.fuse.globalFused) {
    return {allowed:false,reason:s.fuse.globalReason,summary:s};
  }
  if (dir?.fused) {
    return {allowed:false,reason:dir.fuseReason,summary:s};
  }
  return {allowed:true,reason:null,summary:s};
}

function evaluateSelectiveV2EdgeRescueRow(row, selectiveQuality) {
  if (!row || Number(row.roundStartMs) < SELECTIVE_V2_EDGE_RESCUE_START_MS) return null;
  if (row.selectiveV2EdgeRescue?.version === SELECTIVE_V2_EDGE_RESCUE_VERSION) {
    return row.selectiveV2EdgeRescue;
  }
  const direction = row.prediction === 'UP' || row.prediction === 'DOWN' ? row.prediction : null;
  if (!direction || selectiveQuality?.pass) return null;
  const decision = selectiveV2EdgeRescueCandidateDecision(
    direction,
    row.predictionFacts,
    row.predictionDelayMs,
    row.predictionScore
  );
  const evaluated = {
    ...decision,
    baseSelectiveReasons:Array.isArray(selectiveQuality?.reasons) ? [...selectiveQuality.reasons] : [],
  };
  row.selectiveV2EdgeRescue = evaluated;
  saveHistory();
  log('selective_v2_edge_rescue_candidate_evaluated', {
    round:row.roundStartMs,
    baseDirection:direction,
    decision:evaluated.decision,
    reasons:evaluated.reasons,
    baseSelectiveReasons:evaluated.baseSelectiveReasons,
    facts:evaluated.facts,
  });
  return evaluated;
}


function selectiveV2InternalDirectionBacktest() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= LOCK_QUALITY_V2_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN')
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const baseline = rows.map(r => {
    const hasBase = r.prediction === 'UP' || r.prediction === 'DOWN';
    const q = hasBase
      ? (r.lockQualitySelectiveV2 ||
          evaluateSelectiveQualityV2(r.prediction, r.predictionFacts, r.predictionDelayMs))
      : null;
    const decision = hasBase && q?.pass ? r.prediction : 'WAIT';
    return { row:r, decision };
  });
  const baselineDecided = baseline.filter(x => x.decision === 'UP' || x.decision === 'DOWN');
  const baselineHits = baselineDecided.filter(x => x.decision === x.row.actual).length;

  const currentMins = [0.45,0.50,0.55,0.60];
  const scoreMins = [0.08,0.12,0.16,0.20,0.22];
  const momentum30Mins = [0,0.05,0.10];
  const distanceMins = [0,0.5,1.0];
  const results = [];

  for (const currentMin of currentMins) {
    for (const scoreMin of scoreMins) {
      for (const momentum30Min of momentum30Mins) {
        for (const distanceMinBps of distanceMins) {
          let added = 0, addedHits = 0, considered = 0;
          for (const x of baseline) {
            if (x.decision !== 'WAIT') continue;
            const r = x.row;
            // This optimization targets the dominant WAIT cause: no base direction.
            if (r.prediction === 'UP' || r.prediction === 'DOWN') continue;
            const f = r.shadowFacts;
            if (!f || typeof f !== 'object') continue;

            const current = Number(f.currentScore);
            const score = Number(f.liveScore);
            const distance = Number(f.distanceFromOpenBps);
            const m30 = Number(f.normalizedMomentum30s);
            if (![current, score, distance, m30].every(Number.isFinite)) continue;
            considered += 1;
            if (Math.abs(distance) < distanceMinBps) continue;

            const sign = distance > 0 ? 1 : distance < 0 ? -1 : 0;
            if (!sign) continue;
            if (sign * current < currentMin) continue;
            if (sign * score < scoreMin) continue;
            if (sign * m30 < momentum30Min) continue;
            if (f.absorptionRisk === true) continue;

            const regime = String(f.regimeDirection || '').toUpperCase();
            const regimeAgreement = Number(f.regimeAgreement);
            if (
              Number.isFinite(regimeAgreement) &&
              regimeAgreement >= 0.67 &&
              ((sign > 0 && regime === 'DOWN') || (sign < 0 && regime === 'UP'))
            ) continue;

            const upMid = Number(f.predictionMarketUpMid);
            if (Number.isFinite(upMid)) {
              if (sign > 0 && upMid < 0.47) continue;
              if (sign < 0 && upMid > 0.53) continue;
            }

            const decision = sign > 0 ? 'UP' : 'DOWN';
            added += 1;
            if (decision === r.actual) addedHits += 1;
          }

          const combinedSamples = baselineDecided.length + added;
          const combinedHits = baselineHits + addedHits;
          const incrementalAccuracy = added ? addedHits / added : null;
          const combinedAccuracy = combinedSamples ? combinedHits / combinedSamples : null;
          const combinedCoverage = rows.length ? combinedSamples / rows.length : null;
          results.push({
            currentMin,
            scoreMin,
            momentum30Min,
            distanceMinBps,
            considered,
            added,
            addedHits,
            addedMisses: added - addedHits,
            incrementalAccuracy: Number.isFinite(incrementalAccuracy) ? Number(incrementalAccuracy.toFixed(4)) : null,
            combinedSamples,
            combinedAccuracy: Number.isFinite(combinedAccuracy) ? Number(combinedAccuracy.toFixed(4)) : null,
            combinedCoverage: Number.isFinite(combinedCoverage) ? Number(combinedCoverage.toFixed(4)) : null,
          });
        }
      }
    }
  }

  const qualified = results
    .filter(x => x.added >= 5 && Number(x.incrementalAccuracy) >= 0.70 && Number(x.combinedAccuracy) >= 0.70)
    .sort((a,b) =>
      Number(b.combinedCoverage) - Number(a.combinedCoverage) ||
      Number(b.incrementalAccuracy) - Number(a.incrementalAccuracy) ||
      Number(b.combinedAccuracy) - Number(a.combinedAccuracy)
    );

  return {
    ok:true,
    analysis:'SELECTIVE_V2_INTERNAL_DIRECTION_BACKTEST',
    target:'WAITING_FOR_BASE_DIRECTION_ONLY',
    settledRounds:rows.length,
    baseline:{
      samples:baselineDecided.length,
      hits:baselineHits,
      misses:baselineDecided.length-baselineHits,
      accuracy:baselineDecided.length ? Number((baselineHits/baselineDecided.length).toFixed(4)) : null,
      coverage:rows.length ? Number((baselineDecided.length/rows.length).toFixed(4)) : null,
    },
    searchSpace:results.length,
    qualifiedCount:qualified.length,
    top:qualified.slice(0,12),
  };
}




function selectiveV2NoBaseContestDecision(facts, config) {
  const f = facts && typeof facts === 'object' ? facts : null;
  const cfg = config || {};
  const reasons = [];
  if (!f) return {
    contestVersion:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
    candidateId:cfg.id || null,
    decision:'WAIT',
    reasons:['MISSING_FACTS'],
    productionEffect:'NONE_SHADOW_ONLY',
  };

  const current = Number(f.currentScore);
  const trend = Number(f.currentTrendScore);
  const micro = Number(f.microScore);
  const mom30 = Number(f.normalizedMomentum30s);
  const upMid = Number(f.predictionMarketUpMid);

  if (![current,trend,upMid].every(Number.isFinite)) reasons.push('MISSING_CORE_FEATURE');
  if (f.absorptionRisk === true) reasons.push('ABSORPTION_RISK');

  const sign = current > 0 ? 1 : current < 0 ? -1 : 0;
  if (!sign) reasons.push('NO_CURRENT_DIRECTION');
  if (Number.isFinite(current) && Math.abs(current) < Number(cfg.currentMin)) reasons.push('CURRENT_BELOW_MIN');
  if (Number.isFinite(trend) && Math.abs(trend) < Number(cfg.trendMin)) reasons.push('TREND_BELOW_MIN');
  if (sign && Number.isFinite(trend) && sign * trend <= 0) reasons.push('CURRENT_TREND_CONFLICT');

  if (sign > 0 && Number.isFinite(upMid) && upMid < 0.5 + Number(cfg.pmMargin)) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_UP');
  if (sign < 0 && Number.isFinite(upMid) && upMid > 0.5 - Number(cfg.pmMargin)) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_DOWN');

  if (cfg.requireMicroAgree && (!Number.isFinite(micro) || sign * micro <= 0)) reasons.push('MICRO_NOT_AGREE');
  if (cfg.requireMomentumAgree && (!Number.isFinite(mom30) || sign * mom30 <= 0)) reasons.push('MOMENTUM30_NOT_AGREE');

  const regime = String(f.regimeDirection || '').toUpperCase();
  const agreement = Number(f.regimeAgreement);
  if (
    sign &&
    Number.isFinite(agreement) &&
    agreement >= 0.67 &&
    ((sign > 0 && regime === 'DOWN') || (sign < 0 && regime === 'UP'))
  ) reasons.push('STRONG_REGIME_CONFLICT');

  const pass = reasons.length === 0;
  return {
    contestVersion:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
    candidateId:cfg.id,
    evaluatedAt:Date.now(),
    productionEffect:'NONE_SHADOW_ONLY',
    decision:pass ? (sign > 0 ? 'UP' : 'DOWN') : 'WAIT',
    reasons,
    config:{...cfg},
    facts:{
      currentScore:Number.isFinite(current)?Number(current.toFixed(4)):null,
      currentTrendScore:Number.isFinite(trend)?Number(trend.toFixed(4)):null,
      microScore:Number.isFinite(micro)?Number(micro.toFixed(4)):null,
      normalizedMomentum30s:Number.isFinite(mom30)?Number(mom30.toFixed(4)):null,
      predictionMarketUpMid:Number.isFinite(upMid)?Number(upMid.toFixed(4)):null,
      regimeDirection:regime||null,
      regimeAgreement:Number.isFinite(agreement)?Number(agreement.toFixed(4)):null,
    },
  };
}

function selectiveV2NoBaseContestSummary() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r?.selectiveV2NoBaseContest?.version === SELECTIVE_V2_NO_BASE_CONTEST_VERSION
    )
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));

  const noBaseSettled = rows.filter(r => r.prediction !== 'UP' && r.prediction !== 'DOWN');
  const candidates = SELECTIVE_V2_NO_BASE_CONTEST_CONFIGS.map(cfg => {
    const decided = noBaseSettled.filter(r => {
      const d = r?.selectiveV2NoBaseContest?.candidates?.[cfg.id]?.decision;
      return d === 'UP' || d === 'DOWN';
    });
    const hits = decided.filter(r => r.selectiveV2NoBaseContest.candidates[cfg.id].decision === r.actual).length;
    const samples = decided.length;
    const accuracy = samples ? hits / samples : null;
    const recent20 = decided.slice(-20);
    const recent20Hits = recent20.filter(r => r.selectiveV2NoBaseContest.candidates[cfg.id].decision === r.actual).length;
    const recent20Accuracy = recent20.length ? recent20Hits / recent20.length : null;
    const byDir = dir => {
      const a = decided.filter(r => r.selectiveV2NoBaseContest.candidates[cfg.id].decision === dir);
      const h = a.filter(r => r.actual === dir).length;
      return {samples:a.length,hits:h,misses:a.length-h,accuracy:a.length?Number((h/a.length).toFixed(4)):null};
    };

    let status='FORWARD_COLLECTING';
    if (
      samples >= SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_MIN_SAMPLES &&
      Number.isFinite(accuracy) &&
      accuracy < SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_ACCURACY
    ) status='RETIRED_LOW_ACCURACY';
    else if (
      samples >= SELECTIVE_V2_NO_BASE_CONTEST_TARGET &&
      Number.isFinite(accuracy) && accuracy >= SELECTIVE_V2_NO_BASE_CONTEST_REVIEW_ACCURACY &&
      recent20.length >= 20 &&
      Number.isFinite(recent20Accuracy) && recent20Accuracy >= SELECTIVE_V2_NO_BASE_CONTEST_REVIEW_ACCURACY
    ) status='QUALIFIED_FOR_REVIEW';
    else if (samples >= SELECTIVE_V2_NO_BASE_CONTEST_TARGET) status='FORWARD_COMPLETE';

    return {
      candidateId:cfg.id,
      config:cfg,
      status,
      active:status !== 'RETIRED_LOW_ACCURACY',
      productionEffect:'NONE_SHADOW_ONLY',
      strictForwardSamples:samples,
      targetSamples:SELECTIVE_V2_NO_BASE_CONTEST_TARGET,
      remainingSamples:Math.max(0,SELECTIVE_V2_NO_BASE_CONTEST_TARGET-samples),
      hits,
      misses:samples-hits,
      forwardAccuracy:Number.isFinite(accuracy)?Number(accuracy.toFixed(4)):null,
      recent20Accuracy:Number.isFinite(recent20Accuracy)?Number(recent20Accuracy.toFixed(4)):null,
      incrementalCoverage:noBaseSettled.length?Number((samples/noBaseSettled.length).toFixed(4)):null,
      up:byDir('UP'),
      down:byDir('DOWN'),
    };
  });

  const qualified = candidates
    .filter(x=>x.status==='QUALIFIED_FOR_REVIEW')
    .sort((a,b)=>
      Number(b.incrementalCoverage||0)-Number(a.incrementalCoverage||0) ||
      Number(b.forwardAccuracy||0)-Number(a.forwardAccuracy||0) ||
      Number(b.strictForwardSamples||0)-Number(a.strictForwardSamples||0)
    );

  const leaderboard = candidates
    .filter(x=>x.status!=='RETIRED_LOW_ACCURACY')
    .slice()
    .sort((a,b)=>
      Number(b.strictForwardSamples||0)-Number(a.strictForwardSamples||0) ||
      Number(b.forwardAccuracy||0)-Number(a.forwardAccuracy||0) ||
      Number(b.incrementalCoverage||0)-Number(a.incrementalCoverage||0)
    );

  return {
    ok:true,
    version:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
    productionEffect:'NONE_SHADOW_ONLY',
    productionFrozen:true,
    targetSamples:SELECTIVE_V2_NO_BASE_CONTEST_TARGET,
    retirementRule:{
      minSamples:SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_MIN_SAMPLES,
      accuracyBelow:SELECTIVE_V2_NO_BASE_CONTEST_RETIRE_ACCURACY,
    },
    reviewRule:{
      minSamples:SELECTIVE_V2_NO_BASE_CONTEST_TARGET,
      overallAccuracyAtLeast:SELECTIVE_V2_NO_BASE_CONTEST_REVIEW_ACCURACY,
      recent20AccuracyAtLeast:SELECTIVE_V2_NO_BASE_CONTEST_REVIEW_ACCURACY,
      autoProduction:false,
    },
    observedSettledRounds:rows.length,
    noBaseSettledRounds:noBaseSettled.length,
    candidates,
    leader:leaderboard[0] || null,
    recommendedForReview:qualified[0] || null,
    qualifiedCount:qualified.length,
  };
}

function selectiveV2NoBaseContestEvaluate(facts) {
  const current = selectiveV2NoBaseContestSummary();
  const retired = new Set(current.candidates.filter(x=>x.status==='RETIRED_LOW_ACCURACY').map(x=>x.candidateId));
  const candidates = {};
  for (const cfg of SELECTIVE_V2_NO_BASE_CONTEST_CONFIGS) {
    if (retired.has(cfg.id)) {
      candidates[cfg.id] = {
        contestVersion:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
        candidateId:cfg.id,
        decision:'WAIT',
        reasons:['RETIRED_LOW_ACCURACY'],
        config:{...cfg},
        productionEffect:'NONE_SHADOW_ONLY',
        retired:true,
      };
      continue;
    }
    candidates[cfg.id] = selectiveV2NoBaseContestDecision(facts,cfg);
  }
  return {
    version:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
    evaluatedAt:Date.now(),
    productionEffect:'NONE_SHADOW_ONLY',
    candidates,
  };
}


function waitRescueCandidateDecision(facts, config) {
  const f = facts && typeof facts === 'object' ? facts : null;
  const cfg = config || {};
  const reasons = [];
  if (!f) return {
    version:WAIT_RESCUE_SHADOW_VERSION,
    candidateId:cfg.id || null,
    decision:'WAIT',
    reasons:['MISSING_FACTS'],
    productionEffect:'NONE_SHADOW_ONLY',
  };

  const current = Number(f.currentScore);
  const trend = Number(f.currentTrendScore);
  const score = Number(f.liveScore);
  const distance = Number(f.distanceFromOpenBps);
  const micro = Number(f.microScore);
  const mom30 = Number(f.normalizedMomentum30s);
  const upMid = Number(f.predictionMarketUpMid);

  if (![current,trend,upMid].every(Number.isFinite)) reasons.push('MISSING_CORE_FEATURE');
  if (f.absorptionRisk === true) reasons.push('ABSORPTION_RISK');

  const sign = current > 0 ? 1 : current < 0 ? -1 : 0;
  if (!sign) reasons.push('NO_CURRENT_DIRECTION');
  if (Number.isFinite(current) && Math.abs(current) < Number(cfg.currentMin)) reasons.push('CURRENT_BELOW_MIN');
  if (Number.isFinite(trend) && Math.abs(trend) < Number(cfg.trendMin)) reasons.push('TREND_BELOW_MIN');
  if (sign && Number.isFinite(trend) && sign * trend <= 0) reasons.push('CURRENT_TREND_CONFLICT');
  if (cfg.scoreMin != null && (!Number.isFinite(score) || sign * score < Number(cfg.scoreMin))) reasons.push('SCORE_NOT_SUPPORT_DIRECTION');
  if (cfg.distanceMinBps != null && (!Number.isFinite(distance) || sign * distance < Number(cfg.distanceMinBps))) reasons.push('PRICE_DISTANCE_NOT_SUPPORT_DIRECTION');

  if (sign > 0 && Number.isFinite(upMid) && upMid < 0.5 + Number(cfg.pmMargin)) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_UP');
  if (sign < 0 && Number.isFinite(upMid) && upMid > 0.5 - Number(cfg.pmMargin)) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_DOWN');

  if (cfg.requireMicroAgree && (!Number.isFinite(micro) || sign * micro <= 0)) reasons.push('MICRO_NOT_AGREE');
  if (cfg.requireMomentumAgree && (!Number.isFinite(mom30) || sign * mom30 <= 0)) reasons.push('MOMENTUM30_NOT_AGREE');

  const regime = String(f.regimeDirection || '').toUpperCase();
  const agreement = Number(f.regimeAgreement);
  if (
    sign &&
    Number.isFinite(agreement) &&
    agreement >= 0.67 &&
    ((sign > 0 && regime === 'DOWN') || (sign < 0 && regime === 'UP'))
  ) reasons.push('STRONG_REGIME_CONFLICT');

  const pass = reasons.length === 0;
  return {
    version:WAIT_RESCUE_SHADOW_VERSION,
    candidateId:cfg.id,
    evaluatedAt:Date.now(),
    productionEffect:'NONE_SHADOW_ONLY',
    decision:pass ? (sign > 0 ? 'UP' : 'DOWN') : 'WAIT',
    reasons,
    config:{...cfg},
    facts:{
      currentScore:Number.isFinite(current)?Number(current.toFixed(4)):null,
      currentTrendScore:Number.isFinite(trend)?Number(trend.toFixed(4)):null,
      liveScore:Number.isFinite(score)?Number(score.toFixed(4)):null,
      distanceFromOpenBps:Number.isFinite(distance)?Number(distance.toFixed(4)):null,
      microScore:Number.isFinite(micro)?Number(micro.toFixed(4)):null,
      normalizedMomentum30s:Number.isFinite(mom30)?Number(mom30.toFixed(4)):null,
      predictionMarketUpMid:Number.isFinite(upMid)?Number(upMid.toFixed(4)):null,
      regimeDirection:regime||null,
      regimeAgreement:Number.isFinite(agreement)?Number(agreement.toFixed(4)):null,
    },
  };
}

function waitRescueShadowSummary() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= WAIT_RESCUE_SHADOW_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r.prediction !== 'UP' && r.prediction !== 'DOWN' &&
      r?.waitRescueShadow?.version === WAIT_RESCUE_SHADOW_VERSION
    )
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));

  const candidates = WAIT_RESCUE_CONFIGS.map(cfg => {
    const decided = rows.filter(r => {
      const d = r?.waitRescueShadow?.candidates?.[cfg.id]?.decision;
      return d === 'UP' || d === 'DOWN';
    });
    const hits = decided.filter(r => r.waitRescueShadow.candidates[cfg.id].decision === r.actual).length;
    const samples = decided.length;
    const accuracy = samples ? hits / samples : null;
    const recent20 = decided.slice(-20);
    const recent20Hits = recent20.filter(r => r.waitRescueShadow.candidates[cfg.id].decision === r.actual).length;
    const recent20Accuracy = recent20.length ? recent20Hits / recent20.length : null;
    const incrementalCoverage = rows.length ? samples / rows.length : null;

    let status = 'FORWARD_COLLECTING';
    if (
      samples >= WAIT_RESCUE_RETIRE_MIN_SAMPLES &&
      Number.isFinite(accuracy) &&
      accuracy < WAIT_RESCUE_RETIRE_ACCURACY
    ) status = 'RETIRED_LOW_ACCURACY';
    else if (
      samples >= WAIT_RESCUE_FORWARD_TARGET &&
      Number.isFinite(accuracy) && accuracy >= WAIT_RESCUE_REVIEW_ACCURACY &&
      recent20.length >= 20 &&
      Number.isFinite(recent20Accuracy) && recent20Accuracy >= WAIT_RESCUE_REVIEW_ACCURACY &&
      Number.isFinite(incrementalCoverage) && incrementalCoverage >= WAIT_RESCUE_MIN_INCREMENTAL_COVERAGE
    ) status = 'QUALIFIED_FOR_REVIEW';
    else if (samples >= WAIT_RESCUE_FORWARD_TARGET) status = 'FORWARD_COMPLETE';

    const byDir = dir => {
      const a = decided.filter(r => r.waitRescueShadow.candidates[cfg.id].decision === dir);
      const h = a.filter(r => r.actual === dir).length;
      return {samples:a.length,hits:h,misses:a.length-h,accuracy:a.length?Number((h/a.length).toFixed(4)):null};
    };

    return {
      candidateId:cfg.id,
      config:cfg,
      status,
      active:status !== 'RETIRED_LOW_ACCURACY',
      productionEffect:'NONE_SHADOW_ONLY',
      strictForwardSamples:samples,
      targetSamples:WAIT_RESCUE_FORWARD_TARGET,
      remainingSamples:Math.max(0,WAIT_RESCUE_FORWARD_TARGET-samples),
      hits,
      misses:samples-hits,
      forwardAccuracy:Number.isFinite(accuracy)?Number(accuracy.toFixed(4)):null,
      recent20Accuracy:Number.isFinite(recent20Accuracy)?Number(recent20Accuracy.toFixed(4)):null,
      incrementalCoverage:Number.isFinite(incrementalCoverage)?Number(incrementalCoverage.toFixed(4)):null,
      up:byDir('UP'),
      down:byDir('DOWN'),
    };
  });

  const leaderboard = candidates
    .filter(x=>x.active)
    .slice()
    .sort((a,b)=>
      Number(b.strictForwardSamples||0)-Number(a.strictForwardSamples||0) ||
      Number(b.forwardAccuracy||0)-Number(a.forwardAccuracy||0) ||
      Number(b.incrementalCoverage||0)-Number(a.incrementalCoverage||0)
    );
  const qualified = candidates
    .filter(x=>x.status==='QUALIFIED_FOR_REVIEW')
    .sort((a,b)=>
      Number(b.incrementalCoverage||0)-Number(a.incrementalCoverage||0) ||
      Number(b.forwardAccuracy||0)-Number(a.forwardAccuracy||0)
    );

  return {
    ok:true,
    version:WAIT_RESCUE_SHADOW_VERSION,
    productionEffect:'NONE_SHADOW_ONLY',
    productionFrozen:true,
    startMs:WAIT_RESCUE_SHADOW_START_MS,
    targetSamples:WAIT_RESCUE_FORWARD_TARGET,
    observedWaitSettledRounds:rows.length,
    retirementRule:{minSamples:WAIT_RESCUE_RETIRE_MIN_SAMPLES,accuracyBelow:WAIT_RESCUE_RETIRE_ACCURACY},
    reviewRule:{
      minSamples:WAIT_RESCUE_FORWARD_TARGET,
      overallAccuracyAtLeast:WAIT_RESCUE_REVIEW_ACCURACY,
      recent20AccuracyAtLeast:WAIT_RESCUE_REVIEW_ACCURACY,
      incrementalCoverageAtLeast:WAIT_RESCUE_MIN_INCREMENTAL_COVERAGE,
      autoProduction:false,
    },
    candidates,
    leader:leaderboard[0] || null,
    recommendedForReview:qualified[0] || null,
    qualifiedCount:qualified.length,
  };
}

function waitRescueEvaluate(facts) {
  const summary = waitRescueShadowSummary();
  const retired = new Set(summary.candidates.filter(x=>x.status==='RETIRED_LOW_ACCURACY').map(x=>x.candidateId));
  const candidates = {};
  for (const cfg of WAIT_RESCUE_CONFIGS) {
    if (retired.has(cfg.id)) {
      candidates[cfg.id] = {
        version:WAIT_RESCUE_SHADOW_VERSION,
        candidateId:cfg.id,
        decision:'WAIT',
        reasons:['RETIRED_LOW_ACCURACY'],
        config:{...cfg},
        productionEffect:'NONE_SHADOW_ONLY',
        retired:true,
      };
    } else {
      candidates[cfg.id] = waitRescueCandidateDecision(facts,cfg);
    }
  }
  return {
    version:WAIT_RESCUE_SHADOW_VERSION,
    evaluatedAt:Date.now(),
    productionEffect:'NONE_SHADOW_ONLY',
    candidates,
  };
}


function waitRescueEvaluateSnapshot(row, facts, elapsedMs = null) {
  if (!row || !facts || Number(row.roundStartMs) < WAIT_RESCUE_SHADOW_START_MS) return null;
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : Date.now() - Number(row.roundStartMs);
  // Never evaluate a rescue after the live decision window; this preserves
  // strict-forward comparability and prevents restart-time lookahead.
  if (elapsed < 0 || elapsed > 22000) return null;
  const existing = row.waitRescueShadow && row.waitRescueShadow.version === WAIT_RESCUE_SHADOW_VERSION
    ? row.waitRescueShadow
    : {
        version:WAIT_RESCUE_SHADOW_VERSION,
        evaluatedAt:null,
        productionEffect:'NONE_SHADOW_ONLY',
        candidates:{},
        snapshots:[],
        lastScheduledDelayMs:0,
      };

  const lastScheduled = Number(existing.lastScheduledDelayMs || 0);
  const due = WAIT_RESCUE_OBSERVE_DELAYS_MS.filter(ms => ms > lastScheduled && elapsed >= ms);
  if (!due.length) {
    row.waitRescueShadow = existing;
    return null;
  }

  // If polling resumes late, evaluate once at the latest due checkpoint instead
  // of replaying multiple checkpoints with the same later facts.
  const scheduledDelayMs = due[due.length - 1];
  const evaluated = waitRescueEvaluate(facts);
  const now = Date.now();
  const candidates = {...(existing.candidates || {})};

  for (const cfg of WAIT_RESCUE_CONFIGS) {
    const id = cfg.id;
    const prev = candidates[id];
    const next = evaluated?.candidates?.[id];
    if (prev?.decision === 'UP' || prev?.decision === 'DOWN') continue;
    if (!next) continue;
    candidates[id] = {
      ...next,
      observedDelayMs: Math.max(0, elapsed),
      scheduledDelayMs,
      lockedAt: next.decision === 'UP' || next.decision === 'DOWN' ? now : null,
    };
  }

  const decisions = Object.fromEntries(
    Object.entries(candidates).map(([id,v])=>[id,v?.decision || 'WAIT'])
  );
  existing.evaluatedAt = now;
  existing.lastScheduledDelayMs = scheduledDelayMs;
  existing.candidates = candidates;
  existing.snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : [];
  existing.snapshots.push({
    evaluatedAt:now,
    observedDelayMs:Math.max(0,elapsed),
    scheduledDelayMs,
    decisions,
  });
  if (existing.snapshots.length > WAIT_RESCUE_OBSERVE_DELAYS_MS.length) {
    existing.snapshots = existing.snapshots.slice(-WAIT_RESCUE_OBSERVE_DELAYS_MS.length);
  }
  row.waitRescueShadow = existing;

  return {
    scheduledDelayMs,
    observedDelayMs:Math.max(0,elapsed),
    decisions,
    productionEffect:'NONE_SHADOW_ONLY',
  };
}

function waitRescueBacktest() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) < WAIT_RESCUE_SHADOW_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r.prediction !== 'UP' && r.prediction !== 'DOWN' &&
      r.shadowFacts && typeof r.shadowFacts === 'object'
    )
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));

  const candidates = WAIT_RESCUE_CONFIGS.map(cfg => {
    let samples=0,hits=0;
    for (const r of rows) {
      const d=waitRescueCandidateDecision(r.shadowFacts,cfg).decision;
      if (d!=='UP' && d!=='DOWN') continue;
      samples += 1;
      if (d===r.actual) hits += 1;
    }
    return {
      candidateId:cfg.id,
      samples,
      hits,
      misses:samples-hits,
      accuracy:samples?Number((hits/samples).toFixed(4)):null,
      incrementalCoverage:rows.length?Number((samples/rows.length).toFixed(4)):null,
    };
  }).sort((a,b)=>
    Number(b.accuracy||0)-Number(a.accuracy||0) ||
    Number(b.samples||0)-Number(a.samples||0)
  );
  return {
    ok:true,
    analysis:'WAIT_RESCUE_HISTORICAL_BACKTEST_ONLY',
    productionEffect:'NONE_SHADOW_ONLY',
    waitRowsWithFacts:rows.length,
    candidates,
  };
}

function selectiveV2NoBaseConsensusDecision(facts) {
  const f = facts && typeof facts === 'object' ? facts : null;
  const reasons = [];
  if (!f) return {
    version: SELECTIVE_V2_NO_BASE_SHADOW_VERSION,
    decision:'WAIT',
    reasons:['MISSING_FACTS'],
  };

  const current = Number(f.currentScore);
  const trend = Number(f.currentTrendScore);
  const upMid = Number(f.predictionMarketUpMid);
  const currentMin = 0.65;
  const trendMin = 0.70;
  const pmMargin = 0.03;

  if (![current,trend,upMid].every(Number.isFinite)) reasons.push('MISSING_CORE_FEATURE');
  if (f.absorptionRisk === true) reasons.push('ABSORPTION_RISK');

  const sign = current > 0 ? 1 : current < 0 ? -1 : 0;
  if (!sign) reasons.push('NO_CURRENT_DIRECTION');
  if (Number.isFinite(current) && Math.abs(current) < currentMin) reasons.push('CURRENT_BELOW_MIN');
  if (Number.isFinite(trend) && Math.abs(trend) < trendMin) reasons.push('TREND_BELOW_MIN');
  if (sign && Number.isFinite(trend) && sign * trend <= 0) reasons.push('CURRENT_TREND_CONFLICT');
  if (sign > 0 && Number.isFinite(upMid) && upMid < 0.5 + pmMargin) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_UP');
  if (sign < 0 && Number.isFinite(upMid) && upMid > 0.5 - pmMargin) reasons.push('PREDICTION_MARKET_NOT_SUPPORT_DOWN');

  const regime = String(f.regimeDirection || '').toUpperCase();
  const agreement = Number(f.regimeAgreement);
  if (
    sign &&
    Number.isFinite(agreement) &&
    agreement >= 0.67 &&
    ((sign > 0 && regime === 'DOWN') || (sign < 0 && regime === 'UP'))
  ) reasons.push('STRONG_REGIME_CONFLICT');

  const pass = reasons.length === 0;
  return {
    version: SELECTIVE_V2_NO_BASE_SHADOW_VERSION,
    modelVersion: SELECTIVE_V2_NO_BASE_SHADOW_VERSION,
    evaluatedAt: Date.now(),
    productionEffect:'NONE_SHADOW_ONLY',
    decision: pass ? (sign > 0 ? 'UP' : 'DOWN') : 'WAIT',
    reasons,
    facts:{
      currentScore:Number.isFinite(current)?Number(current.toFixed(4)):null,
      currentTrendScore:Number.isFinite(trend)?Number(trend.toFixed(4)):null,
      predictionMarketUpMid:Number.isFinite(upMid)?Number(upMid.toFixed(4)):null,
      regimeDirection:regime||null,
      regimeAgreement:Number.isFinite(agreement)?Number(agreement.toFixed(4)):null,
    },
    thresholds:{currentMin,trendMin,pmMargin,rejectAbsorption:true},
  };
}

function selectiveV2NoBaseShadowSummary() {
  const settled = Array.from(rounds.values())
    .filter(r =>
      Number(r.roundStartMs) >= SELECTIVE_V2_NO_BASE_SHADOW_START_MS &&
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r?.selectiveV2NoBaseShadow?.modelVersion === SELECTIVE_V2_NO_BASE_SHADOW_VERSION
    )
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));

  const incremental = settled.filter(r =>
    r.prediction !== 'UP' &&
    r.prediction !== 'DOWN' &&
    (r.selectiveV2NoBaseShadow?.decision === 'UP' || r.selectiveV2NoBaseShadow?.decision === 'DOWN')
  );
  const hits = incremental.filter(r => r.selectiveV2NoBaseShadow.decision === r.actual).length;
  const samples = incremental.length;
  const accuracy = samples ? hits / samples : null;
  const recent20 = incremental.slice(-20);
  const recent20Hits = recent20.filter(r => r.selectiveV2NoBaseShadow.decision === r.actual).length;
  const recent20Accuracy = recent20.length ? recent20Hits / recent20.length : null;
  const up = incremental.filter(r=>r.selectiveV2NoBaseShadow.decision==='UP');
  const down = incremental.filter(r=>r.selectiveV2NoBaseShadow.decision==='DOWN');
  const sum = arr => {
    const h=arr.filter(r=>r.selectiveV2NoBaseShadow.decision===r.actual).length;
    return {samples:arr.length,hits:h,misses:arr.length-h,accuracy:arr.length?Number((h/arr.length).toFixed(4)):null};
  };

  let status='FORWARD_COLLECTING';
  if (samples >= 20 && Number.isFinite(accuracy) && accuracy < 0.65) status='LOW_ACCURACY';
  else if (
    samples >= SELECTIVE_V2_NO_BASE_FORWARD_TARGET &&
    Number.isFinite(accuracy) && accuracy >= 0.75 &&
    recent20.length >= 20 &&
    Number.isFinite(recent20Accuracy) && recent20Accuracy >= 0.75
  ) status='QUALIFIED_FOR_REVIEW';
  else if (samples >= SELECTIVE_V2_NO_BASE_FORWARD_TARGET) status='FORWARD_COMPLETE';

  return {
    ok:true,
    version:SELECTIVE_V2_NO_BASE_SHADOW_VERSION,
    productionEffect:'NONE_SHADOW_ONLY',
    startMs:SELECTIVE_V2_NO_BASE_SHADOW_START_MS,
    targetSamples:SELECTIVE_V2_NO_BASE_FORWARD_TARGET,
    settledObserved: settled.length,
    incrementalSamples:samples,
    hits,
    misses:samples-hits,
    forwardAccuracy:Number.isFinite(accuracy)?Number(accuracy.toFixed(4)):null,
    recent20Accuracy:Number.isFinite(recent20Accuracy)?Number(recent20Accuracy.toFixed(4)):null,
    remainingSamples:Math.max(0,SELECTIVE_V2_NO_BASE_FORWARD_TARGET-samples),
    incrementalCoverage:settled.length?Number((samples/settled.length).toFixed(4)):null,
    up:sum(up),
    down:sum(down),
    status,
  };
}

function selectiveV2NoBaseConsensusBacktest() {
  const rows = Array.from(rounds.values())
    .filter(r =>
      (r.actual === 'UP' || r.actual === 'DOWN') &&
      r.prediction !== 'UP' && r.prediction !== 'DOWN' &&
      r.shadowFacts && typeof r.shadowFacts === 'object'
    )
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs));

  const configs = [];
  const bools = [false, true];
  for (const currentMin of [0.60,0.65,0.70,0.75,0.80]) {
    for (const trendMin of [0.50,0.60,0.70,0.80]) {
      for (const pmMargin of [0.03,0.05,0.08,0.10,0.12]) {
        for (const requireMicroAgree of bools) {
          for (const requireMomentumAgree of bools) {
            let n=0,h=0,upN=0,upH=0,downN=0,downH=0;
            for (const r of rows) {
              const f=r.shadowFacts;
              if (f.absorptionRisk === true) continue;
              const current=Number(f.currentScore);
              const trend=Number(f.currentTrendScore);
              const micro=Number(f.microScore);
              const mom30=Number(f.normalizedMomentum30s);
              const upMid=Number(f.predictionMarketUpMid);
              if (![current,trend,upMid].every(Number.isFinite)) continue;
              if (Math.abs(current) < currentMin || Math.abs(trend) < trendMin) continue;
              const sign=current>0?1:current<0?-1:0;
              if (!sign || sign*trend <= 0) continue;
              if (sign>0 && upMid < 0.5 + pmMargin) continue;
              if (sign<0 && upMid > 0.5 - pmMargin) continue;
              if (requireMicroAgree && (!Number.isFinite(micro) || sign*micro <= 0)) continue;
              if (requireMomentumAgree && (!Number.isFinite(mom30) || sign*mom30 <= 0)) continue;

              const regime=String(f.regimeDirection||'').toUpperCase();
              const agreement=Number(f.regimeAgreement);
              if (
                Number.isFinite(agreement) && agreement >= 0.67 &&
                ((sign>0 && regime==='DOWN') || (sign<0 && regime==='UP'))
              ) continue;

              const decision=sign>0?'UP':'DOWN';
              const hit=decision===r.actual;
              n++; if(hit)h++;
              if(decision==='UP'){upN++;if(hit)upH++;}
              else {downN++;if(hit)downH++;}
            }
            configs.push({
              currentMin,trendMin,pmMargin,requireMicroAgree,requireMomentumAgree,
              samples:n,hits:h,misses:n-h,
              accuracy:n?Number((h/n).toFixed(4)):null,
              upSamples:upN,upAccuracy:upN?Number((upH/upN).toFixed(4)):null,
              downSamples:downN,downAccuracy:downN?Number((downH/downN).toFixed(4)):null,
              incrementalCoverage:rows.length?Number((n/rows.length).toFixed(4)):null,
            });
          }
        }
      }
    }
  }
  const qualified=configs
    .filter(x=>x.samples>=8 && Number(x.accuracy)>=0.70)
    .sort((a,b)=>b.samples-a.samples || b.accuracy-a.accuracy);
  return {
    ok:true,
    analysis:'SELECTIVE_V2_NO_BASE_CONSENSUS_BACKTEST',
    waitRowsWithFacts:rows.length,
    searchSpace:configs.length,
    qualifiedCount:qualified.length,
    top:qualified.slice(0,15),
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
    // marketTopicId is only a hint. V3 must validate its own start/end timestamps
    // against roundStartMs before it may use it.
    let u = SIGNAL_ORIGIN + '/api/prediction-resolution?round=' + encodeURIComponent(String(roundStartMs));
    if (marketTopicId) u += '&marketTopicId=' + encodeURIComponent(String(marketTopicId));
    const r = await fetch(u, { cache:'no-store', signal:AbortSignal.timeout(12000) });
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
      adaptiveGateShadow: null,
      preLockAdaptiveShadow: null,
      selectiveV2NoBaseShadow: null,
      selectiveV2NoBaseContest: null,
      selectiveV2HighPrecisionShadow: null,
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
      productionPrediction: null,
      productionConfidence: null,
      productionScore: null,
      productionSource: null,
      productionGeneratedAt: null,
      productionDelayMs: null,
      productionModel: null,
      productionLockedAt: null,
      productionActual: null,
      productionResult: 'PENDING',
      productionSettledAt: null,
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
      row.preLockAdaptiveShadow = preLockAdaptiveShadow.evaluate(row);
      if (
        Number(row.roundStartMs) >= SELECTIVE_V2_NO_BASE_SHADOW_START_MS &&
        !row.selectiveV2NoBaseShadow
      ) {
        row.selectiveV2NoBaseShadow = selectiveV2NoBaseConsensusDecision(liveFacts);
        if (!row.selectiveV2NoBaseContest) {
          row.selectiveV2NoBaseContest = selectiveV2NoBaseContestEvaluate(liveFacts);
          log('selective_v2_no_base_contest_evaluated', {
            round:row.roundStartMs,
            version:SELECTIVE_V2_NO_BASE_CONTEST_VERSION,
            decisions:Object.fromEntries(
              Object.entries(row.selectiveV2NoBaseContest.candidates || {}).map(([id,v])=>[id,v?.decision || 'WAIT'])
            ),
            productionEffect:'NONE_SHADOW_ONLY',
          });
        }
        log('selective_v2_no_base_shadow_evaluated', {
          round: row.roundStartMs,
          modelVersion: SELECTIVE_V2_NO_BASE_SHADOW_VERSION,
          decision: row.selectiveV2NoBaseShadow?.decision ?? 'WAIT',
          reasons: row.selectiveV2NoBaseShadow?.reasons ?? [],
          productionEffect:'NONE_SHADOW_ONLY',
        });
      }
      observeShadowForwardRegistry(row, liveFacts);
      shadowV2.observe(row, liveFacts);
      saveHistory();
    }
    if (liveFacts && Number(row.roundStartMs) >= WAIT_RESCUE_SHADOW_START_MS) {
      const rescueSnapshot = waitRescueEvaluateSnapshot(row, liveFacts, elapsedMs);
      if (rescueSnapshot) {
        log('wait_rescue_shadow_snapshot_evaluated', {
          round:row.roundStartMs,
          version:WAIT_RESCUE_SHADOW_VERSION,
          scheduledDelayMs:rescueSnapshot.scheduledDelayMs,
          observedDelayMs:rescueSnapshot.observedDelayMs,
          decisions:rescueSnapshot.decisions,
          productionEffect:'NONE_SHADOW_ONLY',
        });
        saveHistory();
      }
    }
    if (
      liveFacts &&
      !row.noBaseSpecialistObservedAt &&
      elapsedMs >= NO_BASE_SPECIALIST_OBSERVE_MS &&
      elapsedMs <= 22000 &&
      live?.status !== 'LOCKED' &&
      row.prediction !== 'UP' &&
      row.prediction !== 'DOWN'
    ) {
      row.noBaseSpecialistObservedAt = Date.now();
      row.noBaseSpecialistFacts = liveFacts;
      row.noBaseSpecialistRawStatusAtObservation = live?.status || 'WAIT';
      row.noBaseSpecialistRawReasonAtObservation = live?.reason || live?.waitReason || null;
      saveHistory();
      log('no_base_specialist_snapshot_collected', {
        round: row.roundStartMs,
        observedDelayMs: row.noBaseSpecialistObservedAt - row.roundStartMs,
        rawStatus: row.noBaseSpecialistRawStatusAtObservation,
        rawReason: row.noBaseSpecialistRawReasonAtObservation,
        productionEffect: 'NONE_SHADOW_ONLY',
      });
      void noBaseSpecialist.observe(row, liveFacts, row.noBaseSpecialistObservedAt);
    }

    if (row.shadowObservedAt && row.shadowFacts) {
      void shadowV3.observe(row, row.shadowFacts);
      void shadowV4.observe(row, row.shadowFacts);
      void shadowV5.observe(row);
      void shadowV7.observe(row, row.shadowFacts);
      if (productionUsesShadowV3()) {
        void shadowV3.predictProduction(SHADOW_PRODUCTION_MODEL_VERSION, row, row.shadowFacts)
          .then(result => {
            if (!result?.ok) return;
            saveHistory();
            try {
              productionSignalPayload();
            } catch (e) {
              log('shadow_v3_production_lock_failed', {
                round: row.roundStartMs,
                modelVersion: SHADOW_PRODUCTION_MODEL_VERSION,
                error: e?.message || String(e),
              });
            }
          })
          .catch(e => {
            log('shadow_v3_production_prediction_failed', {
              round: row.roundStartMs,
              modelVersion: SHADOW_PRODUCTION_MODEL_VERSION,
              error: e?.message || String(e),
            });
          });
      }
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
      if (Number(row.roundStartMs) >= LOCK_QUALITY_V2_START_MS) {
        row.lockQualitySelectiveV2 = evaluateSelectiveQualityV2(direction, row.predictionFacts, row.predictionDelayMs, row.roundStartMs);
        row.adaptiveGateShadow = adaptiveGateShadow.evaluate(row);

        if (!row.lockQualitySelectiveV2?.pass) {
          const coreEdgeRescue = evaluateSelectiveV2EdgeRescueRow(row, row.lockQualitySelectiveV2);
          if (coreEdgeRescue?.decision !== direction) {
            edgeRescueExpansion.evaluate(row, row.lockQualitySelectiveV2, coreEdgeRescue);
          }
        }
      }
      if (
        Number(row.roundStartMs) >= SELECTIVE_V2_HP_SHADOW_START_MS &&
        !row.selectiveV2HighPrecisionShadow
      ) {
        row.selectiveV2HighPrecisionShadow = evaluateSelectiveV2HighPrecisionShadow(
          direction,
          row.predictionFacts,
          row.predictionDelayMs
        );
        log('selective_v2_high_precision_shadow_evaluated', {
          round: row.roundStartMs,
          version: SELECTIVE_V2_HP_SHADOW_VERSION,
          baseDirection: direction,
          decisions: Object.fromEntries(
            Object.entries(row.selectiveV2HighPrecisionShadow.candidates || {})
              .map(([id,v]) => [id, v?.decision || 'WAIT'])
          ),
          productionEffect: 'NONE_SHADOW_ONLY',
        });
      }
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
        lockQualitySelectiveV2Decision: row.lockQualitySelectiveV2?.decision ?? null,
        lockQualitySelectiveV2Reasons: row.lockQualitySelectiveV2?.reasons ?? [],
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

// Settlement queue prioritizes live production rounds before historical backfill.
async function settlePendingRounds() {
  if (settleBusy) return;
  settleBusy = true;
  try {
    const now = Date.now();
    const revalidating = Boolean(legacyOfficialRevalidation?.active);
    const pending = Array.from(rounds.values())
      .filter(r => !r.actual && now > r.roundEndMs + 1200 && now >= Number(r.nextSettleAt || 0))
      .sort((a, b) => {
        if (revalidating) return Number(b.roundStartMs) - Number(a.roundStartMs);

        // Never let a large legacy backfill block live production settlement.
        // Production-era rounds are resolved first, newest first; older history
        // continues draining afterwards.
        const aProduction = Number(a.roundStartMs) >= PRODUCTION_SHADOW_START_MS ? 1 : 0;
        const bProduction = Number(b.roundStartMs) >= PRODUCTION_SHADOW_START_MS ? 1 : 0;
        if (aProduction !== bProduction) return bProduction - aProduction;
        if (aProduction) return Number(b.roundStartMs) - Number(a.roundStartMs);
        return Number(a.roundStartMs) - Number(b.roundStartMs);
      })
      .slice(0, revalidating ? 10 : 6);

    // Launch historical revalidation lookups concurrently, but keep all state
    // mutation/archive/model updates sequential below.
    const officialPrefetch = revalidating
      ? new Map(pending.map(row => {
          const nextRow = rounds.get(String(Number(row.roundStartMs) + 300000));
          // Prefer the topic captured on this round. The next row is only a
          // legacy fallback because its topic normally belongs to the next 5m round.
          const topicHint = row.predictionMarketTopicId || nextRow?.predictionMarketTopicId || null;
          return [
            String(row.roundStartMs),
            fetchOfficialPredictionResolution(row.roundStartMs, topicHint),
          ];
        }))
      : null;

    for (const row of pending) {
      row.settleAttempts = Number(row.settleAttempts || 0) + 1;
      try {
        // Always try the topic captured on this round first. Passing the next
        // round's topic first caused already-finished rounds to lose their direct
        // lookup path once Binance removed them from the active topic list.
        const nextRow = rounds.get(String(Number(row.roundStartMs) + 300000));
        const ownTopicHint = row.predictionMarketTopicId || null;
        const nextTopicHint = nextRow?.predictionMarketTopicId || null;
        let official = officialPrefetch
          ? await officialPrefetch.get(String(row.roundStartMs))
          : await fetchOfficialPredictionResolution(row.roundStartMs, ownTopicHint || nextTopicHint);

        // Legacy rows can still contain a stale previous-round topic. If direct
        // discovery says the topic is missing, try the following row's persisted
        // topic once; V3 independently validates its timestamps before accepting it.
        const firstWhy = official?.error || official?.status || null;
        if (
          !official?.resolved &&
          nextTopicHint &&
          String(nextTopicHint) !== String(ownTopicHint || '') &&
          (firstWhy === 'PREDICTION_TOPIC_NOT_FOUND' || firstWhy === 'TOPIC_NOT_FOUND')
        ) {
          const retry = await fetchOfficialPredictionResolution(row.roundStartMs, nextTopicHint);
          if (retry?.resolved || retry?.ok) official = retry;
        }
        const direction = String(official?.direction || '').toUpperCase();

        if (!official?.resolved || (direction !== 'UP' && direction !== 'DOWN')) {
          const why = official?.error || official?.status || 'OFFICIAL_RESOLUTION_PENDING';
          row.resolutionEvidence = why;
          row.nextSettleAt = Date.now() + Math.min(30000, 2000 * row.settleAttempts);
          lastSettlementError = why;
          continue;
        }

        row.predictionMarketTopicId = official?.marketTopicId ?? row.predictionMarketTopicId;
        const evidence = `OFFICIAL_${direction}:${official?.evidence || 'RESOLVED'}`;
        const legacyBefore = row.legacyOfficialDirectionBeforeRevalidation;
        applyOfficialSettlement(row, direction, evidence, Date.now());
        if ((legacyBefore === 'UP' || legacyBefore === 'DOWN') && legacyBefore !== direction) {
          row.officialDirectionCorrectedFrom = legacyBefore;
          row.officialDirectionCorrectedAt = Date.now();
          log('official_settlement_direction_corrected', {
            round:row.roundStartMs,
            from:legacyBefore,
            to:direction,
            evidence,
          });
        }
        settleShadowForwardRegistry(row);
        shadowV2.settle(row);
        shadowV3.settle(row);
        noBaseSpecialist.settle(row);
        void shadowV4.settle(row);
        shadowV5.settle(row);
        void shadowV7.settle(row);
        adaptiveGateShadow.onSettled(row, Array.from(rounds.values()));
        preLockAdaptiveShadow.onSettled(row, Array.from(rounds.values()));
        if (row?.selectiveV2NoBaseShadow?.modelVersion === SELECTIVE_V2_NO_BASE_SHADOW_VERSION) {
          const nb = selectiveV2NoBaseShadowSummary();
          if (
            nb.incrementalSamples > 0 &&
            (nb.incrementalSamples % 5 === 0 || nb.incrementalSamples === SELECTIVE_V2_NO_BASE_FORWARD_TARGET)
          ) {
            log('selective_v2_no_base_shadow_forward_progress', nb);
          }
        }
        if (
          row?.waitRescueShadow?.version === WAIT_RESCUE_SHADOW_VERSION &&
          row.prediction !== 'UP' && row.prediction !== 'DOWN'
        ) {
          const rescue = waitRescueShadowSummary();
          const addedIds = Object.entries(row.waitRescueShadow.candidates || {})
            .filter(([,v])=>v?.decision==='UP' || v?.decision==='DOWN')
            .map(([id])=>id);
          const milestone = rescue.candidates.some(x =>
            addedIds.includes(x.candidateId) &&
            x.strictForwardSamples > 0 &&
            (x.strictForwardSamples % 5 === 0 || x.strictForwardSamples === WAIT_RESCUE_FORWARD_TARGET)
          );
          if (milestone) log('wait_rescue_shadow_forward_progress', rescue);
        }
        if (
          row?.selectiveV2NoBaseContest?.version === SELECTIVE_V2_NO_BASE_CONTEST_VERSION &&
          row.prediction !== 'UP' && row.prediction !== 'DOWN'
        ) {
          const contest = selectiveV2NoBaseContestSummary();
          const addedIds = Object.entries(row.selectiveV2NoBaseContest.candidates || {})
            .filter(([,v])=>v?.decision==='UP' || v?.decision==='DOWN')
            .map(([id])=>id);
          const milestone = contest.candidates.some(x =>
            addedIds.includes(x.candidateId) &&
            x.strictForwardSamples > 0 &&
            (x.strictForwardSamples % 5 === 0 || x.strictForwardSamples === SELECTIVE_V2_NO_BASE_CONTEST_TARGET)
          );
          if (milestone) log('selective_v2_no_base_contest_forward_progress', contest);
        }

        if (
          row?.selectiveV2EdgeRescue?.version === SELECTIVE_V2_EDGE_RESCUE_VERSION &&
          (row.selectiveV2EdgeRescue.decision === 'UP' || row.selectiveV2EdgeRescue.decision === 'DOWN')
        ) {
          log('selective_v2_edge_rescue_forward_progress', selectiveV2EdgeRescueSummary());
        }

        if (row?.selectiveV2EdgeExpansionShadow?.version === SELECTIVE_V2_EDGE_EXPANSION_VERSION) {
          const decidedIds = Object.entries(row.selectiveV2EdgeExpansionShadow.candidates || {})
            .filter(([,v]) => v?.decision === 'UP' || v?.decision === 'DOWN')
            .map(([id]) => id);
          if (decidedIds.length) {
            const expansion = edgeRescueExpansion.summary(rounds.values());
            const milestone = expansion.candidates.some(x =>
              decidedIds.includes(x.candidateId) &&
              x.strictForwardSamples > 0 &&
              (
                x.strictForwardSamples === 1 ||
                x.strictForwardSamples % 5 === 0 ||
                x.strictForwardSamples === 20 ||
                x.strictForwardSamples === 60 ||
                x.status === 'AUTO_QUALIFIED' ||
                x.status === 'AUTO_DEMOTED_DRIFT' ||
                x.status === 'RETIRED_LOW_ACCURACY'
              )
            );
            if (milestone) {
              log('selective_v2_edge_expansion_forward_progress', expansion);
            }
          }
        }

        if (row.selectiveV2HighPrecisionShadow?.version === SELECTIVE_V2_HP_SHADOW_VERSION) {
          const decidedIds = Object.entries(row.selectiveV2HighPrecisionShadow.candidates || {})
            .filter(([,v]) => v?.decision === 'UP' || v?.decision === 'DOWN')
            .map(([id]) => id);
          if (decidedIds.length) {
            const hp = selectiveV2HighPrecisionShadowSummary();
            const milestone = hp.candidates.some(x =>
              decidedIds.includes(x.candidateId) &&
              x.strictForwardSamples > 0 &&
              (
                x.strictForwardSamples === 1 ||
                x.strictForwardSamples % 5 === 0 ||
                x.strictForwardSamples === SELECTIVE_V2_HP_FORWARD_TARGET
              )
            );
            if (milestone) {
              log('selective_v2_high_precision_shadow_forward_progress', hp);
            }
          }
        }

        lastSettlementOkAt = Date.now();
        lastSettlementError = null;
        saveHistory();

        const archiveReason = row.needsOfficialArchiveCorrection ? 'official_correction' : 'settlement';
        if (archiveSettledRow(row, archiveReason) && row.needsOfficialArchiveCorrection) {
          row.needsOfficialArchiveCorrection = false;
          row.officialArchiveCorrectedAt = Date.now();
          saveHistory();
        }

        maybeFinalizeLegacyOfficialRevalidation();
        maybeTrainShadowModel();
        shadowV2.maybeTrain(shadowTrainingRows());
        void shadowV3.maybeTrain(row.roundStartMs);
        void noBaseSpecialist.maybeTrain(row.roundStartMs);
        void shadowV4.maybeTrain(row.roundStartMs);
        void shadowV5.maybeTrain(row.roundStartMs);
        void shadowV7.maybeTrain(row.roundStartMs);
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
          officialDirection: direction,
          productionPrediction: row.productionPrediction ?? null,
          productionActual: row.productionActual ?? null,
          productionResult: row.productionResult ?? null,
          productionSource: row.productionSource ?? null,
        });
      } catch (e) {
        lastSettlementError = e?.message || String(e);
        row.nextSettleAt = Date.now() + Math.min(30000, 2000 * row.settleAttempts);
      }
    }
  } finally {
    settleBusy = false;
  }
}


const PRODUCTION_SHADOW_START_MS = 1791000600000;

function freezeProductionLock(row, live) {
  if (!row || !live || live.status !== 'LOCKED') return false;
  const direction = live?.signal?.direction;
  if (direction !== 'UP' && direction !== 'DOWN') return false;
  if (row.productionPrediction === 'UP' || row.productionPrediction === 'DOWN') return false;

  row.productionPrediction = direction;
  row.productionConfidence = Number.isFinite(Number(live?.signal?.confidence)) ? Number(live.signal.confidence) : null;
  row.productionScore = Number.isFinite(Number(live?.signal?.score)) ? Number(live.signal.score) : null;
  row.productionSource = live?.source || 'UNKNOWN';
  row.productionGeneratedAt = Number.isFinite(Number(live?.generatedAt)) ? Number(live.generatedAt) : Date.now();
  row.productionDelayMs = Math.max(0, Number(row.productionGeneratedAt) - Number(row.roundStartMs));
  row.productionModel = live?.model || null;
  row.productionLockedAt = Date.now();
  saveHistory();
  log('production_signal_locked', {
    round: row.roundStartMs,
    direction: row.productionPrediction,
    source: row.productionSource,
    model: row.productionModel,
    generatedAt: row.productionGeneratedAt,
  });
  emitLockedSignal(row, live);
  return true;
}

function productionRecordView(row) {
  const direction = row?.productionPrediction === 'UP' || row?.productionPrediction === 'DOWN'
    ? row.productionPrediction
    : 'WAIT';
  const official = row?.productionActual === 'UP' || row?.productionActual === 'DOWN'
    ? row.productionActual
    : officialDirectionFromRow(row);
  const productionResult =
    official === 'UP' || official === 'DOWN'
      ? direction === 'UP' || direction === 'DOWN'
        ? (direction === official ? 'HIT' : 'MISS')
        : 'NO_DECISION'
      : 'PENDING';

  return {
    ...row,
    // Public/display fields are canonical production statistics only.
    // Prevent clients from rendering legacy V6 outcome as production Shadow outcome.
    prediction: direction,
    actual: official,
    result: productionResult,
    predictionSource: row?.productionSource || 'WAIT',
    predictionModel: row?.productionModel || null,
    productionPrediction: direction,
    productionSource: row?.productionSource || 'WAIT',
    productionActual: official,
    productionResult,
    resultRule: 'PRODUCTION_LOCKED_DIRECTION_VS_BINANCE_PREDICTION_OFFICIAL_DIRECTION',
  };
}

function productionSummary() {
  const records = Array.from(rounds.values())
    .filter(r => Number(r.roundStartMs) >= PRODUCTION_SHADOW_START_MS)
    .sort((a,b) => Number(a.roundStartMs) - Number(b.roundStartMs))
    .map(productionRecordView);
  const settled = records.filter(r => r.productionActual === 'UP' || r.productionActual === 'DOWN');
  const decided = settled.filter(r => r.productionPrediction === 'UP' || r.productionPrediction === 'DOWN');
  const correct = decided.filter(r => r.productionResult === 'HIT').length;
  const wrong = decided.filter(r => r.productionResult === 'MISS').length;
  const noDecision = settled.filter(r => r.productionResult === 'NO_DECISION').length;
  return {
    startMs: PRODUCTION_SHADOW_START_MS,
    totalTrackedRounds: records.length,
    settledRounds: settled.length,
    decidedRounds: decided.length,
    correct,
    wrong,
    noDecision,
    accuracyPct: decided.length ? Number(((correct / decided.length) * 100).toFixed(2)) : null,
    coveragePct: settled.length ? Number(((decided.length / settled.length) * 100).toFixed(2)) : null,
    primaryShadowRounds: decided.filter(r => r.productionSource === 'SHADOW_CANDIDATE_PRIMARY').length,
    v3AutoMLRounds: decided.filter(r => r.productionSource === 'SHADOW_V3_AUTOML_PRIMARY').length,
    selectiveV2Rounds: decided.filter(r => String(r.productionSource || '').startsWith('LOCK_QUALITY_SELECTIVE_V2')).length,
    edgeRescueRounds: decided.filter(r => r.productionSource === 'SELECTIVE_V2_EDGE_RESCUE_PRIMARY').length,
    edgeExpansionRounds: decided.filter(r => r.productionSource === 'SELECTIVE_V2_EDGE_EXPANSION_PRIMARY').length,
    v6FallbackRounds: decided.filter(r => r.productionSource === 'V6_FALLBACK').length,
    currentQualifiedModel: productionUsesSelectiveV2()
      ? LOCK_QUALITY_V2_VERSION
      : productionUsesShadowV3()
        ? (pinnedShadowV3Candidate()?.modelVersion ?? null)
        : (qualifiedShadowV6Candidate()?.candidate?.modelVersion ?? null),
    currentQualificationStatus: productionUsesSelectiveV2()
      ? 'USER_PINNED_SELECTIVE_COLLECTING'
      : (productionShadowApproved() ? 'QUALIFIED' : 'NO_QUALIFIED_MODEL'),
    minForwardSamples: PRODUCTION_MIN_FORWARD_SAMPLES,
    minForwardAccuracy: PRODUCTION_MIN_FORWARD_ACCURACY,
    statsScope: 'HISTORICAL_PRODUCTION_AGGREGATE',
    policy: productionPolicyName(),
  };
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


let lastProductionSignalLogKey = null;

function logProductionSignalState(live) {
  const key = [
    live?.round ?? null,
    live?.status ?? null,
    live?.signal?.direction ?? null,
    live?.source ?? null,
    live?.fallbackUsed ?? null,
    live?.waitReason ?? null,
    live?.fallbackReason ?? null,
  ].join(':');
  if (key === lastProductionSignalLogKey) return;
  lastProductionSignalLogKey = key;
  log('production_signal_state', {
    round: live?.round ?? null,
    status: live?.status ?? null,
    direction: live?.signal?.direction ?? null,
    source: live?.source ?? null,
    model: live?.model ?? null,
    fallbackUsed: Boolean(live?.fallbackUsed),
    waitReason: live?.waitReason ?? null,
    fallbackReason: live?.fallbackReason ?? null,
    generatedAt: live?.generatedAt ?? null,
    shadowForwardStatus: live?.shadowForwardStatus ?? null,
    shadowForwardSamples: live?.shadowForwardSamples ?? null,
  });
}

function productionSignalPayload(now = Date.now()) {
  const expectedRound = Math.floor(Number(now) / 300000) * 300000;
  const row = rounds.get(String(expectedRound)) || null;
  // A production direction is immutable for the entire 5-minute round.
  // If it has already been frozen, every subsequent request returns exactly that lock.
  if (row?.productionPrediction === 'UP' || row?.productionPrediction === 'DOWN') {
    const frozenLive = {
      round: row.roundStartMs,
      status: 'LOCKED',
      signal: {
        direction: row.productionPrediction,
        score: row.productionScore ?? null,
        confidence: row.productionConfidence ?? null,
        modelProbability: row.productionConfidence ?? null,
      },
      input: { round: row.roundStartMs },
      generatedAt: row.productionGeneratedAt ?? row.productionLockedAt ?? null,
      source: row.productionSource || 'UNKNOWN',
      model: row.productionModel || null,
      facts: row.productionSource === 'SHADOW_CANDIDATE_PRIMARY' ||
        row.productionSource === 'SHADOW_V3_AUTOML_PRIMARY' ||
        row.productionSource === 'LOCK_QUALITY_SELECTIVE_V2_NO_BASE_PRIMARY'
        ? (row.shadowFacts ?? null)
        : (row.predictionFacts ?? null),
      productionPolicy: productionPolicyName(),
      fallbackUsed: row.productionSource === 'V6_FALLBACK',
      fallbackReason: row.productionSource === 'V6_FALLBACK' ? 'FROZEN_V6_FALLBACK' : null,
      shadowForwardStatus: shadowModelMetrics.status,
      shadowForwardSamples: shadowModelMetrics.forwardSamples,
      frozen: true,
      productionLockedAt: row.productionLockedAt ?? null,
    };
    logProductionSignalState(frozenLive);
    return { ok: true, live: frozenLive };
  }

  if (productionUsesSelectiveV2()) {
    if (!row) {
      const live = {
        round: expectedRound,
        status: 'WAIT',
        signal: null,
        input: { round: expectedRound },
        generatedAt: null,
        source: 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY',
        model: LOCK_QUALITY_V2_VERSION,
        facts: null,
        productionPolicy: productionPolicyName(),
        fallbackUsed: false,
        waitReason: 'CURRENT_ROUND_NOT_OBSERVED',
        selectiveQuality: selectiveQualityV2Summary(),
      };
      logProductionSignalState(live);
      return { ok: true, live };
    }

    const baseDirection = row.prediction === 'UP' || row.prediction === 'DOWN'
      ? row.prediction
      : null;
    const q = baseDirection
      ? (row.lockQualitySelectiveV2 ||
          evaluateSelectiveQualityV2(baseDirection, row.predictionFacts, row.predictionDelayMs, row.roundStartMs))
      : null;
    const direction = q?.pass && (q?.decision === 'UP' || q?.decision === 'DOWN')
      ? q.decision
      : null;

    if (direction) {
      const confidence = Number.isFinite(Number(row.modelProbability))
        ? Number(row.modelProbability)
        : (Number.isFinite(Number(row.predictionConfidence)) ? Number(row.predictionConfidence) : null);
      const score = Number.isFinite(Number(row.predictionScore)) ? Number(row.predictionScore) : null;
      const live = {
        round: row.roundStartMs,
        status: 'LOCKED',
        signal: {
          direction,
          score,
          confidence,
          modelProbability: confidence,
        },
        input: { round: row.roundStartMs },
        generatedAt: Number.isFinite(Number(row.predictedAt)) ? Number(row.predictedAt) : Date.now(),
        source: 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY',
        model: LOCK_QUALITY_V2_VERSION,
        facts: row.predictionFacts ?? null,
        productionPolicy: productionPolicyName(),
        fallbackUsed: false,
        selectiveQuality: q,
        shadowForwardStatus: selectiveQualityV2Summary().status,
        shadowForwardSamples: selectiveQualityV2Summary().forwardSamples,
      };
      freezeProductionLock(row, live);
      logProductionSignalState(live);
      return { ok: true, live };
    }

    // Preserve Selective V2 as the precision core. Only rescue a filtered
    // base-direction signal when it falls inside the historically high-quality
    // edge region and the independent strict-forward fuse is open.
    const edgeRescue = baseDirection && q && !q.pass
      ? evaluateSelectiveV2EdgeRescueRow(row, q)
      : null;
    const edgeFuse = edgeRescue?.decision === baseDirection
      ? selectiveV2EdgeRescueFuseState(baseDirection)
      : null;
    const edgeExpansionEvaluation =
      baseDirection &&
      q &&
      !q.pass &&
      edgeRescue?.decision !== baseDirection
        ? (row.selectiveV2EdgeExpansionShadow?.version === SELECTIVE_V2_EDGE_EXPANSION_VERSION
          ? row.selectiveV2EdgeExpansionShadow
          : edgeRescueExpansion.evaluate(row, q, edgeRescue))
        : null;

    if (edgeRescue?.decision === baseDirection && edgeFuse?.allowed) {
      const confidence = Number.isFinite(Number(row.modelProbability))
        ? Number(row.modelProbability)
        : (Number.isFinite(Number(row.predictionConfidence)) ? Number(row.predictionConfidence) : null);
      const score = Number.isFinite(Number(row.predictionScore)) ? Number(row.predictionScore) : null;
      const live = {
        round:row.roundStartMs,
        status:'LOCKED',
        signal:{direction:baseDirection,score,confidence,modelProbability:confidence},
        input:{round:row.roundStartMs},
        generatedAt:Number.isFinite(Number(row.predictedAt)) ? Number(row.predictedAt) : Date.now(),
        source:'SELECTIVE_V2_EDGE_RESCUE_PRIMARY',
        model:SELECTIVE_V2_EDGE_RESCUE_VERSION,
        facts:row.predictionFacts ?? null,
        productionPolicy:productionPolicyName(),
        fallbackUsed:false,
        selectiveQuality:q,
        edgeRescue:{
          candidate:edgeRescue,
          fuse:{allowed:true,reason:null},
        },
        shadowForwardStatus:'EDGE_RESCUE_ACTIVE',
        shadowForwardSamples:edgeFuse?.summary?.eligibleStrictForward?.samples ?? 0,
      };
      freezeProductionLock(row, live);
      log('selective_v2_edge_rescue_production_lock', {
        round:row.roundStartMs,
        direction:baseDirection,
        baseSelectiveReasons:q?.reasons || [],
        edgeFacts:edgeRescue.facts,
        strictForwardSamples:edgeFuse?.summary?.eligibleStrictForward?.samples ?? 0,
        strictForwardAccuracy:edgeFuse?.summary?.eligibleStrictForward?.accuracy ?? null,
      });
      logProductionSignalState(live);
      return {ok:true,live};
    }

    // Tier-2/3 expansion only activates after independent strict-forward proof.
    // It inherits the Tier-1 fuse so a degraded rescue regime cannot be widened.
    const expansionCoreFuse = edgeExpansionEvaluation
      ? selectiveV2EdgeRescueFuseState(baseDirection)
      : null;
    const expansionSelection =
      edgeExpansionEvaluation && expansionCoreFuse?.allowed
        ? edgeRescueExpansion.selectProductionCandidate(
            rounds.values(),
            edgeExpansionEvaluation,
            baseDirection
          )
        : null;

    if (expansionSelection?.allowed && expansionSelection?.candidate) {
      const candidate = expansionSelection.candidate;
      const confidence = Number.isFinite(Number(row.modelProbability))
        ? Number(row.modelProbability)
        : (Number.isFinite(Number(row.predictionConfidence)) ? Number(row.predictionConfidence) : null);
      const score = Number.isFinite(Number(row.predictionScore)) ? Number(row.predictionScore) : null;
      const live = {
        round:row.roundStartMs,
        status:'LOCKED',
        signal:{direction:baseDirection,score,confidence,modelProbability:confidence},
        input:{round:row.roundStartMs},
        generatedAt:Number.isFinite(Number(row.predictedAt)) ? Number(row.predictedAt) : Date.now(),
        source:'SELECTIVE_V2_EDGE_EXPANSION_PRIMARY',
        model:SELECTIVE_V2_EDGE_EXPANSION_VERSION + ':' + candidate.candidateId,
        facts:row.predictionFacts ?? null,
        productionPolicy:productionPolicyName(),
        fallbackUsed:false,
        selectiveQuality:q,
        edgeRescue:{
          candidate:edgeRescue,
          fuse:expansionCoreFuse ? {
            allowed:Boolean(expansionCoreFuse.allowed),
            reason:expansionCoreFuse.reason ?? null,
          } : null,
        },
        edgeExpansion:{
          candidateId:candidate.candidateId,
          strictForwardSamples:candidate.strictForwardSamples,
          strictForwardAccuracy:candidate.forwardAccuracy,
          recent10Accuracy:candidate.recent10Accuracy,
          incrementalCoverage:candidate.incrementalCoverage,
          allowedDirections:candidate.allowedDirections,
        },
        shadowForwardStatus:'EDGE_EXPANSION_ACTIVE',
        shadowForwardSamples:candidate.strictForwardSamples,
      };
      freezeProductionLock(row, live);
      log('selective_v2_edge_expansion_production_lock', {
        round:row.roundStartMs,
        direction:baseDirection,
        candidateId:candidate.candidateId,
        strictForwardSamples:candidate.strictForwardSamples,
        strictForwardAccuracy:candidate.forwardAccuracy,
        recent10Accuracy:candidate.recent10Accuracy,
        incrementalCoverage:candidate.incrementalCoverage,
        allowedDirections:candidate.allowedDirections,
      });
      logProductionSignalState(live);
      return {ok:true,live};
    }

    // No-base candidates remain shadow-only. Rescue layers never invent a
    // direction when V3 has not produced one.

    const reasons = !baseDirection
      ? ['WAITING_FOR_BASE_DIRECTION']
      : (Array.isArray(q?.reasons) && q.reasons.length ? q.reasons : ['SELECTIVE_FILTER_WAIT']);
    const s = selectiveQualityV2Summary();
    const live = {
      round: row.roundStartMs,
      status: 'WAIT',
      signal: null,
      input: { round: row.roundStartMs },
      generatedAt: row.predictedAt ?? null,
      source: 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY',
      model: LOCK_QUALITY_V2_VERSION,
      facts: row.predictionFacts ?? null,
      productionPolicy: productionPolicyName(),
      fallbackUsed: false,
      waitReason: 'SELECTIVE_V2_WAIT:' + reasons.join('|'),
      selectiveQuality: q,
      edgeRescue: edgeRescue ? {
        candidate:edgeRescue,
        fuse:edgeFuse ? {
          allowed:Boolean(edgeFuse.allowed),
          reason:edgeFuse.reason ?? null,
        } : null,
      } : null,
      edgeExpansion: edgeExpansionEvaluation ? {
        current: edgeExpansionEvaluation,
        coreFuse: expansionCoreFuse ? {
          allowed:Boolean(expansionCoreFuse.allowed),
          reason:expansionCoreFuse.reason ?? null,
        } : null,
        selection: expansionSelection ? {
          allowed:Boolean(expansionSelection.allowed),
          reason:expansionSelection.reason ?? null,
          candidateId: expansionSelection.candidate?.candidateId ?? null,
        } : null,
      } : null,
      shadowForwardStatus: s.status,
      shadowForwardSamples: s.forwardSamples,
    };
    logProductionSignalState(live);
    return { ok: true, live };
  }

  if (productionUsesShadowV3()) {
    const v3 = pinnedShadowV3Candidate();
    const probability = Number(row?.shadowV3ProductionProbability);
    const threshold = Number(row?.shadowV3ProductionThreshold ?? v3?.threshold ?? 0.5);
    const ready =
      Boolean(v3) &&
      row?.shadowV3ProductionModelVersion === SHADOW_PRODUCTION_MODEL_VERSION &&
      Number.isFinite(probability) &&
      Number.isFinite(threshold);

    if (row && ready) {
      const direction = probability >= threshold ? 'UP' : 'DOWN';
      const directionProbability = direction === 'UP' ? probability : 1 - probability;
      const signedScore = probability * 2 - 1;
      const live = {
        round: row.roundStartMs,
        status: 'LOCKED',
        signal: {
          direction,
          score: Number(signedScore.toFixed(6)),
          confidence: Number(directionProbability.toFixed(6)),
          modelProbability: Number(directionProbability.toFixed(6)),
          upProbability: Number(probability.toFixed(6)),
          threshold: Number(threshold.toFixed(6)),
        },
        input: { round: row.roundStartMs },
        generatedAt: row.shadowV3ProductionPredictedAt || row.shadowObservedAt || null,
        source: 'SHADOW_V3_AUTOML_PRIMARY',
        model: SHADOW_PRODUCTION_MODEL_VERSION,
        facts: row.shadowFacts ?? null,
        productionPolicy: 'IMMUTABLE_FIRST_LOCK_PINNED_SHADOW_PRIMARY',
        fallbackUsed: false,
        shadowForwardStatus: v3.summary?.status ?? null,
        shadowForwardSamples: v3.summary?.forwardSamples ?? null,
      };
      freezeProductionLock(row, live);
      logProductionSignalState(live);
      return { ok: true, live };
    }

    const live = {
      round: row?.roundStartMs ?? expectedRound,
      status: 'WAIT',
      signal: null,
      input: { round: row?.roundStartMs ?? expectedRound },
      generatedAt: row?.shadowObservedAt ?? null,
      source: 'SHADOW_V3_AUTOML_PRIMARY',
      model: SHADOW_PRODUCTION_MODEL_VERSION,
      facts: row?.shadowFacts ?? null,
      productionPolicy: 'IMMUTABLE_FIRST_LOCK_PINNED_SHADOW_PRIMARY',
      fallbackUsed: false,
      waitReason: !row
        ? 'CURRENT_ROUND_NOT_OBSERVED'
        : !v3
          ? 'PINNED_V3_MODEL_UNAVAILABLE'
          : !row.shadowObservedAt || !row.shadowFacts
            ? 'WAITING_FOR_V3_FEATURE_SNAPSHOT'
            : row.shadowV3ProductionModelVersion !== SHADOW_PRODUCTION_MODEL_VERSION
              ? 'WAITING_FOR_PINNED_V3_PREDICTION'
              : !Number.isFinite(probability)
                ? 'WAITING_FOR_V3_PREDICTION'
                : 'NO_VALID_V3_SIGNAL',
      shadowForwardStatus: v3?.summary?.status ?? null,
      shadowForwardSamples: v3?.summary?.forwardSamples ?? null,
    };
    logProductionSignalState(live);
    return { ok: true, live };
  }

  const candidateProbability = Number(row?.shadowCandidateProbability);
  const candidateApproved = productionShadowApproved();
  const candidateReady =
    candidateApproved &&
    Number(row?.shadowCandidateTrainedAt) === Number(shadowCandidate?.trainedAt) &&
    Number.isFinite(candidateProbability);

  if (row && candidateReady) {
    const direction = candidateProbability >= 0.5 ? 'UP' : 'DOWN';
    const directionProbability = direction === 'UP' ? candidateProbability : 1 - candidateProbability;
    const signedScore = candidateProbability * 2 - 1;
    const live = {
      round: row.roundStartMs,
      status: 'LOCKED',
      signal: {
        direction,
        score: Number(signedScore.toFixed(6)),
        confidence: Number(directionProbability.toFixed(6)),
        modelProbability: Number(directionProbability.toFixed(6)),
        upProbability: Number(candidateProbability.toFixed(6)),
      },
      input: { round: row.roundStartMs },
      generatedAt: row.shadowObservedAt || null,
      source: 'SHADOW_CANDIDATE_PRIMARY',
      model: shadowCandidate.modelVersion,
      facts: row.shadowFacts ?? null,
      productionPolicy: productionPolicyName(),
      fallbackUsed: false,
      shadowForwardStatus: shadowModelMetrics.status,
      shadowForwardSamples: shadowModelMetrics.forwardSamples,
    };
    freezeProductionLock(row, live);
    logProductionSignalState(live);
    return { ok: true, live };
  }

  // Do not fall back to an unqualified legacy model. If no model has at least
  // PRODUCTION_MIN_FORWARD_SAMPLES strict-forward decisions at or above
  // PRODUCTION_MIN_FORWARD_ACCURACY, production must abstain.
  const live = {
    round: row?.roundStartMs ?? expectedRound,
    status: 'WAIT',
    signal: null,
    input: { round: row?.roundStartMs ?? expectedRound },
    generatedAt: row?.shadowObservedAt ?? row?.predictedAt ?? null,
    source: 'QUALIFIED_MODEL_GATE',
    model: productionUsesShadowV3()
      ? SHADOW_PRODUCTION_MODEL_VERSION
      : (qualifiedShadowV6Candidate()?.candidate?.modelVersion ?? null),
    facts: row?.shadowFacts ?? row?.predictionFacts ?? null,
    productionPolicy: productionPolicyName(),
    fallbackUsed: false,
    waitReason: !row
      ? 'CURRENT_ROUND_NOT_OBSERVED'
      : 'NO_MODEL_MEETS_65_GATE',
    shadowForwardStatus: shadowModelMetrics.status,
    shadowForwardSamples: shadowModelMetrics.forwardSamples,
  };
  logProductionSignalState(live);
  return { ok: true, live };
}

function payload() {
  const records = Array.from(rounds.values()).sort((a, b) => b.roundStartMs - a.roundStartMs);
  return {
    ok: true,
    service: 'binance-round-tracker',
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    settlementSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
    rule: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
    statsVersion: STATS_VERSION,
    statsStartMs: STATS_START_MS,
    accuracyRule: 'PRODUCTION_LOCKED_DIRECTION_VS_BINANCE_PREDICTION_OFFICIAL_DIRECTION',
    summary: summary(),
    productionSummary: productionSummary(),
    productionPolicy: productionPolicyName(),
    productionQualification: {
      minForwardSamples: PRODUCTION_MIN_FORWARD_SAMPLES,
      minForwardAccuracy: PRODUCTION_MIN_FORWARD_ACCURACY,
    },
    productionStartMs: PRODUCTION_SHADOW_START_MS,
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
    records: records.slice(0, 100).map(productionRecordView),
  };
}

loadHistory();
loadArchiveIndex();
backfillArchiveFromActiveHistory();
loadShadowModelArtifact();
loadShadowForwardRegistry();
adaptiveGateShadow.load();
preLockAdaptiveShadow.load();
shadowV2.load();
shadowV3.load();
noBaseSpecialist.load();
shadowV4.load();
shadowV5.load();
shadowV7.load();
deleteRetiredShadowForwardCandidates();
shadowV2.deleteRetiredCandidates();
shadowV3.deleteRetiredCandidates();
noBaseSpecialist.deleteRetiredCandidates();
shadowV4.deleteRetiredCandidates();
shadowV5.deleteRetiredCandidates();
shadowV7.deleteRetiredCandidates();
applyAuthoritativeSettledHistoryOverrides();
invalidateLegacyWinnerFlagSettlements();
loadShadowCandidateArtifact();
adaptiveGateShadow.ensureModel(Array.from(rounds.values()));
preLockAdaptiveShadow.ensureModel(Array.from(rounds.values()));
maybeTrainShadowModel();
shadowV2.maybeTrain(shadowTrainingRows());
void shadowV3.maybeTrain();
void noBaseSpecialist.maybeTrain();
void shadowV4.maybeTrain();
void shadowV5.maybeTrain();
void shadowV7.maybeTrain();
applyPinnedProductionShadow();
updateShadowForwardMetrics();
log('calibration_backtest_snapshot', calibrationBacktestPayload());
log('v6_feature_audit_snapshot', v6FeatureAuditPayload());
log('selective_v2_internal_direction_backtest_snapshot', selectiveV2InternalDirectionBacktest());
log('selective_v2_filtered_wait_rescue_backtest_snapshot', selectiveV2FilteredWaitRescueBacktest());
log('selective_v2_edge_rescue_status', selectiveV2EdgeRescueSummary());
log('selective_v2_edge_expansion_status', edgeRescueExpansion.summary(rounds.values()));
log('selective_v2_no_base_consensus_backtest_snapshot', selectiveV2NoBaseConsensusBacktest());
log('selective_v2_no_base_shadow_status', selectiveV2NoBaseShadowSummary());
log('no_base_specialist_status', noBaseSpecialist.stats());
log('selective_v2_no_base_contest_status', selectiveV2NoBaseContestSummary());
log('wait_rescue_backtest_snapshot', waitRescueBacktest());
log('wait_rescue_shadow_status', waitRescueShadowSummary());
ensureCurrentRound();
setInterval(pollSignal, POLL_MS).unref();
// Freeze the production direction in the background even when no browser is open
// and trading is disabled. This keeps every 5-minute round auditable and ensures
// the stats direction is exactly the same immutable direction consumers will see.
setInterval(() => {
  try {
    productionSignalPayload();
  } catch (e) {
    log('production_signal_background_error', { error: e?.message || String(e) });
  }
}, POLL_MS).unref();
setInterval(settlePendingRounds, SETTLE_POLL_MS).unref();
pollSignal();
try {
  const bootProduction = productionSignalPayload();
  const live = bootProduction?.live || null;
  if (live?.status === 'LOCKED' && (live?.signal?.direction === 'UP' || live?.signal?.direction === 'DOWN')) {
    const row = rounds.get(String(live.round)) || null;
    latestSignalEnvelope = buildLockedSignalEnvelope(row, live);
    lastPublishedSignalId = latestSignalEnvelope?.signalId || null;
  }
} catch (e) {
  log('production_signal_background_error', { error: e?.message || String(e) });
}
void ensureSignalRedisPublisher();
log('locked_signal_transport_bootstrap', {
  model: SIGNAL_MODEL_NAME,
  redisConfigured: Boolean(SIGNAL_REDIS_URL),
  redisChannel: SIGNAL_REDIS_CHANNEL,
  redisStream: SIGNAL_REDIS_STREAM,
  websocketPath: SIGNAL_WS_PATH,
});
settlePendingRounds();

const signalHttpServer = http.createServer((req, res) => {
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

  if (req.method === 'GET' && url.pathname === '/api/shadow-v2-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowV2.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-v3-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowV3.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/no-base-specialist-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(noBaseSpecialist.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-v4-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowV4.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-v5-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowV5.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-v7-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shadowV7.stats()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-optimization-backtest') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2InternalDirectionBacktest()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-filtered-wait-rescue-backtest') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2FilteredWaitRescueBacktest()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-edge-rescue-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2EdgeRescueSummary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-edge-expansion-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(edgeRescueExpansion.summary(rounds.values())));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-no-base-shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2NoBaseShadowSummary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/wait-rescue-shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(waitRescueShadowSummary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/wait-rescue-backtest') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(waitRescueBacktest()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-no-base-contest-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2NoBaseContestSummary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/shadow-quality-v2-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveQualityV2Summary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/selective-v2-high-precision-shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(selectiveV2HighPrecisionShadowSummary()));
  }

  if (req.method === 'GET' && url.pathname === '/api/adaptive-gate-shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(adaptiveGateShadow.stats(Array.from(rounds.values()))));
  }

  if (req.method === 'GET' && url.pathname === '/api/prelock-adaptive-shadow-stats') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(preLockAdaptiveShadow.stats(Array.from(rounds.values()))));
  }

  if (req.method === 'GET' && url.pathname === '/api/production-signal') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(productionSignalPayload()));
  }

  if (req.method === 'GET' && url.pathname === '/api/signals/latest') {
    const production = productionSignalPayload();
    const live = production?.live || null;
    if (live?.status === 'LOCKED' && (live?.signal?.direction === 'UP' || live?.signal?.direction === 'DOWN')) {
      const row = rounds.get(String(live.round)) || null;
      const current = buildLockedSignalEnvelope(row, live);
      if (current) latestSignalEnvelope = current;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      model: SIGNAL_MODEL_NAME,
      signal: latestSignalEnvelope,
      transport: {
        redisConfigured: Boolean(SIGNAL_REDIS_URL),
        redisConnected: signalRedisConnected,
        redisChannel: SIGNAL_REDIS_CHANNEL,
        redisStream: SIGNAL_REDIS_STREAM,
        websocketPath: SIGNAL_WS_PATH,
        websocketClients: signalWsClients.size,
        lastRedisError: signalRedisLastError,
      },
    }));
  }


  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/round-stats')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(payload()));
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

signalHttpServer.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== SIGNAL_WS_PATH) {
    socket.destroy();
    return;
  }
  signalWss.handleUpgrade(req, socket, head, ws => {
    signalWss.emit('connection', ws, req);
  });
});

signalHttpServer.listen(PORT, '0.0.0.0', () => {
  const startupForward = candidateForwardSummary();
  log('round_tracker_started', {
    port: PORT,
    symbol: SYMBOL,
    signalOrigin: SIGNAL_ORIGIN,
    pollMs: POLL_MS,
    settlePollMs: SETTLE_POLL_MS,
    historyLimit: HISTORY_LIMIT,
    marketDataBase: MARKET_DATA_BASE,
    settlementSource: 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY',
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
    shadowRollingForwardFile: SHADOW_ROLLING_FORWARD_FILE,
    shadowForwardRegistryFile: SHADOW_FORWARD_REGISTRY_FILE,
    shadowForwardRegistryMax: SHADOW_FORWARD_REGISTRY_MAX,
    shadowV2File: SHADOW_V2_FILE,
    shadowV2: shadowV2.stats(),
    shadowV3Dir: SHADOW_V3_DIR,
    shadowV3: shadowV3.stats(),
    noBaseSpecialistDir: NO_BASE_SPECIALIST_DIR,
    noBaseSpecialistObserveMs: NO_BASE_SPECIALIST_OBSERVE_MS,
    noBaseSpecialist: noBaseSpecialist.stats(),
    shadowV3ProductionCandidate: productionUsesShadowV3() ? pinnedShadowV3Candidate() : null,
    shadowV4Dir: SHADOW_V4_DIR,
    shadowV4: shadowV4.stats(),
    shadowV4TrainEveryRounds: SHADOW_V4_TRAIN_EVERY_ROUNDS,
    shadowV5Dir: SHADOW_V5_DIR,
    shadowV5: shadowV5.stats(),
    shadowV5TrainEveryRounds: SHADOW_V5_TRAIN_EVERY_ROUNDS,
    shadowV7Dir: SHADOW_V7_DIR,
    shadowV7: shadowV7.stats(),
    shadowV7TrainEveryRounds: SHADOW_V7_TRAIN_EVERY_ROUNDS,
    adaptiveGateShadowFile: ADAPTIVE_GATE_SHADOW_FILE,
    adaptiveGateShadow: adaptiveGateShadow.stats(Array.from(rounds.values())),
    preLockAdaptiveShadowFile: PRELOCK_ADAPTIVE_SHADOW_FILE,
    preLockAdaptiveShadow: preLockAdaptiveShadow.stats(Array.from(rounds.values())),
    shadowV3TrainEveryRounds: SHADOW_V3_TRAIN_EVERY_ROUNDS,
    shadowV3TrainTimeBudget: SHADOW_V3_TRAIN_TIME_BUDGET,
    shadowRollingForward: rollingForwardSummary(),
    shadowForwardCandidates: shadowForwardRegistrySummary(),
    shadowCandidateFile: SHADOW_CANDIDATE_FILE,
    shadowCandidateModelVersion: shadowCandidate?.modelVersion ?? null,
    shadowProductionModelVersion: SHADOW_PRODUCTION_MODEL_VERSION || shadowCandidate?.modelVersion || null,
    shadowProductionApproved: productionShadowApproved(),
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
    productionSignalPolicy: productionPolicyName(),
    productionMinForwardSamples: PRODUCTION_MIN_FORWARD_SAMPLES,
    productionMinForwardAccuracy: PRODUCTION_MIN_FORWARD_ACCURACY,
    productionSignalEndpoint: '/api/production-signal',
    shadowModelSchemaVersion: SHADOW_MODEL_SCHEMA_VERSION,
    archiveDir: ARCHIVE_DIR,
    archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
    archivedRecords: archiveMetrics.records,
    officialResolutionWaitMs: OFFICIAL_RESOLUTION_WAIT_MS,
    lockQualityShadowVersion: LOCK_QUALITY_SHADOW_VERSION,
    lockQualityShadowStartMs: LOCK_QUALITY_SHADOW_START_MS,
    lockQualitySelectiveV2: selectiveQualityV2Summary(),
    selectiveV2HighPrecisionShadow: selectiveV2HighPrecisionShadowSummary(),
    lockQualityProductionEffect: productionUsesSelectiveV2() ? 'PRIMARY' : 'NONE_SHADOW_ONLY',
  });
});
