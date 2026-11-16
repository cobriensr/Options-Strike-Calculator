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
    """A pool double: only ``close`` is awaited by ``init_pool`` itself."""
    pool = MagicMock()
    pool.close = AsyncMock()
    return pool


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
async def test_failed_boot_check_closes_the_pool_and_propagates():
    """A bad DATABASE_URL must still fail the boot: the check's error reaches the
    caller, the pool is closed, and ``_pool`` is back to None so nothing holds a
    half-made pool.
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
    fake_pool.close.assert_awaited_once()
    assert db._pool is None
    with pytest.raises(RuntimeError, match="Pool not initialized"):
        db.get_pool()


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
    first_pool.close.assert_awaited_once()
    second_pool.close.assert_not_awaited()


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
