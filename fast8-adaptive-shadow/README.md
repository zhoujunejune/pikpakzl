# ZL_FAST8_ADAPTIVE_SHADOW_V1 — independent research-only model

This is an isolated prospective **shadow** experiment, never a production signal source. It makes one UP/DOWN choice per five-minute calendar round, attempts durable publication by T0+8s, and aims to *measure* — not guarantee — a long-term 65% accuracy threshold.

- **Production impact:** NONE. This code exists only in its own folder on independent GitHub branch. It never calls any production write API, routes, Redis publisher or order endpoint. Keep PR #93 as a draft and do not merge to `main`.
- **Live data:** read-only public Binance BTCUSDT 1-minute candle snapshots, with `TREND`, `RANGE` and `HIGH_VOL` classification. This does not claim exchange 5s microstructure/order book features.
- **Outcomes:** only strictly round-matched internal official-source outcomes from the existing *read-only* V2 `/api/fast8-stats` API; not independently certified by a third party.
- **Mandatory choices:** persist each round's UP/DOWN direction (even when low quality) and log all missed or late rounds as failures; do not omit mandatory fallback losses.
- **Learning:** first training at 300 qualified timely settled snapshots; every 100 additional eligible samples or 50 on robust accuracy drift. Global and regime-specific L2 logistic candidates use chronological purged holdout testing and Brier guardrails. Rejected updates do not activate.
- **Rollback:** if 100 forward decisions by a learned model underperform their paired baseline by 6+ hits, disable the model; revert to baseline fallback.
- **Validation:** first 1000 consecutive five-minute calendar rounds, without reset or favorable selection. All 1000 must be published on time with official outcomes and at least 650 correct. No automatic promotion to real trading.
- **Timing:** process must remain online and PostgreSQL commits must succeed to meet the 8-second goal. This is a measured SLA target, not a guarantee on free infrastructure.

## Northflank free Developer Sandbox

See **[NORTHFLANK_FREE.md](NORTHFLANK_FREE.md)** for UI steps. Use `app-northflank.mjs` (configured in Dockerfile) and dedicated PostgreSQL addon. Environment: `DATABASE_URL` or `POSTGRES_URI`. PostgreSQL is the authoritative event journal, including predictions, settlements, model registrations and training results. Restart replays events from the database. Startup fails if database credentials are missing; no silent use of ephemeral files. CI builds the Docker image and tests the DB storage interface offline.

**Payment method restriction:** Northflank requires a payment method for every plan, including its free Developer Sandbox. Do not create a paid addon or volume; check $0 at every step. We cannot create the user account or attach a card.

## Local tests

```sh
cd fast8-adaptive-shadow
npm install
npm test
node --check app-northflank.mjs
```

Get health with `GET /healthz`, prediction through `GET /api/shadow/latest`, stats through `GET /api/shadow/status`. Only GET endpoints exist; no order/trading operations.

The older `app.mjs` is preserved as a local-file prototype and is **not used by the Dockerfile**. Do not deploy it on an ephemeral free instance: event history would be lost upon restart.
