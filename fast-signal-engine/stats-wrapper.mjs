import fs from 'node:fs';

const sourceUrl = new URL('./index.mjs', import.meta.url);
const runtimeUrl = new URL('./.stats-runtime-index.mjs', import.meta.url);
let source = fs.readFileSync(sourceUrl, 'utf8');

const importMarker = "import http from 'node:http';\nimport WebSocket from 'ws';";
if (!source.includes(importMarker)) throw new Error('STATS_IMPORT_MARKER_NOT_FOUND');
source = source.replace(importMarker, "import http from 'node:http';\nimport fs from 'node:fs';\nimport WebSocket from 'ws';");

const statsCore = String.raw`
const SIGNAL_HISTORY_FILE = String(process.env.SIGNAL_HISTORY_FILE || '/tmp/signal-round-history.json');
const SIGNAL_HISTORY_LIMIT = Math.max(20, Number(process.env.SIGNAL_HISTORY_LIMIT || 500));
let roundHistory = [];
let roundHistoryById = new Map();

function normalizeHistoryRecord(r) {
  if (!r || !Number.isFinite(Number(r.roundStartMs))) return null;
  return {
    roundStartMs: Number(r.roundStartMs),
    roundEndMs: Number(r.roundEndMs || (Number(r.roundStartMs) + 300000 - 1)),
    prediction: ['UP', 'DOWN', 'WAIT'].includes(String(r.prediction)) ? String(r.prediction) : null,
    predictionScore: Number.isFinite(Number(r.predictionScore)) ? Number(r.predictionScore) : null,
    confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
    predictionAt: Number.isFinite(Number(r.predictionAt)) ? Number(r.predictionAt) : null,
    predictionMode: r.predictionMode || null,
    openPrice: Number.isFinite(Number(r.openPrice)) ? Number(r.openPrice) : null,
    closePrice: Number.isFinite(Number(r.closePrice)) ? Number(r.closePrice) : null,
    actual: ['UP', 'DOWN', 'FLAT'].includes(String(r.actual)) ? String(r.actual) : null,
    outcome: ['PENDING', 'HIT', 'MISS', 'WAIT', 'FLAT'].includes(String(r.outcome)) ? String(r.outcome) : 'PENDING',
    settledAt: Number.isFinite(Number(r.settledAt)) ? Number(r.settledAt) : null,
  };
}

function loadRoundHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SIGNAL_HISTORY_FILE, 'utf8'));
    const items = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
    roundHistory = items.map(normalizeHistoryRecord).filter(Boolean).slice(-SIGNAL_HISTORY_LIMIT);
    roundHistoryById = new Map(roundHistory.map(r => [String(r.roundStartMs), r]));
    console.log(JSON.stringify({ event: 'signal_history_loaded', records: roundHistory.length, file: SIGNAL_HISTORY_FILE }));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(JSON.stringify({ event: 'signal_history_load_failed', error: e?.message || String(e), file: SIGNAL_HISTORY_FILE }));
    roundHistory = [];
    roundHistoryById = new Map();
  }
}

function persistRoundHistory() {
  try {
    const dir = SIGNAL_HISTORY_FILE.slice(0, SIGNAL_HISTORY_FILE.lastIndexOf('/')) || '.';
    fs.mkdirSync(dir, { recursive: true });
    const tmp = SIGNAL_HISTORY_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: roundHistory }), 'utf8');
    fs.renameSync(tmp, SIGNAL_HISTORY_FILE);
  } catch (e) {
    console.error(JSON.stringify({ event: 'signal_history_persist_failed', error: e?.message || String(e), file: SIGNAL_HISTORY_FILE }));
  }
}

function ensureRoundRecord(signalLike) {
  const start = Number(signalLike?.roundStartMs);
  if (!Number.isFinite(start) || start <= 0) return null;
  const key = String(start);
  let rec = roundHistoryById.get(key);
  if (!rec) {
    rec = {
      roundStartMs: start,
      roundEndMs: Number(signalLike?.roundEndMs || (start + 300000 - 1)),
      prediction: null,
      predictionScore: null,
      confidence: null,
      predictionAt: null,
      predictionMode: null,
      openPrice: Number.isFinite(Number(signalLike?.facts?.roundOpenPrice)) ? Number(signalLike.facts.roundOpenPrice) : null,
      closePrice: null,
      actual: null,
      outcome: 'PENDING',
      settledAt: null,
    };
    roundHistory.push(rec);
    roundHistoryById.set(key, rec);
    if (roundHistory.length > SIGNAL_HISTORY_LIMIT) {
      const removed = roundHistory.splice(0, roundHistory.length - SIGNAL_HISTORY_LIMIT);
      for (const r of removed) roundHistoryById.delete(String(r.roundStartMs));
    }
    persistRoundHistory();
  } else if (rec.openPrice == null && Number.isFinite(Number(signalLike?.facts?.roundOpenPrice))) {
    rec.openPrice = Number(signalLike.facts.roundOpenPrice);
  }
  return rec;
}

function captureRoundPrediction(signalLike) {
  const rec = ensureRoundRecord(signalLike);
  if (!rec || rec.settledAt) return;
  if (rec.prediction == null && ['UP', 'DOWN'].includes(signalLike?.direction)) {
    rec.prediction = signalLike.direction;
    rec.predictionScore = Number.isFinite(Number(signalLike.score)) ? Number(signalLike.score) : null;
    rec.confidence = Number.isFinite(Number(signalLike.confidence)) ? Number(signalLike.confidence) : null;
    rec.predictionAt = Number(signalLike.generatedAt || Date.now());
    rec.predictionMode = 'FIRST_LOCKED';
    persistRoundHistory();
    console.log(JSON.stringify({ event: 'round_prediction_recorded', round: rec.roundStartMs, prediction: rec.prediction, score: rec.predictionScore, confidence: rec.confidence, at: new Date(rec.predictionAt).toISOString() }));
  }
}

function settleRound(roundStartMs, roundEndMs, openPrice, closePrice) {
  const start = Number(roundStartMs);
  const open = Number(openPrice);
  const close = Number(closePrice);
  if (![start, open, close].every(Number.isFinite)) return;
  const rec = ensureRoundRecord({ roundStartMs: start, roundEndMs, facts: { roundOpenPrice: open } });
  if (!rec || rec.settledAt) return;
  rec.roundEndMs = Number.isFinite(Number(roundEndMs)) ? Number(roundEndMs) : rec.roundEndMs;
  rec.openPrice = open;
  rec.closePrice = close;
  rec.actual = close > open ? 'UP' : close < open ? 'DOWN' : 'FLAT';
  if (rec.prediction == null) {
    rec.prediction = 'WAIT';
    rec.predictionMode = 'NO_LOCKED_SIGNAL';
  }
  rec.outcome = rec.actual === 'FLAT' ? 'FLAT' : rec.prediction === 'WAIT' ? 'WAIT' : rec.prediction === rec.actual ? 'HIT' : 'MISS';
  rec.settledAt = Date.now();
  persistRoundHistory();
  console.log(JSON.stringify({ event: 'round_prediction_settled', round: rec.roundStartMs, prediction: rec.prediction, actual: rec.actual, outcome: rec.outcome, openPrice: rec.openPrice, closePrice: rec.closePrice, at: new Date(rec.settledAt).toISOString() }));
}

function statsPayload() {
  const settled = roundHistory.filter(r => r.settledAt);
  const judged = settled.filter(r => ['UP', 'DOWN'].includes(r.prediction) && ['UP', 'DOWN'].includes(r.actual));
  const hits = judged.filter(r => r.outcome === 'HIT').length;
  const misses = judged.filter(r => r.outcome === 'MISS').length;
  const waits = settled.filter(r => r.outcome === 'WAIT').length;
  const flats = settled.filter(r => r.outcome === 'FLAT').length;
  const pending = roundHistory.filter(r => !r.settledAt).length;
  return {
    ok: true,
    summary: {
      totalRecordedRounds: roundHistory.length,
      settledRounds: settled.length,
      judgedRounds: judged.length,
      hits,
      misses,
      waits,
      flats,
      pending,
      accuracyPct: judged.length ? Number(((hits / judged.length) * 100).toFixed(2)) : null,
    },
    methodology: {
      prediction: 'FIRST_LOCKED_SIGNAL_PER_5M_ROUND',
      actual: 'BINANCE_5M_KLINE_CLOSE_VS_OPEN',
      waitExcludedFromAccuracy: true,
      flatExcludedFromAccuracy: true,
      independentOfTrading: true,
    },
    records: [...roundHistory].sort((a, b) => b.roundStartMs - a.roundStartMs),
  };
}

loadRoundHistory();
`;

const pruneMarker = 'function prune(now) {';
if (!source.includes(pruneMarker)) throw new Error('STATS_PRUNE_MARKER_NOT_FOUND');
source = source.replace(pruneMarker, statsCore + '\n' + pruneMarker);

const calcEndMarker = "      micropriceBps: Number(micropriceBps.toFixed(4)),\n    },\n  };\n}\n\nfunction handleMessage(raw) {";
if (!source.includes(calcEndMarker)) throw new Error('STATS_CALC_END_MARKER_NOT_FOUND');
source = source.replace(calcEndMarker, "      micropriceBps: Number(micropriceBps.toFixed(4)),\n    },\n  };\n  captureRoundPrediction(lastSignal);\n}\n\nfunction handleMessage(raw) {");

const klineMarker = "    if (Number.isFinite(open)) currentKlineOpen = open;\n    if (Number.isFinite(start)) currentKlineStart = start;\n    if (Number.isFinite(end)) currentKlineEnd = end;";
if (!source.includes(klineMarker)) throw new Error('STATS_KLINE_MARKER_NOT_FOUND');
source = source.replace(klineMarker, klineMarker + "\n    const close = Number(k.c);\n    if (k.x === true && Number.isFinite(start) && Number.isFinite(open) && Number.isFinite(close)) {\n      settleRound(start, end, open, close);\n    }");

const routeMarker = "  // Compatibility endpoint for the existing trade-control service. It is NOT wired to it automatically.";
if (!source.includes(routeMarker)) throw new Error('STATS_ROUTE_MARKER_NOT_FOUND');
source = source.replace(routeMarker, "  if (req.method === 'GET' && url.pathname === '/api/stats') {\n    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });\n    return res.end(JSON.stringify(statsPayload()));\n  }\n\n" + routeMarker);

fs.writeFileSync(runtimeUrl, source, 'utf8');
console.log(JSON.stringify({ event: 'signal_stats_runtime_patch_ready', runtime: runtimeUrl.pathname }));
await import(runtimeUrl.href + '?v=' + Date.now());
