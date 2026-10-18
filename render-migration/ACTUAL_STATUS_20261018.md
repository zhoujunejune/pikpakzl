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


## PIN-protected access — 2026-10-18 04:01 UTC

- Connected Render owner configured a Binance Prediction API pair on the existing panel, without sharing it in GitHub or this document. The first redeploy failed because `render-preview-seed.mjs` disallowed any keys. Fixed the guard to permit a complete pair while preserving preview-only execution shutdown.
- PIN access has been implemented **server-side** in `render-preview-auth.mjs` behind the Render public HTTPS URL. Only a SHA-256 hash is stored in Render `RENDER_PANEL_LOGIN_PIN_SHA256`, plus a separate high-entropy HMAC session secret in `RENDER_PANEL_SESSION_SECRET`. **Do not store plaintext PIN in source or logs.**
- Secure `HttpOnly` `SameSite=Strict` cookie, 8-hour session, login throttling; logout action. Unauthorized frontend requests redirect to `/auth/login`; unauthenticated data/API requests return HTTP 401. Only minimal `/healthz` is public.
- PIN-authenticated `/api/status` now shows real read-only Prediction balance; anonymous response never includes account data. The public gateway still rejects every state-mutating route with HTTP 403 in preview mode, irrespective of PIN, so logging in does **not** enable order submission.
- Deploy `dep-dba48l7btjjs73dns7ng` is **live** with smoke log `render_pin_gateway_smoke ok:true,anonymousFront:303,anonymousStatus:401,login:200,health:200`.
- Binance balance query succeeded with **3 account options**, but values are deliberately omitted from logs.
- No live trading action was made. Remaining blockers: real settlement history and Z3 source migration, official settlement `PREDICTION_TOPIC_NOT_FOUND`, Render Free reliability and durable funds/order state.


## 2026-10-18 Cloudflare API owner-authorized repair: EDGE verified, breakout deferred

- Cloudflare account owner supplied temporary API token and account id exclusively in Render V3 encrypted environment. No token or secret printed or committed.
- Audited `edge-5m-v1` and `breakout20-shadow` with authenticated GET-only API. Both retain their original SQLite Durable Object namespace bindings (`EDGE5`, `BREAKOUT20`). Both still had Railway origins. Script and source map SHA-256 prefixes checked before any change.
- Deployed **only one precise URL modification** to the existing `edge-5m-v1` script via Cloudflare official `PUT /workers/scripts/edge-5m-v1/content`: settlement `OFFICIAL_URL` from `https://signal-diagnostic-v2-production.up.railway.app/api/round-stats` to `https://zl-signal-v2-migration.onrender.com/api/round-stats`. Source map URL updated too. Model algorithm, 8-second cutoff, CF compatibility date and `EDGE5` binding unchanged. After-code SHA prefix `25bfbaa1b01c719c`.
- **Live independent proof at 2026-10-18 05:30:59 UTC**: Cloudflare `training.samples` increased **23 → 31 (+8 official validated rounds)**; `health.officialError` changed from old Railway HTTP 404 to `null`, `lastOfficialAt` refreshed, recent previous pending predictions acquired exact-round OFFICIAL UP/DOWN labels, SQLite persisted. This validates repair, not a win-rate claim or calibration. 5000 labeled samples are required for model calibration; execution still ineligible.
- Do **not** switch `breakout20-shadow` market origin yet. Render V3 `/api/shadow-market-data` responds HTTP **503** with `WS_WARMING_UP_0_OF_35` for both 1m and 5m after restart. Replacing its dead Railway URL with an unready Render source would not fix predictions and violates the requirement to ensure fresh, complete history first.
- An additional public Binance Spot WebSocket API `klines` historical query through `wss://ws-api.binance.com:443/ws-api/v3` was independently tested from Render V3 and returned **HTTP 418** on upgrade; do not retry on the banned shared egress. The already-connected Spot market WebSocket remains the only verified real-time spot Kline stream.
- **Real trading remains OFF**. Render Free startup/idle/ephemeral state limitations persist. Cloudflare API Token should be revoked in Cloudflare after both Worker changes are complete.
