# DeepSeek Adaptive15 v1 — two pre-round reviews, selective WAIT, official-outcome experience

## Deployed status (2026-10-21 ~05:40 UTC)

Protected Alibaba production **signal provider** cutover succeeded:
[GitHub Actions proof](https://github.com/zhoujunejune/pikpakzl/actions/runs/39550870625).

- Provider listens at existing loopback 13029; public production source remains `DEEPSEEK_5M_V1`, provider `deepseek-flash`.
- Decision cutoff is strictly round open + **15 seconds**.
- Existing automatic follow remained explicitly **OFF**, with no changes to the trading/order router or futures bot.
- Officially settled training records preserved and continued advancing (129 after switch); 130 total prediction history entries at cutover.
- Pre-existing FAST10 source and unit file were backed up; no original learner or experience-case-memory source overwritten. Original unit backup location reported in Action logs.
- New source files are additive and read-only with respect to exchange APIs; only the pre-existing owner-controlled trade service could submit orders if user turns follow on.
- Three offline Node suites checked causal inputs, actual two DeepSeek calls, WAIT, no forged direction, history persistence and output envelope.

## Decision clock

1. Previous round T-120s: start collecting BTCUSDT live proxy ticks and 1m/5m indicators.
2. T-75s: call DeepSeek High-thinking for next-round **initial** UP/DOWN/WAIT analysis. Hard deadline leaves time for second call.
3. T-30s: call DeepSeek again with fresh market observations, previous reasoning and officially settled episodic experience to **revise** to UP/DOWN/WAIT. Second decision supersedes first when available.
4. Current round T+0s: observe actual new opening price and fresh BTCUSDT ticks, respecting exchange event time, current round ID and bounded opening-price revisions.
5. T+8..15s: choose UP/DOWN only when valid analysis, sufficient early tick coverage, confidence safeguards and no evidence conflicts. The model can choose WAIT; the program can also abstain if thresholds are not met.
6. At T+15s: hard stop for signal generation. No delayed or invented signal, no fallback order.
7. After official settlement: existing learner records outcomes, recalls historical comparable examples, and provides rolling direction/regime accuracy feedback. With sufficient labelled history, a **small conservative confidence threshold penalty** applies to historically weaker directions.

## What learning does and doesn't do

**Does:** learning from officially resolved, causal predictions through persisted prior cases, up/down empirical performance, regime experience and rule-based selective thresholds. Every new round may revise initial analysis and skip weak trades, reducing unnecessary exposure (but not proven profit).

**Does not:** retrain or fine-tune hosted DeepSeek weights; magically guarantee next-round correctness; optimize coefficients by verified PnL; invent unobserved price or official resolution; force UP/DOWN every round.

The score 60% AI lean, 30% price move from current round open and 10% previous two-minute movement is a **heuristic, not a calibrated probability**. Model subjective confidence influences the ability to abstain, not an estimated hit rate. Prospective holdout data is needed to evaluate its quality.

## Operational precautions

- The spot proxy and Binance prediction official settlement instrument can differ. Price freshness does not establish equivalence of settlement thresholds or traded quote values.
- Live 15-second signal creation is separate from the real order/quote/acceptance latency. The existing trade router was left unchanged.
- Two model calls per round can consume more of the existing DeepSeek API quota than one call. No new hosting subscriptions introduced.
- A cutover/restart mid-prewarm can create a temporary missed round. Never hide missed rounds from coverage reports.
- The user is the sole controller of the auto-follow switch. No automatic activation on upgrade.

## Live full-round audit

[GET-only full-round two-review validation](https://github.com/zhoujunejune/pikpakzl/actions/workflows/zl-deepseek-adaptive15-realround.yml). No order modifications are part of this audit.
