console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_REGIME_LAYER_LOCK_PER_5M_ROUND_V6',
  strategyVersion: 'REGIME_LAYER_V6_5M',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));
await import('./index.mjs');
