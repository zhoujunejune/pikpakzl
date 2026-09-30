const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync.bind(fs);
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const SERVICE_ROOT = process.cwd();
const TP50_FILE_URL = pathToFileURL(path.join(SERVICE_ROOT, 'tp50-worker.mjs')).href;

if (typeof originalFetch !== 'function') {
  throw new Error('GLOBAL_FETCH_NOT_AVAILABLE');
}

function cloneResponse(response, bodyText) {
  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function patchTradeIndexSource(source) {
  if (typeof source !== 'string' || !source.includes('async function prepareWorker()') || !source.includes('async function discoverTopic(round)')) {
    return { source, applied: false, prepareRetryPatched: false, marketSearchPatched: false, canonicalSignalPatched: false };
  }

  let patched = source;
  patched = patched.replace('min=\\"1.5\\"', 'min=\\"1\\"');
  patched = patched.replace("a<1.5)){alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准')", "a<1)){alert('请输入至少 1 USDT；实际最低金额仍以 Binance 返回为准')");
  patched = patched.replace('Number(amount) < 1.5', 'Number(amount) < 1');
  patched = patched.replace('MARKET 市价单金额请至少填写 1.5 USDT，实际最低值以 Binance 返回为准', 'MARKET 市价单金额请至少填写 1 USDT，实际最低值以 Binance 返回为准');

  const legacyPrepareRetry = '  if (Date.now() - lastPrepareAttemptAt < 2500) return;';
  const fastPrepareRetry = "  if (Date.now() - lastPrepareAttemptAt < Math.max(100, Number(process.env.PREPARE_RETRY_MS || 300))) return;";
  const prepareRetryPatched = patched.includes(legacyPrepareRetry);
  patched = patched.replace(legacyPrepareRetry, fastPrepareRetry);

  const legacyMarketSearchGate = `  if (!topics.length) {\n    const searchCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/search', { query: 'BTC 5m', topK: 50 });\n    if (searchCall.ok && Array.isArray(searchCall.data)) topics = searchCall.data;\n  }`;
  const fastMarketSearchGate = `  const hasMatchingRound = topics.some(t =>\n    String(t?.symbol || '').toUpperCase() === 'BTCUSDT' &&\n    durationLooks5m(t) &&\n    Number.isFinite(Number(t?.startDate)) &&\n    Math.abs(Number(t.startDate) - target) <= 30000\n  );\n  if (!topics.length || !hasMatchingRound) {\n    const searchCall = await signedGet('/sapi/v1/w3w/wallet/prediction/market/search', { query: 'BTC 5m', topK: 50 });\n    if (searchCall.ok && Array.isArray(searchCall.data) && searchCall.data.length) {\n      const merged = new Map();\n      for (const t of topics) merged.set(String(t?.marketTopicId ?? (String(Number(t?.startDate) || 0) + ':' + String(t?.symbol || ''))), t);\n      for (const t of searchCall.data) merged.set(String(t?.marketTopicId ?? (String(Number(t?.startDate) || 0) + ':' + String(t?.symbol || ''))), t);\n      topics = Array.from(merged.values());\n    }\n  }`;
  const marketSearchPatched = patched.includes(legacyMarketSearchGate);
  patched = patched.replace(legacyMarketSearchGate, fastMarketSearchGate);

  let canonicalSignalPatched = false;
  const signalStart = patched.indexOf('async function getSignal() {');
  const signalEndMarker = '\n}\n\nasync function getPaymentBalances()';
  const signalEnd = signalStart >= 0 ? patched.indexOf(signalEndMarker, signalStart) : -1;
  if (signalStart >= 0 && signalEnd >= 0) {
    const canonicalSignalFunction = [
      'async function getSignal() {',
      "  const canonicalOrigin = String(process.env.FROZEN_SIGNAL_ORIGIN || process.env.ROUND_STATS_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\\/+$/, '');",
      '  try {',
      "    const r = await fetch(canonicalOrigin + '/api/round-stats', {",
      "      cache: 'no-store',",
      '      signal: AbortSignal.timeout(2500),',
      '    });',
      '    if (!r.ok) return null;',
      '    const json = await r.json();',
      '    const records = Array.isArray(json?.records) ? json.records : [];',
      '    const expectedRound = Math.floor(Date.now() / 300000) * 300000;',
      '    const row = records.find(x => Number(x?.roundStartMs) === expectedRound);',
      '    if (!row) return null;',
      "    const direction = row.prediction === 'UP' || row.prediction === 'DOWN' ? row.prediction : null;",
      '    return {',
      '      round: row.roundStartMs,',
      "      status: direction ? 'LOCKED' : 'WAIT',",
      '      direction,',
      '      score: row.predictionScore ?? null,',
      '      confidence: row.predictionConfidence ?? null,',
      '      predictedAt: row.predictedAt ?? null,',
      '      canonical: true,',
      "      policy: 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND',",
      '    };',
      '  } catch {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    patched = patched.slice(0, signalStart) + canonicalSignalFunction + patched.slice(signalEnd + 2);
    canonicalSignalPatched = true;
  }

  return {
    source: patched,
    applied: prepareRetryPatched || marketSearchPatched || canonicalSignalPatched,
    prepareRetryPatched,
    marketSearchPatched,
    canonicalSignalPatched,
  };
}

function logFastPreparePatch(result, sourceKind) {
  console.log(JSON.stringify({
    event: 'trade_runtime_fast_prepare_patch',
    sourceKind,
    prepareRetryMs: Math.max(100, Number(process.env.PREPARE_RETRY_MS || 300)),
    prepareRetryPatched: result.prepareRetryPatched,
    marketSearchFallbackOnRoundMiss: result.marketSearchPatched,
    canonicalFrozenSignal: result.canonicalSignalPatched,
    frozenSignalPolicy: result.canonicalSignalPatched ? 'FIRST_LOCKED_UP_DOWN_PER_5M_ROUND' : null,
    failClosedOnCanonicalSignalError: result.canonicalSignalPatched,
  }));
}

// wrapper.mjs reads the local index.mjs directly. Patch that read before the
// wrapper evaluates it so latency + canonical-signal rules are guaranteed to apply.
fs.readFileSync = function patchedReadFileSync(file, ...args) {
  const value = originalReadFileSync(file, ...args);
  const name = String(file?.href || file || '');
  if (!name.endsWith('/index.mjs') && !name.endsWith('\\index.mjs')) return value;

  if (typeof value === 'string') {
    const result = patchTradeIndexSource(value);
    if (result.applied) logFastPreparePatch(result, 'local_read_string');
    return result.source;
  }
  if (Buffer.isBuffer(value)) {
    const result = patchTradeIndexSource(value.toString('utf8'));
    if (result.applied) logFastPreparePatch(result, 'local_read_buffer');
    return result.applied ? Buffer.from(result.source, 'utf8') : value;
  }
  return value;
};

// Keep the trade module's signal polling cadence aligned with the fast signal
// engine. This only replaces the legacy 1200ms prepareWorker timer.
globalThis.setInterval = function patchedSetInterval(callback, delay, ...args) {
  if (typeof callback === 'function' && callback.name === 'prepareWorker' && Number(delay) === 1200) {
    const configured = Number(process.env.SIGNAL_POLL_MS || 200);
    const pollMs = Number.isFinite(configured) ? Math.max(100, Math.trunc(configured)) : 200;
    console.log(JSON.stringify({
      event: 'signal_poll_interval_aligned',
      worker: 'prepareWorker',
      legacyMs: 1200,
      pollMs,
    }));
    return originalSetInterval(callback, pollMs, ...args);
  }
  return originalSetInterval(callback, delay, ...args);
};

globalThis.fetch = async function patchedFetch(input, init) {
  const response = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : String(input?.url || input || '');

  if (!url.includes('raw.githubusercontent.com/zhoujunejune/pikpakzl/')) {
    return response;
  }

  if (url.endsWith('/railway-diagnostic/index.mjs')) {
    const source = await response.text();
    const result = patchTradeIndexSource(source);
    if (result.applied) logFastPreparePatch(result, 'raw_github_fetch');
    return cloneResponse(response, result.source);
  }

  if (url.endsWith('/railway-diagnostic/wrapper.mjs')) {
    const source = await response.text();
    const merged = source + `\n\ntry {\n  await import(${JSON.stringify(TP50_FILE_URL)});\n  console.log(JSON.stringify({ event: 'tp50_worker_merged', mode: 'same_service', thresholdPercent: Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50) }));\n} catch (e) {\n  console.error(JSON.stringify({ event: 'tp50_worker_merge_failed', error: e?.message || String(e) }));\n}\n`;
    console.log(JSON.stringify({ event: 'tp50_merge_runtime_patch', source: 'wrapper.mjs', workerUrl: TP50_FILE_URL }));
    return cloneResponse(response, merged);
  }

  return response;
};
