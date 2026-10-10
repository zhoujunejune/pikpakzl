# LOCK_QUALITY_SELECTIVE_V7_5

The 35-second shadow experiment is named `LOCK_QUALITY_SELECTIVE_V7_5`.
New trained candidate versions use that same prefix followed by their training
timestamp. The former `SHADOW35_PROBABILITY_V1` journal remains readable; naming
does not reset collection, change the feature schema or enable production.

This experiment collects every five-minute round, including rounds without a V6
base direction, and evaluates an independent probability policy. It never emits
production signals, submits orders, or automatically promotes a candidate.

## Collection and decision timing

Checkpoints are 15, 20, 25, 30 and 35 seconds. The last checkpoint collects during
seconds 34–35 so inference can finish before the hard 35-second deadline. Missed
checkpoints are recorded as missing rather than reconstructed with later data.
Features carry their own `factsCalculatedAt` timestamp; the V6 direction's
immutable `generatedAt` is not a feature timestamp. Source timestamps, round
alignment, real depth/trade ages and prediction-market mapping are checked.

Before a model is available, collection proceeds without fabricated predictions.
Once a candidate is registered, a rejected probability can be evaluated again
at the next checkpoint. The first eligible result completed within 35 seconds
is frozen for that shadow policy. Later or conflicting results cannot change it.
Predictions completed after the deadline do not count as coverage.

## Training and evaluation

The initial model is a scikit-learn logistic probability baseline using existing
dependencies, not an assertion that a particular algorithm meets the targets.
Training begins after at least 300 officially settled rounds with valid features
have been collected. Under uninterrupted collection this takes at least about
25 hours; invalid or missing inputs can extend it.

Training, probability calibration, policy threshold selection and holdout are
separated chronologically. Every checkpoint from the same round stays in the
same partition, and labels must have been officially available by the training
cutoff. Threshold selection replays the complete first-eligible policy rather
than selecting the best checkpoint after settlement.

The candidate and its threshold remain frozen for a 30-day forward experiment.
Offline estimates or an apparent 75% hit rate do not establish long-term success.
The forward report targets at least 75% accuracy and 45% coverage. A production
recommendation requires the complete frozen 30-day window, at least 1,000
officially labeled predictions with no pending prediction labels, 95% Wilson
and daily block-bootstrap lower bounds meeting both targets, and every rolling
seven-day window meeting the point targets. Each direction also needs at least
100 predictions and 75% accuracy. Missing calendar rounds remain in coverage;
late, wrong-model or unsupported official records cannot qualify.
This is evidence for the observed window, not a guarantee of future accuracy.
An unsuccessful candidate
remains visibly unqualified and is not a production fallback.

## Persistence and monitoring

The independent journal and models live in `/data/shadow35` on the existing
persistent volume (`SHADOW35_DIR` can override this). Snapshots, official settlement labels, immutable shadow
decisions and model registration survive service restarts. Coverage uses calendar
rounds during the experiment, including missing collection and downtime.
Accuracy uses frozen predictions with official Binance Prediction settlement.
Unresolved labels remain visible.

Read-only monitoring:

- `GET /api/shadow35-stats`
- `GET /api/training-status`, under `models.shadow35`

Reports include valid snapshot counts, missing-input blockers, remaining training
rounds, persistent training attempts/results and retry thresholds, candidate/forward
state, confidence bounds, rolling-week stability, accuracy, coverage and decision
latency. A fresh `shadow35_training_status` report is logged every minute so
authorized scheduled checks can read it through Railway when HTTP is unavailable.
No API
credentials, raw wallet data or executable source payloads are exposed.

The existing production model, first-lock policy, Redis transport and trading
panel continue using their existing paths. Deploying the experiment starts
sampling; it does not switch the live trading strategy.
