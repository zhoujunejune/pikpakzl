const { spawn } = require('node:child_process');
const originalFetch = globalThis.fetch;

if (typeof originalFetch !== 'function') {
  throw new Error('GLOBAL_FETCH_NOT_AVAILABLE');
}

if (!globalThis.__tp50WorkerSpawned) {
  globalThis.__tp50WorkerSpawned = true;
  const launchTp50Worker = () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['./tp50-worker.mjs'], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      console.log(JSON.stringify({ event: 'tp50_worker_exit', code, signal }));
      setTimeout(launchTp50Worker, 1000).unref();
    });
    child.on('error', (error) => {
      console.log(JSON.stringify({ event: 'tp50_worker_spawn_error', error: error?.message || String(error) }));
    });
  };
  launchTp50Worker();
}

globalThis.fetch = async function patchedFetch(input, init) {
  const response = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : String(input?.url || input || '');

  if (!url.includes('raw.githubusercontent.com/zhoujunejune/pikpakzl/') || !url.endsWith('/railway-diagnostic/index.mjs')) {
    return response;
  }

  const source = await response.text();
  let patched = source;
  patched = patched.replace('min=\\"1.5\\"', 'min=\\"1\\"');
  patched = patched.replace("a<1.5)){alert('请输入至少 1.5 USDT；实际最低金额仍以 Binance 返回为准')", "a<1)){alert('请输入至少 1 USDT；实际最低金额仍以 Binance 返回为准')");
  patched = patched.replace('Number(amount) < 1.5', 'Number(amount) < 1');
  patched = patched.replace('MARKET 市价单金额请至少填写 1.5 USDT，实际最低值以 Binance 为准', 'MARKET 市价单金额请至少填写 1 USDT，实际最低值以 Binance 为准');

  const remaining = (patched.match(/1\.5/g) || []).length;
  console.log(JSON.stringify({ event: 'min_amount_runtime_patch', minimumUsdt: 1, remainingLegacy15Count: remaining }));

  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
