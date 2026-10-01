console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_CONTINUOUS_STATE_LOCK_PER_5M_ROUND',
  strategyVersion: 'CONTINUOUS_MARKET_STATE_V4',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));
await import('./index.mjs');
