# Cloudflare Workers → Render origin cutover checklist (2026-10-18)

**STATUS: NOT DEPLOYED TO CLOUDFLARE.** This document never changes a live Worker.
The current GitHub and Render plugins cannot edit Cloudflare Worker code/settings or existing Durable Object state.

## Verified root causes

- `breakout20-shadow` returns `DATA_GAP` and `RAILWAY_MARKET_HTTP_404`. The old Railway V3 origin is broken.
- `edge-5m-v1` uses a persisted SQLite Durable Object; recent predictions keep locking, but official labels do not advance. `health.officialError` is `HTTP_404_signal-diagnostic-v2-production.up.railway.app`.
- At 04:26 UTC the Cloudflare EDGE status showed **63** rounds with locked predictions, **40** official-pending, **23** officially labeled, `training.required=5000`, `executionEligible=false`. Also reported intermittent `BYBIT_RECENT_TRADES_STALE`.
- Render V2 official read-only `GET /api/round-stats` responds HTTP 200, `ok=true`, with 19 currently available records and 13 verified official records. This **does not** prove all 40 older pending Cloudflare rounds can be backfilled; matching round IDs and evidence are necessary.
- Render V3 `GET /api/shadow-market-data` now prefers **authentic** closed BTCUSDT 1m/5m Binance Spot WS klines. Its model's rolling 5m candles require at least 35 contiguous periods (roughly 175 minutes of real market uptime) after restart. Prior to warmup this API correctly returns 503, not fabricated rows.

## Target origins (cut over only after the endpoints have healthy validated data)

- Cloudflare `breakout20-shadow` old `signal-diagnostic-v3-production.up.railway.app`: replace with `https://zl-signal-v3-migration.onrender.com` and fetch `/api/shadow-market-data`.
- Cloudflare `edge-5m-v1` old `signal-diagnostic-v2-production.up.railway.app`: replace with `https://zl-signal-v2-migration.onrender.com` and fetch `/api/round-stats`.
- Do not modify the trained-feature definitions, lock cutoff, official-label proof requirements, observed UTC timestamps or upstream order permissions.
- Do not treat an HTTP 200 alone as market health: validate `ok`, candle sample counts, freshness, round boundaries and official settlement evidence.
- Do not reset SQLite Durable Object history or redefine previous real outcomes. Resume forward-only sample accrual and backfill **only exact-round, separately verified official settlements**.

## Verification after connecting Cloudflare deployment access

1. Obtain authorized access to Workers `breakout20-shadow` and `edge-5m-v1` and inspect live source/settings before applying any code edits. Avoid changing other Workers.
2. Verify Render V3 actually returns HTTP 200 with fresh, complete, contiguous 1m and 5m candles. Free Web services may sleep and their in-memory warmup disappears after restarts. If that cannot be guaranteed, use durable market history rather than force `ok=true`.
3. Verify Render V2 `/api/round-stats` settled evidence covers expected `roundStartMs` values, returns official UP/DOWN and preserves provenance.
4. Change both Workers' upstream origins, preserving previous Durable Object object IDs/migrations, schedules and datasets. Re-deploy one at a time and verify GET `/status`.
5. For EDGE verify `health.officialError=null`, last official poll recency, sample count growth, `recent[].actual` exact matches; `health.marketError` must not be ignored if persistent.
6. EDGE calibration threshold remains 5000 **real labeled** rounds. 5000×5 minutes ≈17.36 days, before gaps. Do not bypass this as an accuracy guarantee.
7. Do not enable real Binance trade execution until a durable per-account-per-round order ledger is actually integrated and reconciliation tested. Design-stage SQL is at `render-migration/durable-order-intents.sql`, **not deployed**.

## Unresolved Render Free production constraint

Current Render Free has three web instances (panel, V2, V3) sharing **750 instance-hours/month**, which cannot sustain 3×24/7. Free web services may idle-sleep and restart, and Free Key Value loses all state on restart. Neither a web-side PIN nor Cloudflare signal training storage is a durable Binance order ledger. The order execution path remains disabled.
