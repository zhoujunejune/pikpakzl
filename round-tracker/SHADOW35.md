# 35-second probability policy

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
The forward report targets at least 75% accuracy and 50% coverage; uncertainty
and different market periods still require review. An unsuccessful candidate
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
rounds, candidate/forward state, accuracy, coverage and decision latency. No API
credentials, raw wallet data or executable source payloads are exposed.

The existing production model, first-lock policy, Redis transport and trading
panel continue using their existing paths. Deploying the experiment starts
sampling; it does not switch the live trading strategy.
