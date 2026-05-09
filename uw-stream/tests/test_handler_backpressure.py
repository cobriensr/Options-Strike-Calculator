"""Backpressure tests for the Handler base class.

Specifically: verifies that drop_count is incremented on the
``drop_oldest`` policy's success path. Without this metric being
correct, "the server stopped sending" and "we fell behind on disk"
look identical from /metrics — which the spec calls out as the
single most-load-bearing observability signal in the daemon.
"""

from __future__ import annotations

import pytest

from handlers.base import Handler
from state import state


class _CountingHandler(Handler):
    """Concrete Handler that just records what _transform / _flush see."""

    def __init__(self, name: str = "test-channel") -> None:
        super().__init__(name=name)
        self.flushed: list[tuple] = []

    def _transform(self, payload: dict) -> tuple | None:
        return (payload.get("seq"),)

    async def _flush(self, rows: list[tuple]) -> None:
        self.flushed.extend(rows)


@pytest.fixture(autouse=True)
def _reset_state():
    state.channels.clear()
    yield
    state.channels.clear()


@pytest.fixture
def handler(monkeypatch) -> _CountingHandler:
    """Construct a handler with a tiny queue so backpressure is easy."""
    # Patch the queue size before construction so we can fill it fast.
    from config import settings

    monkeypatch.setattr(settings, "ws_queue_size", 2)
    monkeypatch.setattr(settings, "ws_backpressure_policy", "drop_oldest")
    return _CountingHandler()


@pytest.mark.asyncio
async def test_drop_oldest_increments_drop_count_on_eviction(handler):
    """Filling the queue beyond capacity must bump drop_count by one
    per evicted payload.
    """
    # Queue cap is 2 (set in fixture). Push 5 payloads with no consumer.
    for seq in range(5):
        await handler.enqueue({"seq": seq})

    # Three evictions happened (5 enqueued - 2 capacity).
    assert state.channel(handler.name).drop_count == 3
    # Queue is at its bounded depth.
    assert state.channel(handler.name).queue_depth == 2


@pytest.mark.asyncio
async def test_drop_newest_increments_drop_count(handler, monkeypatch):
    monkeypatch.setattr(handler, "_policy", "drop_newest")
    for seq in range(5):
        await handler.enqueue({"seq": seq})
    # 3 newest payloads are dropped on a 2-deep queue.
    assert state.channel(handler.name).drop_count == 3


@pytest.mark.asyncio
async def test_block_policy_does_not_drop(handler, monkeypatch):
    monkeypatch.setattr(handler, "_policy", "block")
    # Fill the queue exactly. No drops since we never go past capacity.
    await handler.enqueue({"seq": 0})
    await handler.enqueue({"seq": 1})
    assert state.channel(handler.name).drop_count == 0


@pytest.mark.asyncio
async def test_block_policy_drops_after_timeout_when_queue_full(monkeypatch):
    """Regression for C1: ``block`` policy must NOT freeze the receive
    task when no consumer is draining the queue. After
    BLOCK_PUT_TIMEOUT_S the payload is dropped and the counter ticks.
    """
    import time

    from config import settings
    from handlers import base as base_mod

    # Tighten the queue to maxsize=1 so we hit backpressure on the
    # second enqueue. Patch the timeout down to keep the test fast.
    monkeypatch.setattr(settings, "ws_queue_size", 1)
    monkeypatch.setattr(settings, "ws_backpressure_policy", "block")
    monkeypatch.setattr(base_mod, "BLOCK_PUT_TIMEOUT_S", 0.02)

    h = _CountingHandler()
    await h.enqueue({"seq": 0})  # fills the queue
    assert state.channel(h.name).drop_count == 0

    started = time.monotonic()
    await h.enqueue({"seq": 1})  # must time out and drop
    elapsed = time.monotonic() - started

    assert state.channel(h.name).drop_count == 1
    # 100ms ceiling — well below the 20s WS ping timeout, well above the
    # 20ms put timeout configured above so no flakiness on slow runners.
    assert elapsed < 0.1, f"block-put waited {elapsed:.3f}s — too long"


@pytest.mark.asyncio
async def test_queue_depth_tracks_actual_queue_size(handler):
    await handler.enqueue({"seq": 0})
    assert state.channel(handler.name).queue_depth == 1
    await handler.enqueue({"seq": 1})
    assert state.channel(handler.name).queue_depth == 2
    # Fill past capacity; depth stays at 2 (eviction happens internally).
    await handler.enqueue({"seq": 2})
    assert state.channel(handler.name).queue_depth == 2
