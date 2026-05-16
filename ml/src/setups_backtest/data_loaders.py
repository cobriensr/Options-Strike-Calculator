"""Point-in-time data loaders for the futures-setups backtest.

Two data planes:
  1. Local Parquet archive (TBBO + OHLCV) read via DuckDB with predicate
     pushdown — handles the 200M+ TBBO rows without loading everything.
  2. Neon Postgres (futures_snapshots, futures_options_daily, zero_gamma_levels,
     greek_exposures_0dte) via psycopg2 — historical features that aren't in
     the parquet archive.

The pattern mirrors ``ml/src/features/microstructure.py``:
  - DuckDB session ``TimeZone = 'UTC'`` so ``date_trunc('day', ts)`` buckets the
    same way on a Chicago laptop vs a UTC cloud VM.
  - Front-month contract selected per (symbol, date) by top trading volume,
    excluding calendar spreads (hyphen) and options (space).
  - All returned timestamps are tz-aware UTC.

No look-ahead: every loader accepts a ``date`` or ``(start, end)`` boundary
and returns only data with ``ts <= end``. Callers are responsible for slicing
further (e.g., end-of-prior-minute when computing PIT features intra-day).
"""

from __future__ import annotations

import os
import warnings
from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

# psycopg2 raises a UserWarning under pandas read_sql_query; silence at import.
warnings.filterwarnings(
    "ignore",
    message="pandas only supports SQLAlchemy connectable",
    category=UserWarning,
)

try:
    import psycopg2
    from psycopg2.extensions import connection as PgConnection
except ImportError:  # pragma: no cover - install gate
    psycopg2 = None
    PgConnection = Any  # type: ignore[misc,assignment]


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ML_ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_ROOT = ML_ROOT / "data" / "archive"


def tbbo_glob() -> str:
    return str(ARCHIVE_ROOT / "tbbo" / "year=*" / "part.parquet")


def ohlcv_glob() -> str:
    return str(ARCHIVE_ROOT / "ohlcv_1m" / "year=*" / "part.parquet")


# ---------------------------------------------------------------------------
# DuckDB connection
# ---------------------------------------------------------------------------


def new_duckdb_connection() -> duckdb.DuckDBPyConnection:
    """Open a UTC-locked DuckDB connection.

    Setting ``TimeZone = 'UTC'`` is mandatory: DuckDB's ``date_trunc('day', ts)``
    on a ``TIMESTAMP WITH TIME ZONE`` honors the session TZ, so without this
    the same archive produces different daily buckets on CT vs UTC.
    """
    conn = duckdb.connect()
    conn.execute("SET TimeZone = 'UTC'")
    return conn


@contextmanager
def duckdb_session():
    """Context manager wrapping ``new_duckdb_connection()`` with auto-close."""
    conn = new_duckdb_connection()
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Front-month picker
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FrontMonth:
    symbol_prefix: str  # "ES" or "NQ"
    contract: str  # e.g. "ESM6"
    date: date


def pick_front_month(
    conn: duckdb.DuckDBPyConnection,
    symbol_prefix: str,
    on: date,
) -> str | None:
    """Top-volume outright contract for ``symbol_prefix`` on ``on``.

    Returns None if no trades for that prefix on that date. Excludes calendar
    spreads (``-``) and options (space). Tie-break is alphabetical to make the
    pick deterministic across runs.

    Intentionally simpler than ``ml/src/features/microstructure._pick_front_month``:
    we skip the ``symbology.parquet`` join because TBBO's ``symbol`` column is
    already resolved. The microstructure module keeps the join to mirror
    ``archive_query.py``; the backtest harness has no such constraint.

    Range-form ``ts_recv`` predicate (vs ``date_trunc(...) = ?::DATE``) ensures
    DuckDB pushes the date filter into the Parquet reader's row-group skip
    path, which matters when scanning 200M+ TBBO rows.
    """
    prefix = symbol_prefix.upper()
    if prefix not in {"ES", "NQ"}:
        raise ValueError(f"symbol_prefix must be 'ES' or 'NQ', got {symbol_prefix!r}")

    row = conn.execute(
        """
        SELECT symbol
        FROM read_parquet(?)
        WHERE symbol LIKE ?
          AND strpos(symbol, ' ') = 0
          AND strpos(symbol, '-') = 0
          AND ts_recv >= ?::TIMESTAMP
          AND ts_recv < (?::TIMESTAMP + INTERVAL '1 day')
        GROUP BY symbol
        ORDER BY SUM(size) DESC, symbol ASC
        LIMIT 1
        """,
        [tbbo_glob(), f"{prefix}%", on.isoformat(), on.isoformat()],
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# TBBO per-minute aggregates
# ---------------------------------------------------------------------------


def load_tbbo_minute(
    conn: duckdb.DuckDBPyConnection,
    contract: str,
    on: date,
) -> pd.DataFrame:
    """Per-minute aggregates for one contract on one UTC day.

    Columns:
      minute      tz-aware UTC datetime (bucket start)
      n_trades    count of trade events
      buy_vol     SUM(size) WHERE side='B'  (bid-aggressor, buy flow)
      sell_vol   SUM(size) WHERE side='A'  (ask-aggressor, sell flow)
      total_vol   SUM(size)
      vwap_price  SUM(price*size)/SUM(size)
      max_spread  MAX(ask_px_00 - bid_px_00)
      last_price  arg_max(price, ts_recv) — last trade in the minute
      ofi         (buy_vol - sell_vol) / (buy_vol + sell_vol), NaN if no flow
    """
    df = conn.execute(
        """
        SELECT
          date_trunc('minute', ts_recv) AS minute,
          COUNT(*) AS n_trades,
          COALESCE(SUM(size) FILTER (WHERE side = 'B'), 0)::BIGINT AS buy_vol,
          COALESCE(SUM(size) FILTER (WHERE side = 'A'), 0)::BIGINT AS sell_vol,
          SUM(size)::BIGINT AS total_vol,
          SUM(price * size) / NULLIF(SUM(size), 0) AS vwap_price,
          MAX(ask_px_00 - bid_px_00) AS max_spread,
          arg_max(price, ts_recv) AS last_price
        FROM read_parquet(?)
        WHERE symbol = ?
          AND ts_recv >= ?::TIMESTAMP
          AND ts_recv < (?::TIMESTAMP + INTERVAL '1 day')
        GROUP BY minute
        ORDER BY minute
        """,
        [tbbo_glob(), contract, on.isoformat(), on.isoformat()],
    ).df()

    if df.empty:
        return df

    df["minute"] = pd.to_datetime(df["minute"], utc=True)
    # OFI per minute (-1..+1). Avoid divide-by-zero with NaN, callers can ffill.
    denom = df["buy_vol"] + df["sell_vol"]
    df["ofi"] = (df["buy_vol"] - df["sell_vol"]) / denom.where(denom > 0)
    return df


def load_tbbo_range(
    conn: duckdb.DuckDBPyConnection,
    contract: str,
    start: date,
    end: date,
) -> pd.DataFrame:
    """Per-minute aggregates for one contract over a date range (inclusive)."""
    df = conn.execute(
        """
        SELECT
          date_trunc('minute', ts_recv) AS minute,
          COUNT(*) AS n_trades,
          COALESCE(SUM(size) FILTER (WHERE side = 'B'), 0)::BIGINT AS buy_vol,
          COALESCE(SUM(size) FILTER (WHERE side = 'A'), 0)::BIGINT AS sell_vol,
          SUM(size)::BIGINT AS total_vol,
          SUM(price * size) / NULLIF(SUM(size), 0) AS vwap_price,
          MAX(ask_px_00 - bid_px_00) AS max_spread
        FROM read_parquet(?)
        WHERE symbol = ?
          AND ts_recv >= ?::TIMESTAMP
          AND ts_recv < (?::TIMESTAMP + INTERVAL '1 day')
        GROUP BY minute
        ORDER BY minute
        """,
        [tbbo_glob(), contract, start.isoformat(), end.isoformat()],
    ).df()

    if df.empty:
        return df

    df["minute"] = pd.to_datetime(df["minute"], utc=True)
    denom = df["buy_vol"] + df["sell_vol"]
    df["ofi"] = (df["buy_vol"] - df["sell_vol"]) / denom.where(denom > 0)
    return df


# ---------------------------------------------------------------------------
# OHLCV
# ---------------------------------------------------------------------------


def load_ohlcv_day(
    conn: duckdb.DuckDBPyConnection,
    symbols: Sequence[str],
    on: date,
) -> pd.DataFrame:
    """1m OHLCV bars for one or more symbols on one UTC day.

    Returns long format with columns: ts, symbol, open, high, low, close, volume.
    Empty DataFrame if no bars match.
    """
    if not symbols:
        raise ValueError("symbols must be a non-empty sequence")
    placeholders = ",".join("?" for _ in symbols)
    # Safe SQL: `placeholders` is a comma-joined string of literal '?'
    # tokens equal in count to len(symbols); no user input flows into the SQL.
    df = conn.execute(
        f"""
        SELECT
          ts_event AS ts,
          symbol,
          open, high, low, close, volume
        FROM read_parquet(?)
        WHERE symbol IN ({placeholders})
          AND ts_event >= ?::TIMESTAMP
          AND ts_event < (?::TIMESTAMP + INTERVAL '1 day')
        ORDER BY symbol, ts
        """,
        [ohlcv_glob(), *symbols, on.isoformat(), on.isoformat()],
    ).df()

    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def load_ohlcv_range(
    conn: duckdb.DuckDBPyConnection,
    symbols: Sequence[str],
    start: date,
    end: date,
) -> pd.DataFrame:
    """1m OHLCV bars for symbols over a date range (inclusive of both ends)."""
    if not symbols:
        raise ValueError("symbols must be a non-empty sequence")
    placeholders = ",".join("?" for _ in symbols)
    # Safe SQL: `placeholders` is a comma-joined string of literal '?'
    # tokens equal in count to len(symbols); no user input flows into the SQL.
    df = conn.execute(
        f"""
        SELECT
          ts_event AS ts,
          symbol,
          open, high, low, close, volume
        FROM read_parquet(?)
        WHERE symbol IN ({placeholders})
          AND ts_event >= ?::TIMESTAMP
          AND ts_event < (?::TIMESTAMP + INTERVAL '1 day')
        ORDER BY symbol, ts
        """,
        [ohlcv_glob(), *symbols, start.isoformat(), end.isoformat()],
    ).df()

    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


# ---------------------------------------------------------------------------
# Neon Postgres
# ---------------------------------------------------------------------------


def neon_connection() -> PgConnection:
    """Open a Neon Postgres connection from ``DATABASE_URL``.

    Caller is responsible for closing. Use within a ``with`` block or
    explicit try/finally to avoid leaking sockets.
    """
    if psycopg2 is None:
        raise RuntimeError(
            "psycopg2 not installed in this venv. Run "
            "ml/.venv/bin/pip install psycopg2-binary."
        )
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL not set. Run `vercel env pull .env.local` and "
            "`set -a && source .env.local && set +a` first."
        )
    return psycopg2.connect(url)


def load_zero_gamma(
    pg: PgConnection,
    ticker: str,
    start: date,
    end: date,
) -> pd.DataFrame:
    """Per-minute zero-gamma levels for ``ticker`` (SPX/NDX/SPY/QQQ).

    Returns columns: ts (UTC), zero_gamma, confidence. Empty frame if range has no rows.
    """
    df = pd.read_sql_query(
        """
        SELECT ts, zero_gamma_strike AS zero_gamma, confidence
        FROM zero_gamma_levels
        WHERE ticker = %s
          AND ts >= %s
          AND ts < (%s::date + INTERVAL '1 day')
        ORDER BY ts
        """,
        pg,
        params=[ticker, start, end],
    )
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def load_dealer_gamma(
    pg: PgConnection,
    ticker: str,
    start: date,
    end: date,
) -> pd.DataFrame:
    """Per-minute 0DTE dealer gamma exposure aggregated to net for ``ticker``.

    Returns columns: ts (UTC), net_gamma. Reads ``greek_exposures_0dte`` and
    sums by minute. If the table doesn't have a ticker filter (it's
    SPX-only in current schema), pass ``ticker='SPX'`` or callers should
    handle the absence of NDX/QQQ.

    Schema-tolerant: if the table doesn't exist or column names changed,
    returns an empty frame and logs nothing — the caller decides whether
    that's fatal for the setup.
    """
    try:
        df = pd.read_sql_query(
            """
            SELECT ts, SUM(gamma_dollars) AS net_gamma
            FROM greek_exposures_0dte
            WHERE ticker = %s
              AND ts >= %s
              AND ts < (%s::date + INTERVAL '1 day')
            GROUP BY ts
            ORDER BY ts
            """,
            pg,
            params=[ticker, start, end],
        )
    except psycopg2.Error:
        pg.rollback()
        return pd.DataFrame(columns=["ts", "net_gamma"])
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def load_futures_snapshot(
    pg: PgConnection,
    symbols: Sequence[str],
    start: date,
    end: date,
) -> pd.DataFrame:
    """Per-snapshot rows from ``futures_snapshots``.

    Returns columns: ts, symbol, price, change_pct_1h, change_pct_day,
    volume_ratio, basis (ES-SPX where available).
    """
    if not symbols:
        raise ValueError("symbols must be a non-empty sequence")
    df = pd.read_sql_query(
        """
        SELECT ts, symbol, price, change_pct_1h, change_pct_day,
               volume_ratio, basis
        FROM futures_snapshots
        WHERE symbol = ANY(%s)
          AND ts >= %s
          AND ts < (%s::date + INTERVAL '1 day')
        ORDER BY symbol, ts
        """,
        pg,
        params=[list(symbols), start, end],
    )
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


# ---------------------------------------------------------------------------
# Trading-day helpers
# ---------------------------------------------------------------------------


def list_trading_days(
    conn: duckdb.DuckDBPyConnection,
    start: date,
    end: date,
) -> list[date]:
    """List dates in [start, end] that have at least one ES TBBO trade.

    Cheaper proxy for a real exchange-holiday calendar; sufficient for backtest
    iteration since no-trade days are weekends/holidays we want to skip anyway.
    """
    rows = conn.execute(
        """
        SELECT DISTINCT CAST(date_trunc('day', ts_recv) AS DATE) AS d
        FROM read_parquet(?)
        WHERE symbol LIKE 'ES%'
          AND ts_recv >= ?::TIMESTAMP
          AND ts_recv < (?::TIMESTAMP + INTERVAL '1 day')
        ORDER BY d
        """,
        [tbbo_glob(), start.isoformat(), end.isoformat()],
    ).fetchall()
    return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------


def _smoke_test() -> None:  # pragma: no cover - manual sanity check
    """Quick sanity probe. Run as `python -m setups_backtest.data_loaders`."""
    sample_date = date(2026, 4, 15)
    with duckdb_session() as conn:
        fm = pick_front_month(conn, "ES", sample_date)
        print(f"ES front-month on {sample_date}: {fm}")
        if fm is None:
            return
        tbbo = load_tbbo_minute(conn, fm, sample_date)
        print(f"TBBO minutes: {len(tbbo)}, total_vol: {tbbo['total_vol'].sum():,}")
        ohlcv = load_ohlcv_day(conn, [fm], sample_date)
        print(f"OHLCV bars: {len(ohlcv)}")


if __name__ == "__main__":  # pragma: no cover
    _smoke_test()
