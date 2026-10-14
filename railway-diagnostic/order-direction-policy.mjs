// Order execution direction is separate from the immutable production prediction.
// Inversion is paused: locked UP buys UP, and locked DOWN buys DOWN.
// The policy version is checked on submit: an old inverted pending intent
// cannot be accepted by the normal-direction execution path.
export const ORDER_DIRECTION_POLICY = 'FOLLOW_PRODUCTION_DIRECTION_V1';
export function orderDirectionForProduction(productionDirection) {
  return productionDirection === 'UP' || productionDirection === 'DOWN'
    ? productionDirection : null;
}
export function mappedOrderSignal(signal) {
  const productionSignal = signal?.status === 'LOCKED' ? signal.direction : null;
  const orderSignal = orderDirectionForProduction(productionSignal);
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
