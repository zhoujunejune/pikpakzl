import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const ORIGIN = String(process.env.SITE_ORIGIN || '').replace(/\/$/, '');
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 5000));

let initialized = false;
let lastSeenRound = null;
let observedTransitions = 0;
let state = { ok: false, reason: 'starting' };

function summarize(record) {
  return {
    round: record?.round ?? record?.input?.round ?? null,
    status: record?.status ?? null,
    direction: record?.signal?.direction ?? null,
    score: record?.signal?.score ?? null
  };
}

async function poll() {
  if (!ORIGIN) {
    state = { ok: false, reason: 'SITE_ORIGIN_MISSING' };
    console.log(JSON.stringify({ event: 'validator_blocked', ...state }));
    return;
  }
  try {
    const res = await fetch(`${ORIGIN}/api/local-predictions`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    const records = Array.isArray(data?.records) ? data.records : [];
    const current = summarize(records[0]);
    state = { ok: true, ...current, recordCount: records.length, observedTransitions };

    if (!initialized) {
      initialized = true;
      lastSeenRound = current.round;
      console.log(JSON.stringify({ event: 'validator_baseline', note: 'Baseline only; no action is performed', ...state }));
      return;
    }

    if (current.round == null || current.round === lastSeenRound) return;

    observedTransitions += 1;
    lastSeenRound = current.round;
    state = { ...state, observedTransitions };
    console.log(JSON.stringify({
      event: 'VALIDATED_SIGNAL_TRANSITION',
      round: current.round,
      status: current.status,
      direction: current.direction,
      score: current.score,
      mapping: current.direction === 'UP' ? 'UP' : current.direction === 'DOWN' ? 'DOWN' : 'SKIP',
      duplicateKey: String(current.round),
      note: 'Validation only; this service never calls a trading API',
      ts: new Date().toISOString()
    }));
  } catch (e) {
    state = { ok: false, reason: String(e?.message || e) };
    console.log(JSON.stringify({ event: 'validator_poll_error', ...state }));
  }
}

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'prediction-signal-validator', initialized, lastSeenRound, observedTransitions, state }));
}).listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'validator_started', port: PORT, pollMs: POLL_MS, hasSiteOrigin: Boolean(ORIGIN) }));
});

await poll();
setInterval(poll, POLL_MS);
