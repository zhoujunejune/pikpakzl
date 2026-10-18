# Railway → Render: migration staging, NOT a production cutover

This branch stages an **unconnected Render Blueprint** for the same GitHub repo. It has not been executed in Render and does not modify Railway. The existing independent Cloudflare EDGE_5M_V1 Worker remains on Cloudflare. None of the Binance order-writing credentials have been migrated.

## Mapped services

| Existing Railway | Render Preview | Notes |
|---|---|---|
| trade-control-panel | zl-trade-control | Existing Node panel code; auto confirmation off for preview |
| signal-diagnostic-v2 | zl-signal-v2 | Existing round-tracker Docker build, Python ML deps |
| signal-diagnostic-v3 | zl-signal-v3 | Existing signal engine |
| z3-collector | zl-z3-collector | Needs original base64 bundle + SHA256 from Railway environment variables |
| Redis | zl-transient-kv | Free only; VOLATILE, NOT a production data store |

The Blueprint is `render.yaml`. Region is Singapore for all five resources; every resource explicitly uses `plan: free`. The Blueprint does **not** authorize a paid upgrade. It intentionally sets `autoDeployTrigger: off` and initial `AUTO_CONFIRM_ENABLED=false` for the trade control panel.

## Important blockers — do not switch live trading

1. **Not always-on:** Render Free offers 750 instance-hours/month per workspace, not per service. Four 24/7 web services would need roughly 2,880–2,976 hours/month. Idle free web services spin down after 15 minutes without qualifying traffic. Free capacity is not suitable for 24/7 production trading.
2. **Persistence:** The current Railway Redis and V2 `/data` volumes contain persistent records. Free Render Key Value loses its content on restart, and free web services have no persistent disks. V2 history in this preview is under `/tmp` and is *not* a replacement for the original settlement ledger, deduplication state, order lock state or audit evidence. Back up Railway /data and Redis before cutover; confirm a durable storage destination first.
3. **Undisclosed environment values:** Railway OAuth integration supplies only the variable *names*, not the contents. The collector's executable `Z3_COLLECTOR_CODE_BASE64` + `Z3_COLLECTOR_CODE_SHA256` are not in GitHub and must be copied privately into Render. Transfer per-service env variables and secret values directly to Render's environment UI. Never paste Binance credentials, PIN hashes, wallet secrets, base64 source or Redis URLs in chat or GitHub.
4. **IP and market access:** Render Singapore region does not guarantee permission to call all Binance endpoints. Independently check real outbound IP and Binance HTTP responses. HTTP 451 blocks a required route even when every health check returns 200.
5. **EDGE model readiness:** The current Cloudflare EDGE response is declared read-only in the codebase; model direction and model selection are not proof of real Binance order submission, fill or confirmed official settlement. Confirm each stage separately. Retain existing order safeguards until proven safe.

## Required setup before live deployment

- Connect Render to ChatGPT, or sign in to https://dashboard.render.com and authorize `zhoujunejune/pikpakzl` with the Render workspace.
- Render Blueprints can be created using the custom Git branch `migration/render-blueprint-20261018`, file path `render.yaml`.
- **Preview only:** do not activate auto-follow / automatic order confirmation. Verify that new Render endpoints return health `/healthz` before anything involving money.
- Set `SIGNAL_ORIGIN` (V2 → V3), `ROUND_STATS_ORIGIN` and `ROUND_STATS_PUBLIC_ORIGIN` (panel → V2), `SIGNAL_WS_URL` (panel → V2 WebSocket), `SITE_ORIGIN` (collector target). Use only the actual Render hostnames; avoid stale railway.app endpoints.
- Review *all* environment variable names from current Railway deployments; Blueprint contains only a minimal bootstrap subset and is **not** full configuration parity.
- Set the collector source bundle and checksum in Render secret variables. The code intentionally fails startup if source is missing or SHA256 mismatches.
- Before switching UI/domain, export and restore V2 history, Redis state, training epochs and the durable order/settlement ledger. Compare counts and checksums.
- Verify Cloudflare status, feed timestamps, 5-minute lock timing, model selection on the panel, Binance market read results, order state transitions and original fill/order IDs using read-only endpoints. Do not place a new real-money test order.
- Only after an independent durable store, usable free/paid capacity that you explicitly accept, and a confirmed Render egress path exist should any real Binance trading credential be enabled and a controlled cutover considered.
- Do not stop Railway or delete its volumes before all verification succeeds.

## Current status

- [x] Railway configuration and service-to-service dependencies inspected
- [x] Render staging configuration written in a separate GitHub branch
- [x] Render collector bootstrap written; source bundle not available in repo
- [ ] Render app connected and Render resources actually created
- [ ] All secrets/configuration transferred
- [ ] History, Redis state and order records migrated into durable storage
- [ ] Render egress / Binance 451 verified
- [ ] Cloudflare EDGE actual signal response verified from Render
- [ ] Read-only exchange order ID/fill reconciliation complete
- [ ] Production cutover complete

Official docs: https://render.com/docs/free ; https://render.com/docs/blueprint-spec ; https://render.com/docs/migrate-from-railway .
