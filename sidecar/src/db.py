"""PostgreSQL connection pool and query helpers for the sidecar.

Uses psycopg2 (not @neondatabase/serverless) since this runs on Railway,
not Vercel serverless. Connection pooling via psycopg2.pool.
"""

from __future__ import annotations

import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import psycopg2
import psycopg2.pool

from logger_setup import log

_pool: psycopg2.pool.ThreadedConnectionPool | None = None

# Default timeout for borrowing a connection from the pool. If the pool
# is saturated (all maxconn connections are in use), the borrow will
# fail with PoolTimeoutError after this many seconds rather than
# blocking the calling thread forever. See SIDE-005.
DEFAULT_GETCONN_TIMEOUT_S = 10.0

# Log a warning when a borrow takes longer than this threshold. This
# is the early-warning signal for pool saturation before the full
# timeout kicks in.
SLOW_GETCONN_WARNING_MS = 1000

# Short borrow timeout used ONLY by the /health probe. If every pooled
# connection is busy, the default 10s timeout would hang the probe and
# then return False -> HTTP 503 -> Railway may restart a HEALTHY-but-busy
# container. A 2s deadline fails fast; pool saturation is then reported
# as healthy-but-busy (see is_db_healthy). See Finding E.
HEALTH_PROBE_TIMEOUT_S = 2.0


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
        # TCP keepalives let the kernel notice a server-side SSL/TCP drop
        # before the next query lands on a dead socket. Neon silently tears
        # down idle pooler connections (the pool sits quiet between
        # /health probes); without keepalives, the first borrow after
        # that gap raises ``OperationalError: SSL connection has been
        # closed unexpectedly``. With these settings the kernel probes
        # every 30s + 10s*5 = ~80s after each idle window, so the broken
        # socket is detected and the pool's ``putconn(close=True)`` path
        # can discard it before the next borrow.
        # See SENTRY-EMERALD-DESERT-6X / -2C.
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            dsn=dsn,
            sslmode="require",
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
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
        except psycopg2.pool.PoolError as exc:
            # Pool is exhausted. Sleep a bit and retry until the deadline.
            if time.monotonic() >= deadline:
                elapsed_ms = (time.monotonic() - start) * 1000.0
                raise PoolTimeoutError(
                    f"db pool saturated: could not borrow a connection "
                    f"within {timeout_s:.1f}s (waited {elapsed_ms:.0f}ms)"
                ) from exc
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
        # Rolling back a connection whose socket libpq has already torn
        # down raises InterfaceError("connection already closed"), which
        # would mask the real exception (typically OperationalError from
        # a Neon SSL drop mid-batch). Swallow the rollback failure and
        # let the original exception propagate via `raise` below. See
        # SENTRY-EMERALD-DESERT-6S / -2C.
        try:
            conn.rollback()
        except Exception as rollback_exc:
            log.debug(
                "rollback after error failed (connection likely dead): %s",
                rollback_exc,
            )
        raise
    finally:
        # When libpq has marked the connection broken (`conn.closed != 0`,
        # e.g. SSL drop, server-side disconnect), pass close=True so the
        # pool discards it rather than handing the same dead socket to
        # the next caller. Without this, a single network blip can poison
        # every borrow until the pool happens to recycle.
        try:
            pool.putconn(conn, close=bool(conn.closed))
        except Exception as exc:
            # Don't let putconn failures mask the real exception. During
            # shutdown the pool may already be closed (PoolError) — that's
            # benign and shouldn't replace whatever the caller was raising.
            log.debug("pool.putconn failed (likely shutdown): %s", exc)


def verify_connection() -> None:
    """Verify the database is reachable."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 AS ok")
        row = cur.fetchone()
        if not row or row[0] != 1:
            raise RuntimeError("Database connection verification failed")
    log.info("Database connection verified")


def is_db_healthy() -> bool:
    """Quick health check for the HTTP health endpoint.

    Distinguishes "pool saturated (alive but busy)" from "DB actually
    unreachable" so a saturated pool doesn't trip a spurious 503 and a
    Railway restart of a healthy container (Finding E):

    - Borrows with a SHORT timeout (``HEALTH_PROBE_TIMEOUT_S``) so the
      probe fails fast instead of hanging the full default 10s.
    - A ``PoolTimeoutError`` means every pooled connection is in use but
      the DB itself is reachable -> treat as healthy (return True) and
      surface a Sentry warning so saturation stays observable.
    - Any other exception (real connection/query failure) -> False.
    """
    try:
        with (
            get_conn(timeout_s=HEALTH_PROBE_TIMEOUT_S) as conn,
            conn.cursor() as cur,
        ):
            cur.execute("SELECT 1")
            return True
    except PoolTimeoutError:
        # Pool is saturated but the DB is alive — do NOT report unhealthy,
        # or Railway may restart a container that's simply busy.
        try:
            from sentry_setup import capture_message

            capture_message(
                "db health probe: pool saturated (healthy but busy)",
                level="warning",
            )
        except Exception:
            # Observability must never flip the healthy-but-busy verdict.
            log.warning("db health probe: pool saturated (healthy but busy)")
        return True
    except Exception:
        return False


def drain_pool() -> None:
    """Close all connections in the pool."""
    global _pool
    if _pool is not None and not _pool.closed:
        _pool.closeall()
        _pool = None
        log.info("Database pool drained")
