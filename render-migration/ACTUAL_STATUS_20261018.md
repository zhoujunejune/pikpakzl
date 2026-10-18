# Render actual migration state — 2026-10-18 03:07 UTC

## Created in connected Render workspace
Workspace: `tea-db8509mq1p3s739jsnr0` / My Workspace. Region: `singapore`. All created with explicit `free` plans; automatic deploys off.

1. **V3** `srv-dba2jtom7kps73f7nv60` https://zl-signal-v3-migration.onrender.com — deployment live. BTCUSDT WebSocket connected. Outbound IPv4 read-only check: 74.220.52.132. No trade credentials.
2. **V2** `srv-dba2m7vbtjjs73di4hbg` https://zl-signal-v2-migration.onrender.com — Docker build live, tracker starts and reaches the V3 origin. Fresh ephemeral history; no real legacy archive transfer or persistent Redis. Official results unavailable without credentials.
3. **Trade panel** `srv-dba2mfdg1s2s73ahpt60` https://zl-trade-panel-migration.onrender.com — live after branch-only portable wrapper path patch. Inner trade-control started. V2 stats origin success and WebSocket connected. Explicit `AUTO_CONFIRM_ENABLED=false` and no Binance trading keys. Render Key Value is now connected in free preview. Model choice is ready and direction policy has been initialized to six `OFF` choices. Binance credentials are absent and automatic order confirmation remains disabled.
4. **Free preview Key Value** `red-dba2lsnavr4c73ftv16g` / `zl-migration-preview-kv` — available and **connected** to V2/panel with its unauthenticated Render-internal DNS URL (only same-region internal networking, external connection disabled). Verified `locked_signal_redis_ready` on V2 and `locked_signal_redis_subscriber_ready` on panel. It is volatile and must never be trusted for actual order deduplication, risk state, ledger or settlement persistence.
5. Existing Render network probe `srv-db9rmbe1egvs738cs8sg` remains untouched.

**Not created:** collector. Railway's collector runs a base64-encoded program and relay stored in Railway environment variables. The current Railway connector gives variable *names only*; it cannot export source bundles or secrets. `render-migration/collector/index.mjs` will load them once moved via private environment configuration.

## Read-only network results, from Render V3 deployment logs
- Binance Spot REST `api.binance.com/api/v3/time`: HTTP **418**, exchange code **-1003**
- Binance Data REST `data-api.binance.vision/api/v3/time`: HTTP **418**, code **-1003**
- Binance Futures REST `fapi.binance.com/fapi/v1/time`: HTTP **200**
- Binance Prediction unauthenticated REST: HTTP **400**, code **-2014** (reachable but no valid credentials; not proof of trading authorization)
- Binance Spot WebSocket: connected
- Cloudflare EDGE status: HTTP **200**, model `EDGE_5M_V1`, latest status `LOCKED`, `readOnly:true`, `orders:false`, `productionIntegration:false`, training samples **23** at last probe. EDGE is **not** an authorized production execution path.
- Cloudflare Breakout20 status: HTTP **200** but latest status **`DATA_GAP`**, with no valid current predicted direction; explains Render V2's missing original production locks.
- Render internal read-only HTTP checks: `/api/order-signal-model` 200 and ready, `/api/direction-mode` 200 and ready, `/api/shadow-breakout20/edge-5m` 200, `/api/status` 200 and ready. Preview has all UP/DOWN source-side modes `OFF` and auto confirmation disabled. No real orders.

## Blocking conditions for actual production cutover
- Restore the original Railway V2 persistent volume and Redis state to a **durable** destination with independently verified checksums, preserving order IDs and round settlement ledger.
- Provide connected Render secret configuration, including the Railway collector program and Binance keys through secure environment controls. Production origin URLs and a **durable** Redis/deduplication store still need a separately tested cutover. The current free Key Value is ONLY a preview cache. No credential values in GitHub or this markdown.
- Investigate HTTP 418 and verify the **authenticated** Binance Prediction market/settlement endpoints in read-only mode before any write attempts.
- Resolve the Free plan's idle spin-down, 750 shared instance-hours/month, volatile Key Value and free Postgres's 30-day expiration; **do not** silently upgrade or enable payment.
- Validate each production stage separately: latest real Cloudflare direction, stored lock, selected model configuration, effective order mapping, quote, submission and independently confirmed Binance fill.
- The preview services are **not trading-ready**. No real-money order was submitted by the migration tests.

## Git details
Migration branch: `migration/render-blueprint-20261018` (PR #167). The original Railway services are not edited/deleted. The earlier Render Blueprint is preserved only in `render-migration/render-blueprint-reference.yaml` (root `render.yaml` was removed to prevent duplicate resource creation). This reference must not be applied because the actual preview resources were created explicitly, under new names. Render service settings currently managed through the Render API calls.


## Binance HTTP 418 mitigation — 2026-10-18 03:15 UTC

- Binance Spot REST and data REST returned HTTP 418 / error `-1003` from the Singapore Render outbound IP `74.220.52.132`. Binance documentation describes 418 as an IP rate-limit ban; its original source is unconfirmed (potentially shared egress). This is **not** an HTTP 451 region restriction.
- Render V3 startup now **skips** Spot REST historical 1s K-line / aggregate-trade warmup in `RENDER_MIGRATION_PREVIEW=true` mode. It waits for authentic BTCUSDT spot WebSocket ticks instead; no manufactured data and a warm-up gap is expected.
- Render V3's read-only network preflight now skips all 4 Binance REST probe calls by default (`BINANCE_REST_PREFLIGHT=false`), retaining only Cloudflare status checks. Panel's startup Spot REST ping is also opt-in only.
- Signed read-only Binance Prediction `GET` requests in V3 now record cooldown and honor the `Retry-After` header or the message's IP ban-until timestamp upon HTTP 429/418. During cooldown they return a blocked result rather than retrying.
- Deployed V3 and panel, both reports **live**. V3 confirmed log events `render_binance_rest_probes_config enabled:false skipped:4`, `spot_rest_history_bootstrap_paused`, and `binance_ws_connected`. Panel model/direction/EDGE/status read-only routes remain HTTP 200 and model config ready.
- **This does not lift an already-active Binance IP ban**; the actual Retry-After was not captured by earlier probes. Do not assume Spot REST, Binance Prediction signed authorization or real-money orders are restored. No live trading credentials were entered and no real orders were placed. A single read-only probe can be considered **only after the ban interval**; ongoing probing is disabled.
- These fixes are limited to the separate Render migration branch, and don't modify Railway deployment, Cloudflare models, official settlement ledger or Binance order execution logic.
