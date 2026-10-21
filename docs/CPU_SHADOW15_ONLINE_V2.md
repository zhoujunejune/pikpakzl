# CPU Shadow15 Online V2 — live deployment record

**Deployed (2026-10-21 UTC):** New isolated service \`zl-deepseek-shadow15-online.service\`, loopback **127.0.0.1:13044**, running independently of \`zl-prediction-deepseek5\`, the original \`zl-deepseek-shadow-online\` V1 (+30 seconds) and trading/futures.

## What really learns

A 14-weight **logistic regression model** that updates its numerical weights after independently verified official Binance Prediction 5-minute settlement. It is NOT DeepSeek Flash self-fine-tuning or downloaded DeepSeek LLM weights. It trains without any paid AI API. The production DeepSeek remains unchanged and retains the user-controlled follow switch.

One true market observation per round is captured **between +8s and strictly before +15s**, never later, using 1m/5m closed-candle features, market event timestamp and actual early-round opening reference. All features must be present and fresh. The prediction and probability are persisted BEFORE its official result is known. Later verified official resolution updates weights once per sample, including L2 regularization; it never retroactively changes the recorded prediction. Rounds without sufficient timely data are skipped; no fabricated sample. Official labels are required to have the intended official-source marker, official-resolution evidence and a settlement timestamp at or after the end of the round and not in the future.

## Forward evaluation

- Reports full and most recent 50-sample hit rate, log loss, Brier score, 95% Wilson interval, unsettled samples, latest weight revision and training version.
- Each weight revision is linked to a settled prediction that was made when old weights were active; the state is durably checkpointed to \`/var/lib/zl-prediction/deepseek-shadow15-online/state.json\`.
- \`readyForEvaluation\` requires at least **200 officially settled prospective observations**. Even then this is NOT permission to move the weights into production; evaluate recent score, calibration, cross-regime robustness, and executable trade economics separately.
- No automatic promotion to live trading, no risk-control/owner-switch modifications, no direct Binance API order operations, and no paid infrastructure added.
- The older +30s V1 shadow has a **different sampling basis** and must never share the V2 weights or data; its previously recorded metrics cannot be used to claim new +15s performance.
- The 15-second trained model is **independent** and does not yet change the DeepSeek prompt, AI decision or real trading. This is intentional while it accumulates adequate forward evidence.

## Resource isolation and deployment

Existing 2-vCPU/1.58GiB Alibaba SWAS in Singapore; at latest check ~0.75GiB RAM available. New process under \`zl-pred\` in systemd sandbox, \`CPUQuota=10%\`, \`MemoryMax=96M\`, \`IPAddressDeny=any\` except loopback. Serves status \`http://127.0.0.1:13044/api/status\` **only within the server**, with no public port. Read-only GET to existing localhost feeds; the service cannot access external paid AI or exchange APIs.

[Offline tests](https://github.com/zhoujunejune/pikpakzl/actions/runs/39561199799) and [actual safeguarded Alibaba deploy](https://github.com/zhoujunejune/pikpakzl/actions/runs/39561426981) both passed. The production AI, trading engine, futures, and pre-existing V1 shadow were still active after deploy. Real following status was OFF. New model begins at sample zero and accumulates only future market captures and official settlements.

## Safety and limitations

The upstream spot proxy market feed and official Prediction contract settlement are NOT proven identical benchmarks at the millisecond boundary. No confirmed orders, fills, fees, or payouts are joined: **realized net PnL is unknown**. Model performance can fall after online learning and cannot guarantee gains. Small samples are statistically noisy; do not select/promote only by short-run win rate.
