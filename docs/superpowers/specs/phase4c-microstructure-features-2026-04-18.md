# Phase 4c — Microstructure Feature Engineering — 2026-04-18

Part of the max-leverage roadmap. Phase 4c engineers per-day
microstructure features over the local TBBO Parquet archive built
in Phase 4a, producing an ML-ready feature matrix. No Railway, no
Neon, no Vercel — pure local Python + DuckDB.

## Goal

Produce `ml/data/features/microstructure_daily.parquet` — one row
per `(date, symbol)` pair with ~20 microstructure features derived
from the TBBO archive. Features cover OFI, spread widening, TOB
pressure, tick velocity. Phase 4d (separate spec) does EDA and
correlation analysis on the output; this phase just ships the
feature computation + tests.

## Input

- **Archive:** `ml/data/archive/tbbo/year={2025,2026}/part.parquet`
  (3.9 GB total, 210.6M rows, 16 instrument contracts)
- **Symbology:** `ml/data/archive/symbology.parquet` (shared, maps
  `instrument_id` → `symbol` string like `ESM5`, `ESZ5`, `NQM5`, etc.)
- **Degraded days:** `ml/data/archive/tbbo_condition.json` (6 days
  flagged). Feature rows for these dates should carry a
  `is_degraded` flag so downstream ML can filter.

## Output

`ml/data/features/microstructure_daily.parquet` with schema:

| Column                                                                  | Type   | Description                                                                     |
| ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `date`                                                                  | DATE   | Trading date (UTC)                                                              |
| `symbol`                                                                | TEXT   | "ES" or "NQ" — front-month aggregate, not contract-specific                     |
| `front_month_contract`                                                  | TEXT   | e.g., "ESZ5" — which contract was front on this date (top volume)               |
| `is_degraded`                                                           | BOOL   | True if date appears in tbbo_condition.json degraded list                       |
| `trade_count`                                                           | BIGINT | Total trades on the day                                                         |
| **OFI features**                                                        |        |                                                                                 |
| `ofi_5m_mean`                                                           | FLOAT  | Mean OFI across rolling 5-min windows during session                            |
| `ofi_5m_std`                                                            | FLOAT  | Std of 5-min OFI                                                                |
| `ofi_5m_abs_p95`                                                        | FLOAT  | 95th percentile of \|OFI\| at 5-min resolution                                  |
| `ofi_5m_pct_extreme`                                                    | FLOAT  | Fraction of 5-min windows with \|OFI\| > 0.3                                    |
| `ofi_15m_mean`, `ofi_15m_std`, `ofi_15m_abs_p95`, `ofi_15m_pct_extreme` | FLOAT  | Same for 15-min windows                                                         |
| `ofi_1h_mean`, `ofi_1h_std`, `ofi_1h_abs_p95`, `ofi_1h_pct_extreme`     | FLOAT  | Same for 1h windows                                                             |
| **Spread widening**                                                     |        |                                                                                 |
| `spread_widening_count_2sigma`                                          | INT    | Number of 1-min buckets with spread z-score > 2.0 (vs trailing 30-min baseline) |
| `spread_widening_count_3sigma`                                          | INT    | Same for z > 3.0                                                                |
| `spread_widening_max_zscore`                                            | FLOAT  | Peak z-score observed                                                           |
| `spread_widening_max_run_minutes`                                       | INT    | Longest consecutive run of z > 2.0                                              |
| **TOB pressure**                                                        |        |                                                                                 |
| `tob_extreme_minute_count`                                              | INT    | Count of minutes where median bid_size/ask_size > 1.5 OR < 0.67                 |
| `tob_max_run_buy_pressure`                                              | INT    | Longest consecutive run of ratio > 1.5 (minutes)                                |
| `tob_max_run_sell_pressure`                                             | INT    | Longest consecutive run of ratio < 0.67 (minutes)                               |
| `tob_mean_abs_log_ratio`                                                | FLOAT  | Mean of \|log(bid_size/ask_size)\| across session minutes                       |
| **Tick velocity**                                                       |        |                                                                                 |
| `tick_velocity_mean`                                                    | FLOAT  | Mean trades-per-minute during session                                           |
| `tick_velocity_p95`                                                     | FLOAT  | 95th percentile trades-per-minute                                               |
| `tick_velocity_max_minute`                                              | INT    | Highest single-minute trade count                                               |

Row count estimate: 2 symbols × ~252 trading days = **~500 rows**.

## Design choices

### Per-day front-month aggregation, not per-contract

For each `(date, symbol)` row, select the top-volume ES or NQ
contract that date and compute features over that contract's bars
only. This matches the existing `archive_query.py` pattern and
cleanly separates front-month trading signal from back-month noise.

Rationale: back-month contracts trade ~0.01% of front-month volume.
Aggregating across contracts would let back-month noise contaminate
feature stats that should reflect the "active" market.

### DuckDB over pandas

Query the Parquet directly via DuckDB rather than loading to pandas.

- Archive is 3.9 GB — pandas-loading even a single year is painful
- DuckDB predicate pushdown scans only needed date/symbol rows
- Same pattern as sidecar's `archive_query.py`

### Rolling windows done in SQL

Use `window function over (partition by ... order by ts range between)`
where practical; fall back to pandas for features that need Python-level
state machines (like "longest consecutive run").

### Deterministic feature ordering

Feature functions return `dict` in a documented order; the orchestrator
assembles them into a DataFrame with a fixed column schema. No
"columns appear in arbitrary order depending on which symbol happened
to process first" surprises.

## Files

### New

- `ml/src/features/__init__.py` (empty package marker, if not existing)
- `ml/src/features/microstructure.py` — the feature computation module.
  Exports:

  ```python
  def compute_daily_features(
      tbbo_glob: str,
      symbology_path: str,
      date_iso: str,
      symbol: str,  # "ES" or "NQ"
      *,
      condition_path: Path | None = None,
      conn: duckdb.DuckDBPyConnection | None = None,
  ) -> dict[str, Any] | None:
      """Compute one row of features for a given (date, symbol).
      Returns None if no trades for that (date, symbol) combo."""

  def backfill_daily_features(
      tbbo_root: Path,
      *,
      out_path: Path,
      start_date: str | None = None,
      end_date: str | None = None,
      symbols: Sequence[str] = ("ES", "NQ"),
  ) -> pd.DataFrame:
      """Iterate all (date, symbol) combos, compute features, write Parquet.
      start_date/end_date default to archive date range."""
  ```

  Plus private helpers: `_compute_ofi_stats`, `_compute_spread_widening_stats`,
  `_compute_tob_persistence_stats`, `_compute_tick_velocity_stats`,
  `_pick_front_month`, `_load_degraded_days`.

- `ml/tests/features/__init__.py` (if tests aren't flat)
- `ml/tests/test_microstructure_features.py` — unit tests.

### Modified

- `ml/requirements.txt` — add `duckdb>=1.0`. (Already in sidecar venv
  at 1.x; use the same major version for consistency.)

### Not touched

- `ml/src/archive_convert.py`, `ml/src/tbbo_convert.py` — Phase 4a, done.
- Anything in `api/`, `sidecar/`, `scripts/` — out of scope.
- `ml/data/archive/` — read-only input.

## Feature computation details

### OFI at window W minutes

For each minute `m` in the session, compute:

```
OFI_{m,W} = (buy_vol - sell_vol) / (buy_vol + sell_vol)

where sums are over (trade events with side = 'B') and
(side = 'S') respectively, within [m - W, m]. Exclude side = 'N'.
```

Skip the minute if `(buy_vol + sell_vol) == 0` or `buy_vol + sell_vol < 20`
(small-sample noise).

Day aggregates across all valid windows: mean, std, |p95|, fraction > 0.3.

### Spread widening z-score

For each minute `m`, compute median spread = median(ask_px - bid_px)
across all TBBO events in that minute.

Baseline for minute `m`: median + stddev of per-minute median spreads
from minutes `[m - 30, m - 1]`. If fewer than 10 baseline minutes (start
of session), skip.

Z-score = `(current_min_median - baseline_median) / baseline_std`.
Guard: if `baseline_std == 0`, treat z as 0 (no widening).

Day aggregates: count(z > 2), count(z > 3), max(z), longest consecutive
run of z > 2.

### TOB pressure persistence

For each minute `m`, compute the median `bid_sz_00 / ask_sz_00` across
all TBBO events in that minute. Guard `ask_sz_00 == 0` → skip.

Day aggregates: count of minutes with ratio > 1.5 OR < 0.67, longest
run in each direction, mean of |log(ratio)|.

### Tick velocity

Per-minute trade count (simple `COUNT(*)` grouping by minute). Day
aggregates: mean, p95, max per-minute.

## Backfill orchestration

`backfill_daily_features(...)`:

1. Determine date range from archive (min/max ts_recv per year partition).
2. For each date × symbol, call `compute_daily_features`. Skip when it
   returns None.
3. Collect results into a pandas DataFrame with the exact column order
   from the output schema above.
4. Sort by (date, symbol).
5. Write to `out_path` via `pq.write_table(table, out_path, compression='zstd', compression_level=3)`.
6. Log progress every 10 dates processed.
7. Return the DataFrame.

CLI entrypoint:

```
cd ml
.venv/bin/python -m src.features.microstructure \
    --tbbo-root data/archive \
    --out data/features/microstructure_daily.parquet
```

## Tests

### Unit tests

Mock DuckDB via a temporary in-process connection populated with
synthetic Parquet fixtures. Pattern: write tiny TBBO rows to a
tmpdir via pyarrow, point DuckDB at them, exercise each feature
function independently with hand-computable expected values.

Required cases:

1. **compute_ofi_stats — balanced flow:** 10 buy + 10 sell trades evenly
   spread → OFI mean ≈ 0, std ≈ 0.
2. **compute_ofi_stats — aggressive buyers:** 20 buy + 2 sell → OFI ≈ +0.82.
3. **compute_ofi_stats — sparse minute:** only 5 trades in a window →
   window is skipped (below 20-trade threshold).
4. **compute_spread_widening_stats — flat spreads:** all spreads = $0.25 →
   count_2sigma = 0, count_3sigma = 0, max_zscore = 0 (stddev=0 → z=0 guard).
5. **compute_spread_widening_stats — one wide spread event:** 30 minutes
   of $0.25 spreads + 1 minute of $2.50 spreads → count_2sigma ≥ 1.
6. **compute_tob_persistence_stats — sustained buy pressure:** 10 minutes
   of bid_sz/ask_sz = 2.0 → tob_max_run_buy_pressure = 10.
7. **compute_tob_persistence_stats — balanced:** all minutes with ratio
   in [0.67, 1.5] → tob_extreme_minute_count = 0.
8. **compute_tick_velocity_stats — uniform:** 60 trades/minute for 60
   minutes → mean = 60, p95 = 60, max = 60.
9. **compute_daily_features — no trades for (date, symbol):** returns None.
10. **compute_daily_features — happy path:** returns dict with all 20+
    feature keys, types match spec.
11. **\_pick_front_month:** given two contracts with different volumes,
    picks the higher-volume one.
12. **is_degraded flag:** mock condition.json with 2 degraded dates;
    those dates get `is_degraded=True`, others False.
13. **backfill_daily_features — happy path:** 3 dates × 2 symbols →
    6-row DataFrame with all columns present, sorted by (date, symbol).
14. **backfill_daily_features — date with missing data:** returns only
    rows that have trades; doesn't emit empty rows.

## Constraints

- **No new Python deps beyond `duckdb>=1.0`.** Use what's already in
  the ml venv (pandas, pyarrow, numpy, scikit-learn, matplotlib).
- **No DB writes.** No Neon, no Railway, no Vercel. Local file I/O only.
- **No model training or backtesting.** Pure feature computation.
- **Peak memory < 2 GB.** Rely on DuckDB's streaming scan; don't
  load entire days or symbols into pandas at once.
- **Runtime target:** backfill of ~500 feature rows completes in
  under 20 minutes on a MacBook.

## Done when

- `ml/src/features/microstructure.py` and
  `ml/tests/test_microstructure_features.py` exist and are self-contained.
- `cd ml && .venv/bin/pytest tests/test_microstructure_features.py`
  passes with all 14+ tests.
- `ruff check ml/src/features/ ml/tests/test_microstructure_features.py`
  clean.
- `ml/requirements.txt` includes `duckdb>=1.0`.
- Local trial run (user will execute, not the subagent):
  ```
  cd ml
  .venv/bin/pip install duckdb
  .venv/bin/python -m src.features.microstructure \
      --tbbo-root data/archive \
      --out data/features/microstructure_daily.parquet
  ```
  produces a non-empty Parquet with ~500 rows covering both symbols
  across the archive date range.
- Existing `test_tbbo_convert.py` + `test_archive_convert.py` still green
  (regression check).

## Out of scope for Phase 4c

- **EDA / signal validation** — Phase 4d (matplotlib plots, correlation
  with trade outcomes, cohort analysis).
- **Feature selection / dimensionality reduction** — defer until 4d shows
  which features carry signal.
- **Model training** — far downstream.
- **Railway / Vercel runtime integration** — Phase 4b (still paused).
- **Intraday-rolling features** (one-feature-per-minute time series).
  This phase ships per-day aggregates only. Minute-resolution features
  can be a follow-up if 4d shows the aggregates are too coarse.

## Open questions

- **Session windowing:** should features be computed over the full UTC
  day (all Globex hours) or restricted to RTH 13:30-20:00 UTC? Default:
  **full UTC day including overnight** — captures 0DTE pre-market
  dynamics that would be lost in RTH-only. 4d can compare both if useful.
- **Symbol exclusion:** if a date has no trades for ES (extremely rare,
  maybe a full market holiday), skip the row entirely rather than
  emitting zeros. Same for NQ.
