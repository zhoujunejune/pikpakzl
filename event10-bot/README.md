# EVENT10 · DeepSeek 10-minute event contract analysis

Status: CODE REVIEW / NOT DEPLOYED / NO LIVE ORDERS.

This independent prototype adds a BTCUSDT 10-minute analysis cadence with a
DeepSeek decision (UP, DOWN, or WAIT), persistent signal history and a
mobile-friendly dashboard. It never uses Binance signed order endpoints and
never submits an order.

## Critical platform limitation

Binance's event-contract FAQ (updated May 2026) explicitly says Event
Contracts are available only in the Android and iOS app and do not
offer an official order API:
https://www.binance.com/zh-CN/support/faq/detail/172247f1c4b8401ab106fb63900f3825

The 10-minute event-contract expiry is anchored to the actual confirmed
opening time, not necessarily a fixed Unix ten-minute clock. This prototype
runs ten-minute analysis cycles only; it must not present those as official
event contracts or their settlement windows. Event contract index prices,
payout quotes, positions, official outcomes and win-rate are unknown.

Do not re-purpose a Binance perpetual futures endpoint to place event
contracts. Do not reverse-engineer restricted/private mobile API endpoints,
reuse app authentication tokens, automate the mobile app to bypass API limits,
or bypass regional restrictions.

## Architecture

- server.mjs: loopback-only Node 20+ HTTP server; GET endpoints only.
- panel.html: mobile-friendly standalone dashboard, auto-refreshing status.
- Reuses only the existing internal read-only BTCUSDT spot/public proxy
  endpoint http://127.0.0.1:13003/api/shadow-market-data.
- Uses the existing DeepSeek API contract (/chat/completions) with a
  separate 10-minute prompt, never the five-minute prediction outcome.
- Every analysis cycle starts on a Unix 10-minute boundary. Signals may be
  generated in the initial 5–180 seconds; up to three DeepSeek attempts with
  a WAIT option. One final direction is stored per cycle.
- History is on a separate local durable file (300 records maximum), never
  mixed into production prediction stats, nor counted as executed orders.
- All trading APIs, POST routes and real-auto-trading switches are
  intentionally absent. Response status always has
  autoTradingEnabled:false, executionAvailable:false.

## Developer run (non-production)

Use Node.js 20+ and run:

    node --test event10-bot/server.test.mjs
    EVENT10_STATE_FILE=/tmp/event10-test-history.json node event10-bot/server.mjs

Open http://127.0.0.1:13020/ from the host.

Configuration via server-side secrets (never commit secrets):

- DEEPSEEK_API_KEY: required for automatic DeepSeek analysis.
- EVENT10_DEEPSEEK_MODEL: optional, defaults to configured DEEPSEEK_MODEL
  or deepseek-flash.
- DEEPSEEK_API_URL: optional, defaults to official DeepSeek HTTPS endpoint.
- EVENT10_READONLY_FEED: internal read-only JSON BTC market data source.
- EVENT10_STATE_FILE: isolated writable persistent state path.
- EVENT10_PORT: loopback-only listener port, defaults to 13020.

Endpoints:

- GET / or GET /event10/: dashboard.
- GET /api/status: status, decision, and hard disabled trade capability.
- GET /api/history: signal log without invented official settlements.
- GET /healthz: lightweight health.

## Production deployment prerequisites

This PR deliberately does not change Alibaba Cloud Caddy routing,
GitHub Actions production deployments, DeepSeek production engine, existing
futures or prediction worker processes, or shared API key manager.

To surface a new /event10/ menu item on Alibaba Cloud, first install and
verify a separate event10 service and reverse proxy with the existing
Basic Auth, then update the existing read-only navigation bridge. Do not add
a live link before the service exists, and do not restart the trade workers.
Keep its DeepSeek key in a dedicated server-side environment file.

Before any change to real execution, verify an officially supported
Binance Event Contracts API, live quote/payout schema, account eligibility,
trade confirmation, idempotency/ambiguous-order reconciliation, and outcome
settlement. Until that occurs, no real order automation is possible here.
