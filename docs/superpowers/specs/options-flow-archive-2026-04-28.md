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

Not started. This spec defines the schema first; implementation follows in phases.

## Schema (frozen — pin explicitly in Polars)

CSV order is preserved. Polars `dtype` is the wire-level type used by `scan_csv(schema=...)` and `sink_parquet`. Postgres column is what we'd use **only if** we later push aggregates — not at archive time.

| # | CSV column | Polars dtype | Notes |
|---|---|---|---|
| 1 | `executed_at` | `Datetime("us", "UTC")` | UW gives `2026-04-24 13:30:00.002365+00` — microsecond precision in UTC. |
| 2 | `underlying_symbol` | `Categorical` | ~5K unique tickers. Dictionary encoding is huge here. |
| 3 | `option_chain_id` | `Utf8` | OCC-style: `SPY260515P00650000`. High cardinality, no dict benefit. |
| 4 | `side` | `Enum(["ask", "bid", "mid", "no_side"])` | Closed set verified from sample. UW classification of who hit the print. |
| 5 | `strike` | `Float64` | Some products have non-integer strikes; safe over Int. |
| 6 | `option_type` | `Enum(["put", "call"])` | Closed set. |
| 7 | `expiry` | `Date` | No time component. |
| 8 | `underlying_price` | `Float64` | Spot at print time. |
| 9 | `nbbo_bid` | `Float64` | |
| 10 | `nbbo_ask` | `Float64` | |
| 11 | `ewma_nbbo_bid` | `Float64` | UW's smoothed NBBO. Useful for less-noisy aggressor detection. |
| 12 | `ewma_nbbo_ask` | `Float64` | |
| 13 | `price` | `Float64` | Execution price. |
| 14 | `size` | `Int32` | Contract count for this print. Max observed ~100K. |
| 15 | `premium` | `Float64` | size × price × 100. SPX whale prints can hit $50M+. |
| 16 | `volume` | `Int32` | Running daily volume on this contract. |
| 17 | `open_interest` | `Int32` | OI as of prior close. |
| 18 | `implied_volatility` | `Float64` | |
| 19 | `delta` | `Float64` | Per-contract Greek at print time. |
| 20 | `theta` | `Float64` | |
| 21 | `gamma` | `Float64` | |
| 22 | `vega` | `Float64` | |
| 23 | `rho` | `Float64` | Keep — costs ~80 MB/yr, useful for rate-sensitive products. |
| 24 | `theo` | `Float64` | UW's theoretical fair value. |
| 25 | `sector` | `Categorical` | GICS sector; null for ETF/Index. |
| 26 | `exchange` | `Categorical` | Exchange code (XPHO, XCBO, etc.). ~20 unique. |
| 27 | `report_flags` | `Utf8` | Postgres-array literal like `{}` or `{stopped_stock,intermarket_sweep}`. Keep raw at archive time; parse on read. |
| 28 | `canceled` | `Boolean` | UW gives `f`/`t` — cast at ingest. |
| 29 | `upstream_condition_detail` | `Categorical` | "auto" dominates; small closed-ish set. |
| 30 | `equity_type` | `Enum(["ADR", "Common Stock", "ETF", "Index", "Other", "Unit"])` | Closed set verified from sample. |

**Added at write time (not in CSV):**

| Column | Type | Source |
|---|---|---|
| `date` | `Date` | Extracted from filename via regex `bot-eod-report-(\d{4}-\d{2}-\d{2})\.csv`. Used as Hive partition key. |
| `ingested_at` | `Datetime("us", "UTC")` | Wall-clock time of conversion. Audit trail. |

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
6. **Closed-enum drift** — if `side`, `option_type`, or `equity_type` produce a value outside the declared Enum, abort. (UW *adding* a category is rare but it's load-bearing for ML; we want the script to break loudly so we can update the enum deliberately.)

## Phases

### Phase 1 — Ingest script

- [ ] `scripts/ingest-flow.py` — CLI: `python scripts/ingest-flow.py <YYYY-MM-DD> [--input-dir ~/Downloads/EOD-OptionFlow] [--dry-run] [--keep-csv]`
- [ ] Reads CSV via `pl.scan_csv(schema=FLOW_SCHEMA, ...)` — streaming, no full RAM load
- [ ] Validates per rules above; aborts on any failure
- [ ] **Filters to regular cash session: 13:30–20:00 UTC (08:30–15:00 CT) inclusive of 08:30, exclusive of 15:00.** Implemented as `executed_at.dt.time().is_between(time(13,30), time(20,0), closed="left")`.
- [ ] Drops rows where `report_flags` contains `extended_hours_trade` (defense in depth — UW occasionally tags ETH prints inside the time window).
- [ ] Sorts by `(underlying_symbol, executed_at)`
- [ ] Writes local Parquet to `~/.flow-archive/year=YYYY/month=MM/day=DD/data.parquet`
- [ ] Uploads to Vercel Blob at the same path under `flow/` via signed-URL PUT (see Phase 1b)
- [ ] **Verifies upload** — HEAD request to the Blob URL returns expected `Content-Length` matching local file size
- [ ] **Deletes source CSV** from `--input-dir` only after upload verification passes (skip if `--keep-csv`)
- [ ] **Deletes local Parquet** from `~/.flow-archive/` after successful upload (Blob is the single source of truth — local cache is rebuilt on demand by Phase 3 read helpers)
- [ ] Idempotent: if Blob path exists and matches CSV row count, skip upload unless `--force`
- [ ] Prints summary: row count (raw → after filter), file size, compression ratio, top-10 underlyings by row count

### Phase 1b — Signed-URL helper endpoint

- [ ] `api/_lib/blob-upload-url.ts` — generates a short-lived PUT signed URL for `flow/year=YYYY/month=MM/day=DD/data.parquet`
- [ ] `api/blob-upload-url.ts` — owner-only endpoint (`rejectIfNotOwner`) that returns the signed URL given a `{ date }` body. Bot-protect via `botid` and add to `protect` array in `src/main.tsx`.
- [ ] Python script calls this endpoint with the owner cookie (one-time export to env or stdin) before uploading.

### Phase 2 — Backfill

- [ ] `scripts/backfill-flow.sh` — wraps Phase 1 over the existing `~/Downloads/EOD-OptionFlow/*.csv` files (sequential — each takes ~2-3 min so 30 days = ~90 min)
- [ ] Skips already-uploaded dates (idempotent)

### Phase 3 — Read helpers

- [ ] `ml/src/flow_archive.py` — convenience module:
  - `load_flow(date | date_range, tickers=None, columns=None)` — returns Polars LazyFrame from Blob via signed URL or local cache
  - `local_cache_dir()` — `~/.flow-archive/`
  - `ensure_local(date)` — pulls from Blob if missing locally
- [ ] DuckDB recipe doc: how to query directly from Blob with `httpfs` extension

### Phase 4 — Nightly automation (deferred — manual for now)

- [ ] Once user is comfortable with the manual flow, add a launchd plist (macOS) that watches `~/Downloads/EOD-OptionFlow/` and runs `ingest-flow.py` when a new file lands. Optional — not part of MVP.

### Phase 5 — Verification

- [ ] `npm run review` passes (lint Python via ruff if it's wired; otherwise just verify TS/JS still green)
- [ ] Spot-check: load 2026-04-24 via `load_flow`, verify row count matches CSV `wc -l - 1`
- [ ] Compression check: 2.9 GB CSV → expect 250-450 MB Parquet
- [ ] Code-reviewer subagent verdict: pass

## Files

**Created:**

- `scripts/ingest-flow.py` — main ingest CLI
- `scripts/backfill-flow.sh` — wrapper for existing files
- `ml/src/flow_archive.py` — read helpers
- `ml/tests/test_flow_archive.py` — unit tests for load/cache logic (mock Blob)
- `docs/flow-archive-recipes.md` — DuckDB / Polars query examples

**Modified:**

- `pyproject.toml` (or wherever project deps live) — add `polars`, `pyarrow`. Blob upload uses raw HTTPS PUT against a signed URL (no Python Blob SDK required).
- `src/main.tsx` — add `/api/blob-upload-url` to the `protect` array in `initBotId()`.

**Not modified:**

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
- **Blob upload:** raw HTTPS PUT against signed URL from owner-only `/api/blob-upload-url` endpoint
- **CSV cleanup:** DELETE source CSV from `--input-dir` after upload verification passes (HEAD request matches local Content-Length). Override with `--keep-csv` flag for paranoia.

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
