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
const STATS_VERSION = String(process.env.ROUND_STATS_VERSION || 'CONTINUOUS_MARKET_STATE_V5');
const STATS_START_MS = Math.max(0, Number(process.env.ROUND_STATS_START_MS || 0));
const CALIBRATION_MIN_SAMPLES = Math.max(8, Number(process.env.CALIBRATION_MIN_SAMPLES || 20));
const CALIBRATION_BAND = Math.max(0.05, Number(process.env.CALIBRATION_SCORE_BAND || 0.15));
const OFFICIAL_RESOLUTION_WAIT_MS = Math.max(10000, Number(process.env.OFFICIAL_RESOLUTION_WAIT_MS || 60000));

const rounds = new Map();
let signalPollBusy = false;
let settleBusy = false;
let lastSignalPollAt = 0;
let lastSignalOkAt = 0;
let lastSignalError = null;
let lastSettlementOkAt = 0;
let lastSettlementError = null;

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

async function fetchOfficialPredictionResolution(roundStartMs) {
  try {
    const u = SIGNAL_ORIGIN + '/api/prediction-resolution?round=' + encodeURIComponent(String(roundStartMs));
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
        const official = await fetchOfficialPredictionResolution(row.roundStartMs);
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
    rule: 'FIRST_CONTINUOUS_STATE_LOCK_PER_5M_ROUND_V5',
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
    officialResolutionWaitMs: OFFICIAL_RESOLUTION_WAIT_MS,
  });
});
