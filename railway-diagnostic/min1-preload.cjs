const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
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

// Keep the trade module's signal polling cadence aligned with the fast signal
// engine without changing order preparation/submission semantics. This patch is
// intentionally narrow: it only replaces the legacy 1200ms prepareWorker timer.
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
    let patched = source;
    patched = patched.replace('min=\\"1.5\\"', 'min=\\"1\\"');
    patched = patched.replace("a<1.5)){alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准')", "a<1)){alert('请输入至少 1 USDT；实际最低金额仍以 Binance 返回为准')");
    patched = patched.replace('Number(amount) < 1.5', 'Number(amount) < 1');
    patched = patched.replace('MARKET 市价单金额请至少填写 1.5 USDT，实际最低值以 Binance 返回为准', 'MARKET 市价单金额请至少填写 1 USDT，实际最低值以 Binance 返回为准');

    const remaining = (patched.match(/1\.5/g) || []).length;
    console.log(JSON.stringify({ event: 'min_amount_runtime_patch', minimumUsdt: 1, remainingLegacy15Count: remaining }));
    return cloneResponse(response, patched);
  }

  if (url.endsWith('/railway-diagnostic/wrapper.mjs')) {
    const source = await response.text();
    const merged = source + `\n\ntry {\n  await import(${JSON.stringify(TP50_FILE_URL)});\n  console.log(JSON.stringify({ event: 'tp50_worker_merged', mode: 'same_service', thresholdPercent: Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50) }));\n} catch (e) {\n  console.error(JSON.stringify({ event: 'tp50_worker_merge_failed', error: e?.message || String(e) }));\n}\n`;
    console.log(JSON.stringify({ event: 'tp50_merge_runtime_patch', source: 'wrapper.mjs', workerUrl: TP50_FILE_URL }));
    return cloneResponse(response, merged);
  }

  return response;
};
