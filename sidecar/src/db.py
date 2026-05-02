"""PostgreSQL connection pool and upsert operations for futures data.

Uses psycopg2 (not @neondatabase/serverless) since this runs on Railway,
not Vercel serverless. Connection pooling via psycopg2.pool.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Generator, Sequence

import psycopg2
import psycopg2.extras
import psycopg2.pool

from logger_setup import log

_pool: psycopg2.pool.ThreadedConnectionPool | None = None

# Default timeout for borrowing a connection from the pool. If the pool
# is saturated (all maxconn connections are in use), the borrow will
# fail with PoolTimeoutError after this many seconds rather than
# blocking the Databento callback thread forever. See SIDE-005.
DEFAULT_GETCONN_TIMEOUT_S = 10.0

# Log a warning when a borrow takes longer than this threshold. This
# is the early-warning signal for pool saturation before the full
# timeout kicks in.
SLOW_GETCONN_WARNING_MS = 1000

# Default chunk size handed to ``psycopg2.extras.execute_values`` for
# every batch insert in this module. Tuned for Neon's round-trip
# overhead: smaller pages let RTT dominate; larger pages risk
# proportionally larger rollbacks on a single bad row. 500 has been the
# stable value across all four batch-insert call sites since SIDE-003.
_DEFAULT_BATCH_PAGE_SIZE = 500


class PoolTimeoutError(RuntimeError):
    """Raised when `get_conn` fails to borrow a connection in time."""


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


def _getconn_with_timeout(
    pool: psycopg2.pool.ThreadedConnectionPool,
    timeout_s: float,
) -> Any:
    """Borrow a connection from the pool with a deadline.

    psycopg2's `ThreadedConnectionPool.getconn()` doesn't support a
    native timeout — it raises `PoolError` immediately if the pool is
    exhausted, but only after consuming a lock. We poll it with a short
    backoff so a transient saturation blip (e.g. one slow query) doesn't
    immediately kill the caller.

    Raises PoolTimeoutError if no connection becomes available within
    `timeout_s` seconds. Callers that need to retry should catch this
    exception and decide whether to back off or fail.
    """
    start = time.monotonic()
    deadline = start + timeout_s
    backoff_s = 0.005  # 5ms initial poll interval

    while True:
        try:
            conn = pool.getconn()
            elapsed_ms = (time.monotonic() - start) * 1000.0
            if elapsed_ms > SLOW_GETCONN_WARNING_MS:
                # Lazy import to avoid a circular dep and to keep
                # sentry_setup optional (e.g., for unit tests that don't
                # install sentry_sdk).
                try:
                    from sentry_setup import capture_message

                    capture_message(
                        "db pool getconn was slow",
                        level="warning",
                        context={"elapsed_ms": round(elapsed_ms, 1)},
                    )
                except Exception:
                    log.warning("db pool getconn slow: %.1fms", elapsed_ms)
            return conn
        except psycopg2.pool.PoolError:
            # Pool is exhausted. Sleep a bit and retry until the deadline.
            if time.monotonic() >= deadline:
                elapsed_ms = (time.monotonic() - start) * 1000.0
                raise PoolTimeoutError(
                    f"db pool saturated: could not borrow a connection "
                    f"within {timeout_s:.1f}s (waited {elapsed_ms:.0f}ms)"
                )
            time.sleep(backoff_s)
            backoff_s = min(backoff_s * 2, 0.2)  # cap at 200ms


@contextmanager
def get_conn(
    timeout_s: float = DEFAULT_GETCONN_TIMEOUT_S,
) -> Generator[Any, None, None]:
    """Borrow a connection from the pool, auto-return on exit.

    Raises `PoolTimeoutError` if the pool is saturated for longer than
    `timeout_s` seconds. Logs a warning (and reports to Sentry) if a
    successful borrow took longer than `SLOW_GETCONN_WARNING_MS`
    milliseconds, so operators see pool pressure building before it
    turns into full timeouts. See SIDE-005.
    """
    pool = get_pool()
    conn = _getconn_with_timeout(pool, timeout_s)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        # Don't let putconn() failures mask the real exception. During
        # shutdown the pool may already be closed, in which case putconn
        # raises PoolError("connection pool is closed") — that's benign
        # and shouldn't replace whatever the caller was actually raising.
        try:
            pool.putconn(conn)
        except Exception as exc:
            log.debug("pool.putconn failed (likely shutdown): %s", exc)


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
# Batch-insert helper
# ---------------------------------------------------------------------------


def _execute_values_batch(
    sql: str,
    rows: Sequence[tuple],
    page_size: int = _DEFAULT_BATCH_PAGE_SIZE,
) -> None:
    """Run ``psycopg2.extras.execute_values(sql, rows, page_size=...)``.

    Centralizes the verbatim shape that every batch-insert function
    in this module needs: empty-rows no-op guard, one ``get_conn``
    context, ``execute_values`` with the standard page size. Lets the
    callers stay one-liners that just supply their own SQL.

    The page size defaults to :data:`_DEFAULT_BATCH_PAGE_SIZE` (500),
    which is the value every existing call site uses; callers that
    need a different page size can override per-call.
    """
    if not rows:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, sql, rows, page_size=page_size)


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

    Uses ON CONFLICT DO NOTHING against the unique index created by
    migration #50 on `(ts, underlying, expiry, strike, option_type,
    price, size, side)`. This makes the insert idempotent so Databento
    re-sends (which happen after brief disconnects) don't accumulate
    duplicate rows. See SIDE-003 in the audit for the full story.
    """
    _execute_values_batch(
        """
        INSERT INTO futures_options_trades
            (underlying, expiry, strike, option_type, ts, price, size, side, trade_date)
        VALUES %s
        ON CONFLICT (ts, underlying, expiry, strike, option_type, price, size, side)
        DO NOTHING
        """,
        rows,
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


def batch_insert_top_of_book(rows: list[tuple]) -> None:
    """Batch insert pre-trade top-of-book snapshots into futures_top_of_book.

    Each tuple: (symbol, ts, bid, bid_size, ask, ask_size)

    Rows come from Databento TBBO records (``levels[0]`` BBO seen at the
    moment of each trade). No ON CONFLICT dance because migration #71
    intentionally omits the UNIQUE constraint — dedup at this layer isn't
    meaningful; a brief Databento resend just adds a few extra rows and
    downstream Phase 2b compute jobs will aggregate.
    """
    _execute_values_batch(
        """
        INSERT INTO futures_top_of_book
            (symbol, ts, bid, bid_size, ask, ask_size)
        VALUES %s
        """,
        rows,
    )


def batch_insert_trade_ticks(rows: list[tuple]) -> None:
    """Batch insert Databento TBBO trade events into futures_trade_ticks.

    Each tuple: (symbol, ts, price, size, aggressor_side)

    aggressor_side is one of 'B' (buyer-initiated), 'S' (seller-initiated),
    or 'N' (trade printed between the spread) — classified by
    quote_processor.classify_aggressor() from the pre-trade BBO in the
    TBBO record's levels[0]. See migration #72's CHECK constraint.
    """
    _execute_values_batch(
        """
        INSERT INTO futures_trade_ticks
            (symbol, ts, price, size, aggressor_side)
        VALUES %s
        """,
        rows,
    )


def upsert_theta_option_eod_batch(rows: list[tuple]) -> None:
    """Batch upsert Theta EOD rows into theta_option_eod.

    Each tuple must match this column order exactly:
        (symbol, expiration, strike, option_type, date,
         open, high, low, close, volume, trade_count,
         bid, ask, bid_size, ask_size)

    Upserts on the UNIQUE (symbol, expiration, strike, option_type, date)
    constraint created by migration #70. On conflict we overwrite every
    data column with EXCLUDED.* because Theta's EOD report is a full
    snapshot — a later fetch for the same contract/day supersedes any
    earlier partial. `created_at` deliberately stays untouched so we
    preserve the first-seen timestamp across revisions.
    """
    _execute_values_batch(
        """
        INSERT INTO theta_option_eod
            (symbol, expiration, strike, option_type, date,
             open, high, low, close, volume, trade_count,
             bid, ask, bid_size, ask_size)
        VALUES %s
        ON CONFLICT (symbol, expiration, strike, option_type, date)
        DO UPDATE SET
            open        = EXCLUDED.open,
            high        = EXCLUDED.high,
            low         = EXCLUDED.low,
            close       = EXCLUDED.close,
            volume      = EXCLUDED.volume,
            trade_count = EXCLUDED.trade_count,
            bid         = EXCLUDED.bid,
            ask         = EXCLUDED.ask,
            bid_size    = EXCLUDED.bid_size,
            ask_size    = EXCLUDED.ask_size
        """,
        rows,
    )


def has_theta_option_eod_rows(symbol: str) -> bool:
    """True when theta_option_eod has at least one row for `symbol`.

    Cheap existence check used by the backfill scheduler to skip roots
    that already have data. `LIMIT 1` + the ix_theta_option_eod_symbol_date
    index makes this O(1) even as the table grows into the millions of
    rows over time.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM theta_option_eod WHERE symbol = %s LIMIT 1",
                (symbol,),
            )
            return cur.fetchone() is not None


def load_alert_config() -> dict[str, dict]:
    """Load all alert configurations from the alert_config table.

    Returns a dict keyed by alert_type with {enabled, params, cooldown_minutes}.

    Phase 5e — silent-fallback investigation. There are currently
    ZERO production callers of this function (alert_engine was
    removed 2026-04-08; the table is preserved as a future-use
    asset). The empty-dict fallback IS the intended runtime
    behavior — "no alerts configured" is a valid state — but the
    unexpected-Exception branch used to swallow without observability.
    Now we forward to Sentry before returning empty so any future
    drift (schema change, connection issue, RLS policy add) surfaces
    rather than silently masking. The UndefinedTable branch stays a
    plain log.warning since that's a known-OK pre-init state.
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
        # Forward to Sentry so config-loading drift surfaces in
        # observability instead of silently degrading to "no alerts."
        # Lazy import to avoid pulling sentry_setup into the db.py
        # import path of every test that touches Postgres.
        try:
            from sentry_setup import capture_exception

            capture_exception(
                exc,
                context={"phase": "load_alert_config"},
                tags={"component": "db"},
            )
        except Exception:  # noqa: BLE001
            # Sentry path failure must never block the empty-dict
            # fallback — caller depends on this returning a dict.
            pass
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
