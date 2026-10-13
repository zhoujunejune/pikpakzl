// Order execution mapping is separate from the model's immutable prediction.
// ONLY valid, locked binary production signals are eligible to be inverted.
export const ORDER_DIRECTION_POLICY = 'INVERT_PRODUCTION_UP_DOWN_V1';
export function inverseOrderDirection(productionDirection) {
  if (productionDirection === 'UP') return 'DOWN';
  if (productionDirection === 'DOWN') return 'UP';
  return null;
}
export function mappedOrderSignal(signal) {
  const productionSignal = signal?.status === 'LOCKED' ? signal.direction : null;
  const orderSignal = inverseOrderDirection(productionSignal);
  return {
    productionSignal,
    orderSignal,
    action: orderSignal === null ? null : 'BUY_' + orderSignal,
    mappingPolicy: ORDER_DIRECTION_POLICY,
  };
}
export function pendingOrderMatchesProduction(pending, liveSignal) {
  if (!pending || !liveSignal || liveSignal.status !== 'LOCKED' ||
      String(liveSignal.round) !== String(pending.round)) return false;
  const mapped = mappedOrderSignal(liveSignal);
  return mapped.orderSignal !== null && pending.productionSignal === mapped.productionSignal &&
    pending.orderSignal === mapped.orderSignal &&
    pending.signal === mapped.orderSignal &&
    pending.action === mapped.action &&
    pending.orderDirectionPolicy === ORDER_DIRECTION_POLICY;
}
