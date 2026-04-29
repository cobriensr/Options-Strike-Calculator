# Flow Archive Recipes

Quick-reference patterns for querying the EOD options flow Parquet archive on Vercel Blob via [`ml/src/flow_archive.py`](../ml/src/flow_archive.py). Spec: [docs/superpowers/specs/options-flow-archive-2026-04-28.md](superpowers/specs/options-flow-archive-2026-04-28.md).

## Setup

Every Python session that reads from the archive needs `BLOB_READ_WRITE_TOKEN` exported. Do this once in your shell:

```bash
set -a; source .env.local; set +a
```

Then in Python:

```python
import sys
sys.path.insert(0, "ml/src")
from flow_archive import list_archive_dates, ensure_local, load_flow, clear_cache
```

(Or use the project's standard pattern of running scripts from the repo root with the `ml/.venv` Python — `ml/src` is already on `sys.path` via `ml/conftest.py`.)

## What's in the archive right now?

```python
dates = list_archive_dates()
print(f"{len(dates)} dates available: {dates[0]} → {dates[-1]}")
```

Calls Vercel Blob's list API with `prefix=flow/` and parses pathnames into `date` objects. Cheap (one HTTP call per ~1000 blobs).

## One day, all rows

```python
df = load_flow("2026-04-22").collect()
```

First call downloads the Parquet to `~/.flow-archive-cache/year=YYYY/month=MM/day=DD/data.parquet` (~5-10 seconds for a 500 MB file). Subsequent calls are instant — local Parquet scan at ~3-5 GB/s.

## Last 5 days, SPY only, just the columns I care about

```python
import polars as pl

df = (
    load_flow(
        ("2026-04-24", "2026-04-28"),
        tickers=["SPY"],
        columns=["executed_at", "strike", "option_type", "side", "premium"],
    )
    .filter(pl.col("premium") >= 1_000_000)
    .collect()
)
```

The tuple `(start, end)` form intersects with what's actually in the archive — weekends and gaps are skipped automatically. Both `tickers=` and `columns=` push down to Parquet via Polars, so the on-disk read is minimized.

## Top 100 premium prints across the whole archive

```python
top100 = (
    load_flow(("2026-04-13", "2026-04-28"))
    .sort("premium", descending=True)
    .limit(100)
    .collect()
)
```

Lazy: the sort fans out across the per-day Parquets, only the top 100 surface. Memory-bounded regardless of archive size.

## Stream a date range without exploding RAM

```python
import polars as pl

streamed = (
    load_flow(("2026-04-13", "2026-04-28"))
    .filter(pl.col("expiry") == pl.col("executed_at").dt.date())  # 0DTE only
    .group_by("underlying_symbol")
    .agg(
        n_prints=pl.len(),
        total_premium=pl.col("premium").sum(),
    )
    .sort("total_premium", descending=True)
    .collect(engine="streaming")
)
```

`engine="streaming"` keeps memory flat by chunking. Useful for archive-wide aggregations.

## Per-minute synthesized underlying bars (for Phase 5 forward returns)

No external data source needed. Each row has `underlying_price` snapped to the moment that option printed:

```python
minute_bars = (
    load_flow("2026-04-22")
    .select(["executed_at", "underlying_symbol", "underlying_price"])
    .with_columns(minute=pl.col("executed_at").dt.truncate("1m"))
    .group_by(["underlying_symbol", "minute"])
    .agg(close=pl.col("underlying_price").last())
    .sort(["underlying_symbol", "minute"])
    .collect()
)
```

Dense for SPX/SPY/QQQ/NDX/NDXP (every minute populated). Forward-fill within the session for thinner tickers.

## Cache management

```python
# Total disk usage
import subprocess
subprocess.run(["du", "-sh", "/Users/charlesobrien/.flow-archive-cache"])

# Drop everything
clear_cache()

# Keep only the last 30 days
from datetime import date, timedelta
clear_cache(before=date.today() - timedelta(days=30))
```

The cache is fully reconstructible from Blob, so deletion is non-destructive — next read of a cleared date pays the download cost once and re-populates.

## Common gotchas

- **`BLOB_READ_WRITE_TOKEN` not set** → `RuntimeError: BLOB_READ_WRITE_TOKEN not set`. Source `.env.local` first.
- **Date not in archive** → empty result for ranges (silently); for single dates, the download will 404. Always use `list_archive_dates()` to confirm what's available before assuming a date exists.
- **`tickers` filter on a column you also project** → no problem; if you forget to include `underlying_symbol` in `columns`, `load_flow` adds it automatically when there's a ticker filter.
- **Polars version drift** — schema casts assume Polars 1.20+; older versions may not have `Datetime("us", "UTC")` arithmetic on `dt.time()`.
