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


## 2026-10-21 readonly field audit findings (no production modification)

Evidence is in GitHub Actions on the **draft branch**:
- [Live-only aggregate timing and model attribution](https://github.com/zhoujunejune/pikpakzl/actions/runs/39532662052): 97 history records, 96 official resolved, 62 hits. Provider-separated: deepseek-flash 60/94; deepseek-v4-pro 2/2. **Do not merge provider populations when claiming current Flash performance.** Historical endpoint is currently limited to 100.
- [Existing isolated online logistic shadow](https://github.com/zhoujunejune/pikpakzl/actions/runs/39532548277): service active on localhost; 14 features, 27 officially trained, 13/27 correct; it cannot trade, cannot replace the production model, and is not eligible for promotion.
- [Read-only current production model check](https://github.com/zhoujunejune/pikpakzl/actions/runs/39531231683): DeepSeek Flash, High thinking, 270s dynamic window, six calls per round, history feedback active, DeepSeek weights are **not** fine-tuned.
- [Read-only production SHA fingerprints](https://github.com/zhoujunejune/pikpakzl/actions/runs/39531436674): live engine and learner DIFFER from branch, feature extractor matches. **Never overwrite** the production engine or learner from this PR.

## Deployment and trading gates

This PR intentionally remains **draft and not merged**. All audit work is read-only; no service restart, order submission, live switch, or futures-bot modification occurred.

The economic-value analyzer needs actual executable exchange quotes and exchange-verified fill/payout evidence. Without them its PnL fields MUST remain null, irrespective of observed accuracy. LLM confidence is not a validated probability. A safe deployment requires reconciling differences against running engine code, authenticating any new public endpoint and ensuring durable storage; none of those may be silently assumed complete.

Provider-specific sample counts and shadow results are research evidence, not an endorsement to activate trading or increase risk.
