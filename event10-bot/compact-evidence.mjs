// Intentionally minimal evidence fed to EVENT10 DeepSeek.
// Raw data and prior round history remain preserved for audit only.
export const COMPACT_VERSION="EVENT10_AI_PRICE_STRUCTURE_V6_20261024";
const finite=n=>typeof n==="number"&&Number.isFinite(n);
const n=v=>finite(v)?v:null;
export function compactEvidence(session){
 const f=session.features||{},e=session.enrichment?.features||{};
 const fifteen=e.fifteenMinute||{},rest=e.aggressiveFlow||{};
 const verified=session.continuousTradeFlow?.windows?.["600s"]||null;
 const last10=session.rollingTenMinutes||{};
 const structure=session.priceStructure;
 const validStructure=structure?.source==="SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES"&&
   Number.isSafeInteger(structure.lastClosedCandleAt)&&
   structure.lastClosedCandleAt<=session.openedAt&&
   session.openedAt-structure.lastClosedCandleAt<=120000;
 const sameRest=rest.verifiedPriceResponse===true&&finite(rest.futuresPriceMovePct)&&
   finite(rest.takerBuyFraction)&&Number(rest.tradeSpanMs)>=20000;
 const checks={
  proxyCandles:finite(f.momentum1m5Pct)&&finite(f.momentum5m15Pct)&&finite(f.atr1m14),
  verifiedPriceStructure:validStructure,
  fifteenMinute:finite(fifteen.ema9)&&finite(fifteen.ema21)&&finite(fifteen.rsi14),
  fullTenMinuteFlow:!!verified&&verified.complete===true&&
    finite(verified.buyFraction)&&finite(verified.netTakerNotionalUsd),
  shortSameMarketResponse:sameRest
 };
 const missing=Object.keys(checks).filter(k=>!checks[k]);
 return {
  version:COMPACT_VERSION,
  forecastTarget:{priceSource:session.source,
    capturedAt:session.openedAt,horizonSeconds:600,
    referencePrice:session.openPrice,
    notOfficialBinanceEventSettlement:true},
  shortPriceTrend:checks.proxyCandles?{
    last5mPct:n(f.momentum1m5Pct),
    last15mPctFrom5mBars:n(f.momentum5m15Pct),
    rolling10mPct:n(last10.movePct),
    atr1mPrice:n(f.atr1m14),
    atr1mPct:finite(session.openPrice)&&session.openPrice>0?
      Number((100*f.atr1m14/session.openPrice).toFixed(5)):null,
    priceSource:"SAME_READONLY_REFERENCE_1M_5M_CANDLES"
  }:null,
  // Technical price zones share the SAME 1m bars with short momentum;
  // do not treat the two sections as statistically independent votes.
  priceStructure:checks.verifiedPriceStructure?structure:null,
  fifteenMinuteContext:checks.fifteenMinute?{
    trend:fifteen.ema9>fifteen.ema21?"UP":fifteen.ema9<fifteen.ema21?"DOWN":"FLAT",
    rsi14:n(fifteen.rsi14),
    source:"BINANCE_USDM_PERP_15M_CLOSED_CANDLES_NON_REFERENCE"
  }:null,
  continuousFlow10m:checks.fullTenMinuteFlow?{
    takerBuyFraction:n(verified.buyFraction),
    netTakerUsd:n(verified.netTakerNotionalUsd),
    groups:n(verified.observedGroups),
    source:"BINANCE_USDM_PERP_AGGTRADE_WS_600S"
  }:null,
  shortFuturesPriceResponse:checks.shortSameMarketResponse?{
    takerBuyFraction:n(rest.takerBuyFraction),
    sampledNetTakerUsd:n(rest.deltaNotionalUsd),
    sameInstrumentPriceMovePct:n(rest.futuresPriceMovePct),
    observationSeconds:Number((rest.tradeSpanMs/1000).toFixed(1)),
    source:"BINANCE_USDM_PERP_AGGTRADE_REST_SAME_SAMPLE"
  }:null,
  limitations:{
    missingVerifiedSections:missing,
    referencePriceNotComparableInAbsoluteTermsToFutures:true,
    latestStreamWindowOverlapsShortRestSample:true,
    priceStructureOverlapsShortPriceMomentum:true,
    subjectiveConfidenceIsNotCalibratedWinProbability:true
  }
 };
}