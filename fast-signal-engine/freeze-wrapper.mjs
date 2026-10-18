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
await import('./index.mjs');
