console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
  strategyVersion: 'REGIME_LAYER_V6_5M',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));
// One-shot, read-only identification of the actual public egress for V3.
// Intentionally does not access credentials, signal decisions, or order execution.
void (async () => {
  const targets = [
    ['aws_checkip', 'https://checkip.amazonaws.com/'],
    ['ipify', 'https://api.ipify.org/'],
  ];
  for (const [provider, url] of targets) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(4500),
      });
      const body = response.ok ? (await response.text()).trim() : '';
      const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(body) ? body : null;
      console.log(JSON.stringify({
        event: 'v3_egress_public_ip_readonly_probe',
        service: 'signal-diagnostic-v3',
        provider,
        httpStatus: response.status,
        publicIp: ipv4,
        elapsedMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      }));
    } catch (error) {
      console.log(JSON.stringify({
        event: 'v3_egress_public_ip_readonly_probe',
        service: 'signal-diagnostic-v3',
        provider,
        error: String(error?.message || error).slice(0, 140),
        at: new Date().toISOString(),
      }));
    }
  }
})();

// Migration-branch-only diagnostics; results are read-only and independent of signal decisions.
void import('./render-migration-readonly-preflight.mjs').catch(e=>
  console.warn(JSON.stringify({event:'render_migration_preflight_load_failed',error:String(e?.message||e).slice(0,120)})));
// Cloudflare Worker inspection runs only if the user provides the two values
// in Render's encrypted environment. It makes GET requests only: no deployment.
if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
  void import('./cloudflare-worker-audit.mjs').catch(e=>
    console.warn(JSON.stringify({event:'cloudflare_worker_audit_import_failed',
      errorType:String(e?.name||'UNKNOWN').slice(0,50)})));
}
// Explicit, single-purpose Cloudflare API repair, only enabled by
// an owner-supplied temporary Render environment flag. Never submits orders.
if(process.env.CF_REPAIR_STAGE==='edge-official'){
  void import('./cloudflare-edge-official-repair.mjs').catch(e=>
    console.warn(JSON.stringify({event:'cloudflare_edge_repair_import_failed',
      reason:String(e?.message||e).slice(0,100)})));
}
// One-shot, public-only WebSocket klines experiment to recover spot history
// without using REST on the banned Render shared egress.
if(process.env.RENDER_WS_KLINE_HISTORY_PROBE==='true'){
  void import('./binance-ws-history-probe.mjs').catch(e=>
    console.log(JSON.stringify({event:'binance_ws_history_probe_module_error',
      errorType:String(e?.name||'UNKNOWN').slice(0,70)})));
}
// One-shot signed GET verification after startup; never invokes order-writing APIs.
// Only status codes/counts returned by the existing redacted diagnostic endpoint are logged.
if (process.env.RENDER_MIGRATION_PREVIEW === 'true' &&
    process.env.RENDER_AUTH_READONLY_CHECK !== 'false') {
  setTimeout(async () => {
    try {
      const r=await fetch('http://127.0.0.1:' + (process.env.PORT || '10000') +
        '/api/official-settlement-source-diagnostic', {
        cache:'no-store',signal:AbortSignal.timeout(18000)
      });
      const data=await r.json();
      const short=x=>({
        ok:x?.ok===true,httpStatus:Number(x?.httpStatus)||0,
        binanceCode:x?.binanceCode??null,itemCount:Number(x?.itemCount)||0,
        btcusdt5mItems:Number(x?.btcusdt5mItems)||0,
        shape:x?.shape??null,errorType:x?.errorType??null
      });
      console.log(JSON.stringify({event:'render_authenticated_prediction_readonly_check',
        httpStatus:r.status,credentialsConfigured:data?.credentialsConfigured===true,
        list:short(data?.list),search:short(data?.search)}));
    } catch (e) {
      console.log(JSON.stringify({event:'render_authenticated_prediction_readonly_check',
        error:String(e?.message||e).slice(0,160)}));
    }
  }, 12000).unref();
}
await import('./index.mjs');
