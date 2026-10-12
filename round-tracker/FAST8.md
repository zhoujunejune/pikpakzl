# ZL_FAST8_65 (shadow only)

This independent prospective policy always chooses UP or DOWN. It samples existing
live feature snapshots only until T0+6500ms, freezes at about T0+7000ms in a worker,
and measures persistence plus actual parent/server publication against T0+8000ms.
It never calls the production router, Redis publisher or order APIs. Target accuracy
is 65%; it is not a demonstrated result or a guarantee.

The first collection round is the next complete five-minute round after initial
startup, durably recorded in `/data/fast8-65/events.jsonl`. Restarting resumes that
same experiment and never resets missed calendar rounds. Whole-service downtime,
late publication and persistence failure remain visible as failures. Source snapshots
received after the cutoff cannot backfill an earlier prediction.

Initial predictions use the observed 60-second momentum, then previously received
official direction counts, then a deterministic round-parity fallback explicitly
marked `NO_INFORMATION_FALLBACK`. All fallback results remain in overall accuracy.
After 300 timely, officially labeled snapshots with at least five present features,
a separate training worker fits fixed-feature L2 logistic regression, using a temporal
80/20 holdout with label-availability purging. A candidate is adopted for the next
complete round only if holdout accuracy is at least the fixed baseline and Brier <0.26.
Retraining happens after 100 additional eligible samples, using at most 2000 recent
samples. Training/holdout statistics never count as prospective performance.

The first 1000 calendar rounds are a preregistered validation window. It passes only
with 1000 timely published directions, all 1000 official binary outcomes and at least
650 hits. Missing or unresolved labels block acceptance; unsupported void outcomes
remain unresolved rather than being guessed or dropped. Wilson intervals are reported,
not used as an extra 65% lower-bound requirement. Algorithm changes require a new
policy version/experiment; weight updates under this fixed policy are recorded.

Read-only endpoints:

- `GET /api/fast8-stats`: cached worker report, complete calendar denominators,
  recent 100/300/1000 windows, direction breakdown, deadline failures, baseline use,
  training progress, first-window validation and latest 12 settlements.
- `GET /api/fast8-latest`: isolated shadow prediction (`executionEligible:false`).

Logs: `fast8_status` (at most 30s old), `fast8_direction_locked`,
`fast8_round_settled`, `fast8_training_result`, `fast8_deadline_breach`, `fast8_error`.
Official results use the existing strictly round-aligned Binance resolution path.
They are explicitly labeled as Railway official-source results, not independent
external certification. The hourly task must report even when no progress occurred.

Run: `node --test round-tracker/fast8.test.mjs` from repository root. Existing CI's
`node --test round-tracker/*.test.mjs round-tracker/test/*.test.mjs` includes these tests.
