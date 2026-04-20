"""Load 1m OHLCV bars from the local Databento archive via DuckDB.

Mirrors the access pattern in `sidecar/src/archive_query.py`:
- Thread-local connection singleton — DuckDB's "thread-safe" only guarantees
  concurrent access won't crash, it still serializes queries on a shared
  connection. For the pytest / CLI use case here we're single-threaded, so
  this is mostly defensive symmetry with the sidecar module.
- `SET TimeZone = 'UTC'` on every new connection — prevents `date_trunc('day', ...)`
  from bucketing by host-local date, which would silently shift TBBO/OHLCV
  activity into the wrong calendar day on a non-UTC laptop.
- Year-partitioned parquet globs (`year=*/part.parquet`) so queries touching
  a bounded date range only read the relevant year files.
- Front-month-by-volume contract selection (pick the top-volume outright
  futures symbol per day) rather than a hardcoded roll calendar. Robust to
  early/late rolls and makes no assumption about the continuous series.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import duckdb
import pandas as pd

_DEFAULT_ROOT = Path(
    os.environ.get(
        "ARCHIVE_ROOT",
        str(Path(__file__).resolve().parents[3] / "ml" / "data" / "archive"),
    )
)

_tls = threading.local()


def _connection() -> duckdb.DuckDBPyConnection:
    """Thread-local DuckDB connection with UTC TimeZone forced."""
    conn: duckdb.DuckDBPyConnection | None = getattr(_tls, "conn", None)
    if conn is None:
        conn = duckdb.connect()
        # Pin session TimeZone to UTC so date_trunc() buckets by UTC calendar
        # regardless of host TZ. See sidecar/src/archive_query.py for the full
        # rationale (matches that module's discipline).
        conn.execute("SET TimeZone = 'UTC'")
        _tls.conn = conn
    return conn


def reset_connection_for_tests() -> None:
    """Drop the current thread's connection. Test-only hook."""
    conn: duckdb.DuckDBPyConnection | None = getattr(_tls, "conn", None)
    if conn is not None:
        conn.close()
        del _tls.conn


def _ohlcv_glob(root: Path | None = None) -> str:
    base = root or _DEFAULT_ROOT
    return str(base / "ohlcv_1m" / "year=*" / "part.parquet")


def load_bars(
    root_symbol: str,
    start: str,
    end: str,
    *,
    root: Path | None = None,
    continuous: bool = True,
) -> pd.DataFrame:
    """Load 1-minute OHLCV bars for a root symbol between [start, end).

    Parameters
    ----------
    root_symbol:
        Root symbol prefix, e.g. "NQ", "ES", "MNQ", "MES". Matches
        `{root_symbol}%` in the archive `symbol` column.
    start, end:
        Inclusive-start, exclusive-end timestamps. Accepts any string
        DuckDB parses as TIMESTAMPTZ ("2024-01-02", "2024-01-02 13:30:00+00").
    root:
        Archive root override. Defaults to `ml/data/archive/` or the
        `ARCHIVE_ROOT` env var.
    continuous:
        If True (default), return the day-by-day front-month contract
        concatenated into a continuous series (front-month picked by
        top daily volume among outright futures, excluding options and
        spreads). If False, return all outright contracts interleaved.

    Returns
    -------
    DataFrame with columns:
        ts_event (TIMESTAMPTZ, UTC), open, high, low, close, volume, symbol

    Empty DataFrame if no bars match.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)

    # `strpos(symbol, ' ') = 0` drops options (e.g. "ESH4 P4150").
    # `strpos(symbol, '-') = 0` drops spreads (e.g. "ESH4-ESM4").
    if continuous:
        query = """
            WITH daily_top AS (
                SELECT
                    CAST(date_trunc('day', ts_event) AS DATE) AS day,
                    symbol,
                    ROW_NUMBER() OVER (
                        PARTITION BY CAST(date_trunc('day', ts_event) AS DATE)
                        ORDER BY SUM(volume) DESC
                    ) AS rnk
                FROM read_parquet(?, hive_partitioning=True)
                WHERE symbol LIKE ? || '%'
                  AND strpos(symbol, ' ') = 0
                  AND strpos(symbol, '-') = 0
                  AND ts_event >= ?::TIMESTAMPTZ
                  AND ts_event < ?::TIMESTAMPTZ
                GROUP BY day, symbol
            )
            SELECT b.ts_event, b.open, b.high, b.low, b.close, b.volume, b.symbol
            FROM read_parquet(?, hive_partitioning=True) b
            JOIN daily_top t
                ON CAST(date_trunc('day', b.ts_event) AS DATE) = t.day
                AND b.symbol = t.symbol
                AND t.rnk = 1
            WHERE b.symbol LIKE ? || '%'
              AND strpos(b.symbol, ' ') = 0
              AND strpos(b.symbol, '-') = 0
              AND b.ts_event >= ?::TIMESTAMPTZ
              AND b.ts_event < ?::TIMESTAMPTZ
            ORDER BY b.ts_event
        """
        params = [ohlcv, root_symbol, start, end, ohlcv, root_symbol, start, end]
    else:
        query = """
            SELECT ts_event, open, high, low, close, volume, symbol
            FROM read_parquet(?, hive_partitioning=True)
            WHERE symbol LIKE ? || '%'
              AND strpos(symbol, ' ') = 0
              AND strpos(symbol, '-') = 0
              AND ts_event >= ?::TIMESTAMPTZ
              AND ts_event < ?::TIMESTAMPTZ
            ORDER BY ts_event
        """
        params = [ohlcv, root_symbol, start, end]

    return conn.execute(query, params).fetch_df()


def front_month_symbol(
    root_symbol: str,
    date_iso: str,
    *,
    root: Path | None = None,
) -> str | None:
    """Return the top-volume outright contract for a root symbol on a date.

    Used when tests or diagnostic scripts need to know *which* contract the
    continuous series resolved to on a given day.
    """
    conn = _connection()
    row = conn.execute(
        """
        SELECT symbol
        FROM read_parquet(?, hive_partitioning=True)
        WHERE symbol LIKE ? || '%'
          AND strpos(symbol, ' ') = 0
          AND strpos(symbol, '-') = 0
          AND CAST(date_trunc('day', ts_event) AS DATE) = ?::DATE
        GROUP BY symbol
        ORDER BY SUM(volume) DESC
        LIMIT 1
        """,
        [_ohlcv_glob(root), root_symbol, date_iso],
    ).fetchone()
    return row[0] if row else None
