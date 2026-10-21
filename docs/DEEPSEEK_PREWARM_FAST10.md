# DEEPSEEK_PREWARM_FAST10 — isolated shadow and production compatibility proposal

**Status:** Experimental. Alibaba production DeepSeek signal server at port 13029 and its order router are NOT switched by this PR. No paid AI calls enabled in the installed shadow.

## Requested decision schedule

1. T=-120s: Start collecting real BTCUSDT feed observations from the previous round, with verified exchange event timestamps and previous-round ID.
2. T≈-75s: Request DeepSeek High-thinking provisional direction for the NEXT round, before its unknown opening price is available.
3. T=0–8s: Measure actual new-round opening price and observed early prices. Reconcile full previous two-minute movement, from-open early movement and the pre-round DeepSeek lean using an UNVALIDATED experimental heuristic.
4. T<10s: At most one UP/DOWN decision, and only when DeepSeek prewarm and fresh early feed meet strict timing gates. If AI or feed is late, never create a fake DeepSeek signal or substitute another model.
5. T≥10s: No new signals for that round. Provider does not submit exchange orders.

## Implemented

- deepseek-fast10-shadow-core.mjs: strict temporal/market validation and reconciliation.
- deepseek-fast10-shadow-runner.mjs: standalone local-only status, paid inference OFF by default.
- deepseek-fast10-production-adapter.mjs: NOT deployed; maintains previous DeepSeek /signal contract and officially settled feedback without direct exchange writes.
- aliyun_fast10_shadow_install.py: install isolated capped-resource read-only service on existing Alibaba port 13042.
- Tests: previous 120s, causal new opening price, sufficient and fresh early ticks, by-10-second signal, one lock, no synthetic LLM output and order isolation.
- Actions: offline tests, live read-only market cadence and shadow install.

## Live read-only evidence

- Feed: 17 polls over ~15 seconds, 7 distinct exchange ticks, median event age ~1s, maximum event age under 2s. Observed cadence supports a potential fast early tick capture but does not prove all-round coverage.
- Original DeepSeek and production order control remained active.
- Shadow installed, local port 13042, capped CPU/memory, paid inference disabled, orders false; futures and prediction production services active.
- Original production still uses 270s decision generation and a 5-second poll schedule.
- Tests pass, but real DeepSeek High latency under current load has NOT been validated for this new prewarm mode.

## Production activation gates

- Measure DeepSeek response latency with a limited approved live prewarm pilot before assuming it will return before the next round. Additional shadow API calls cost tokens; do not enable by default.
- Existing Alibaba production engine and learner hashes diverge from repository reference. NEVER blanket overwrite; preserve historic official settlement/case-memory data and use backup and automatic rollback.
- Check model selection, active follow state, order records, front-end, futures service and real-order safety before and after any service switch.
- Current weighted blend: 35% pre-round model, 55% early price move, 10% prior 2min move. This is UNCALIBRATED, NOT validated for trading. Evaluate forward-only official outcomes and executable net profit before routing into real orders.
- Existing validator expects compatible signal expiry of round+270s; this is separate from strict signal CREATION <10s. Existing order submission latency must be checked independently.
- Never confuse a signal locked before 10s with an exchange-accepted and filled order before 10s.
