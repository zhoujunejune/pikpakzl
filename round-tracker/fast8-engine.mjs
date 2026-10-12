import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION, POLICY, ROUND_MS, CUTOFF_MS, LOCK_MS, DEADLINE_MS, MIN_TRAINING,
  FEATURES, finite, isDirection, featureVector, probability } from './fast8-model.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ratio = (a, b) => b ? a / b : null;
const percentile = (xs, q) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1] : null;
function wilson(h, n) {
  if (!n) return [null, null];
  const z = 1.95996398454, p = h / n, denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [center - half, center + half];
}

export function createFast8Engine({ dir, clock = Date.now, emit = () => {}, publish = () => {} }) {
  const rows = new Map(), snapshots = new Map();
  let start = null, journalReady = false, error = null, fd = null;
  let model = null, lastTraining = null, trainingBusy = false, lastTrainingCount = 0;
  let lastSourceAt = null, lastMarket = null, lastCaptureError = null;
  let revision = 0, cachedStats = null;
  const state = round => {
    if (!rows.has(round)) rows.set(round, { roundStartMs: round });
    return rows.get(round);
  };
  function apply(e) {
    if (e.type === 'started') start = e.start;
    else if (e.type === 'model') model = e.model;
    else if (e.type === 'training') {
      lastTraining = e;
      lastTrainingCount = e.count;
    } else if (finite(e.roundStartMs)) {
      const row = state(e.roundStartMs);
      if (e.type === 'decision' && !row.decision) row.decision = e;
      if (e.type === 'persisted' && !row.persistedAt) row.persistedAt = e.at;
      if (e.type === 'published' && !row.publishedAt) row.publishedAt = e.at;
      if (e.type === 'settlement') row.settlement = e;
    }
    revision++;
  }
  function append(event) {
    if (!journalReady) return false;
    const e = { schemaVersion: 1, modelFamily: VERSION, policyVersion: POLICY, ...event };
    try {
      const bytes = Buffer.from(JSON.stringify(e) + '\n');
      if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('PARTIAL_JOURNAL_WRITE');
      fs.fsyncSync(fd);
      apply(e);
      if (error === 'JOURNAL_WRITE_FAILED') error = null;
      return true;
    } catch {
      error = 'JOURNAL_WRITE_FAILED';
      journalReady = false;
      emit('fast8_error', { reason: error });
      return false;
    }
  }
  function load() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'events.jsonl');
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file, 'utf8');
        const end = body.lastIndexOf('\n') + 1;
        if (end !== body.length) fs.truncateSync(file, Buffer.byteLength(body.slice(0, end)));
        for (const line of body.slice(0, end).split('\n').filter(Boolean)) {
          const e = JSON.parse(line);
          if (e.schemaVersion !== 1 || e.modelFamily !== VERSION || e.policyVersion !== POLICY) throw new Error('WRONG_JOURNAL_VERSION');
          apply(e);
        }
      }
      fd = fs.openSync(file, 'a');
      journalReady = true;
      if (start === null && !append({ type: 'started', start: Math.ceil(clock() / ROUND_MS) * ROUND_MS,
        at: clock(), targets: { accuracy: 0.65, coverage: 1, deadlineMs: DEADLINE_MS } })) return false;
      if (lastTraining?.status === 'TRAINING') lastTraining = { ...lastTraining, status: 'INTERRUPTED_RETRY_PENDING' };
      return true;
    } catch {
      journalReady = false;
      error = 'JOURNAL_LOAD_FAILED';
      emit('fast8_error', { reason: error });
      return false;
    }
  }
  function capture(live, receivedAt = clock()) {
    const now = clock(), round = Math.floor(now / ROUND_MS) * ROUND_MS;
    const source = live?.factsCalculatedAt;
    if (!finite(receivedAt) || receivedAt > now || live?.round !== round || !finite(source) ||
        source > receivedAt || source < round || now - source > 2000 || now - receivedAt > 1000) {
      lastCaptureError = 'STALE_FUTURE_OR_WRONG_ROUND_SNAPSHOT';
      return false;
    }
    const f = live.facts || {};
    const features = Object.fromEntries(FEATURES.map(([key]) => [key, finite(f[key]) ? f[key] : null]));
    const issues = [];
    if (!finite(f.depthAgeMs) || f.depthAgeMs < 0 || f.depthAgeMs > 1500) {
      features.ofiNormalized5s = null;
      issues.push('DEPTH_MISSING_OR_STALE');
    }
    if (!finite(f.lastAggTradeAgeMs) || f.lastAggTradeAgeMs < 0 || f.lastAggTradeAgeMs > 12000 || f.tradeStreamStalled) {
      features.tradePressure15s = features.tradePressure60s = null;
      issues.push('TRADES_MISSING_OR_STALE');
    }
    const pmValid = f.predictionMarketMappingReliable === true && f.predictionMarketRoundAligned === true &&
      f.predictionMarketRound === round && finite(f.predictionMarketBookAgeMs) &&
      f.predictionMarketBookAgeMs >= 0 && f.predictionMarketBookAgeMs <= 5000 &&
      finite(f.predictionMarketUpMid) && f.predictionMarketUpMid >= 0 && f.predictionMarketUpMid <= 1 &&
      (!finite(f.predictionMarketUpdateTimestampMs) || f.predictionMarketUpdateTimestampMs <= receivedAt);
    if (!pmValid) { features.predictionMarketUpMid = null; issues.push('PM_MISSING_OR_UNALIGNED'); }
    const snapshot = { features, sourceAt: source, receivedAt, capturedAt: now, issues,
      presentFeatures: Object.values(features).filter(finite).length };
    lastMarket = snapshot;
    lastSourceAt = source;
    lastCaptureError = null;
    if (round >= start && !rows.get(round)?.decision && now <= round + CUTOFF_MS) snapshots.set(round, snapshot);
    return true;
  }
  function prior(round, cutoff) {
    const history = [...rows.values()].filter(r => r.roundStartMs < round &&
      r.settlement?.receivedAt <= cutoff && isDirection(r.settlement?.actual))
      .sort((a, b) => a.roundStartMs - b.roundStartMs).slice(-300);
    const up = history.filter(r => r.settlement.actual === 'UP').length;
    if (history.length && up * 2 !== history.length) return { direction: up * 2 > history.length ? 'UP' : 'DOWN', fallbackLevel: 'HISTORICAL_MAJORITY' };
    return { direction: (round / ROUND_MS) % 2 === 0 ? 'UP' : 'DOWN', fallbackLevel: 'NO_INFORMATION_FALLBACK' };
  }
  function baseline(round, snapshot) {
    const momentum = snapshot?.features?.normalizedMomentum60s;
    if (finite(momentum) && momentum !== 0) return { direction: momentum > 0 ? 'UP' : 'DOWN', fallbackLevel: 'MOMENTUM60_BASELINE' };
    return prior(round, round + CUTOFF_MS);
  }
  function decisionView(row) {
    if (!row?.decision) return null;
    const { features, x, ...decision } = row.decision;
    return { ...decision, persistedAtMs: row.persistedAt ?? null, publishedAtMs: row.publishedAt ?? null,
      status: 'SHADOW_LOCKED', executionEligible: false, productionEffect: 'NONE_SHADOW_ONLY' };
  }
  function tick() {
    const now = clock(), round = Math.floor(now / ROUND_MS) * ROUND_MS;
    if (!journalReady || start === null || round < start || now < round + LOCK_MS) return null;
    const row = state(round);
    if (row.decision) return decisionView(row);
    // Never use a newly received post-cutoff snapshot as a deadline fallback.
    let snapshot = snapshots.get(round);
    if (snapshot && round + LOCK_MS - snapshot.sourceAt > 2500) snapshot = null;
    if (!snapshot && lastMarket && lastMarket.capturedAt <= round + CUTOFF_MS &&
        lastMarket.receivedAt <= round + CUTOFF_MS && round + LOCK_MS - lastMarket.sourceAt <= 5000) snapshot = lastMarket;
    const base = baseline(round, snapshot);
    const features = snapshot?.features || {};
    const x = featureVector(features);
    const active = model && model.effectiveFromRound <= round;
    const p = active && snapshot?.presentFeatures >= 5 ? probability(model.weights, x) : null;
    const learned = finite(p);
    const direction = learned && p !== 0.5 ? (p > 0.5 ? 'UP' : 'DOWN') : base.direction;
    const decision = { type: 'decision', roundStartMs: round, officialRoundStartMs: round,
      decisionComputedAtMs: now, featureCutoffMs: round + CUTOFF_MS,
      maxEventTimeMs: snapshot?.sourceAt ?? null, maxReceivedAtMs: snapshot?.receivedAt ?? null,
      capturedAtMs: snapshot?.capturedAt ?? null, direction, pUpRaw: learned ? p : null,
      confidenceStatus: learned ? 'UNCALIBRATED_MODEL_SCORE' : 'BASELINE_NOT_CALIBRATED',
      fallbackLevel: learned && p !== 0.5 ? (snapshot.issues.length ? 'MODEL_WITH_MISSING_FEATURES' : 'NONE') : base.fallbackLevel,
      baselineDirection: base.direction, dataQuality: snapshot?.issues || ['NO_FRESH_SNAPSHOT'],
      presentFeatures: snapshot?.presentFeatures || 0,
      modelVersion: learned ? model.modelVersion : VERSION + '-baseline-v1',
      weightsHash: learned ? model.weightsHash : null, trainingLabelsReceivedThrough: learned ? model.trainingLabelsReceivedThrough : null,
      featuresHash: hash(features), features, x, productionEffect: 'NONE_SHADOW_ONLY' };
    if (!append(decision)) return null;
    if (!append({ type: 'persisted', roundStartMs: round, at: clock() })) return null;
    snapshots.delete(round);
    for (const key of snapshots.keys()) if (key < round) snapshots.delete(key);
    const view = decisionView(row);
    publish(view);
    emit('fast8_direction_frozen', view);
    return view;
  }
  function acknowledge(round, at) {
    const row = rows.get(round);
    if (!row?.decision || row.publishedAt || !finite(at) || at < row.persistedAt || at > clock()) return false;
    if (!append({ type: 'published', roundStartMs: round, at })) return false;
    if (at - round > DEADLINE_MS) emit('fast8_deadline_breach', { roundStartMs: round, delayMs: at - round });
    return true;
  }
  function settle(row) {
    const now = clock(), round = row?.roundStartMs;
    if (!journalReady || !finite(round) || round % ROUND_MS || round < start ||
      !isDirection(row.actual) || row.actualSource !== 'BINANCE_PREDICTION_OFFICIAL_RESOLUTION' ||
      !String(row.resolutionEvidence || '').startsWith('OFFICIAL_' + row.actual + ':') ||
      !String(row.resolutionEvidence).includes('STRICT_ROUND_ALIGNED_TOPIC') ||
      !finite(row.settledAt) || row.settledAt < round + ROUND_MS || row.settledAt > now) return false;
    const existing = rows.get(round)?.settlement;
    if (existing?.actual === row.actual && existing.resolutionEvidence === row.resolutionEvidence) return false;
    const event = { type: 'settlement', roundStartMs: round, actual: row.actual,
      settledAt: row.settledAt, receivedAt: now, resolutionEvidence: row.resolutionEvidence,
      evidenceHash: hash(row.officialSettlementAudit || row.resolutionEvidence),
      auditEvidence: row.officialSettlementAudit || null,
      verification: 'RAILWAY_OFFICIAL_SOURCE_NOT_INDEPENDENTLY_REVERIFIED' };
    if (!append(event)) return false;
    const prediction = rows.get(round)?.decision?.direction;
    emit('fast8_round_settled', { roundStartMs: round, actual: row.actual,
      direction: prediction ?? null, result: prediction ? (prediction === row.actual ? 'HIT' : 'MISS') : 'MISSING_PREDICTION',
      evidenceHash: event.evidenceHash, verification: event.verification, productionEffect: 'NONE_SHADOW_ONLY' });
    return true;
  }
  function onTime(row) {
    const d = row.decision;
    return Boolean(d && row.persistedAt >= d.decisionComputedAtMs && row.publishedAt >= row.persistedAt &&
      d.decisionComputedAtMs >= row.roundStartMs && row.publishedAt <= row.roundStartMs + DEADLINE_MS &&
      (d.maxReceivedAtMs === null || (d.maxEventTimeMs <= d.maxReceivedAtMs &&
        d.maxReceivedAtMs <= d.capturedAtMs && d.capturedAtMs <= d.featureCutoffMs)));
  }
  function trainingRows() {
    return [...rows.values()].filter(r => r.settlement && onTime(r) && r.decision.presentFeatures >= 5)
      .sort((a, b) => a.roundStartMs - b.roundStartMs).map(r => ({
        roundStartMs: r.roundStartMs, x: r.decision.x, y: Number(r.settlement.actual === 'UP'),
        baseline: r.decision.baselineDirection, decisionAt: r.decision.decisionComputedAtMs,
        labelReceivedAt: r.settlement.receivedAt }));
  }
  function beginTraining() {
    const all = trainingRows(), count = all.length;
    const retry = lastTraining?.status === 'INTERRUPTED_RETRY_PENDING';
    if (!journalReady || trainingBusy || count < MIN_TRAINING || (!retry && lastTrainingCount && count - lastTrainingCount < 100)) return null;
    if (!append({ type: 'training', status: 'TRAINING', count, at: clock() })) return null;
    trainingBusy = true;
    return all.slice(-2000);
  }
  function finishTraining(result, failure = null) {
    trainingBusy = false;
    const valid = result && Array.isArray(result.weights) && result.weights.length === FEATURES.length * 2 + 3 &&
      result.weights.every(finite) && finite(result.trainingLabelsReceivedThrough) && result.trainingLabelsReceivedThrough <= clock();
    let status = failure ? 'TRAINING_FAILED' : valid ? (result.accepted ? 'MODEL_REGISTERED' : 'CANDIDATE_BELOW_BASELINE') : 'INVALID_MODEL';
    if (valid && result.accepted) {
      const weightsHash = hash(result.weights);
      const next = { ...result, modelVersion: VERSION + '-' + clock() + '-' + weightsHash.slice(0, 8), weightsHash,
        registeredAt: clock(), effectiveFromRound: (Math.floor(clock() / ROUND_MS) + 1) * ROUND_MS };
      if (!append({ type: 'model', model: next })) status = 'MODEL_PERSISTENCE_FAILED';
    }
    append({ type: 'training', status, count: lastTrainingCount, at: clock(),
      holdout: valid ? result.holdout : null, reason: failure ? 'TRAINER_FAILED' : null });
    emit('fast8_training_result', lastTraining);
  }
  function summarize(list, expected) {
    const predictions = list.filter(r => r.decision), official = list.filter(r => r.settlement);
    const labeled = official.filter(r => r.decision), hits = labeled.filter(r => r.decision.direction === r.settlement.actual).length;
    const timely = predictions.filter(onTime), timelyHits = labeled.filter(r => onTime(r) && r.decision.direction === r.settlement.actual).length;
    const delay = predictions.filter(r => r.publishedAt).map(r => r.publishedAt - r.roundStartMs);
    const levels = {};
    for (const r of predictions) {
      const key = r.decision.fallbackLevel, entry = levels[key] ||= { rounds: 0, labeled: 0, hits: 0 };
      entry.rounds++;
      if (r.settlement) { entry.labeled++; entry.hits += Number(r.decision.direction === r.settlement.actual); }
    }
    for (const entry of Object.values(levels)) { entry.rate = ratio(entry.rounds, expected); entry.accuracy = ratio(entry.hits, entry.labeled); }
    let currentMissStreak = 0, longestMissStreak = 0;
    for (const r of labeled) {
      currentMissStreak = r.decision.direction === r.settlement.actual ? 0 : currentMissStreak + 1;
      longestMissStreak = Math.max(longestMissStreak, currentMissStreak);
    }
    return { expectedRounds: expected, decidedRounds: predictions.length, missingRounds: expected - predictions.length,
      onTimeRounds: timely.length, lateOrUnpublishedRounds: predictions.length - timely.length,
      directionCoverage: ratio(predictions.length, expected), onTimeCoverage: ratio(timely.length, expected),
      officialRounds: official.length, pendingLabels: expected - official.length, labeledPredictions: labeled.length,
      hits, misses: labeled.length - hits, predictionAccuracy: ratio(hits, labeled.length),
      endToEndAccuracy: ratio(timelyHits, official.length), accuracyWilson95: wilson(hits, labeled.length),
      fallbackByLevel: levels, currentMissStreak, longestMissStreak,
      publicationDelayMs: { p50: percentile(delay, 0.5), p95: percentile(delay, 0.95), p99: percentile(delay, 0.99), max: delay.length ? Math.max(...delay) : null },
      byDirection: Object.fromEntries(['UP', 'DOWN'].map(d => {
        const rs = labeled.filter(r => r.decision.direction === d), h = rs.filter(r => r.settlement.actual === d).length;
        return [d, { samples: rs.length, hits: h, misses: rs.length - h, accuracy: ratio(h, rs.length) }];
      })) };
  }
  function stats() {
    const now = clock(), ended = Math.floor(now / ROUND_MS) * ROUND_MS;
    const expected = start === null ? 0 : Math.max(0, (ended - start) / ROUND_MS);
    if (!cachedStats || cachedStats.revision !== revision || cachedStats.expected !== expected) {
      const all = [...rows.values()].filter(r => r.roundStartMs >= start && r.roundStartMs < ended).sort((a, b) => a.roundStartMs - b.roundStartMs);
      const totals = summarize(all, expected);
      const windows = Object.fromEntries([100, 300, 1000].map(n => [n,
        summarize(all.filter(r => r.roundStartMs >= ended - Math.min(n, expected) * ROUND_MS), Math.min(n, expected))]));
      const first = all.filter(r => r.roundStartMs < start + 1000 * ROUND_MS);
      const validation = summarize(first, Math.min(1000, expected));
      const passed = validation.expectedRounds === 1000 && validation.officialRounds === 1000 &&
        validation.onTimeRounds === 1000 && validation.hits >= 650;
      cachedStats = { revision, expected, data: { ...totals, windows,
        validation: { ...validation, status: passed ? 'OBSERVED_1000_ROUND_TARGET_MET' : expected < 1000 ? 'COLLECTING' : 'TARGET_NOT_MET_OR_LABELS_PENDING',
          passed, fromRound: start, toRound: start === null ? null : start + 999 * ROUND_MS, independentOfficialVerification: false },
        training: { status: lastTraining?.status || 'COLLECTING', requiredSamples: MIN_TRAINING,
          validTrainingSamples: trainingRows().length, trainEveryAdditionalSamples: 100,
          lastResult: lastTraining, busy: trainingBusy },
        latestSettlements: all.filter(r => r.settlement).slice(-12).map(r => ({ roundStartMs: r.roundStartMs,
          direction: r.decision?.direction ?? null, actual: r.settlement.actual,
          result: r.decision ? (r.decision.direction === r.settlement.actual ? 'HIT' : 'MISS') : 'MISSING_PREDICTION',
          modelVersion: r.decision?.modelVersion ?? null, fallbackLevel: r.decision?.fallbackLevel ?? null,
          publishedDelayMs: r.publishedAt ? r.publishedAt - r.roundStartMs : null })) } };
    }
    const latestRow = [...rows.values()].filter(r => r.decision).sort((a, b) => b.roundStartMs - a.roundStartMs)[0];
    return { ok: journalReady && !error, modelFamily: VERSION, policyVersion: POLICY,
      generatedAtMs: now, productionEffect: 'NONE_SHADOW_ONLY', autoPromotion: false, executionEligible: false,
      status: model ? (now >= model.effectiveFromRound ? 'MODEL_FORWARD_ACTIVE' : 'MODEL_REGISTERED_PENDING_NEXT_ROUND') : 'BASELINE_COLLECTING', deadlineMs: DEADLINE_MS,
      targets: { accuracy: 0.65, directionCoverage: 1, onTimeCoverage: 1 }, experimentStartRound: start,
      modelVersion: model?.modelVersion || VERSION + '-baseline-v1', modelEffectiveFromRound: model?.effectiveFromRound ?? null,
      health: { journalReady, lastError: error, lastSourceAt, lastSourceAgeMs: lastSourceAt === null ? null : now - lastSourceAt, lastCaptureError },
      ...cachedStats.data, latest: decisionView(latestRow),
      evidence: 'STRICT_FORWARD_WITH_INTERNAL_OFFICIAL_SETTLEMENT; NOT_INDEPENDENTLY_CERTIFIED',
      noGuarantee: '65% is a target. Baseline and fallback outcomes are included; future performance is not guaranteed.' };
  }
  function close() { if (fd !== null) fs.closeSync(fd); fd = null; }
  return { load, capture, tick, acknowledge, settle, stats, beginTraining, finishTraining, close,
    replayLatest: () => { const latest = stats().latest; if (latest) publish(latest); } };
}
