# FAST8 sole active external BTC5m strategy

## Live routing
From this deployment forward, the single **active** model is
`FLOW_BOOK_PROXY_V1`. Its one UP/DOWN prediction is computed in the
existing FAST8 worker at ~T+2s and enters the production lock through
`selectExternalFast8Production()`. This uses the user's existing
Binance Prediction 5-minute round IDs and the original frozen market
snapshot, without network calls or separate paid infrastructure.

The FLOW_BOOK score combines order book OFI, 15s/60s trade pressure
(proxy for cumulative volume delta), short-term micro/current/trend
scores, normalized momentum and PM midprice, with fixed published
weights. The signal does **not** contain a fitted third-party model.
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
