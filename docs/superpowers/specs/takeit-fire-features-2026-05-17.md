# takeit XGBoost — add fire_count + fire_position features

**Date:** 2026-05-17
**Status:** deferred — note for the next takeit retrain cycle
**Owner:** ML pipeline (ml/src/takeit\_\*.py)
**Empirical basis:** [burst-profitability-findings-2026-05-17.md](../../tmp/burst-profitability-findings-2026-05-17.md)

## Why

Two strong univariate signals fell out of the 2026-05-17 burst-profitability analysis on 93 days / 626k fires:

1. **`fire_count` (chain-day total fires)** — monotone lift across 8 buckets. Single-fire chains (45% win, mean R = -5.8%) → 100+ fire chains (100% win on best, 78% win on median, mean R = +0.7%). Magnitude of the lift exceeds many features currently in the takeit XGBoost feature set.
2. **`fire_position` (this fire's Nth-on-chain)** — U-shaped: position 1 win = 57.1%, position 6-10 = 59.6% (peak), position 51+ = 56.6%. The "freshness" of the fire within its chain matters.

The takeit v2 model already takes ticker reliability + macro features as inputs. Both burst features are derivable at detect time (no new ingestion) and Phase 6 just shipped meta-detector wiring, so the integration cost is low.

Phase 1 / Phase B of the same session shipped read-time score adjustments (`fireCountScoreAdjustment` in commit `254c94ed`). That's a heuristic stopgap; baking the lift into the trained model is the rigorous version.

## Proposed change

Add two columns to the takeit feature export (`ml/src/takeit_export.py` or equivalent):

- `fire_count` — int, the chain-day's total fire count AT THIS FIRE's trigger time (cumulative, not full-day) so the feature is available at scoring time without future leakage.
- `fire_position` — int, this fire's 1-indexed position within its chain-day (1 = first fire, 2 = second, etc.).

Both must be computed from `trigger_time_ct` ordering, NOT the `alert_seq` or `minutes_since_prev_fire` columns — those are unreliable for chains like QQQ 708P 2026-05-15 (verified by the REIGNITION tuning analysis).

## Risks

- **Look-ahead leakage** if the feature is computed against the chain's FINAL fire_count instead of fire_count-at-trigger. The cumulative-at-trigger semantics must be explicit in the SQL and validated by a test that asserts `fire_count` is non-decreasing within a chain-day.
- **Ticker concentration** — high-fire-count chains are dominated by mega-cap names (TSLA, NVDA). The model could overweight ticker as a proxy. Mitigate by cross-validating per-ticker performance lift.
- **Adjustment double-count** — the read-time `fireCountScoreAdjustment` (shipped Phase B) feeds into the displayed score. If the takeit model also ingests `score` as a feature, AND learns fire_count, there's a risk of double-counting. Decide whether to (a) feed raw_score not adjusted_score, or (b) drop the read-time adjustment once the model captures the lift.

## Acceptance

- OOF AUC lift of ≥ +1pp on the takeit benchmark when both features are added.
- Per-ticker performance lift is positive for non-mega-cap names (i.e. not just an indirect ticker proxy).
- A test in `ml/src/test_takeit_export.py` (or equivalent) asserts `fire_count` is non-decreasing within `(date, option_chain_id)` ordered by `trigger_time_ct`.

## Out of scope

- Adding `cluster_size` (distinct-ticker count in same CT minute) — found by the 2026-05-15 12:05 cluster analysis on the same day, but a different signal surface; lives in its own follow-up spec.
- Promoting `fireCountScoreAdjustment` to a stored generated column so the score-sort SQL path picks up the lift — separate DB-migration follow-up noted inline at the integration site in `api/lottery-finder.ts`.
