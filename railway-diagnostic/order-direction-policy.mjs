// Keep the immutable production prediction distinct from the actual order.
// The source-aware order policy is versioned, so an old pending quote/token
// cannot be submitted after changing from the globally inverted policy.
export const ORDER_DIRECTION_POLICY = 'FORWARD_ONLY_SELECTIVE8_V2';
export const LOW_CONFIDENCE_SOURCE = 'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';
export const PRIMARY_SOURCE = 'SELECTIVE_V2_FAST8_PRIMARY';
export const RESCUE_SOURCE = 'EDGE_RESCUE_FAST8_PRIMARY';

export function orderDirectionForProduction(productionDirection, productionSource = null) {
  if (productionDirection !== 'UP' && productionDirection !== 'DOWN') return null;
  // Reverse order mapping is suspended for every production signal source.
  return productionDirection;
}

export function mappedOrderSignal(signal) {
  const productionSignal = signal?.status === 'LOCKED' ? signal.direction : null;
  const productionSource = signal?.source ?? signal?.upstreamSource ?? null;
  const orderSignal = orderDirectionForProduction(productionSignal, productionSource);
  return {
    productionSignal,
    productionSource,
    orderSignal,
    action: orderSignal === null ? null : 'BUY_' + orderSignal,
    mappingMode: 'FORWARD',
    mappingPolicy: ORDER_DIRECTION_POLICY,
  };
}

export function pendingOrderMatchesProduction(pending, liveSignal) {
  if (!pending || !liveSignal || liveSignal.status !== 'LOCKED' ||
      String(liveSignal.round) !== String(pending.round)) return false;
  const mapped = mappedOrderSignal(liveSignal);
  return mapped.orderSignal !== null &&
    pending.productionSignal === mapped.productionSignal &&
    pending.productionSource === mapped.productionSource &&
    pending.orderSignal === mapped.orderSignal &&
    pending.signal === mapped.orderSignal &&
    pending.action === mapped.action &&
    pending.mappingMode === mapped.mappingMode &&
    pending.orderDirectionPolicy === ORDER_DIRECTION_POLICY;
}
