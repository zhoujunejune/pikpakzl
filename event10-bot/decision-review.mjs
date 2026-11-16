// Compact V5 quality notes only; never a directional override or trained model.
import {compactEvidence,COMPACT_VERSION} from "./compact-evidence.mjs";
export const REVIEW_VERSION=COMPACT_VERSION;
export function buildDecisionReview(session){
 const d=compactEvidence(session);
 const warnings=[];
 const p=d.shortPriceTrend,t=d.fifteenMinuteContext,c=d.continuousFlow10m,s=d.shortFuturesPriceResponse;
 const zone=d.priceStructure;
 if(zone?.confirmedThreeBarBreakout==="UP"&&t?.trend==="DOWN")
  warnings.push("BREAKOUT_VS_HIGHER_TREND: confirmed 1m upside breakout contrasts with 15m futures background");
 if(zone?.confirmedThreeBarBreakout==="DOWN"&&t?.trend==="UP")
  warnings.push("BREAKOUT_VS_HIGHER_TREND: confirmed 1m downside breakout contrasts with 15m futures background");
 if(zone?.lastThreeClosedBarsTrend==="MIXED")
  warnings.push("NO_PERSISTENT_SHORT_TREND: recent closed 1m bars did not keep a consistent direction");
 if(t?.rsi14<=30)warnings.push("OVERSOLD_REVERSAL_RISK: 15m RSI low; a 10-minute rebound and continued fall both remain plausible");
 if(t?.rsi14>=70)warnings.push("OVERBOUGHT_PULLBACK_RISK: 15m RSI high; an upside extension and pullback both remain plausible");
 if(t&&p){
  if(t.trend==="DOWN"&&p.last5mPct>0)
   warnings.push("TIMEFRAME_TREND_CONFLICT: short reference trend rising, 15m futures trend down");
  if(t.trend==="UP"&&p.last5mPct<0)
   warnings.push("TIMEFRAME_TREND_CONFLICT: short reference trend falling, 15m futures trend up");
 }
 if(s&&s.sampledNetTakerUsd<0&&s.sameInstrumentPriceMovePct>.02)
  warnings.push("POSSIBLE_SELL_ABSORPTION: sell pressure but price rose on same futures sample; not proof of reversal");
 if(s&&s.sampledNetTakerUsd>0&&s.sameInstrumentPriceMovePct<-.02)
  warnings.push("POSSIBLE_BUY_ABSORPTION: buy pressure but price fell on same futures sample; not proof of reversal");
 if(c&&s&&((c.takerBuyFraction<.4&&s.takerBuyFraction>.6)||
            (c.takerBuyFraction>.6&&s.takerBuyFraction<.4)))
  warnings.push("FLOW_WINDOWS_DISAGREE: 10m flow and short sample diverge; they overlap and must not be treated as independent votes");
 for(const item of d.limitations.missingVerifiedSections)
  warnings.push("MISSING_"+item.toUpperCase()+": unavailable or insufficient verified observations");
 return {
  version:REVIEW_VERSION,
  purpose:"V6R1 preserves five curated evidence sections; consider failed-breakout and price-flow conflicts without automatic directional flips or double counting.",
  warnings,
  missingVerifiedSections:d.limitations.missingVerifiedSections,
  riskOfOverconfidentDecision:warnings.length>=3?"HIGH":warnings.length>0?"ELEVATED":"UNASSESSED",
  policy:"Always independently review UP and DOWN; never auto-reverse, auto-trade or pretend confidence is win probability"
 };
}
