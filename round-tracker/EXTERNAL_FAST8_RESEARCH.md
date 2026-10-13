# External BTC 5-minute FAST8 microstructure research

This implementation is **inspired by public research projects**; it is an
original, lightweight JavaScript *research proxy*, **not** a copy of their
trained model weights and **not** a 62%, 65%, 75%, or 85% proven win-rate
strategy. No unverified probabilities are presented as calibrated.

## Public source comparison

- [Yash Vaidya/BTC-microstructure-signal-detection](https://github.com/yashvaidya42/BTC-microstructure-signal-detection)
  (MIT license) reports 54/87 independent non-overlapping live samples
  (62.07%) during one 7.43-hour session; its actual XGBoost training
  features, fitted scaler, and 15-minute startup history cannot be
  reproduced from this repo's frozen FAST8 17-feature payload as-is.
- [HorseDev77/bitcoin_price_up_down_prediction_5minute](https://github.com/HorseDev77/bitcoin_price_up_down_prediction_5minute)
  (package metadata: ISC) provides a TypeScript microstructure workflow
  using CVD, order-book imbalance, regime and VWAP/OI; its original
  decision includes NO_TRADE and it has **no independently documented 5m
  full-coverage win rate**.
- [sfeirc/Short-Horizon-Price-Direction-5-min-from-LOB-Microstructure](https://github.com/sfeirc/Short-Horizon-Price-Direction-5-min-from-LOB-Microstructure)
  (MIT license) reports 85% after selecting only 12.7% of raw rows
  based on future-horizon labels, and negative PnL after transaction
  costs; this statistic **cannot** be transplanted into mandatory
  binary decisions at T+8s. No model weights from that source are used.
- [FreqAI](https://github.com/freqtrade/freqtrade/blob/develop/docs/freqai.md)
  provides retraining infrastructure, not a 65% accuracy guarantee;
  loading the entire Python stack into the existing Railway 1 GB
  service is not appropriate.

## What is implemented

`external-btc5m-fast8-shadow.mjs` outputs **three immutable
UP/DOWN directions**, all on the FAST8 worker's **same frozen 1.5s
feature snapshot**, published in the existing worker's ~T+2s decision:

- `FLOW_BOOK_PROXY_V1`: momentum + trade-flow + orderbook imbalance
- `MEAN_REVERSION_FLOW_PROXY_V1`: round-open deviation + mean reversion
  with flow confirmation
- `REGIME_SWITCH_PROXY_V1`: switch by the *pre-lock* trend/regime signs

Flow uses the existing spot trade pressure as a **CVD proxy** and depth
OFI as an **order-book imbalance proxy**. Open interest and VWAP are
not present in current FAST8 features and are **not fabricated**.
Likewise this pipeline uses Binance spot observations against the
user's Binance Prediction binary settlement, not another provider's
market label.

**Always UP/DOWN while worker is healthy**; no extra training process,
network call or separate Railway instance. Missing data forces a
marked baseline/no-information fallback. Every decision is journaled
with the existing immutable round record before settlement.

The existing worker's published direction, Redis lock, order routing,
stop-loss, take-profit, prediction-market settlement and all production
risk controls remain **unchanged**. External research predictions
are always `productionEffect=NONE_SHADOW_ONLY`,
`executionEligible=false`, `autoPromotion=false`.

Statistics: `GET /api/fast8-stats` adds
`externalResearch.models.<id>` and `windows[100].externalResearch`.
This reports raw accuracy including fallback, timely accuracy, complete
calendar coverage, current-quality-only subgroup and matched-sample
production baseline. All percentages start with **new prospective
rounds after this deployment**, never retroactively backfill the
existing 350+ historical predictions. No claim of independent Binance
settlement certification is made.

No change to the model's current ~49% hit rate should be expected
on deployment; measured improvement needs frozen official future
outcomes and independent evaluation.

## Test / rollback

`node --test round-tracker/external-btc5m-fast8-shadow.test.mjs round-tracker/fast8.test.mjs`

Rolling back the importing commit removes computation; old immutable
journal fields remain valid and only archival. No new Railway service
or paid resource is required.
