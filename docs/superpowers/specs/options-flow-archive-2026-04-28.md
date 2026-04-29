# EOD Options Flow Archive (UW bot-eod-report → Parquet → Vercel Blob)

## Goal

Convert the nightly Unusual Whales `bot-eod-report-{date}.csv` exports (~3 GB / 10.6M rows / day, manually downloaded) into a **typed, schema-stable Parquet archive on Vercel Blob** that can be queried directly from `ml/` (DuckDB / Polars) and from the Railway sidecar without ever round-tripping through Vercel Functions or Neon.

**Not** going into Neon. **Not** going through a browser upload form. Local CLI script → Parquet → Blob.

## Why Parquet, not Neon

- 1 year × 3 GB CSV ≈ 1.1 TB raw. Neon at $0.30/GB-month → ~$330/mo.
- Same data as Parquet (zstd) ≈ 100–150 GB. Vercel Blob at $0.15/GB-month → ~$20/mo.
- Workload is **analytical scans** (group by ticker × strike × hour), not OLTP point lookups. Parquet column pruning + predicate pushdown is the correct shape.
- Postgres can still receive **derived aggregates** (e.g. daily SPX 0DTE summary rows) via a separate cron once the analytical layer is in place.

## Status

- ✅ Phase 1 (ingest script) — shipped 2026-04-28, commit `08ba1f41`
- ✅ Multipart upload fix — shipped 2026-04-28, commit `2cba2d3e`
- ✅ Phase 2 (backfill) — shipped 2026-04-28, commit `ccb9a971`. Archive populated with 12 days × ~10M rows.
- ⏳ Phase 3 (read helpers) — next
- ⏳ Phase 4 (outlier detection) — depends on Phase 3
- ⏳ Phase 5 (exploration & validation) — research notebook + findings doc
- ⏸ Phase 6 (nightly automation) — deferred
- 🔁 Phase 7 (verification) — rolling, updated as each phase ships

## Schema (frozen — pin explicitly in Polars)

CSV order is preserved. Polars `dtype` is the wire-level type used by `scan_csv(schema=...)` and `sink_parquet`. Postgres column is what we'd use **only if** we later push aggregates — not at archive time.

| #   | CSV column                  | Polars dtype                                                     | Notes                                                                                                             |
| --- | --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `executed_at`               | `Datetime("us", "UTC")`                                          | UW gives `2026-04-24 13:30:00.002365+00` — microsecond precision in UTC.                                          |
| 2   | `underlying_symbol`         | `Categorical`                                                    | ~5K unique tickers. Dictionary encoding is huge here.                                                             |
| 3   | `option_chain_id`           | `Utf8`                                                           | OCC-style: `SPY260515P00650000`. High cardinality, no dict benefit.                                               |
| 4   | `side`                      | `Enum(["ask", "bid", "mid", "no_side"])`                         | Closed set verified from sample. UW classification of who hit the print.                                          |
| 5   | `strike`                    | `Float64`                                                        | Some products have non-integer strikes; safe over Int.                                                            |
| 6   | `option_type`               | `Enum(["put", "call"])`                                          | Closed set.                                                                                                       |
| 7   | `expiry`                    | `Date`                                                           | No time component.                                                                                                |
| 8   | `underlying_price`          | `Float64`                                                        | Spot at print time.                                                                                               |
| 9   | `nbbo_bid`                  | `Float64`                                                        |                                                                                                                   |
| 10  | `nbbo_ask`                  | `Float64`                                                        |                                                                                                                   |
| 11  | `ewma_nbbo_bid`             | `Float64`                                                        | UW's smoothed NBBO. Useful for less-noisy aggressor detection.                                                    |
| 12  | `ewma_nbbo_ask`             | `Float64`                                                        |                                                                                                                   |
| 13  | `price`                     | `Float64`                                                        | Execution price.                                                                                                  |
| 14  | `size`                      | `Int32`                                                          | Contract count for this print. Max observed ~100K.                                                                |
| 15  | `premium`                   | `Float64`                                                        | size × price × 100. SPX whale prints can hit $50M+.                                                               |
| 16  | `volume`                    | `Int32`                                                          | Running daily volume on this contract.                                                                            |
| 17  | `open_interest`             | `Int32`                                                          | OI as of prior close.                                                                                             |
| 18  | `implied_volatility`        | `Float64`                                                        |                                                                                                                   |
| 19  | `delta`                     | `Float64`                                                        | Per-contract Greek at print time.                                                                                 |
| 20  | `theta`                     | `Float64`                                                        |                                                                                                                   |
| 21  | `gamma`                     | `Float64`                                                        |                                                                                                                   |
| 22  | `vega`                      | `Float64`                                                        |                                                                                                                   |
| 23  | `rho`                       | `Float64`                                                        | Keep — costs ~80 MB/yr, useful for rate-sensitive products.                                                       |
| 24  | `theo`                      | `Float64`                                                        | UW's theoretical fair value.                                                                                      |
| 25  | `sector`                    | `Categorical`                                                    | GICS sector; null for ETF/Index.                                                                                  |
| 26  | `exchange`                  | `Categorical`                                                    | Exchange code (XPHO, XCBO, etc.). ~20 unique.                                                                     |
| 27  | `report_flags`              | `Utf8`                                                           | Postgres-array literal like `{}` or `{stopped_stock,intermarket_sweep}`. Keep raw at archive time; parse on read. |
| 28  | `canceled`                  | `Boolean`                                                        | UW gives `f`/`t` — cast at ingest.                                                                                |
| 29  | `upstream_condition_detail` | `Categorical`                                                    | "auto" dominates; small closed-ish set.                                                                           |
| 30  | `equity_type`               | `Enum(["ADR", "Common Stock", "ETF", "Index", "Other", "Unit"])` | Closed set verified from sample.                                                                                  |

**Added at write time (not in CSV):**

| Column        | Type                    | Source                                                                                                   |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `date`        | `Date`                  | Extracted from filename via regex `bot-eod-report-(\d{4}-\d{2}-\d{2})\.csv`. Used as Hive partition key. |
| `ingested_at` | `Datetime("us", "UTC")` | Wall-clock time of conversion. Audit trail.                                                              |

## Storage layout (Vercel Blob)

Hive-partitioned for native partition pruning in DuckDB and Polars `scan_parquet`:

```text
flow/year=2026/month=04/day=24/data.parquet
flow/year=2026/month=04/day=25/data.parquet
...
```

A query like `SELECT * FROM flow WHERE date >= '2026-04-01'` will skip every directory outside that range without opening the files.

**Compression:** zstd level 3 (good balance; level 9 only saves ~5% but takes 3× longer).
**Row group size:** 1M rows (Polars default; works well for analytical scans).
**Sort order before write:** `(underlying_symbol, executed_at)` — improves dict compression and lets SPX/SPY-only queries scan less.

## Validation rules (hard fails, no silent NaN)

These run inside the ingest script and abort with a clear error before any Blob upload:

1. **Unknown column** — if the CSV header has a column not in the 30-column schema, abort. Forces explicit acknowledgement of UW schema changes.
2. **Missing column** — same.
3. **Type cast failure** — Polars `strict=True` on `scan_csv`. Any row that won't cast aborts with line number.
4. **Empty file** — abort if row count == 0.
5. **Sanity floor** — warn if row count < 1M (a normal day is ~10M; <1M means the file is truncated or it's a half-session like Black Friday).
6. **Closed-enum drift** — if `side`, `option_type`, or `equity_type` produce a value outside the declared Enum, abort. (UW _adding_ a category is rare but it's load-bearing for ML; we want the script to break loudly so we can update the enum deliberately.)

## Phases

### Phase 1 — Ingest script (single Python file, no Node helper)

- [x] `scripts/ingest-flow.py` — CLI: `ml/.venv/bin/python scripts/ingest-flow.py <YYYY-MM-DD> [--input-dir ~/Downloads/EOD-OptionFlow] [--dry-run] [--keep-csv]`
- [x] Reads CSV via `pl.scan_csv(schema=FLOW_SCHEMA, ...)` — streaming, no full RAM load
- [x] Validates header column-by-column (hard fail on missing or extra columns vs the 30-column spec)
- [x] **Filters to regular cash session: 13:30–20:00 UTC (08:30–15:00 CT) inclusive of 08:30, exclusive of 15:00.**
- [x] Drops rows where `report_flags` contains `extended_hours_trade` (defense in depth)
- [x] Sorts by `(underlying_symbol, executed_at)`
- [x] Validates closed enums (`side`, `option_type`, `equity_type`) — hard fail if UW adds a category
- [x] Writes local Parquet to `~/.flow-archive/year=YYYY/month=MM/day=DD/data.parquet` with zstd level 3, 1M row groups
- [x] Uploads directly to Vercel Blob via REST API (`PUT https://vercel.com/api/blob/?pathname=...`, headers verified against `@vercel/blob` 2.3.3 SDK source). Reads `BLOB_READ_WRITE_TOKEN` from env (`source .env.local` first).
- [x] Verifies upload by checking the response `pathname` matches what was sent
- [x] **Deletes source CSV** from `--input-dir` after upload (skip if `--keep-csv`)
- [x] **Deletes local Parquet** after upload (Blob is the single source of truth — local cache is rebuilt on demand by Phase 3 read helpers)
- [x] Prints summary: row count (raw → after filter), file size, compression ratio, top-10 underlyings by row count
- [x] Tests: `ml/tests/test_flow_ingest.py` — exercises `transform`, `validate_categoricals`, `validate_header`, `blob_pathname` with synthetic LazyFrames and tmp_path CSV fixtures.

### Phase 2 — Backfill (DONE)

- [x] `scripts/backfill-flow.sh` — bash 3.2-compatible loop over `~/Downloads/EOD-OptionFlow/*.csv`, sequential, stops on first failure, pre-flight token check
- [x] Idempotent via the ingest script's delete-after-upload behavior (CSV gone = uploaded)
- [x] Backfill executed 2026-04-28: 12 days × ~10M rows ingested in ~8 min total (multipart added mid-run for >100 MB Parquets)

### Phase 3 — Read helpers

The bridge from "data is in Blob" to "I can query it from Python." Lazy local cache (`~/.flow-archive-cache/`) so first read pays the download once and every subsequent query is local-disk-fast.

- [ ] `ml/src/flow_archive.py`:
  - `list_archive_dates() -> list[date]` — call Vercel Blob `list` API with `prefix=flow/`, parse pathnames into `date` objects, return sorted
  - `ensure_local(date) -> Path` — check `~/.flow-archive-cache/year=YYYY/month=MM/day=DD/data.parquet`; if missing, download from Blob; return the local Path. Idempotent.
  - `load_flow(date_or_range, tickers=None, columns=None) -> pl.LazyFrame` — accepts a single `date`, a `(start, end)` tuple, or a list of dates; returns a Polars LazyFrame backed by `pl.scan_parquet(paths)` with optional pushdown filters/projections applied lazily
  - `clear_cache(before: date | None = None)` — utility for disk-space management
  - `_download_blob(blob_path: str, local_path: Path)` — internal; uses `BLOB_READ_WRITE_TOKEN` from env, single-shot GET (Blob serves Parquet just fine over plain HTTPS once authed)
- [ ] `ml/tests/test_flow_archive.py` — mock `requests.get`/`requests.request` to verify cache hit/miss behavior, list-API parsing, lazy frame composition, and pushdown pass-through. Use `tmp_path` for cache dir override.
- [ ] `docs/flow-archive-recipes.md` — short reference for end users:
  - "Get the last 5 days for SPY only, just the columns you care about"
  - "Find the top-100 premium prints across the whole archive"
  - "Stream a date range without exploding RAM"

### Phase 4 — Outlier detection (the "needles in the haystack" layer)

The mechanical part of "find the prints that drive price." Multi-criteria scoring rather than a single threshold — a print scores points for each axis it's extreme on, and high-score prints are the ones to look at.

- [ ] `ml/src/flow_outliers.py`:
  - `score_prints(df: pl.DataFrame) -> pl.DataFrame` — adds a `significance_score` integer column plus a `score_breakdown` struct showing which criteria contributed. Pure function; no I/O.
  - `find_outliers(date_or_range, *, min_score=4, tickers=None) -> pl.DataFrame` — convenience: `load_flow` → `score_prints` → filter by score. Returns scored prints sorted descending by score.
  - `add_forward_returns(outliers, candles_df, *, intervals=(5, 15, 30, 60)) -> pl.DataFrame` — for each outlier, join the underlying's price at `executed_at + N min` and compute log returns. SPX bars come from your existing `spx_candles_1m` cron table; helper accepts a `pl.DataFrame` of candles to keep this layer storage-agnostic.
  - `summarize_outlier_outcomes(outliers_with_returns) -> pl.DataFrame` — group by criteria-bucket (signed side × DTE × time-of-day × score-band), compute hit rate / mean return / Sharpe per bucket. The output of this table is what tells you which kind of outlier actually pays.
- [ ] `ml/tests/test_flow_outliers.py` — synthetic flow with known outliers (one $6M 0DTE put-sell, one $200K deep-ITM call that should NOT score, one sweep block) and assert the scoring tags them correctly. Test forward-return joining against synthetic candles. Test summary aggregation math.

### Phase 5 — Exploration & validation (the part where we find out if this works)

This is the research step that decides whether the scoring framework actually identifies tradeable signal. Not "build a model" — instead, walk through historical detections one by one with eyes on, then look at aggregate statistics.

The notebook is what produces evidence; the spec is what describes the evidence we'd need to see.

- [ ] `ml/notebooks/outlier-discovery.py` (plain script, not `.ipynb` — easier to diff and re-run):
  1. **Inventory** — `list_archive_dates()` and report what we have (12+ days as of 2026-04-28)
  2. **Detection sweep** — `find_outliers(all_dates, min_score=4)` — print count + per-day breakdown
  3. **Top-by-day review** — for each archive day, dump the top 5 outliers with full context (executed_at, ticker, strike, type, side, premium, DTE, score breakdown). User reads through manually and tags each as: real-signal / noise / unsure.
  4. **Forward-return analysis** — join SPX 1-min candles (from existing Postgres `spx_candles_1m` table, hydrated to Parquet for offline use) and compute realized 5/15/30/60-min returns conditional on signed direction implied by the print
  5. **Stratified hit-rate table** — break the universe down by:
     - Signed direction (bullish put-sell, bullish call-buy, bearish put-buy, bearish call-sell)
     - Time of day bucket (open/morning/midday/afternoon/close)
     - DTE (0DTE / 1DTE / 2-7DTE / longer)
     - Ticker family (SPX-complex / index ETFs / single names)
  6. **Concentration check** — applying the `feedback_uniform_lift_is_leakage` rule: if hit rate is uniformly elevated across all buckets, kill the signal. If it concentrates in 1-2 buckets, that's real edge worth productizing.
- [ ] `ml/findings/outlier-detection-2026-04-28.md` — written-up findings: what scored, what worked, what didn't, what threshold to use going forward, what features to add to the user's existing 2 intraday detectors

**Decision gates from the notebook output:**

- If hit rate (signed direction matches forward-return sign at 30 min) is **>60% in some bucket** → that bucket's an exploitable edge; build a live alert
- If hit rate is **45–55% across all buckets** → no edge in this scoring scheme; revisit the criteria weights or look at different axes
- If we get **<10 candidates per day** → loosen `min_score` and re-run; if **>500 per day** → tighten

### Phase 6 — Nightly automation (deferred — manual for now)

- [ ] Once daily ingest is reliable (currently is — 12/12 days have processed cleanly), add a launchd plist (macOS) that watches `~/Downloads/EOD-OptionFlow/` and runs `ingest-flow.py` when a new file lands. Optional — not part of MVP.

### Phase 7 — Verification (rolling)

- [x] Phase 1 verification: 17 unit tests, real CSV header validates, live Blob upload tested
- [x] Phase 2 verification: 12-day backfill executed end-to-end
- [ ] Phase 3 verification: load `2026-04-22` via `load_flow`, row count matches the live-test summary (9,155,800)
- [ ] Phase 4 verification: synthetic-fixture tests + spot-check the NDXP 27000P 2026-04-28 print scores ≥4
- [ ] Phase 5 verification: notebook runs end-to-end on the archive without errors, produces a hit-rate table, findings doc written

## Files

**Created (Phases 1-2 — DONE):**

- `scripts/ingest-flow.py` — main ingest CLI, single Python file, all logic incl. multipart Blob upload
- `ml/tests/test_flow_ingest.py` — 17 unit tests covering transform, header validation, enum validation, dispatch threshold, multipart chunking
- `scripts/backfill-flow.sh` — bash 3.2 orchestrator over local CSVs

**To create (Phase 3 — read helpers):**

- `ml/src/flow_archive.py` — `list_archive_dates`, `ensure_local`, `load_flow`, `clear_cache`, internal `_download_blob`
- `ml/tests/test_flow_archive.py` — mock-based tests for cache hit/miss + lazy frame composition
- `docs/flow-archive-recipes.md` — short query reference

**To create (Phase 4 — outlier detection):**

- `ml/src/flow_outliers.py` — `score_prints`, `find_outliers`, `add_forward_returns`, `summarize_outlier_outcomes`
- `ml/tests/test_flow_outliers.py` — synthetic-fixture tests with known outliers + known noise

**To create (Phase 5 — exploration):**

- `ml/notebooks/outlier-discovery.py` — research script that runs the full pipeline end-to-end on the archive
- `ml/findings/outlier-detection-2026-04-28.md` — findings writeup (what worked, what didn't, thresholds to use)

**Modified:**

- `ml/requirements.txt` — adds `polars>=1.20` (pyarrow + requests already present, used for Blob REST PUT)

**Not modified:**

- No Vercel Function changes — script reads `BLOB_READ_WRITE_TOKEN` directly from local env after `source .env.local`. No signed-URL endpoint needed for an owner-only single-machine workflow.
- No Neon migration
- No frontend UI changes

## Constants & locked decisions

**Storage:**

- **Blob prefix:** `flow/`
- **Hive partition keys:** `year`, `month`, `day` (zero-padded)
- **Compression:** zstd, level 3
- **Row group size:** 1,048,576 (Polars default)
- **Sort key:** `(underlying_symbol, executed_at)`
- **Local cache root:** `~/.flow-archive/` (transient — populated on read, cleared after upload)
- **Sanity floor:** 1,000,000 rows minimum before warn

**Ingest behavior (locked 2026-04-28):**

- **Tickers:** archive ALL tickers UW exports — no underlying filter (~10.6M rows/day)
- **Time filter:** PRE-filter to regular cash session 13:30–20:00 UTC (08:30–15:00 CT) at ingest. Drop `extended_hours_trade` flagged rows.
- **Blob upload:** direct PUT from Python `requests` to `https://vercel.com/api/blob/?pathname=...` with `BLOB_READ_WRITE_TOKEN` from local env. Headers (`x-api-version: 12`, `x-vercel-blob-access: private`, etc.) verified against `@vercel/blob` 2.3.3 SDK source.
- **CSV cleanup:** DELETE source CSV from `--input-dir` after upload verification (response pathname matches sent pathname). Override with `--keep-csv` flag for paranoia.

**Outlier scoring criteria (Phase 4 — initial weights, tune in Phase 5):**

A print earns 1 point per criterion satisfied. Default `min_score=4` for `find_outliers`. Weights are tunable; this is the v1 scheme.

| Criterion | Test | Captures |
| --- | --- | --- |
| Premium ≥ $1M | `premium >= 1_000_000` | Capital committed |
| Premium ≥ $5M | `premium >= 5_000_000` | Whale-level conviction |
| 0DTE | `expiry == executed_at::date` | High-conviction timing |
| Aggressive sweep | `report_flags` contains `intermarket_sweep` | Time-sensitive urgency |
| Outside NBBO | `price > nbbo_ask OR price < nbbo_bid` | Paid through the spread |
| Volume spike | `size >= 5σ` vs that contract's prior-bar baseline | Statistical anomaly |
| Delta-weighted size large | `abs(size × delta × 100 × underlying_price) >= $10M` | Mechanical hedging pressure |

**Forward-return windows (Phase 4):** 5, 15, 30, 60 minutes (and EOD).
**Hit-rate threshold for "edge" (Phase 5 decision gate):** ≥60% sign-match in some bucket.

## Open questions

1. **Drop columns to save space?** Candidates:
   - `rho` — ~80 MB/yr; trader hasn't used rho in the analyze prompt to date. **Default: keep** (cheap insurance).
   - `theo` — UW's theoretical price; mostly redundant with `(nbbo_bid + nbbo_ask) / 2`. **Default: keep**.
   - `sector` — null for SPX/SPY/QQQ/NDX (the only tickers user trades). **Default: keep** (might be useful for future single-name work).
   - `upstream_condition_detail` — almost always `auto`. **Default: keep raw**, decide later.

2. **Schema versioning?** If UW adds a column in 2027, do we version the Parquet schema (`flow_v1/`, `flow_v2/`) or evolve in place?
   - **Default:** evolve in place if the change is additive (new optional column → fill with null for older files). Hard fork to `flow_v2/` only on breaking changes.

## Out of scope (separate specs if/when needed)

- Pushing aggregates to Neon — separate cron + table once analytical layer is proven
- Browser upload UI — explicitly rejected (see Goal section)
- Real-time / intraday flow — UW EOD reports are the data source, not live API
- Cross-broker enrichment (e.g. attaching Schwab fill prices to UW prints)
