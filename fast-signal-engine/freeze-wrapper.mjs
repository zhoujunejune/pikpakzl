console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_CONTINUOUS_STATE_LOCK_PER_5M_ROUND_V5',
  strategyVersion: 'CONTINUOUS_MARKET_STATE_V5',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));
await import('./index.mjs');
