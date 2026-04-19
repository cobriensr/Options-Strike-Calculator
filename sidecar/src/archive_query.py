"""DuckDB-backed queries over the seeded Databento archive.

The archive sits on the Railway persistent volume at `ARCHIVE_ROOT`
(default `/data/archive/`), populated by `archive_seeder`. DuckDB reads
Parquet directly — no server, no load step, no sidecar memory overhead
beyond the ~12 MB DuckDB library itself.

Design notes:

- **One module-level connection.** DuckDB is in-process and thread-safe;
  a single shared handle avoids re-planning queries and re-reading
  Parquet footer metadata on every call.
- **Year-partitioned globs.** `read_parquet('year=*/part.parquet')`
  lets DuckDB prune whole files when a query filters by year — e.g.
  a 2024 summary touches exactly one of the 17 year files.
- **Parameters over string interpolation.** Query plans cache by
  text, and SQL injection at this trust boundary would be embarrassing
  even on a single-owner tool. Paths and filters go through `execute(q, params)`.
- **Front-month selection.** On any ES trading day the front-month
  contract dominates volume. We pick "top symbol by volume on that day"
  rather than hardcoding a roll calendar — robust to early/late rolls
  and makes no assumption about the continuous series in the archive.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import duckdb

from logger_setup import log

_ROOT = Path(os.environ.get("ARCHIVE_ROOT", "/data/archive"))


def _ohlcv_glob(root: Path | None = None) -> str:
    """Parquet glob across year partitions. Override `root` for tests."""
    base = root or _ROOT
    return str(base / "ohlcv_1m" / "year=*" / "part.parquet")


def _symbology_path(root: Path | None = None) -> str:
    base = root or _ROOT
    return str(base / "symbology.parquet")


# Lazy module-level connection — built on first use so tests that point
# at a different root can construct their own.
_conn: duckdb.DuckDBPyConnection | None = None


def _connection() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        _conn = duckdb.connect()
        log.info("DuckDB connection initialized for archive queries")
    return _conn


def reset_connection_for_tests() -> None:
    """Drop the shared connection so a new one is built on next use.

    Tests that swap `_ROOT` or test_duckdb bindings call this so state
    doesn't leak across tests.
    """
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


# ---------------------------------------------------------------------------
# Public queries
# ---------------------------------------------------------------------------


def es_day_summary(
    date_iso: str,
    *,
    root: Path | None = None,
) -> dict[str, Any]:
    """Return a day-level summary of ES futures activity.

    Picks the top ES contract by volume for `date_iso` (de facto front
    month) and returns its OHLC + volume + bar count. `date_iso` is a
    `YYYY-MM-DD` string in UTC.

    Raises ValueError if the date has no ES bars in the archive.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Step 1 — pick the top ES contract by volume on this date.
    # Symbology uses 'ESH5' etc. for futures; options carry 'ES <date> C<strike>'
    # (note the space), which we exclude by forbidding spaces in the symbol.
    top_row = conn.execute(
        """
        SELECT sym.symbol
        FROM read_parquet(?) AS bars
        JOIN read_parquet(?) AS sym USING (instrument_id)
        WHERE sym.symbol LIKE 'ES%'
          AND strpos(sym.symbol, ' ') = 0
          AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        GROUP BY sym.symbol
        ORDER BY SUM(bars.volume) DESC
        LIMIT 1
        """,
        [ohlcv, symbology, date_iso],
    ).fetchone()

    if top_row is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    top_symbol = top_row[0]

    # Step 2 — aggregate OHLC for just that contract on that day.
    summary = conn.execute(
        """
        WITH filtered AS (
            SELECT bars.ts_event, bars.open, bars.high, bars.low,
                   bars.close, bars.volume
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        )
        SELECT FIRST(open ORDER BY ts_event) AS day_open,
               MAX(high)                     AS day_high,
               MIN(low)                      AS day_low,
               LAST(close ORDER BY ts_event) AS day_close,
               SUM(volume)                   AS day_volume,
               COUNT(*)                      AS bar_count
        FROM filtered
        """,
        [ohlcv, symbology, top_symbol, date_iso],
    ).fetchone()

    assert summary is not None  # filtered is non-empty by construction
    day_open, day_high, day_low, day_close, day_volume, bar_count = summary

    return {
        "date": date_iso,
        "symbol": top_symbol,
        "open": float(day_open),
        "high": float(day_high),
        "low": float(day_low),
        "close": float(day_close),
        "volume": int(day_volume),
        "bar_count": int(bar_count),
    }
