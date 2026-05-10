"""Unit tests for src/db.py — Phase 3.2 (M1) pool sizing.

Phase 3 of the uw-stream-hardening spec bumped the asyncpg pool to
``min_size=2, max_size=10`` to match the daemon's actual handler
concurrency: 5 channels (flow_alerts, option_trades, gex_strike_expiry,
off_lit_trades, net_flow) each potentially flushing in parallel, plus
headroom for the health-check connection and any manual ad-hoc query.

The single round-trip per flush from Phase 2's multi-row INSERT
compresses each handler's wall-clock pool tenancy, but five concurrent
handlers + a health check on a max=5 pool still queues — under volume
spikes the pool starvation surfaces as Sentry timeouts on /healthz.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import db


@pytest.fixture(autouse=True)
def _reset_pool_singleton():
    """Each test starts with a fresh _pool=None so init_pool() runs."""
    saved = db._pool
    db._pool = None
    yield
    db._pool = saved


@pytest.mark.asyncio
async def test_pool_size_supports_handler_count():
    """``init_pool`` must request min=2/max=10 so 5 handlers + health
    check + manual queries never starve the pool.
    """
    fake_pool = object()
    create_pool_mock = AsyncMock(return_value=fake_pool)

    with patch("db.asyncpg.create_pool", create_pool_mock):
        result = await db.init_pool()

    assert result is fake_pool
    create_pool_mock.assert_awaited_once()
    kwargs = create_pool_mock.await_args.kwargs
    assert kwargs["min_size"] == 2
    assert kwargs["max_size"] == 10


@pytest.mark.asyncio
async def test_init_pool_is_idempotent():
    """Subsequent calls return the same pool without recreating it."""
    fake_pool = object()
    create_pool_mock = AsyncMock(return_value=fake_pool)

    with patch("db.asyncpg.create_pool", create_pool_mock):
        first = await db.init_pool()
        second = await db.init_pool()

    assert first is second
    # Only the first call hit asyncpg.create_pool.
    assert create_pool_mock.await_count == 1
