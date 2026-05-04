# Lottery Net Flow — EDA + Phase 3 Plateau Flag

**Date:** 2026-05-03
**Author:** Session continued from lottery-finder Phase 2 (twin-chart per-fire panel)
**Status:** Spec — pending user approval before implementation
**Predecessor:** [lottery-finder-2026-05-02.md](./lottery-finder-2026-05-02.md) Phase 3

---

## What this is

An exploratory data-science investigation into whether **ticker-level net flow (NCP / NPP) carries predictive signal for `lottery_finder_fires` profitability**, plus the Phase 3 informational plateau-flag from the predecessor spec.

The motivating anecdote — TSLA 395C 2026-05-01, NCP plateau 12:45–1:50pm preceding price decline by ~25 min — is one observation. We do not yet know:

1. Whether plateau is the right feature (vs slope, level, asymmetry, lead time)
2. Whether any net-flow feature improves selection over the existing cheap-call-PM RE-LOAD baseline (18.9% lottery rate)
3. Whether observed lift would be **concentrated** (real signal) or **uniform** (leakage fingerprint per `feedback_uniform_lift_is_leakage`)

This spec runs the EDA first, then ships the plateau flag as **informational only** regardless of EDA outcome (per user decision: "Just informational is fine now"). EDA findings will feed a separate decision on whether to ship plateau as a selection filter in a future spec.

## What this is NOT

- **Not a selection-filter rollout.** Even if EDA finds strong signal, gating the lottery feed on a flow feature requires a follow-up spec with its own backtest discipline.
- **Not a production ML model.** Pure descriptive statistics + univariate analysis. No classifier, no held-out test set, no hyperparameter sweep.
- **Not validation of the lottery_finder detector itself.** That was done in `docs/tmp/options-flow-analysis/`. We're testing whether ticker-level flow conditions enrich the existing fires.

---

## Goal

> One sentence: **Determine which (if any) ticker-level net-flow features predict lottery_fire profitability, with concentration analysis to rule out leakage.**

---

## Universe + scope

- **Tickers:** Union of `LOTTERY_V3_TICKERS` (38) + `LOTTERY_EXTENDED_TICKERS` (19) from `api/_lib/lottery-finder.ts`. Dedup → ~50 tickers.
- **Date range:** Last 30 calendar days at the time the backfill runs (≈ 21 trading days). Bounded by UW REST `/stock/{ticker}/net-prem-ticks` retention.
- **Outcome labels:** Realized return under all 3 exit policies (`realizedTrail30_10Pct`, `realizedHard30mPct`, `realizedTier50HoldEodPct`) + `peakCeilingPct`. Reporting separately so we don't pre-commit to one policy.

---

## Data dependencies

| Source | What we need | Notes |
|---|---|---|
| UW REST `/stock/{ticker}/net-prem-ticks` | Per-minute NCP/NPP/NCV/NPV deltas, 50 tickers × 30 days | Same endpoint pattern as `api/cron/fetch-flow.ts` |
| `lottery_finder_fires` | All historical fires + outcomes | Already populated (used by Lottery Finder UI) |
| `ws_net_flow_per_ticker` | NOT used here — only ~hours of history at spec time | The new table from Phase 1.1 of the predecessor spec |

**Storage:** New table `net_flow_per_ticker_history` — separate from `ws_net_flow_per_ticker` to keep WS-live and REST-backfill data clean. Same shape as `ws_net_flow_per_ticker` but with `source TEXT NOT NULL` ('rest' / 'ws') in case we union later.

---

## Phases

### Phase 1 — Backend: backfill table + script

#### Task 1.1 — Migration #122: `net_flow_per_ticker_history`

- [ ] Add migration to `api/_lib/db-migrations.ts`. Schema mirrors `ws_net_flow_per_ticker` plus `source` column:
  ```sql
  CREATE TABLE IF NOT EXISTS net_flow_per_ticker_history (
    id BIGSERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    net_call_prem NUMERIC(18, 2) NOT NULL,
    net_call_vol INTEGER NOT NULL,
    net_put_prem NUMERIC(18, 2) NOT NULL,
    net_put_vol INTEGER NOT NULL,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS net_flow_per_ticker_history_ticker_ts_src_idx
    ON net_flow_per_ticker_history (ticker, ts, source);
  CREATE INDEX IF NOT EXISTS net_flow_per_ticker_history_ticker_ts_idx
    ON net_flow_per_ticker_history (ticker, ts DESC);
  ```
- [ ] Update `api/__tests__/db.test.ts`: applied-migrations mock, expected output, SQL call count (4 statements).
- **Verify:** `npx vitest run api/__tests__/db.test.ts` passes.

#### Task 1.2 — `scripts/backfill-net-prem-ticks.mjs`

- [ ] Iterate over `LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS` (dedup).
- [ ] For each ticker × each of last 30 calendar days: GET `/stock/{ticker}/net-prem-ticks?date=YYYY-MM-DD` via `uwFetch` pattern.
- [ ] Restrict rows to 08:30–15:00 CT per `feedback_extended_hours`.
- [ ] Batched INSERT (500/query) per `feedback_batched_inserts`. `ON CONFLICT (ticker, ts, source) DO NOTHING`.
- [ ] Pacing: existing semaphore=3 + jitter pattern from sidecar (per UW 429 history). Resumable: skip (ticker, date) pairs already covered.
- [ ] Print run summary: total rows, per-ticker row counts, gaps.
- **Verify:** Dry-run on 1 ticker × 1 day, assert row shape; full run prints expected ~585k rows.

### Phase 2 — EDA: feature extraction + univariate analysis

#### Task 2.1 — `ml/experiments/lottery-net-flow-eda/` scaffold

- [ ] Create directory with `README.md`, `extract_features.py`, `analyze.py`, `report.md` (output).
- [ ] Use `ml/.venv/bin/python` per CLAUDE.md.
- [ ] Reuse pandas + matplotlib + seaborn. No sklearn — pure descriptive.

#### Task 2.2 — `extract_features.py`: per-fire feature vector

For every row in `lottery_finder_fires`, join `net_flow_per_ticker_history` on (ticker, date) and compute features from a 30-min pre-fire window ending at `trigger_time_ct`:

| Feature | Definition |
|---|---|
| `ncp_at_fire` | Cumulative NCP from session-open through trigger time |
| `npp_at_fire` | Cumulative NPP, same window |
| `ncp_slope_5m` | NCP delta over the last 5 minutes / 5 |
| `ncp_slope_15m` | NCP delta over the last 15 minutes / 15 |
| `ncp_slope_30m` | NCP delta over the last 30 minutes / 30 |
| `asymmetry` | NCP / (NCP + NPP) at fire — 0.5 = balanced |
| `direction_match` | bool — call fire & ncp_slope_5m > 0, or put fire & npp_slope_5m > 0 |
| `level_pct_of_day_high` | NCP at fire / max(NCP) over the day so far |
| `pre_fire_variance` | std of per-minute NCP delta over the prior 30 min |
| `lead_time_to_ncp_peak` | minutes between fire and the most recent prior local NCP max (null if peak is at fire) |

Output: `features.parquet` keyed by `(fire_id)` with all features + outcome columns from `lottery_finder_fires`.

- **Verify:** parquet has expected row count (≈ count of fires in last 30 days), no nulls in core features (allow nulls in `lead_time_to_ncp_peak` only).

#### Task 2.3 — `analyze.py`: univariate + stratified analysis

For each feature in the table above, produce:

1. **Univariate scatter** — feature value (x) vs realized return under each exit policy (y). Saved to `ml/plots/lottery-net-flow-eda/<feature>_scatter.png`.
2. **Quartile lift table** — bin fires into feature quartiles, report lottery rate (≥+100%) per quartile. Markdown table in `report.md`.
3. **Direction-match contingency** — 2×2 table (direction_match yes/no × lottery yes/no) with chi-squared p-value.
4. **Stratified concentration check** — for the top-2 features by quartile-spread, compute lift across strata (cheap-call-PM × mode × TOD × top-tickers). Per `feedback_uniform_lift_is_leakage`: flag any feature where lift is uniform — that's a leakage fingerprint, not signal.
5. **Correlation matrix** — heatmap of all features + outcomes. Saved.

- **Verify:** `report.md` exists with all 5 sections populated, all referenced PNGs exist.

#### Task 2.4 — Findings memo `report.md`

Author a flat summary (no "ah-ha!" framing per `feedback_dont_jump_to_conclusions`):

- Top 3 features by lift, with effect size and concentration assessment
- Features that look like leakage (uniform lift), flagged explicitly
- Recommendation: **(a)** ship one feature as a selection-filter follow-up, **(b)** keep plateau-flag as informational only and re-EDA in 60 days, or **(c)** kill the line of investigation
- Open questions for next iteration

### Phase 3 — Informational plateau flag (deferred — depends on Phase 2 findings)

Originally Phase 3 of the predecessor spec. **Defer the implementation** until Phase 2 picks the right feature. If Phase 2 says "plateau" wins, build it as `plateau_preceded` boolean. If Phase 2 says something else (e.g., `direction_match` + `level_pct_of_day_high > 0.8`), the flag should reflect that instead. Don't build the cron column blind.

The UI surfacing (badge on the row) is unchanged regardless of which feature wins — it's "this fire had the favorable flow signature, FYI." Not a filter.

---

## Open questions

1. **Endpoint shape verification.** `/stock/{ticker}/net-prem-ticks` returns deltas per UW notebook + per `api/cron/fetch-flow.ts`. Need to confirm the response field names match what we expect (`net_call_premium` etc.) before writing the backfill — check actual response with a curl probe before bulk run.
2. **30-day lookback enough?** `lottery_finder_fires` has ~15 days of backfilled history per the predecessor spec. So the join will only have ~15 days of paired data even if we fetch 30 days of net flow. That's ~3,000–10,000 fires depending on filter. Probably enough for univariate; tight for multivariate. Mitigation: re-run EDA in 30 days when data has doubled.
3. **Peak-detection algorithm for `lead_time_to_ncp_peak`.** Use scipy `signal.find_peaks` with prominence threshold = 5% of day's NCP range. Confirm prominence threshold during implementation.
4. **Calls vs puts symmetry.** All EDA features computed for the side that matches the fire's option type (call → use NCP, put → use NPP). Don't aggregate — they're different signals.
5. **Should weekend/holidays cause `(ticker, date)` skip in backfill?** Yes — UW returns empty for non-trading days. Skip-via-empty-response is fine.

---

## Thresholds + constants (locked)

| Constant | Value | Source |
|---|---|---|
| Backfill window | 30 calendar days | UW REST retention practical limit |
| Pre-fire feature window | 30 minutes | Anecdote was 25-min lead — pad to 30 |
| Slope sub-windows | 5, 15, 30 min | Standard intraday horizons |
| Lottery rate threshold | ≥ +100% realized | Matches Lottery Finder UI definition |
| Concentration test | Coefficient of variation across strata | `feedback_uniform_lift_is_leakage` |
| Backfill batch size | 500 rows / INSERT | `feedback_batched_inserts` |
| Backfill concurrency | semaphore=3 + jitter | UW 429 history |
| Session window | 08:30–15:00 CT | `feedback_extended_hours` |

---

## Files to create / modify

### Create
- `api/_lib/db-migrations.ts` — append migration #122 (modify, not create)
- `scripts/backfill-net-prem-ticks.mjs`
- `ml/experiments/lottery-net-flow-eda/README.md`
- `ml/experiments/lottery-net-flow-eda/extract_features.py`
- `ml/experiments/lottery-net-flow-eda/analyze.py`
- `ml/experiments/lottery-net-flow-eda/report.md` (output, written by analyze.py)
- `ml/plots/lottery-net-flow-eda/*.png` (output)

### Modify
- `api/__tests__/db.test.ts` (mock counts + applied list)

### Not modified (intentionally)
- `api/cron/detect-lottery-fires.ts` — Phase 3 deferred
- `api/_lib/lottery-finder.ts` — no schema change to fires output
- Any frontend file — no UI work in this spec

---

## Done when

- [ ] Phase 1: `net_flow_per_ticker_history` table populated with ≥ 21 days × ≥ 45 tickers worth of rows
- [ ] Phase 2: `report.md` exists with top-3 features + leakage flags + recommendation
- [ ] Decision recorded (in this spec, appended): which feature wins, ship-as-flag-or-kill
- [ ] If recommendation = ship: new spec opened for the production cron + flag column

---

## Notes

- This is research, not production. The Get It Right loop still applies for Phase 1 (backend code), but Phase 2 is exploratory — code review subagent on EDA scripts is overkill. Run lint + tests on Phase 1, eyeball Phase 2 outputs.
- Per `feedback_no_silent_methodology_changes`: if during analysis a metric or feature definition changes, append a "Methodology amendment" section to this spec BEFORE re-running.
- Per `feedback_subagent_driven`: Phase 1 (backfill + migration) and Phase 2 (EDA scaffold) are independent — can dispatch in parallel after this spec is approved.
