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
    state.handlers.clear()
    yield
    state.handlers.clear()


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
    assert state.handler(handler.name).drop_count == 3
    # Queue is at its bounded depth.
    assert state.handler(handler.name).queue_depth == 2


@pytest.mark.asyncio
async def test_drop_newest_increments_drop_count(handler, monkeypatch):
    monkeypatch.setattr(handler, "_policy", "drop_newest")
    for seq in range(5):
        await handler.enqueue({"seq": seq})
    # 3 newest payloads are dropped on a 2-deep queue.
    assert state.handler(handler.name).drop_count == 3


@pytest.mark.asyncio
async def test_block_policy_does_not_drop(handler, monkeypatch):
    monkeypatch.setattr(handler, "_policy", "block")
    # Fill the queue exactly. No drops since we never go past capacity.
    await handler.enqueue({"seq": 0})
    await handler.enqueue({"seq": 1})
    assert state.handler(handler.name).drop_count == 0


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
    assert state.handler(h.name).drop_count == 0

    started = time.monotonic()
    await h.enqueue({"seq": 1})  # must time out and drop
    elapsed = time.monotonic() - started

    assert state.handler(h.name).drop_count == 1
    # 100ms ceiling — well below the 20s WS ping timeout, well above the
    # 20ms put timeout configured above so no flakiness on slow runners.
    assert elapsed < 0.1, f"block-put waited {elapsed:.3f}s — too long"


@pytest.mark.asyncio
async def test_queue_depth_tracks_actual_queue_size(handler):
    await handler.enqueue({"seq": 0})
    assert state.handler(handler.name).queue_depth == 1
    await handler.enqueue({"seq": 1})
    assert state.handler(handler.name).queue_depth == 2
    # Fill past capacity; depth stays at 2 (eviction happens internally).
    await handler.enqueue({"seq": 2})
    assert state.handler(handler.name).queue_depth == 2


# --- Backlog batching (P1) ----------------------------------------------------
#
# After a slow flush the queue holds a backlog. Draining it 500 rows per flush
# costs one Neon round trip per 500 and can fall further behind; the 50k
# drop-oldest queue then evicts rows with no error at all. When the batch hits
# its size threshold, run() now tops it up from the queue (get_nowait), up to
# BACKLOG_BATCH_MAX rows in one flush. bulk_insert_* chunk it under the
# Postgres parameter limit (test_db_bulk.py covers the chunking).


class _BatchRecordingHandler(Handler):
    """Records each flushed batch separately, so tests can see batch sizes."""

    def __init__(self, name: str = "backlog-test") -> None:
        super().__init__(name=name)
        self.batches: list[list[tuple]] = []

    def _transform(self, payload: dict) -> tuple | None:
        if payload.get("seq") == "bad":
            raise ValueError("unparseable payload")
        return (payload.get("seq"),)

    async def _flush(self, rows: list[tuple]) -> None:
        self.batches.append(list(rows))


async def _run_until_idle(h: Handler, *, expected_rows: int) -> None:
    """Run the consumer until ``expected_rows`` rows were flushed, then stop it."""
    import asyncio
    import contextlib

    task = asyncio.create_task(h.run())
    try:
        for _ in range(200):
            if sum(len(b) for b in h.batches) >= expected_rows and h.queue.empty():
                break
            await asyncio.sleep(0.01)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_run_flushes_backlog_in_larger_batch(monkeypatch):
    from config import settings
    from handlers.base import BACKLOG_BATCH_MAX

    monkeypatch.setattr(settings, "ws_queue_size", 10_000)
    monkeypatch.setattr(settings, "ws_batch_size", 500)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)
    h = _BatchRecordingHandler()
    backlog = BACKLOG_BATCH_MAX + 1_000
    for seq in range(backlog):
        h.queue.put_nowait({"seq": seq})

    await _run_until_idle(h, expected_rows=backlog)

    # One flush of the cap, then the remainder: not 12 flushes of 500.
    assert BACKLOG_BATCH_MAX == 5_000
    assert [len(b) for b in h.batches] == [BACKLOG_BATCH_MAX, 1_000]
    # Arrival order is kept and no row is flushed twice.
    assert [r[0] for b in h.batches for r in b] == list(range(backlog))
    assert state.handler(h.name).queue_depth == 0


@pytest.mark.asyncio
async def test_shallow_queue_keeps_the_normal_batch_size(monkeypatch):
    from config import settings

    monkeypatch.setattr(settings, "ws_batch_size", 4)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)
    monkeypatch.setattr(settings, "ws_queue_size", 16)
    h = _BatchRecordingHandler()

    import asyncio
    import contextlib

    task = asyncio.create_task(h.run())
    try:
        # Rows arrive one at a time with the consumer keeping up: no backlog
        # to pull, so each flush is exactly the size threshold.
        for seq in range(8):
            await h.enqueue({"seq": seq})
            await asyncio.sleep(0)
        for _ in range(50):
            if len(h.batches) >= 2:
                break
            await asyncio.sleep(0.01)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert [len(b) for b in h.batches] == [4, 4]


@pytest.mark.asyncio
async def test_backlog_top_up_stops_at_the_drain_sentinel(monkeypatch):
    """drain() queues a wake-up sentinel. If run() wakes from an empty-queue
    get just as rows and then the sentinel land, its top-up can reach the
    sentinel. It must honor it like the main loop does: flush what it pulled,
    exit, and leave the rows behind the sentinel for drain() to collect.
    """
    import asyncio

    from config import settings
    from handlers import base as base_mod

    monkeypatch.setattr(settings, "ws_batch_size", 2)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)
    monkeypatch.setattr(settings, "ws_queue_size", 16)
    h = _BatchRecordingHandler()
    for seq in (0, 1, 2):
        h.queue.put_nowait({"seq": seq})
    h.queue.put_nowait(base_mod._STOP_SENTINEL)
    h._sentinel_queued = True
    for seq in (3, 4):
        h.queue.put_nowait({"seq": seq})

    await asyncio.wait_for(h.run(), timeout=1.0)

    assert h.batches == [[(0,), (1,), (2,)]]
    assert h._sentinel_queued is False
    assert h.queue.qsize() == 2  # rows 3 and 4, for drain()


@pytest.mark.asyncio
async def test_backlog_top_up_reports_a_bad_payload_and_keeps_going(monkeypatch):
    from config import settings
    from handlers import base as base_mod

    monkeypatch.setattr(settings, "ws_batch_size", 2)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)
    monkeypatch.setattr(settings, "ws_queue_size", 16)
    captured: list[tuple[BaseException, dict]] = []
    monkeypatch.setattr(base_mod, "capture_exception", lambda exc, **kw: captured.append((exc, kw)))
    h = _BatchRecordingHandler()
    for seq in (0, 1, "bad", 3):
        h.queue.put_nowait({"seq": seq})

    await _run_until_idle(h, expected_rows=3)

    assert h.batches == [[(0,), (1,), (3,)]]
    assert [str(e) for e, _ in captured] == ["unparseable payload"]
    assert captured[0][1]["tags"] == {"component": "handler", "channel": h.name}


@pytest.mark.asyncio
async def test_drain_reports_a_bad_payload_with_its_stage_and_flushes_the_rest(monkeypatch):
    # drain() shares _add_row with run(); its Sentry tags carry the stage.
    from config import settings
    from handlers import base as base_mod

    monkeypatch.setattr(settings, "ws_queue_size", 16)
    captured: list[tuple[BaseException, dict]] = []
    monkeypatch.setattr(base_mod, "capture_exception", lambda exc, **kw: captured.append((exc, kw)))
    h = _BatchRecordingHandler()
    for seq in (0, "bad", 2):
        h.queue.put_nowait({"seq": seq})
    h._stopped.set()  # no consumer running

    assert await h.drain() == 2

    assert h.batches == [[(0,), (2,)]]
    assert [kw["tags"]["stage"] for _, kw in captured] == ["drain_transform"]
