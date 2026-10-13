// Merge independently polled Binance order snapshots without allowing stale
// active/history records to overwrite a previously observed terminal state.
// A contradictory terminal outcome is unresolved, not a safe FAILED or FILLED.
const norm = value => String(value ?? '').trim().toUpperCase();
const succeeded = s => ['FILLED','SUCCESS','COMPLETED','COMPLETE'].includes(norm(s));
const failed = s => ['FAILED','REJECTED','CANCELLED','CANCELED','EXPIRED'].includes(norm(s));

export function reconcileOrderUpdate(previous, observed) {
  if (!previous || !observed) throw new TypeError('ORDER_STATUS_INPUT_MISSING');
  const status = observed.status ?? previous.status;
  const fillPercentage = observed.fillPercentage ?? previous.fillPercentage;
  const filledUsdtAmount = observed.filledUsdtAmount ?? previous.filledUsdtAmount;
  const filledNow = succeeded(status) || Number(fillPercentage || 0) >= 1 || Number(filledUsdtAmount || 0) > 0;
  const failedNow = failed(status);
  const filledBefore = previous.state === 'CONFIRMED_FILLED' ||
    succeeded(previous.status) || Number(previous.fillPercentage || 0) >= 1 ||
    Number(previous.filledUsdtAmount || 0) > 0;
  const failedBefore = previous.state === 'CONFIRMED_FAILED' || failed(previous.status);
  const next = {
    status, fillPercentage, filledUsdtAmount, price: observed.price ?? previous.price,
    lastObservedStatus: observed.status ?? null,
  };
  if (previous.state === 'RECONCILIATION_REQUIRED') {
    return { ...next, state: 'RECONCILIATION_REQUIRED', status: previous.status,
      fillPercentage: previous.fillPercentage, filledUsdtAmount: previous.filledUsdtAmount,
      error: previous.error, conflictingStatus: previous.conflictingStatus };
  }
  if ((filledBefore && failedNow) || (failedBefore && filledNow) || (filledNow && failedNow)) {
    return { ...next, state: 'RECONCILIATION_REQUIRED',
      status: 'CONFLICTING_EXCHANGE_ORDER_STATES',
      fillPercentage: filledBefore ? previous.fillPercentage : next.fillPercentage,
      filledUsdtAmount: filledBefore ? previous.filledUsdtAmount : next.filledUsdtAmount,
      conflictingStatus: observed.status ?? null,
      error: '交易所订单状态前后矛盾，需独立核对成交明细；自动下单已停止' };
  }
  // Binance history/list may temporarily serve older snapshots.
  if (filledBefore) return { ...next, state: 'CONFIRMED_FILLED',
    status: previous.status, fillPercentage: previous.fillPercentage,
    filledUsdtAmount: previous.filledUsdtAmount };
  if (failedBefore) return { ...next, state: 'CONFIRMED_FAILED', status: previous.status };
  return { ...next, state: filledNow ? 'CONFIRMED_FILLED' :
    failedNow ? 'CONFIRMED_FAILED' : 'SUBMITTED_PENDING_CONFIRMATION' };
}
