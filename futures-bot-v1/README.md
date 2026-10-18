# ZL Futures Bot V1 (experimental)

A standalone trend-breakout Binance **USDT-M futures** bot for a 200 USDT experiment. This strategy has **not** demonstrated a positive expected return. It is not connected to the older EDGE/prediction-market system.

## Status

- Source code on feature branch only; **not deployed and not live trading**.
- MODE=paper by default. Uses real Binance public market data for paper simulated entries/exits, including an estimated taker fee; does not simulate exchange order-book fills or slippage. Paper results may be optimistic.
- MODE=live provides API integration, but should not be enabled without validating contract filters, account configuration, stop orders, recovery, journal, and Binance account/region permissions. It is **not yet production-certified**.
- Never paste exchange API secrets into GitHub or chat. Put them in Railway encrypted variables. Enable futures only, disable withdrawals, restrict IP if possible.
- Never work around Binance HTTP 451 or other geographic restrictions.

## Strategy

5-minute **closed-candle** breakout above prior 12 bars or below prior 12 bars, aligned with closed 1-hour EMA20/EMA50 trend; requires volume >1.3x prior 20-bar average. Stop distance = max(1.5 ATR14, 0.4% price), take-profit target = 1.8R. One position across BTCUSDT and ETHUSDT. No compulsory trades and no trade in the same bar twice. 30-min cooldown.

## Reference configuration (not profit forecasts)

| Setting | Default | Purpose |
|---|---|---|
| PAPER_BALANCE | 200 | Paper wallet start |
| MODE | paper | Live trading is gated |
| SYMBOLS | BTCUSDT,ETHUSDT | Allowed symbols |
| LEVERAGE | 10 | 1-20 supported |
| RISK_FRACTION | 0.015 | Target risk budget per position (excludes gap/slippage/fees) |
| MAX_MARGIN_FRACTION | 0.15 | Margin cap per position |
| MAX_DAILY_LOSS_FRACTION | 0.08 | Pauses new entries after mark-to-wallet loss |
| PAPER_TAKER_FEE | 0.0005 | Estimated per-side taker fee |
| LOOP_SECONDS | 30 | Polling |
| STATE_FILE | ./futures-state.json | Must be durable for live mode |
| KILL_FILE | ./KILL | File presence halts entries, does NOT guarantee liquidation/flatten |

Live-only safeguards:
- MODE=live
- ALLOW_REAL_TRADING=I_ACCEPT_REAL_TRADING
- BINANCE_API_KEY, BINANCE_API_SECRET
- DURABLE_STORAGE_CONFIRMED=YES and absolute STATE_FILE on durable volume.
- Assumes one-way (BOTH) Binance account mode and isolated margin.
- Exchange-side stop placed **before** take profit through 2026 USDT-M algo orders endpoint.
- If order state uncertain, **halts** instead of automatically repeating a live order.
- A **dedicated futures account or subaccount** is strongly preferred: this bot does not adopt pre-existing positions.
- Do not run multiple replicas or parallel bot instances against one account.
- The loop starts new positions only when the system has confirmed no existing owned position. Exceptions halt live entries until manual review.
- A one-way position with an absent stop triggers a best-effort emergency reduce-only market close. There is no guarantee this succeeds.

## Install (local only)

Run: pip install -r requirements.txt
Then: MODE=paper python bot.py

## Deployment and limitations

Do not deploy live unless an authorised human reviews and tests this implementation against Binance futures testnet. API permissions, regional restrictions, Binance symbol filters, minimum order sizes, order triggering, exchange server-side protective orders, network interruptions, partial fills and restart recovery can all prevent correct operation.

The initial version polls REST endpoints and has no live dashboard, mobile kill switch, notification system or complete accounting of all live executions/fees. Do not label it a production-ready unattended trading robot without adding those features.

Independent of leverage, with a 200 USDT wallet and a 1.5% target price risk, **3 USDT** is the approximate planned *price-based* loss per trade before fees, slippage, gaps and liquidation. 20x leverage does not make that a guaranteed maximum.

Source: [Binance USD-M trading API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

## 2026-10-18 audit (do not use live)

- Render free Singapore service `zl-futures-bot-v1-paper` deployed successfully but Binance USDT-M REST access returned **HTTP 418** with `Retry-After: 103412`. The engine now **stops** on 418/429/451; no IP rotation, repeated probing or access restriction circumvention.
- Read-only Binance futures candlesticks (2026-10-03 through 2026-10-18) were used for an **illustrative** strategy backtest with a 200 USDT starting wallet *for each symbol separately*, 10x position cap, 0.05% per-side fees and 0.03% per-side assumed adverse slippage.
- BTCUSDT: 42 closed, 14 profitable, estimated 180.40 USDT ending balance, **-19.60 USDT**.
- ETHUSDT: 53 closed, 17 profitable, estimated 173.94 USDT ending balance, **-26.06 USDT**.
- Those exploratory results are not independently audited and omit funding, liquidation, exchange order quantity constraints and some opening-bar fill complexities. They **do not establish profitability** and are a reason to **not** authorize live execution with this prototype.
- Free Render web services sleep after inactivity and discard local files on redeploy; **no durable 24/7 production order manager is possible with this exact setup**.
- No authenticated Binance futures account/permission probe was completed: the Render connector does not expose the existing secret environment variables and the separate new service does not inherit them.
