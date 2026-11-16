"""Unit tests for src/db.py: pool sizing and the boot check.

The pool is ``min_size=0, max_size=10``. The ceiling matches the daemon's
handler concurrency: 5 channels (flow_alerts, option_trades,
gex_strike_expiry, off_lit_trades, net_flow) each potentially flushing in
parallel, plus headroom for the health-check connection and any manual ad-hoc
query. The floor is 0 so Neon can suspend its compute when nothing writes:
asyncpg 0.32's floor maintenance reconnects on every suspend, and a floor
connection is exempt from the 300 s inactive close (spec:
docs/superpowers/specs/2026-11-16-uw-stream-pool-floor.md).

With no floor, ``create_pool`` opens no connection, so ``init_pool`` runs
``SELECT 1`` once to keep a bad DATABASE_URL failing at boot.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg
import pytest

import db


@pytest.fixture(autouse=True)
def _reset_pool_singleton():
    """Each test starts with a fresh _pool=None so init_pool() runs."""
    saved = db._pool
    db._pool = None
    yield
    db._pool = saved


def _fake_pool() -> MagicMock:
    """A pool double for tests that patch ``db.fetch``: ``init_pool`` itself only
    calls ``terminate`` (sync) on a failed check, never ``close``. ``close`` is an
    ``AsyncMock`` so a test can assert it was not awaited.
    """
    pool = MagicMock()
    pool.close = AsyncMock()
    return pool


def _pool_with_conn(conn: MagicMock) -> MagicMock:
    """A pool double for tests that run the real ``fetch``: ``acquire()`` is an
    async context manager yielding ``conn``, as asyncpg's is.
    """

    @asynccontextmanager
    async def _acquire():
        yield conn

    pool = MagicMock()
    pool.acquire = MagicMock(side_effect=_acquire)
    pool.close = AsyncMock()
    return pool


def _conn(*fetch_results) -> MagicMock:
    """A connection double whose ``fetch`` yields ``fetch_results`` in order
    (an exception instance is raised).
    """
    conn = MagicMock()
    conn.fetch = AsyncMock(side_effect=list(fetch_results))
    return conn


@pytest.mark.asyncio
async def test_pool_size_supports_handler_count():
    """``init_pool`` must request min=0/max=10: the ceiling keeps 5 handlers +
    health check + manual queries from starving the pool, and the zero floor
    lets Neon suspend.
    """
    fake_pool = _fake_pool()
    create_pool_mock = AsyncMock(return_value=fake_pool)

    with patch("db.asyncpg.create_pool", create_pool_mock), patch("db.fetch", AsyncMock()):
        result = await db.init_pool()

    assert result is fake_pool
    create_pool_mock.assert_awaited_once()
    kwargs = create_pool_mock.await_args.kwargs
    assert kwargs["min_size"] == 0
    assert kwargs["max_size"] == 10


@pytest.mark.asyncio
async def test_init_pool_is_idempotent():
    """Subsequent calls return the same pool without recreating it."""
    fake_pool = _fake_pool()
    create_pool_mock = AsyncMock(return_value=fake_pool)

    with patch("db.asyncpg.create_pool", create_pool_mock), patch("db.fetch", AsyncMock()):
        first = await db.init_pool()
        second = await db.init_pool()

    assert first is second
    # Only the first call hit asyncpg.create_pool.
    assert create_pool_mock.await_count == 1


@pytest.mark.asyncio
async def test_boot_check_runs_once_on_success():
    """A zero floor opens no connection at create time, so ``init_pool`` runs
    ``SELECT 1`` through ``fetch`` (the transient-retry path) exactly once.
    """
    fake_pool = _fake_pool()
    fetch_mock = AsyncMock()

    with (
        patch("db.asyncpg.create_pool", AsyncMock(return_value=fake_pool)),
        patch("db.fetch", fetch_mock),
    ):
        result = await db.init_pool()

    assert result is fake_pool
    assert db._pool is fake_pool
    fetch_mock.assert_awaited_once_with("boot_check", "SELECT 1")
    fake_pool.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_second_init_pool_does_not_rerun_the_boot_check():
    fetch_mock = AsyncMock()

    with (
        patch("db.asyncpg.create_pool", AsyncMock(return_value=_fake_pool())),
        patch("db.fetch", fetch_mock),
    ):
        await db.init_pool()
        await db.init_pool()

    assert fetch_mock.await_count == 1


@pytest.mark.asyncio
async def test_failed_boot_check_terminates_the_pool_and_propagates():
    """A bad DATABASE_URL must still fail the boot: the check's error reaches the
    caller, the pool is terminated (nothing to drain, so no wait on ``close``),
    and ``_pool`` is back to None so nothing holds a half-made pool.
    """
    fake_pool = _fake_pool()
    failure = asyncpg.InvalidPasswordError("password authentication failed")
    fetch_mock = AsyncMock(side_effect=failure)

    with (
        patch("db.asyncpg.create_pool", AsyncMock(return_value=fake_pool)),
        patch("db.fetch", fetch_mock),
        pytest.raises(asyncpg.InvalidPasswordError) as caught,
    ):
        await db.init_pool()

    assert caught.value is failure
    fake_pool.terminate.assert_called_once_with()
    fake_pool.close.assert_not_awaited()
    assert db._pool is None
    with pytest.raises(RuntimeError, match="Pool not initialized"):
        db.get_pool()


@pytest.mark.asyncio
async def test_a_failing_terminate_does_not_replace_the_boot_check_error(service_log_records):
    """If the cleanup itself raises, the caller still sees the check's error (a bad
    DATABASE_URL must not surface as a terminate error), ``_pool`` is None, and the
    cleanup failure is logged.
    """
    fake_pool = _fake_pool()
    fake_pool.terminate.side_effect = RuntimeError("terminate blew up")
    failure = asyncpg.InvalidPasswordError("password authentication failed")

    with (
        patch("db.asyncpg.create_pool", AsyncMock(return_value=fake_pool)),
        patch("db.fetch", AsyncMock(side_effect=failure)),
        pytest.raises(asyncpg.InvalidPasswordError) as caught,
    ):
        await db.init_pool()

    assert caught.value is failure
    fake_pool.terminate.assert_called_once_with()
    assert db._pool is None
    warnings = [r for r in service_log_records if "terminate failed" in r.getMessage()]
    assert len(warnings) == 1
    assert warnings[0].err == "terminate blew up"


@pytest.mark.asyncio
async def test_init_pool_retries_from_scratch_after_a_failed_boot_check():
    """A failed boot check leaves no singleton behind, so the next call builds a
    new pool and runs the check again.
    """
    first_pool, second_pool = _fake_pool(), _fake_pool()
    create_pool_mock = AsyncMock(side_effect=[first_pool, second_pool])
    fetch_mock = AsyncMock(side_effect=[OSError("network unreachable"), None])

    with patch("db.asyncpg.create_pool", create_pool_mock), patch("db.fetch", fetch_mock):
        with pytest.raises(OSError, match="network unreachable"):
            await db.init_pool()
        result = await db.init_pool()

    assert result is second_pool
    assert create_pool_mock.await_count == 2
    assert fetch_mock.await_count == 2
    first_pool.terminate.assert_called_once_with()
    second_pool.terminate.assert_not_called()


@pytest.mark.asyncio
async def test_pool_ready_is_logged_only_after_the_boot_check_passes(service_log_records):
    fetch_mock = AsyncMock(side_effect=[OSError("network unreachable"), None])

    with (
        patch("db.asyncpg.create_pool", AsyncMock(side_effect=[_fake_pool(), _fake_pool()])),
        patch("db.fetch", fetch_mock),
    ):
        with pytest.raises(OSError):
            await db.init_pool()
        assert not any("pool ready" in r.getMessage() for r in service_log_records)
        await db.init_pool()

    ready = [r.getMessage() for r in service_log_records if "pool ready" in r.getMessage()]
    assert ready == ["asyncpg pool ready (min=0 max=10)"]


# The tests below leave ``db.fetch`` unpatched, so the boot check runs the real
# path: fetch -> get_pool() -> pool.acquire() -> conn.fetch, inside _with_db_retry.
# That is what needs ``_pool`` set before the check runs.


@pytest.fixture
def instant_retries(monkeypatch):
    """No backoff sleep between retry attempts."""
    monkeypatch.setattr(db, "_DB_RETRY_BACKOFF_S", (0, 0))


@pytest.mark.asyncio
async def test_boot_check_goes_through_the_pool_when_fetch_is_not_patched():
    conn = _conn([])
    pool = _pool_with_conn(conn)

    with patch("db.asyncpg.create_pool", AsyncMock(return_value=pool)):
        result = await db.init_pool()

    assert result is pool
    assert db._pool is pool
    conn.fetch.assert_awaited_once_with("SELECT 1")
    pool.acquire.assert_called_once_with()
    pool.terminate.assert_not_called()


@pytest.mark.asyncio
async def test_boot_check_retries_a_transient_error_and_keeps_the_pool(instant_retries):
    """Two ``InterfaceError`` (a connection torn down under the pool) then a
    success: the retry policy absorbs them, so the boot goes on.
    """
    conn = _conn(
        asyncpg.InterfaceError("connection is closed"),
        asyncpg.InterfaceError("connection is closed"),
        [],
    )
    pool = _pool_with_conn(conn)

    with patch("db.asyncpg.create_pool", AsyncMock(return_value=pool)):
        result = await db.init_pool()

    assert result is pool
    assert db._pool is pool
    assert conn.fetch.await_count == 3
    pool.terminate.assert_not_called()


@pytest.mark.asyncio
async def test_boot_check_fails_the_boot_when_the_transient_error_persists(instant_retries):
    """Three transient errors exhaust the retries: the last one surfaces, the pool
    is terminated and ``_pool`` is None.
    """
    errors = [asyncpg.InterfaceError(f"connection is closed {n}") for n in range(3)]
    conn = _conn(*errors)
    pool = _pool_with_conn(conn)

    with (
        patch("db.asyncpg.create_pool", AsyncMock(return_value=pool)),
        pytest.raises(asyncpg.InterfaceError) as caught,
    ):
        await db.init_pool()

    assert caught.value is errors[-1]
    assert conn.fetch.await_count == 3
    pool.terminate.assert_called_once_with()
    assert db._pool is None
