console.log(JSON.stringify({
  event: 'round_signal_freeze_patch_applied',
  policy: 'FIRST_QUALITY_LOCKED_UP_DOWN_PER_5M_ROUND',
  strategyVersion: 'QUALITY_FILTER_V3_5M',
  failMode: 'IMMUTABLE_UNTIL_NEXT_5M_ROUND',
}));
await import('./index.mjs');
