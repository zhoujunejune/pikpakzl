# FAST8 sole active external BTC5m strategy

## Live routing
From this deployment forward, the single **active** model is
`FLOW_BOOK_PROXY_V1`. Its one UP/DOWN prediction is computed in the
existing FAST8 worker at ~T+2s and enters the production lock through
`selectExternalFast8Production()`. This uses the user's existing
Binance Prediction 5-minute round IDs and the original frozen market
snapshot, without network calls or separate paid infrastructure.

FLOW_BOOK V8 directly scores ONLY current-round regimeScore (weight 0.05)
and aligned predictionMarketUpMid (weight 0.03), normalized across present
valid inputs (62.5%/37.5% when both are present). Previous-round PREP60
collection and blending are REMOVED. A current-round snapshot with one
valid input is scored from that input only; two valid aligned inputs
are needed for full quality. With no current-round snapshot or no valid
input, the existing NO_INFORMATION fallback is visibly tagged and still
returns a binary direction (not a market forecast).
Retained upstream regimeScore may still contain INDIRECT OFI, trend, and
trade-pressure components: excluding them from the final score does not
eliminate their causal influence inside regimeScore. The signal does **not** contain a fitted third-party model.
Original inspiration: [HorseDev77/bitcoin_price_up_down_prediction_5minute]
(https://github.com/HorseDev77/bitcoin_price_up_down_prediction_5minute)
and [yashvaidya42/BTC-microstructure-signal-detection]
(https://github.com/yashvaidya42/BTC-microstructure-signal-detection).

At the last pre-deployment forward audit, FLOW_BOOK was 3 hits in
6 independent resolved rounds (50%). The original FAST8 had 4/6
on those same rounds; **there is no evidence the chosen candidate
outperforms the existing system**, much less meets 65%, 75% or 85%.
The user explicitly elected to switch despite these limitations.

## Guarantee boundaries
- The running worker freezes one UP/DOWN at approximately T+2s.
- If worker fails / primary candidate is unavailable at T+7s,
  the existing gateway makes a separately tagged no-information
  contingency UP/DOWN; this is not a verified prediction.
- Network outages, Railway restarts or insufficient clock resources
  mean the <=8s target is not physically guaranteed on every round.
- This implementation DOES NOT change order preparation, purchase
  API, take-profit, stop-loss, order sizing, account permissions or
  settlement logic.
- Alternative experimental flow/reversion/regime candidates were
  removed from *new calculations* and hidden on the trade panel.
  Older journal/settlement history remains immutable.
- The dashboard shows only the selected model's **post-switch**
  `productionModel === 'FLOW_BOOK_PROXY_V1'` predictions and the
  Binance Prediction official-aligned settlement results. No
  historical WIN/LOSS from other models is mixed in.
- `GET /api/round-stats.activeProductionModel.metrics` exposes
  signalRounds, settledRounds, hits, misses, accuracyPct,
  coveragePct, fallbackRounds. No validated probability/EV claim.

## Rollback & regression
The previous production FAST8 main-branch commit is preserved for
rollback. The previous durable prediction journals remain untouched.
`node --test round-tracker/external-fast8-primary.test.mjs
round-tracker/external-btc5m-fast8-shadow.test.mjs`

## 2026-10-13 live feed rollover optimization (V3_BRIDGE)
The upstream spot engine can briefly retain the previous five-minute round
label while its trade/depth streams have already advanced past the boundary.
Before T+1.5s, the FAST8 worker now admits these observations **only** when
fresh depth or trade activity proves a post-boundary event; it strips all old
contract price and prior-round-open-dependent inputs. The signal is explicitly
tagged as degraded and never counted as a fully verified current-round input.
An aligned current-round observation always replaces a bridge and cannot be
overwritten by a delayed previous-round label. Existing T+1.8s lock, T+8s
deadline, fallbacks, and order/TP-SL paths are unchanged. Forward performance
is tracked under a distinct model version and cannot be assumed improved.

## 2026-10-14 remove previous-round 60s preparation entirely (V8)
User-directed deletion of the live prewarm mechanism, including its
in-memory buffer, 70/30 blend, PREP60 status, old-snapshot fallback, and
associated obsolete files. Live prediction and timing shadows now score
only data whose event/source timestamp is in the current round. Current
BTC spot events reported with a delayed previous-round label remain
admissible only when their event timestamp and freshness prove they
occurred AFTER the current round opened. The old PM contract quote is
never accepted. Legacy prewarm fields report false/zero/null for schema
compatibility; V8 results are isolated from past version results.
The signal still uses the existing historical/no-information direction
fallback if no current inputs are available; such directions are not
predictive evidence. Inversion and order/TP-SL handling are untouched.

## 2026-10-14 score only regime and current-round PM midprice (V7)
User-directed removal of microScore, currentTrendScore, and
normalizedMomentum60s from the direct production score, leaving ONLY
regimeScore and predictionMarketUpMid. PREP60 becomes regime-only and
its readiness gate uses regimeScore sample count. The two-input model
accepts one live input as degraded evidence, with two aligned inputs
required for full quality; this preserves prewarm blending and NO WAIT.
New model version separates forward results from V6. Inverse order
direction, 8s lock, execution, amount, TP and SL are unchanged.
NO claim of improved 5m forward accuracy or guaranteed edge.

## 2026-10-14 remove direct 15-second aggressive flow and currentScore (V6)
Following V5, remove two further direct scoring terms: tradePressure15s
and currentScore. The preceding-minute snapshot removes tradePressure15s
and uses at least two populated features including microScore for readiness.
Preserve the prior decision timing, no-WAIT fallback, inverse execution,
order sizing, take-profit and stop-loss. Split forward performance by V6.
No claim that eliminating further inputs improves accuracy. Indirect upstream
composite dependencies are unchanged.

## 2026-10-14 remove direct OFI and 60-second flow weights (V5)
User-directed live and 60-second preparation score revision. New V5 version
keeps forward performance separate from V4 historical results. No changes
to Binance orders, inversion policy, 8-second signal lock, sizing or TP/SL.
Upstream composite indicators can still reflect the removed raw factors.

## 2026-10-13 round-clock, opening-price safety and timing shadow (V4)
A new BTC five-minute candle can lag the market event clock. The upstream
engine now assigns UTC five-minute round identity using market timestamps,
independently verifies the arriving five-minute/one-minute kline open, and
zeroes prior-candle-derived price contributions until matching opens arrive.
The FAST8 worker explicitly marks new-round opening-price absence, while
preserving safe spot order-flow, directional microstructure and momentum.
The original T+1.8s production freeze and T+8s hard deadline do not change.
It also journals immutable T+4s/T+6s SHADOW-ONLY directions after that freeze,
and compares them against the **same** officially settled rounds; these late
signals never route to production orders. Results are split by weak fixed-score
strength bands; these strength values are uncalibrated, not win probabilities.
The new V4 version resets the research-forward comparison window. None of this
establishes a 65% real trading edge; future activation of later timings or
retraining requires sufficient uncontaminated forward evidence.
