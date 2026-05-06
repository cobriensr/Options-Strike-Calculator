# Lottery Pipeline Runbook

Daily / weekly cadence for keeping the lottery_finder enrichment + research artifacts current. Last refreshed: 2026-05-06.

## TL;DR — what to run when

| When                                                 | Command               | Time     |
| ---------------------------------------------------- | --------------------- | -------- |
| **Every trading evening** (after EOD CSV is on disk) | `make nightly update` | ~1–6 min |
| **Once a week** (Sunday/Monday is fine)              | `make tune`           | ~25 min  |

That's it. Anything else (`make refit`, `make enrich`, etc.) is also valid as a standalone, but the two lines above cover normal operation.

## Daily flow

### `make nightly`

Pipeline (5 phases): `analyze → ingest → plots → backfill-flow → enrich`.

- Analyzes today's `bot-eod-report-YYYY-MM-DD.csv` from `~/Downloads/EOD-OptionFlow/`
- Writes the per-trade parquet to `~/Desktop/Bot-Eod-parquet/{DATE}-trades.parquet`
- Backfills `net_flow_per_ticker_history` from UW REST (so flow_inversion can compute even when the Vercel cron silently fails)
- Replays the parquet against `lottery_finder_fires` to populate the realized exit columns

**Resume mode**: if the CSV was already consumed in a prior run but the parquet is on disk, `make nightly` auto-falls-back to `plots → backfill-flow → enrich` only. Safe to re-run.

**If it fails partway**: exit non-zero, chained `update` won't run — that's the safety net. Investigate, fix, re-run.

### `make update`

Refreshes the research layer using the freshly-enriched fires. Order: `refit → exit_policy_search → feature_audit → daily_tracker`.

- **refit**: regenerates [ml/data/lottery_score_weights.json](../ml/data/lottery_score_weights.json), syncs to [api/\_lib/lottery-score-weights.ts](../api/_lib/lottery-score-weights.ts), backfills the `score` column on every fire under the new weights.
- **exit_policy_search**: 18 exit policies head-to-head across all enriched fires → `docs/tmp/lottery-exit-policy-search-{LATEST_DATE}.md`.
- **feature_audit**: Sharpe lift per fire-row feature on the Tier 2+ subset → `docs/tmp/lottery-feature-audit-{LATEST_DATE}.md`.
- **daily_tracker**: appends one row to `docs/tmp/lottery-tracking.csv` (idempotent on date — same-day reruns overwrite).

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

| Path                                            | What                                                                             | Lifespan                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| `docs/tmp/lottery-tracking.csv`                 | One row per most-recent enriched fire date — headline metrics for trend charting | Cumulative (grows ~1 row/day) |
| `docs/tmp/lottery-exit-policy-search-{DATE}.md` | 18 exit policies head-to-head                                                    | Per day                       |
| `docs/tmp/lottery-feature-audit-{DATE}.md`      | Sharpe lift per feature on Tier 2+ subset                                        | Per day                       |
| `docs/tmp/flow-inversion-tuning-{DATE}.md`      | Per-mode parameter grid + held-out test                                          | Per weekly tune               |
| `ml/data/lottery_score_weights.json`            | Source of truth for ticker score weights                                         | Overwritten by every refit    |
| `api/_lib/lottery-score-weights.ts`             | TS mirror — read by the cron                                                     | Overwritten by every refit    |

## Tracking CSV columns

The 26-column row appended by `daily_tracker.py` covers:

- **Fire counts**: `n_fires_today`, `n_fires_total_window`, `days_in_window`, plus per-tier (`t1_today`, `t2_today`, `t3_today`)
- **Flow_inv aggregate**: `flow_inv_n / flow_inv_mean_pct / flow_inv_sharpe`
- **Tier 2+ slice** (the recommended trade cohort): `t2plus_n / t2plus_mean_pct / t2plus_sharpe`
- **Mode B slice** (the structurally cleaner cohort): `modeB_n / modeB_mean_pct / modeB_sharpe`
- **Top 3 tickers by high-peak rate** (n ≥ 100 floor): early-warning if the universe drifts away from where the score weights are calibrated

Drift signals to watch for over time:

- T2+ Sharpe trending _down_ over multiple weeks → entry filter losing edge, run `make tune`
- Top-3 tickers churning week-to-week → universe drift, `refit` will adapt automatically but worth eyeballing
- `n_fires_today` collapsing → detector misfire (UW WS down, Vercel cron broken) — investigate

## Troubleshooting

| Symptom                                      | Likely cause                                           | Fix                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `make nightly` errors at `check`             | No CSV in `~/Downloads/EOD-OptionFlow/` AND no parquet | Drop the CSV, or wait for Bot to deliver it                                                                                                   |
| `[backfill-flow] empty_tickers=41`           | UW REST is down / API key expired                      | Check `UW_API_KEY` in `.env.local`; retry once UW is back                                                                                     |
| `[enrich] unenriched fires: 0` immediately   | Vercel cron already ran and populated everything       | No-op — proceed                                                                                                                               |
| `[track] no enriched fires found`            | DB query returned 0 rows                               | Ran before `enrich` — re-run `make update`                                                                                                    |
| `make tune` shows huge train/test Sharpe gap | Overfit (sample too small)                             | Wait for more days, then re-tune                                                                                                              |
| Day-over-day Sharpe jumps > 0.05             | Possible regime shift OR enrichment glitch             | Check `lottery-feature-audit-{DATE}.md` ranking — if macro features dominate the same direction, regime is real; if they invert, suspect data |

## Where the moving parts live

- **Pipeline scripts**: `scripts/` (Python, run via `ml/.venv/bin/python`)
- **Score-weight artifact**: `ml/data/lottery_score_weights.json` (canonical) → `api/_lib/lottery-score-weights.ts` (TS mirror)
- **Algorithm source-of-truth**: `api/_lib/flow-inversion.ts` + `api/_lib/lottery-exit-policies.ts`
- **Python ports** (parity-tested via pytest): in `scripts/enrich_lottery_outcomes.py`
- **Tests**: `scripts/test_enrich_lottery_outcomes.py` (33 cases, run via `ml/.venv/bin/pytest scripts/test_enrich_lottery_outcomes.py -q`)
