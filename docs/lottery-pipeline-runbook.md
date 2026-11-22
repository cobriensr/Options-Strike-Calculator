# Lottery Pipeline Runbook

Daily / weekly cadence for keeping the lottery_finder enrichment + research artifacts current. Last refreshed: 2026-11-21.

## TL;DR — what to run when

| When                                                 | Command               | Time     |
| ---------------------------------------------------- | --------------------- | -------- |
| **Every trading evening** (after EOD CSV is on disk) | `make nightly update` | ~4–9 min |
| **Once a week** (Sunday/Monday is fine)              | `make tune`           | ~25 min  |

That's it. Anything else (`make refit`, `make enrich`, etc.) is also valid as a standalone, but the two lines above cover normal operation.

## Daily flow

### `make nightly`

Pipeline (4 steps): `analyze → ingest → plots → enrich`.

- Analyzes today's `bot-eod-report-YYYY-MM-DD.csv` from `~/Downloads/EOD-OptionFlow/`
- Writes the per-trade parquet to `~/Desktop/Bot-Eod-parquet/{DATE}-trades.parquet`
- Does not backfill `net_flow_per_ticker_history`: the `fetch-net-flow-history` cron fills it. `scripts/backfill_net_flow_history.py` is manual-only, to repair a day that cron missed (flow_inversion can't compute without it)
- Replays the parquet against `lottery_finder_fires` to populate the realized exit columns (`scripts/enrich_lottery_outcomes.py` and `scripts/enrich_silent_boom_outcomes.py` can read the R2 Full Tape instead with `--r2`, and take `--select` and `--dry-run`)

**Resume mode**: if the CSV was already consumed in a prior run but the parquet is on disk, `make nightly` auto-falls-back to `plots → enrich` only. Safe to re-run.

**If it fails partway**: exit non-zero, chained `update` won't run — that's the safety net. Investigate, fix, re-run.

### `make update`

Refreshes the research layer using the freshly-enriched fires. Order: `refit → exit_policy_search → feature_audit → flow_inversion_timing → daily_tracker → mine_outcome_patterns → score_lineage_audit → takeit-drift`.

- **refit** (`make refit`): two dry runs, nothing is written (`lottery_scoring.py --through` prints the fit; `backfill_lottery_scores.py` writes nothing without `--write`). The refit itself is the nightly service's `lottery-refit` step, which builds and judges a shadow candidate in `lottery_score_versions`; promotion, which rewrites live scores, stays off until the owner's go-ahead. The reports read the `active` pointer in `lottery_score_pointers`.
- **exit_policy_search**: 18 exit policies head-to-head across all enriched fires → `docs/tmp/lottery-exit-policy-search-{LATEST_DATE}.md`.
- **feature_audit**: Sharpe lift per fire-row feature on the Tier 2+ subset → `docs/tmp/lottery-feature-audit-{LATEST_DATE}.md`.
- **flow_inversion_timing**: re-runs the inversion algorithm to capture exit timestamps; reports per-ticker median time-to-inversion + distribution → `docs/tmp/flow-inversion-timing-{LATEST_DATE}.md`. Slowest step (~3 min — parquet replay).
- **daily_tracker**: appends a row to `docs/tmp/lottery-tracking.csv` for every enriched fire date after the file's last row, each computed as of its own date (a missed run is filled by the next one; with no usable last row it writes the newest date only). Idempotent on date — a rerun with nothing newer overwrites the newest date's row.
- **mine_outcome_patterns**: scans 2- and 3-feature combinations of the 90 days of single-leg fires up to the `--as-of` date for ones that lift winners or losers beyond their best single feature → `docs/tmp/lottery-composite-candidates-{DATE}.md` (`{DATE}` is the `--as-of` date, today by default).
- **score_lineage_audit**: per day-of-week attribution of each score component over the last 30 days of single-leg fires, flagging components that contribute more to losers than winners → `docs/tmp/lottery-score-lineage-{DATE}.md` (`{DATE}` as above).
- **takeit-drift** (`make takeit-drift`): TAKE-IT AUC and reliability drift over the enriched window → `docs/tmp/takeit-drift-{DATE}.md` and `ml/plots/takeit-drift/reliability_<feed>_{DATE}.png`.
- **Flags on the four Neon-only reports** (all optional; `make update` passes none): `--out-dir DIR` on `feature_audit.py`, `mine_outcome_patterns.py` and `score_lineage_audit.py` (default `docs/tmp`); `--as-of YYYY-MM-DD` on `mine_outcome_patterns.py` and `score_lineage_audit.py` (default today; the 90- or 30-day window ends on it, it names the report, and fires dated after it are left out); `--csv PATH` on `daily_tracker.py` (default `docs/tmp/lottery-tracking.csv`).

Six reports read the active weights version from the store, not the frozen JSON (owner, 2026-11-19; phase 3 D8). exit_policy_search, flow_inversion_timing and feature_audit tier fires by the feed's qas against its `feed_cutoffs`. The qas is `GREATEST(0, score) + inversion bonus`, with no round-trip deduct and no gamma term: the feed fixes its tier at the fire (owner, 2026-11-17). daily_tracker uses its bare `cutoffs` on the stored score. mine_outcome_patterns and score_lineage_audit build their features and components from its `features`, and they select single-leg fires (`anchor_leg_kind = 'single'`, the population the refit trains on) in place of the old `inferred_structure IS NULL`. Each names the version in its output, and `make update` exits non-zero when the active weights can't be read.

### Chaining

`make nightly update` runs both in one shot. Use this; manual two-step is only useful when debugging.

## Weekly flow

### `make tune`

Heavy parameter grid (84 combos × 63K fires) for the flow-inversion algorithm, per mode. Writes `docs/tmp/flow-inversion-tuning-{LATEST_DATE}.md`.

**Why weekly, not daily**: a single new day adds ~5K fires to a ~63K-fire window (8% turnover). The optimization landscape doesn't move; running it daily burns 25 minutes for noise. Sunday or Monday morning is plenty.

**When to run ad-hoc**:

- After a major regime shift (e.g., VIX > 30 for a week, FOMC decision day, post-earnings cluster)
- After 30+ days of new data have accumulated
- If `feature_audit.py` shows the macro features inverting their effect (current finding: Q1 macro = best; if that flips, the underlying signal has changed and tuning may want to reconfirm)

## Outputs at a glance

| Path                                                     | What                                                                                                                                                                                                                  | Lifespan                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `docs/tmp/lottery-tracking.csv`                          | One row per enriched fire date (a run adds every date after the file's last row) — headline metrics for trend charting                                                                                                | Cumulative (grows ~1 row/day)   |
| `docs/tmp/lottery-exit-policy-search-{DATE}.md`          | 18 exit policies head-to-head                                                                                                                                                                                         | Per day                         |
| `docs/tmp/lottery-feature-audit-{DATE}.md`               | Sharpe lift per feature on Tier 2+ subset                                                                                                                                                                             | Per day                         |
| `docs/tmp/flow-inversion-timing-{DATE}.md`               | Per-ticker median time-to-inversion + distribution                                                                                                                                                                    | Per day                         |
| `docs/tmp/flow-inversion-tuning-{DATE}.md`               | Per-mode parameter grid + held-out test                                                                                                                                                                               | Per weekly tune                 |
| `docs/tmp/lottery-composite-candidates-{DATE}.md`        | Feature combinations that lift winners or losers beyond their best single feature                                                                                                                                     | Per day                         |
| `docs/tmp/lottery-score-lineage-{DATE}.md`               | Per day-of-week attribution of each score component                                                                                                                                                                   | Per day                         |
| `docs/tmp/takeit-drift-{DATE}.md`                        | TAKE-IT AUC and reliability drift over the enriched window                                                                                                                                                            | Per day                         |
| `ml/plots/takeit-drift/reliability_<feed>_{DATE}.png`    | TAKE-IT reliability curves, one per feed                                                                                                                                                                              | Per day                         |
| `ml/output/lottery_score_weights.json`                   | Frozen seed source of the first weights version                                                                                                                                                                       | Frozen                          |
| Neon `lottery_score_pointers` / `lottery_score_versions` | The active weights every report reads                                                                                                                                                                                 | Changes on promotion            |
| `api/_lib/lottery-score-weights.ts`                      | Legacy V1 scorer constants, plus the `LotteryScoreTier` type and `gammaScoreAdjustment` the feed still imports. Not the live weights: see `api/_lib/lottery-weights-loader.ts` and `api/_lib/lottery-weights-seed.ts` | Hand-edited; no refit writes it |

## Tracking CSV columns

The 26-column row appended by `daily_tracker.py` covers:

- **Fire counts**: `n_fires_today`, `n_fires_total_window`, `days_in_window`, plus per-tier (`t1_today`, `t2_today`, `t3_today`)
- **Flow_inv aggregate**: `flow_inv_n / flow_inv_mean_pct / flow_inv_sharpe`
- **Tier 2+ slice** (the recommended trade cohort): `t2plus_n / t2plus_mean_pct / t2plus_sharpe`
- **Mode B slice** (the structurally cleaner cohort): `modeB_n / modeB_mean_pct / modeB_sharpe`
- **Top 3 tickers by high-peak rate** (n ≥ 100 floor): early-warning if the universe drifts away from where the score weights are calibrated

Drift signals to watch for over time:

- T2+ Sharpe trending _down_ over multiple weeks → entry filter losing edge, run `make tune`
- Top-3 tickers churning week-to-week → universe drift; the nightly refit builds a shadow candidate (promotion is off, so the live weights do not adapt on their own), worth eyeballing
- `n_fires_today` collapsing → detector misfire (UW WS down, Vercel cron broken) — investigate

## Troubleshooting

| Symptom                                      | Likely cause                                           | Fix                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `make nightly` errors at `check`             | No CSV in `~/Downloads/EOD-OptionFlow/` AND no parquet | Drop the CSV, or wait for Bot to deliver it                                                                                                   |
| Net-flow history missing for a day           | `fetch-net-flow-history` cron missed that day          | Run `scripts/backfill_net_flow_history.py --date YYYY-MM-DD`; `empty_tickers=41` in its `[backfill-flow]` log = UW down or key expired        |
| `[enrich] unenriched fires: 0` immediately   | Vercel cron already ran and populated everything       | No-op — proceed                                                                                                                               |
| `[track] no enriched fires found`            | DB query returned 0 rows                               | Ran before `enrich` — re-run `make update`                                                                                                    |
| `make tune` shows huge train/test Sharpe gap | Overfit (sample too small)                             | Wait for more days, then re-tune                                                                                                              |
| Day-over-day Sharpe jumps > 0.05             | Possible regime shift OR enrichment glitch             | Check `lottery-feature-audit-{DATE}.md` ranking — if macro features dominate the same direction, regime is real; if they invert, suspect data |

## Where the moving parts live

- **Pipeline scripts**: `scripts/` (Python, run via `ml/.venv/Scripts/python`; `ml/.venv/bin/python` on Linux/macOS)
- **Score weights**: the `active` pointer in the store (`ml/src/lottery_weights.py` `load_pointer`; `api/_lib/lottery-weights-loader.ts`). The frozen seed is `ml/output/lottery_score_weights.json` → `api/_lib/lottery-weights-seed.ts`.
- **Algorithm source-of-truth**: `api/_lib/flow-inversion.ts` + `api/_lib/lottery-exit-policies.ts`
- **Python ports** (parity-tested via pytest): in `scripts/enrich_lottery_outcomes.py`
- **Tests**: `scripts/test_enrich_lottery_outcomes.py` (33 cases, run via `ml/.venv/Scripts/pytest scripts/test_enrich_lottery_outcomes.py -q`)
