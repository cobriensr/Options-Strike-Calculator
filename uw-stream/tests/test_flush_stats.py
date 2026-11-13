"""Flush, batch and queue high-water stats (pipeline diagnostics, Task 2).

These counters tell a slow Neon write, an exhausted pool and a blocked event
loop apart when trades land late. ``flushes`` / ``flush_rows`` / ``flush_seconds``
are cumulative; ``interval_flush_max_s`` / ``interval_batch_max`` /
``interval_queue_hwm`` and ``State.receive_queue_hwm`` are interval fields the
per-minute reporter reads and resets. The ``/metrics`` shape is asserted in
test_health.py.
"""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

import pytest

import handlers.base as base_mod
from config import settings
from handlers.base import Handler
from router import Router
from state import state


@pytest.fixture(autouse=True)
def _isolated_state(monkeypatch):
    """A clean handlers map and receive-queue stats per test; no Sentry capture."""
    saved_handlers = dict(state.handlers)
    saved_hwm = state.receive_queue_hwm
    saved_depth = state.receive_queue_depth
    state.handlers.clear()
    state.receive_queue_hwm = 0
    monkeypatch.setattr(base_mod, "capture_exception", lambda *_a, **_kw: None)
    monkeypatch.setattr(base_mod, "capture_message", lambda *_a, **_kw: None)
    yield
    state.handlers.clear()
    state.handlers.update(saved_handlers)
    state.receive_queue_hwm = saved_hwm
    state.receive_queue_depth = saved_depth


class _H(Handler):
    """Flushes a configurable way; records nothing about the DB."""

    def __init__(self, name: str = "flush-stats-test") -> None:
        super().__init__(name=name)
        self.fail = False

    def _transform(self, payload: dict) -> tuple | None:
        return (payload.get("seq"),)

    async def _flush(self, rows: list[tuple]) -> int:
        if self.fail:
            raise TimeoutError("command_timeout")
        return len(rows)


def _clock(monkeypatch, *ticks: float) -> None:
    """Make handlers.base read these monotonic values, one per call.

    Replaces only base's ``time`` name, so asyncio's own clock is untouched.
    """
    values = iter(ticks)
    monkeypatch.setattr(base_mod, "time", SimpleNamespace(monotonic=lambda: next(values)))


def _fresh(h: Handler):
    return state.handler(h.name)


async def _cancel(task: asyncio.Task) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


# ----------------------------------------------------------------------
# _safe_flush: cumulative and interval flush stats
# ----------------------------------------------------------------------


async def test_a_new_handler_starts_with_zeroed_flush_stats():
    m = _fresh(_H())
    assert (m.flushes, m.flush_rows, m.flush_seconds) == (0, 0, 0.0)
    assert (m.interval_flush_max_s, m.interval_batch_max, m.interval_queue_hwm) == (0, 0, 0)


async def test_a_successful_flush_records_count_rows_seconds_and_maxima(monkeypatch):
    h = _H()
    _clock(monkeypatch, 100.0, 100.4)

    await h._safe_flush([(1,), (2,), (3,)])

    m = _fresh(h)
    assert m.flushes == 1
    assert m.flush_rows == 3
    assert m.flush_seconds == pytest.approx(0.4)
    assert m.interval_flush_max_s == pytest.approx(0.4)
    assert m.interval_batch_max == 3


async def test_a_failing_flush_still_records_its_time_and_rows(monkeypatch):
    """A flush that raised took time and carried rows: that is the stall signal."""
    h = _H()
    h.fail = True
    _clock(monkeypatch, 50.0, 80.0)  # 30 s, a command_timeout

    await h._safe_flush([(1,), (2,)])  # swallowed: the drain loop must survive

    m = _fresh(h)
    assert m.flushes == 1
    assert m.flush_rows == 2
    assert m.flush_seconds == pytest.approx(30.0)
    assert m.interval_flush_max_s == pytest.approx(30.0)
    assert m.interval_batch_max == 2
    assert m.lost_rows == 2  # the existing failure accounting is unchanged
    assert m.write_count == 0


async def test_flush_stats_accumulate_and_the_maxima_keep_the_peak(monkeypatch):
    h = _H()
    _clock(monkeypatch, 0.0, 2.0, 10.0, 10.5, 20.0, 20.1)

    await h._safe_flush([(i,) for i in range(4)])  # 2.0 s, 4 rows
    await h._safe_flush([(1,)])  # 0.5 s, 1 row
    h.fail = True
    await h._safe_flush([(1,), (2,)])  # 0.1 s, 2 rows, fails

    m = _fresh(h)
    assert m.flushes == 3
    assert m.flush_rows == 7
    assert m.flush_seconds == pytest.approx(2.6)
    assert m.interval_flush_max_s == pytest.approx(2.0)  # later, shorter flushes keep it
    assert m.interval_batch_max == 4


async def test_a_cancelled_flush_records_no_flush_stats():
    """A cancel is not a flush: the CancelledError propagates and nothing is counted."""
    started = asyncio.Event()

    class _Stuck(_H):
        async def _flush(self, rows: list[tuple]) -> int:
            started.set()
            await asyncio.sleep(3600)
            return len(rows)

    h = _Stuck()
    task = asyncio.create_task(h._safe_flush([(1,), (2,)]))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    m = _fresh(h)
    assert (m.flushes, m.flush_rows, m.flush_seconds) == (0, 0, 0.0)
    assert (m.interval_flush_max_s, m.interval_batch_max) == (0, 0)
    assert m.lost_rows == 0


async def test_a_cancel_that_surfaces_as_an_exception_records_no_flush_stats():
    """asyncpg can turn a cancel into InterfaceError mid-unwind. The task is
    still being cancelled, so _safe_flush re-raises and counts nothing.
    """
    import asyncpg

    started = asyncio.Event()

    class _CancelAsError(_H):
        async def _flush(self, rows: list[tuple]) -> int:
            started.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                raise asyncpg.exceptions.InterfaceError("connection is closed") from None
            return len(rows)

    h = _CancelAsError()
    task = asyncio.create_task(h._safe_flush([(1,), (2,)]))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncpg.exceptions.InterfaceError):
        await task

    m = _fresh(h)
    assert (m.flushes, m.flush_rows, m.flush_seconds) == (0, 0, 0.0)
    assert m.lost_rows == 0


# ----------------------------------------------------------------------
# Handler.run: the batch maximum follows what _flush actually received
# ----------------------------------------------------------------------


async def test_batch_max_follows_the_largest_batch_including_a_backlog_take(monkeypatch):
    """A full batch tops itself up from the queue (_take_backlog), so one flush
    can carry far more rows than ``ws_batch_size``. The maximum must show that.
    """
    h = _H()
    monkeypatch.setattr(h, "_batch_size", 3)
    monkeypatch.setattr(h, "_batch_interval", 60.0)
    for seq in range(10):
        await h.enqueue({"seq": seq})

    task = asyncio.create_task(h.run())
    try:
        await asyncio.wait_for(h.queue.join(), timeout=2.0)
    finally:
        await _cancel(task)

    m = _fresh(h)
    assert m.flushes == 1  # one flush took all ten, not four of three
    assert m.flush_rows == 10
    assert m.interval_batch_max == 10  # over the patched batch size of 3

    await h._safe_flush([(1,), (2,)])  # a later, smaller batch
    assert m.interval_batch_max == 10
    assert m.flushes == 2


# ----------------------------------------------------------------------
# Handler.enqueue: queue high-water follows the peak, not the current depth
# ----------------------------------------------------------------------


async def test_queue_hwm_follows_the_peak_not_the_current_depth():
    h = _H()
    for seq in range(5):
        await h.enqueue({"seq": seq})
    assert _fresh(h).queue_depth == 5
    assert _fresh(h).interval_queue_hwm == 5

    for _ in range(3):  # the consumer catches up
        h.queue.get_nowait()
        h.queue.task_done()
    await h.enqueue({"seq": 99})

    m = _fresh(h)
    assert m.queue_depth == 3  # current depth went down
    assert m.interval_queue_hwm == 5  # the peak did not


async def test_queue_hwm_caps_at_the_queue_size_when_the_queue_is_full(monkeypatch):
    monkeypatch.setattr(settings, "ws_queue_size", 2)
    monkeypatch.setattr(settings, "ws_backpressure_policy", "drop_newest")
    h = _H()
    for seq in range(5):
        await h.enqueue({"seq": seq})

    m = _fresh(h)
    assert m.drop_count == 3
    assert m.interval_queue_hwm == 2


async def test_an_enqueue_override_that_calls_super_raises_the_hwm_too():
    """Option trades dedupe before queueing and then call the base enqueue."""
    from handlers.option_trades import OptionTradesHandler

    h = OptionTradesHandler()
    await h.enqueue({"id": "8f8a2c3b-1234-4567-89ab-cdef01234567"})
    await h.enqueue({"id": "11111111-1234-4567-89ab-cdef01234567"})

    assert state.handler("option_trades").interval_queue_hwm == 2


# ----------------------------------------------------------------------
# Router: receive-queue high-water
# ----------------------------------------------------------------------


class _Sink:
    name = "sink"

    def __init__(self) -> None:
        self.received: list[dict] = []

    async def enqueue(self, payload: dict) -> None:
        self.received.append(payload)


async def test_the_router_raises_the_receive_queue_hwm_to_the_peak():
    import orjson

    sink = _Sink()
    router = Router({"flow-alerts": sink})
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    for seq in range(5):
        queue.put_nowait(orjson.dumps(["flow-alerts", {"seq": seq}]))

    task = asyncio.create_task(router.run(queue))
    try:
        await asyncio.wait_for(queue.join(), timeout=2.0)
    finally:
        await _cancel(task)

    assert len(sink.received) == 5
    assert state.receive_queue_depth == 0  # drained
    assert state.receive_queue_hwm == 4  # four were still queued behind the first frame


async def test_the_router_never_lowers_the_receive_queue_hwm():
    import orjson

    state.receive_queue_hwm = 7
    router = Router({"flow-alerts": _Sink()})
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue.put_nowait(orjson.dumps(["flow-alerts", {"seq": 1}]))

    task = asyncio.create_task(router.run(queue))
    try:
        await asyncio.wait_for(queue.join(), timeout=2.0)
    finally:
        await _cancel(task)

    assert state.receive_queue_hwm == 7
