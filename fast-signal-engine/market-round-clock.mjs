// The Binance 5m candle can arrive AFTER the UTC round boundary.
// Clock timestamps determine round identity; candle opens are usable only
// when their own kline start matches that identity.
export const FIVE_MINUTES_MS = 300000;
export function marketRoundClock(marketTimeMs, klineStartMs = null) {
  if (!Number.isFinite(marketTimeMs)) throw new TypeError('INVALID_MARKET_TIME');
  const start = Math.floor(marketTimeMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  return {
    start,
    end: start + FIVE_MINUTES_MS - 1,
    roundOpenAligned: Number.isFinite(klineStartMs) && klineStartMs === start,
  };
}
export function minuteOpenAligned(marketTimeMs, minuteKlineStartMs = null) {
  return Number.isFinite(marketTimeMs) &&
    Number.isFinite(minuteKlineStartMs) &&
    minuteKlineStartMs === Math.floor(marketTimeMs / 60000) * 60000;
}
