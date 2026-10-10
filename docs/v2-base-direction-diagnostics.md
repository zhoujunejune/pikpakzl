# V2 base-direction diagnostics

This document defines additive, read-only diagnostic fields; it does not change trading decisions.

For each unique round_id and freeze timestamp, record: model SHA/version, V3 base direction (UP/DOWN/NONE), V3 reason and input age, V2 gate decision and reason, Edge Rescue trigger/decision/reason, final production status, official settlement reference, and settlement verification status.

Separate final WAIT causes: A missing V3 base direction, B V2 gate rejection after V3 direction, C Edge Rescue not triggered or rejected, D missing/stale data or PRICE_FLAT. Keep both primary cause and overlapping contributing causes. Count independent settled rounds by round_id, not checkpoint events. Never overwrite frozen inputs with later values. Do not equate V3 direction coverage with final production release.

This is a diagnostic specification only. Implementation, tests, and production deployment require separate verification.
