import { Worker } from 'node:worker_threads';
import { VERSION, POLICY, FEATURES } from './fast8-model.mjs';

// This adapter only publishes into its private read-only cache and logs.
// It has no callback or reference to production locks, trading, or Redis.
export function createFast8Client({ dir = '/data/fast8-65', log = () => {}, onReady = () => {}, onDecision = () => {} } = {}) {
  let worker = null, latest = null, stopped = false, timer = null, generation = 0;
  let workerError = null;
  let status = { ok: false, status: 'STARTING', modelFamily: VERSION, policyVersion: POLICY,
    productionEffect: 'NONE_SHADOW_ONLY', autoPromotion: false, executionEligible: false };
  function start() {
    if (stopped) return;
    const current = ++generation;
    let instance;
    try { instance = new Worker(new URL('./fast8-worker.mjs', import.meta.url), { workerData: { dir } }); }
    catch {
      workerError = 'SHADOW_WORKER_START_FAILED';
      log('fast8_error', { reason: workerError });
      timer = setTimeout(start, 5000);
      timer.unref();
      return;
    }
    worker = instance;
    instance.on('message', m => {
      if (current !== generation || stopped) return;
      if (m.type === 'status') {
        status = m.stats;
        workerError = null;
        if (latest && status.latest?.roundStartMs === latest.roundStartMs) {
          latest = { ...status.latest, serverAvailableAtMs: latest.serverAvailableAtMs };
        }
        log('fast8_status', status);
      }
      if (m.type === 'log') log(m.event, m.data);
      if (m.type === 'decision') {
        const received = Date.now();
        latest = { ...m.decision, serverAvailableAtMs: received };
        // First worker acknowledgement is immutable; recovery cannot turn a late
        // publication into a timely one or alter a direction.
        worker.postMessage({ type: 'published', roundStartMs: latest.roundStartMs, at: received });
        log('fast8_direction_locked', { ...latest, productionEffect: 'NONE_SHADOW_ONLY' });
        // Optional event notification; production polling remains a fallback.
        try { onDecision(latest); } catch { log('fast8_error', { reason: 'FAST8_DECISION_CALLBACK_FAILED' }); }
      }
      if (m.type === 'ready') {
        try { onReady(); } catch { log('fast8_error', { reason: 'SETTLEMENT_REPLAY_FAILED' }); }
      }
    });
    instance.on('error', () => {
      workerError = 'SHADOW_WORKER_FAILED';
      log('fast8_error', { reason: workerError });
    });
    instance.on('exit', () => {
      if (current !== generation) return;
      worker = null;
      workerError = 'SHADOW_WORKER_EXITED';
      if (!stopped) { timer = setTimeout(start, 1000); timer.unref(); }
    });
    instance.unref();
  }
  const fields = [...FEATURES.map(([key]) => key), 'depthAgeMs', 'lastAggTradeAgeMs', 'tradeStreamStalled',
    'predictionMarketMappingReliable', 'predictionMarketRoundAligned', 'predictionMarketRound',
    'predictionMarketBookAgeMs', 'predictionMarketUpdateTimestampMs'];
  return {
    start,
    observe(live, receivedAt = Date.now()) {
      if (!worker || !live) return;
      worker.postMessage({ type: 'observe', receivedAt, live: { round: live.round, factsCalculatedAt: live.factsCalculatedAt,
        facts: Object.fromEntries(fields.map(key => [key, live.facts?.[key]])) } });
    },
    settle(row) {
      if (!worker || !row) return;
      worker.postMessage({ type: 'settle', row: { roundStartMs: row.roundStartMs, actual: row.actual,
        actualSource: row.actualSource, resolutionEvidence: row.resolutionEvidence, settledAt: row.settledAt,
        officialSettlementAudit: row.officialSettlementAudit || null } });
    },
    stats: () => ({ ...status, ok: Boolean(status.ok && worker && !workerError), workerError,
      statusAgeMs: status.generatedAtMs ? Date.now() - status.generatedAtMs : null }),
    latest: () => ({ modelFamily: VERSION, productionEffect: 'NONE_SHADOW_ONLY', executionEligible: false, signal: latest }),
    async stop() { stopped = true; clearTimeout(timer); generation++; await worker?.terminate(); worker = null; },
  };
}
