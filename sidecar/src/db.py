"""PostgreSQL connection pool and upsert operations for futures data.

Uses psycopg2 (not @neondatabase/serverless) since this runs on Railway,
not Vercel serverless. Connection pooling via psycopg2.pool.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Generator

import psycopg2
import psycopg2.extras
import psycopg2.pool

from logger_setup import log

_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    """Lazy-init a threaded connection pool."""
    global _pool
    if _pool is None or _pool.closed:
        from config import settings

        # Strip options from DSN — Neon's pooler rejects startup
        # parameters like statement_timeout. Set timeout per-query instead.
        dsn = settings.database_url.split("?")[0]
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            dsn=dsn,
            sslmode="require",
        )
        log.info("Database pool created")
    return _pool


@contextmanager
def get_conn() -> Generator[Any, None, None]:
    """Borrow a connection from the pool, auto-return on exit."""
    pool = get_pool()
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def verify_connection() -> None:
    """Verify the database is reachable."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            row = cur.fetchone()
            if not row or row[0] != 1:
                raise RuntimeError("Database connection verification failed")
    log.info("Database connection verified")


def is_db_healthy() -> bool:
    """Quick health check for the HTTP health endpoint."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Upsert operations
# ---------------------------------------------------------------------------


def upsert_futures_bar(
    symbol: str,
    ts: datetime,
    open_: Decimal,
    high: Decimal,
    low: Decimal,
    close: Decimal,
    volume: int,
) -> None:
    """Insert or update a 1-minute OHLCV bar in futures_bars."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (symbol, ts) DO UPDATE SET
                    open   = futures_bars.open,
                    high   = GREATEST(futures_bars.high, EXCLUDED.high),
                    low    = LEAST(futures_bars.low, EXCLUDED.low),
                    close  = EXCLUDED.close,
                    volume = GREATEST(futures_bars.volume, EXCLUDED.volume)
                """,
                (symbol, ts, open_, high, low, close, volume),
            )


def insert_options_trade(
    underlying: str,
    expiry: date,
    strike: Decimal,
    option_type: str,
    ts: datetime,
    price: Decimal,
    size: int,
    side: str,
    trade_date: date,
) -> None:
    """Insert a single ES options trade record."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO futures_options_trades
                    (underlying, expiry, strike, option_type, ts, price, size, side, trade_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    underlying,
                    expiry,
                    strike,
                    option_type,
                    ts,
                    price,
                    size,
                    side,
                    trade_date,
                ),
            )


def batch_insert_options_trades(rows: list[tuple]) -> None:
    """Batch insert ES options trades for efficiency.

    Each tuple: (underlying, expiry, strike, option_type, ts, price, size, side, trade_date)
    """
    if not rows:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO futures_options_trades
                    (underlying, expiry, strike, option_type, ts, price, size, side, trade_date)
                VALUES %s
                """,
                rows,
                page_size=500,
            )


def upsert_options_daily(
    underlying: str,
    trade_date: date,
    expiry: date,
    strike: Decimal,
    option_type: str,
    *,
    open_interest: int | None = None,
    volume: int | None = None,
    settlement: Decimal | None = None,
    implied_vol: Decimal | None = None,
    delta: Decimal | None = None,
    is_final: bool = False,
) -> None:
    """Upsert EOD statistics for an ES option strike."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO futures_options_daily
                    (underlying, trade_date, expiry, strike, option_type,
                     open_interest, volume, settlement, implied_vol, delta, is_final)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (underlying, trade_date, expiry, strike, option_type)
                DO UPDATE SET
                    open_interest = COALESCE(EXCLUDED.open_interest, futures_options_daily.open_interest),
                    volume        = COALESCE(EXCLUDED.volume, futures_options_daily.volume),
                    settlement    = COALESCE(EXCLUDED.settlement, futures_options_daily.settlement),
                    implied_vol   = COALESCE(EXCLUDED.implied_vol, futures_options_daily.implied_vol),
                    delta         = COALESCE(EXCLUDED.delta, futures_options_daily.delta),
                    is_final      = COALESCE(EXCLUDED.is_final, futures_options_daily.is_final)
                """,
                (
                    underlying,
                    trade_date,
                    expiry,
                    strike,
                    option_type,
                    open_interest,
                    volume,
                    settlement,
                    implied_vol,
                    delta,
                    is_final,
                ),
            )


def load_alert_config() -> dict[str, dict]:
    """Load all alert configurations from the alert_config table.

    Returns a dict keyed by alert_type with {enabled, params, cooldown_minutes}.
    """
    configs: dict[str, dict] = {}
    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT alert_type, enabled, params, cooldown_minutes FROM alert_config"
                )
                for row in cur.fetchall():
                    configs[row["alert_type"]] = {
                        "enabled": row["enabled"],
                        "params": row["params"],
                        "cooldown_minutes": row["cooldown_minutes"],
                    }
    except psycopg2.errors.UndefinedTable:
        log.warning("alert_config table does not exist yet -- using defaults")
    except Exception as exc:
        log.error("Failed to load alert_config: %s", exc)
    return configs


def get_recent_bars(symbol: str, minutes: int = 60) -> list[dict]:
    """Fetch the most recent N minutes of bars for a symbol."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT ts, open, high, low, close, volume
                FROM futures_bars
                WHERE symbol = %s
                  AND ts >= NOW() - make_interval(mins => %s)
                ORDER BY ts ASC
                """,
                (symbol, minutes),
            )
            return [dict(row) for row in cur.fetchall()]


def drain_pool() -> None:
    """Close all connections in the pool."""
    global _pool
    if _pool is not None and not _pool.closed:
        _pool.closeall()
        _pool = None
        log.info("Database pool drained")
