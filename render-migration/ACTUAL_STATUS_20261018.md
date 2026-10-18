# Render actual migration state — 2026-10-18 02:17 UTC

## Created in connected Render workspace
Workspace: `tea-db8509mq1p3s739jsnr0` / My Workspace. Region: `singapore`. All created with explicit `free` plans; automatic deploys off.

1. **V3** `srv-dba2jtom7kps73f7nv60` https://zl-signal-v3-migration.onrender.com — deployment live. BTCUSDT WebSocket connected. Outbound IPv4 read-only check: 74.220.52.132. No trade credentials.
2. **V2** `srv-dba2m7vbtjjs73di4hbg` https://zl-signal-v2-migration.onrender.com — Docker build live, tracker starts and reaches the V3 origin. Fresh ephemeral history; no real legacy archive transfer or persistent Redis. Official results unavailable without credentials.
3. **Trade panel** `srv-dba2mfdg1s2s73ahpt60` https://zl-trade-panel-migration.onrender.com — live after branch-only portable wrapper path patch. Inner trade-control started. V2 stats origin success and WebSocket connected. Explicit `AUTO_CONFIRM_ENABLED=false` and no Binance trading keys. Redis settings and live order readiness are deliberately incomplete.
4. **Free preview Key Value** `red-dba2lsnavr4c73ftv16g` / `zl-migration-preview-kv` — available but **not connected** to V2/panel. Its actual connection URI isn't returned by the connector and must be privately configured through Render. It is volatile and must never be trusted for actual order deduplication, risk state, ledger or settlement persistence.
5. Existing Render network probe `srv-db9rmbe1egvs738cs8sg` remains untouched.

**Not created:** collector. Railway's collector runs a base64-encoded program and relay stored in Railway environment variables. The current Railway connector gives variable *names only*; it cannot export source bundles or secrets. `render-migration/collector/index.mjs` will load them once moved via private environment configuration.

## Read-only network results, from Render V3 deployment logs
- Binance Spot REST `api.binance.com/api/v3/time`: HTTP **418**, exchange code **-1003**
- Binance Data REST `data-api.binance.vision/api/v3/time`: HTTP **418**, code **-1003**
- Binance Futures REST `fapi.binance.com/fapi/v1/time`: HTTP **200**
- Binance Prediction unauthenticated REST: HTTP **400**, code **-2014** (reachable but no valid credentials; not proof of trading authorization)
- Binance Spot WebSocket: connected
- Cloudflare EDGE status: HTTP **200**, model `EDGE_5M_V1`, `readOnly:true`, `orders:false`, `productionIntegration:false`, training samples **23**. EDGE is **not** an authorized production execution path.

## Blocking conditions for actual production cutover
- Restore the original Railway V2 persistent volume and Redis state to a **durable** destination with independently verified checksums, preserving order IDs and round settlement ledger.
- Provide connected Render secret configuration, including source of collector, appropriate production origin URLs, and actual Redis URL through a private secret UI. No credential values in GitHub or this markdown.
- Investigate HTTP 418 and verify the **authenticated** Binance Prediction market/settlement endpoints in read-only mode before any write attempts.
- Resolve the Free plan's idle spin-down, 750 shared instance-hours/month, volatile Key Value and free Postgres's 30-day expiration; **do not** silently upgrade or enable payment.
- Validate each production stage separately: latest real Cloudflare direction, stored lock, selected model configuration, effective order mapping, quote, submission and independently confirmed Binance fill.
- The preview services are **not trading-ready**. No real-money order was submitted by the migration tests.

## Git details
Migration branch: `migration/render-blueprint-20261018` (PR #167). The original Railway services are not edited/deleted. The earlier Render Blueprint in `render.yaml` is a design reference and **must not be applied** because the preview resources were created explicitly, under new names. Synchronizing that older YAML can create duplicates. Render service settings currently managed through the Render API calls.
