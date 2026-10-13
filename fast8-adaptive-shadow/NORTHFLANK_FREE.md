# Northflank free Sandbox deployment runbook

**Scope:** ZL_FAST8_ADAPTIVE_SHADOW_V1, isolated from all Railway production services.
This document intentionally does not require any trading credentials or Railway write permissions.

## Prerequisites and cost guardrails

1. Northflank [Developer Sandbox](https://northflank.com/docs/v1/application/billing/pricing-on-northflank) account.
   Northflank requires a payment method even for the free plan. If you cannot provide one,
   **stop**; there is no no-card bypass.
2. At each resource selection check the dashboard explicitly says **free / $0**.
   Free Sandbox grants 2 services, 2 jobs, 1 addon; not all plans, storage sizes or regions are free.
   **Do not** accept any charges, paid volumes, paid add-on sizes, or BYOC resources.
3. Connect GitHub account to Northflank; allow access to `zhoujunejune/pikpakzl`.
4. Use an isolated project, e.g. `zl-fast8-adaptive-shadow`, and a region with supported free compute.

## Persistent addon (must succeed before starting the service)

1. Create **PostgreSQL** addon named `fast8-shadow-db`. Choose the *free* addon
   resource profile if shown; if not, do not create a billable addon.
2. Keep addon network **private**. No publicly exposed database or admin account.
3. Under addon connection details, link its **non-admin** `POSTGRES_URI`
   or `DATABASE_URL` via Northflank secret group.
4. Set the variable name inherited by the shadow service to either
   `DATABASE_URL` or `POSTGRES_URI`. **Never paste credentials into GitHub.**
5. This database is the authoritative append-only event journal.
   Without it the app fails startup rather than silently lose experiment history.

## Isolated combined service

- New **Combined Service**: `zl-fast8-adaptive-shadow`
- Repository: `zhoujunejune/pikpakzl`
- **Branch: `feat/fast8-adaptive-shadow-isolated-20261012`**
- Build mode: Dockerfile
- Docker build context: `/fast8-adaptive-shadow`
- Dockerfile: `/fast8-adaptive-shadow/Dockerfile`
- Continuous build/deploy: watch **this branch only**. Do not link `main`.
- Service port: `3000` (HTTP), one instance, free-sized resources.
- Runtime variable: `PORT=3000`. Database variable from secret group.
- Healthcheck: GET `/healthz`; status: GET `/api/shadow/status`
- No production trading keys, Redis connections, PINs or order APIs.
- Do not mount/share a Railway volume; do not route production signals to this service.

## Acceptance checks after service deployment

1. Logs contain `adaptive_shadow_ready`, and healthcheck is `{"ok":true}`.
2. GET `/api/shadow/status` reports `productionEffect:"NONE_SHADOW_ONLY"`
   and `executionEligible:false`.
3. New round: `adaptive_direction_locked` is recorded once with UP/DOWN and
   actual full delay <=8000ms; report all missed/late rounds.
4. After >5 minutes the corresponding Binance official-source label is recorded
   by `adaptive_round_settled`; if source is blocked, **do not claim training**.
5. Restart service and verify previous predictions and first experiment round persist
   via PostgreSQL replay. If data resets, reject the run.
6. After 300 **valid, timely, officially labelled snapshots** inspect
   `adaptive_training_result` and out-of-sample evidence;
   do not confuse candidate acceptance with 65% forward accuracy.
7. Monitor rolling 100/300 and **the first 1000 consecutive calendar rounds**,
   *including mandatory fallbacks and missing/late rounds*.
8. Keep PR #93 a **draft** and do not merge this branch into main.

## Read-only external data

- GET public Binance BTCUSDT **1-minute candles**: not the native subsecond/5s order book.
- GET Railway V2 **read-only** `/api/fast8-stats` for matched settlement labels.
- If either is unavailable, health reports errors and training samples stop increasing.

**Limitations:** A free sandbox and network/database are not 100% uptime guarantees.
Hobby research should never be treated as a validated live-trading model. Target
65% long-run accuracy is not demonstrated or promised.
