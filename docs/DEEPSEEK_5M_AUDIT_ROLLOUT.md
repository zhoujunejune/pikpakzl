# DeepSeek 5m decision quality / value audit — staged only

Base: \`feature/deepseek-evidence-memory-v2\` (2026-10-21). This PR must not be mistaken for a live Alibaba deployment.

## Implemented in branch

- **Durable inference trace:** each model attempt emits a *sanitized* daily JSONL event with round, attempt, WAIT/LOCKED/ERROR, decision, observed BTC and round-open prices, quote-independent decision time, LLM latency and token usage. No API keys, raw prompts, raw model responses, or credentials.
- **Observability:** local-only \`GET /api/decision-audit?limit=40\` and a non-invasive \`decisionJournal\` in status. If storage fails, signal generation continues and status reports the error.
- **Quoted value function (research-only):** \`assessQuote\` computes break-even probability and expected profit **only** when an executable Binance Prediction quote, explicit fee/slippage allowances and an independently forward-calibrated probability are present. LLM \`confidence\` must NEVER be passed as calibrated probability.
- **Timing analysis:** \`summarizeTiming\` segments officially settled predictions by signal second and calculates real net profit only from verified filled executions (missing fills => PnL null).
- **Model promotion safeguard:** \`assessPromotion\` accepts only paired strictly forward settled model-vs-baseline samples. It never promotes models automatically or edits live orders.
- **Automated offline tests** cover quote/probability integrity, no fake PnL, forward-only pairing, WAIT/LOCKED trace and existing DeepSeek engine regression.

## Production connections still required before deployment

1. Verify Alibaba running files and service, and compare with the branch. Never blindly overwrite diverged production code.
2. Confirm exact Binance Prediction executable UP/DOWN quote schema, payout/fees and endpoint freshness before passing quotes to \`assessQuote\`. No invented payout or market depth fields.
3. Join official round resolution with *exchange-verified* fills by immutable order ID. Signal hit-rate must remain separate from executed net PnL.
4. Validate real order-book and aggressive-trade data freshness, market basis and symbol identifiers before adding microstructure to model inputs. Never fill missing market data with a plausible synthetic value.
5. Shadow-evaluate new learners against the same strictly forward time window, with versioned weights, calibration, sample-count and drawdown checks; any real model switch requires a separate reversible production change.
6. Security review: local \`/api/decision-audit\` must not be publicly proxied without the existing panel authentication. Store JSONL on durable non-world-readable disk and configure retention.
7. Verify current 270s dynamic decision and existing owner-controlled trading mode remain unchanged during any deployment. Keep the futures bot untouched.

No existing production decision deadline, LLM prompt, lock direction, order logic, or auto-follow settings are changed in this branch.
