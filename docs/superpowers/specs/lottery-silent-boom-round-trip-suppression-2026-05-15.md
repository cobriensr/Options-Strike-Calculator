---
status: Likely Shipped
date: 2026-05-15
---

# Lottery + Silent Boom Round-Trip Suppression — 2026-05-15

## Goal

Suppress Lottery Finder + Silent Boom alerts whose underlying position has been round-tripped (opened and closed intraday), so the dashboard surfaces only contracts where the informed bet is still alive. Validation is evidence-driven against the 92-day fulltape archive **before** any production rule ships.

## Motivation

Real-world recurring noise: an alert fires when a large opening print hits the ask, then a similar-size closing print hits the bid 15-60 minutes later. The position is already gone but the alert keeps cluttering the UI with no actionable read. Example: MU 702.5P 05/22 on 2026-05-15 — 100c ask sweep ~14:05, 100c bid hit ~14:30, alert remained "fresh" in the panel.

This sits **on top of** the gating that already exists:

- Multi-leg filter (silent_boom migration #146): rejects buckets with `multi_leg_share ≥ 0.50`
- Direction-gating (#156): demotes counter-trend fires per Market Tide
- Tier scoring (#135): silent_boom rolled up to tier1/tier2/tier3

The round-trip suppressor is a **residual** filter — the question is whether it adds lift after the above are already applied.

## Decisions Made During Scoping

1. **Suppress, don't tag.** Alerts that round-trip are hidden from the UI entirely (cleaner panel, higher signal-per-row).
2. **Real-time score = 0 when suppressed.** Suppression flows through the existing Lottery score path; no separate lifecycle state machine.
3. **Punt per-trader attribution.** Rely on contract-level net flow as a proxy — if the contract has fully two-way flowed, the dealer position is back to neutral regardless of which actors did what.
4. **Backend audit log preserved.** Suppressed alerts still write to `lottery_finder_fires` / `silent_boom_alerts`; a new boolean column flags them. Allows weekly false-positive review and threshold re-tuning.
5. **Three cohorts in the EDA**, separated:
   - **Cohort A** — current rules only (post-2026-05-14, after direction-gating shipped). Production-relevant lift estimate.
   - **Cohort B** — all historical alerts. Long-term signal estimate.
   - **Cohort C** — synthetic: apply current gating predicates retroactively to historical alerts. Apples-to-apples comparison vs A with statistical power.

## Critical Schema Gotcha (Verified 2026-05-15 sanity check)

The fulltape `ask_vol` / `bid_vol` / `mid_vol` / `no_side_vol` / `multi_vol` / `stock_multi_vol` fields are **cumulative running totals at print time**, not per-print sizes. Naive `sum(ask_vol)` overcounts by ~10-20×.

Per-print side attribution must use one of:

- **Parse `tags` field** for `ask_side` / `bid_side` literals (Postgres array notation, e.g. `{bid_side,bearish,earnings_next_week}`). This is the canonical UW per-print classification.
- **Compute deltas** after sorting by `executed_at`: `per_print_ask = current_row.ask_vol − prev_row.ask_vol`.

Window-level aggregates: `window_ask = last_row.ask_vol − first_pre_window_row.ask_vol` (NOT `sum`).

Same applies to `multi_vol` for per-print multi-leg classification.

This is referenced in memory `feedback_uw_fulltape_vols_cumulative.md`; the spec calls it out so the implementer doesn't re-discover the trap.

## Data Dependencies

| Source               | Path                                                                                                                  | Coverage                         | Grain                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------ |
| Fulltape (per-print) | `~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet`                                                             | 92 days, 2026-01-02 → 2026-05-14 | Per print, ~11M rows/day |
| Lottery alerts       | Postgres `lottery_finder_fires`                                                                                       | All-time                         | Per fire                 |
| Silent Boom alerts   | Postgres `silent_boom_alerts`                                                                                         | 2026-04-22 → present             | Per fire                 |
| Outcome labels       | Already enriched on both tables: `realized_trail30_10_pct`, `realized_eod_pct`, `peak_ceiling_pct`, `minutes_to_peak` | N/A                              | Per alert                |

Join key: `option_chain_id` (byte-identical across all three sources — confirmed for both equity tickers and SPXW).

Timezone: fulltape `executed_at` is UTC. Alert `trigger_time_ct` / `bucket_ct` are TIMESTAMPTZ — Postgres stores UTC under the hood; compare in UTC consistently.

## Phases

### Phase 1 — EDA notebook (no production code)

**File:** `ml/experiments/round-trip-suppression-eda/notebook.py` (Polars, runs on `ml/.venv/bin/python`)

Tasks:

- [ ] Load all `lottery_finder_fires` and `silent_boom_alerts` rows with enriched outcomes → Verify: row counts per cohort match Postgres COUNT(\*) within ±0
- [ ] Compute Cohort A / B / C masks → Verify: counts add up: A ⊆ C ⊆ B; print sample sizes per cohort
- [ ] For each alert, lazy-scan the matching fulltape day, filter by `option_chain_id`, compute the suppression features → Verify: feature set runs end-to-end on Cohort A subset (~hundreds of rows) in under 5 min
- [ ] Suppression features per alert:
  - `post_fire_net_ask_minus_bid` (using `tags` parse, NOT raw `ask_vol`/`bid_vol` sums)
  - `post_fire_premium_net` (delta-dollar weighted by `delta` × `size` × `price`)
  - `post_fire_total_volume` (sum of `size`)
  - `time_to_50pct_volume_reversal_min`
  - `oi_delta_intraday` (last `open_interest` − first `open_interest`)
  - `mid_print_pct` (count of `mid_side` tags as % of post-fire print count)
  - `nbbo_relative_position_at_close` (does last print hit ask or bid relative to NBBO?)
- [ ] Plot distributions of each feature, split by outcome (`peak_ceiling_pct ≥ 50%` win vs `< 0%` loser) → Verify: PNG files in `ml/plots/round-trip-suppression/` per feature
- [ ] ROC + feature-importance pass (logistic regression / LightGBM, target = `realized_trail30_10_pct < −20%`) → Verify: ranked features printed; top-3 identified
- [ ] Threshold sweep: simulate suppression at thresholds 10/15/20/25/30/40% net-reversal; report % suppressed, win rate of suppressed vs surviving, net expected lift in R → Verify: table printed per cohort
- [ ] Cohort comparison report: A vs B vs C side-by-side on the chosen threshold(s) → Verify: markdown summary written to `docs/tmp/round-trip-suppression-cohort-results-2026-05-15.md`

**Decision gate:** ship Phase 2 only if EDA shows:

- Suppressed alerts have ≤30% peak-50% win rate (clearly noise)
- Surviving alerts maintain or improve win rate (signal preserved)
- Effect is concentrated in identifiable cohorts (per `feedback_uniform_lift_is_leakage.md` — uniform lift is suspicious)

### Phase 2 — Production rule design (only if Phase 1 validates)

Write `docs/superpowers/specs/round-trip-suppressor-production-2026-05-XX.md` covering:

- Exact suppression predicate (feature, threshold, time window)
- Whether to apply uniformly or per ticker/DTE bucket
- Migration column name + tables
- Cron schedule (likely every 5 min during market hours)
- Score integration point in `api/_lib/lottery-score-weights.ts`
- Resurrection rule (re-fire as new alert if post-suppression flow re-opens?)

### Phase 3 — Production implementation (separate spec)

Out of scope here. Will reference Phase 2 spec.

## Files to Create/Modify

Phase 1 only:

- `ml/experiments/round-trip-suppression-eda/notebook.py` — EDA driver
- `ml/experiments/round-trip-suppression-eda/features.py` — per-alert feature computation (importable, tested)
- `ml/experiments/round-trip-suppression-eda/tests/test_features.py` — unit tests with synthetic fulltape fixtures, especially exercising the cumulative-vol gotcha
- `ml/plots/round-trip-suppression/*.png` — distribution + ROC plots
- `docs/tmp/round-trip-suppression-cohort-results-2026-05-15.md` — written by the notebook on completion

## Open Questions

- **Forward window length.** 30 min? 60 min? 90 min? Will fall out of the time-to-reversal distribution analysis.
- **Asymmetric opener-vs-closer detection at fire time.** The alert print itself may be a closing print (no informed entry was ever flagged). Investigate via `size vs open_interest` and prior cumulative same-side volume at fire time. May warrant a separate filter from the forward suppressor.
- **Per-bucket thresholds vs global threshold.** TBD from cohort-concentration analysis in Phase 1.

## Notes

- Phase 1 runs in `ml/.venv/bin/python`; do NOT use system python3 (per memory `project_ml_pipeline_online.md` venv conventions).
- The 109 GB fulltape archive lives outside the repo at `~/Desktop/Eod-Full-Tape-parquet/`. Polars lazy scans with predicate pushdown on `option_chain_id` are the only viable read pattern at this scale — never load a full day into memory.
- DB access for Phase 1: use the same `psycopg2` pattern as `scripts/enrich_silent_boom_outcomes.py` (read `DATABASE_URL` from `.env.local`).
- Plots go in `ml/plots/round-trip-suppression/` per `feedback_keep_ml_plots_in_git.md` — tracked in git, not gitignored.
- No production code changes in Phase 1. Phase 2 starts only after the cohort-results doc shows ship-worthy lift.
