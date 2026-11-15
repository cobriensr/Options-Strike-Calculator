"""Concurrent flushes in ``Handler.run`` (spec uw-stream-open-drain-2026-11-14).

A handler with ``flush_concurrency`` N > 1 starts each flush as a task and goes
back to building the next batch, with at most N in flight. N = 1, the default
for every handler but the shared option-trade one, awaits each flush inline as
before; test_handlers.py and test_flush_stats.py cover that path.

Every test drives the real ``run()`` / ``drain()`` with a fake ``_flush`` that
blocks on an event, so overlap, waiting and cancellation are observed rather
than inferred. Batch size 1 and one enqueue at a time make each row its own
batch (a queued row would otherwise be taken into the batch by the backlog
top-up); a batch is named by its first row's ``seq``.
"""

from __future__ import annotations

import asyncio
import contextlib
import gc
from collections.abc import Callable
from types import SimpleNamespace

import pytest

import handlers.base as base_mod
from config import settings
from handlers.base import Handler
from state import state


@pytest.fixture(autouse=True)
def _isolated_state(monkeypatch):
    """A clean handlers map per test, and Sentry captures recorded, not sent."""
    state.handlers.clear()
    reports = SimpleNamespace(exceptions=[], messages=[])
    monkeypatch.setattr(
        base_mod,
        "capture_exception",
        lambda exc, **kw: reports.exceptions.append((exc, kw)),
    )
    monkeypatch.setattr(
        base_mod,
        "capture_message",
        lambda msg, **kw: reports.messages.append((msg, kw)),
    )
    yield reports
    state.handlers.clear()


@pytest.fixture
def reports(_isolated_state):
    return _isolated_state


class _Gated(Handler):
    """Two writers. Each flush enters, blocks on its gate, then returns or raises.

    A flush is named by the ``seq`` of its first row. ``entered`` and
    ``finished`` record the order, ``cancelled`` the flushes a cancel reached,
    and ``peak`` the most flushes inside ``_flush`` at once.
    """

    flush_concurrency = 2

    def __init__(self, name: str = "gated") -> None:
        super().__init__(name=name)
        self.entered: list[int] = []
        self.finished: list[int] = []
        self.cancelled: list[int] = []
        self.written: list[int] = []
        self.fail_on: set[int] = set()
        self.cancel_as_error = False
        self.in_flight = 0
        self.peak = 0
        self._gates: dict[int, asyncio.Event] = {}
        self._all_open = False

    def gate(self, key: int) -> asyncio.Event:
        gate = self._gates.setdefault(key, asyncio.Event())
        if self._all_open:
            gate.set()
        return gate

    def release(self, *keys: int) -> None:
        for key in keys:
            self.gate(key).set()

    def release_all(self) -> None:
        self._all_open = True
        for gate in self._gates.values():
            gate.set()

    def _transform(self, payload: dict) -> tuple | None:
        return (payload["seq"],)

    async def _flush(self, rows: list[tuple]) -> int:
        key = rows[0][0]
        self.entered.append(key)
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await self.gate(key).wait()
            if key in self.fail_on:
                raise TimeoutError("command_timeout")
            self.finished.append(key)
            self.written.extend(row[0] for row in rows)
            return len(rows)
        except asyncio.CancelledError:
            self.cancelled.append(key)
            if self.cancel_as_error:
                # asyncpg can surface a cancel as InterfaceError while unwinding.
                import asyncpg

                raise asyncpg.exceptions.InterfaceError("connection is closed") from None
            raise
        finally:
            self.in_flight -= 1


class _OneWriter(_Gated):
    flush_concurrency = 1


async def _until(predicate: Callable[[], bool], timeout: float = 2.0) -> None:
    """Poll until ``predicate()`` holds; fail with a plain message, not a hang."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("condition not reached within the timeout")
        await asyncio.sleep(0.005)


async def _quiet() -> None:
    """Give the loop time to do anything it was going to do, for a 'did not happen' check."""
    await asyncio.sleep(0.05)


def _start(monkeypatch, h: Handler, batch_size: int = 1) -> asyncio.Task:
    monkeypatch.setattr(h, "_batch_size", batch_size)
    monkeypatch.setattr(h, "_batch_interval", 60.0)
    return asyncio.create_task(h.run())


async def _cancel(task: asyncio.Task) -> None:
    if not task.done():
        task.cancel()
    with contextlib.suppress(BaseException):
        await task


async def _enqueue_and_wait_entered(h: _Gated, seq: int) -> None:
    await h.enqueue({"seq": seq})
    await _until(lambda: seq in h.entered)


def _stray_tasks(before: set[asyncio.Task]) -> set[asyncio.Task]:
    """Tasks started since ``before`` that have not finished."""
    return asyncio.all_tasks() - before - {asyncio.current_task()}


# ----------------------------------------------------------------------
# The mechanism: two flushes overlap, never more than two, in build order
# ----------------------------------------------------------------------


async def test_two_flushes_are_in_flight_at_once(monkeypatch):
    h = _Gated()
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)

        # Both flushes were entered before either returned.
        assert h.entered == [0, 1]
        assert h.finished == []
        assert h.peak == 2
    finally:
        h.release_all()
        await _cancel(run)


async def test_a_third_batch_waits_until_one_of_the_two_finishes(monkeypatch):
    h = _Gated()
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)
        await h.enqueue({"seq": 2})
        await _until(lambda: h.queue.qsize() == 0)  # the consumer took it and holds the batch
        await _quiet()

        assert h.entered == [0, 1]  # no third flush while two are in flight
        assert h._batch == [(2,)]  # built, waiting for a writer
        assert h.peak == 2

        h.release(0)
        await _until(lambda: h.entered == [0, 1, 2])

        assert h.peak == 2  # one writer freed, one taken: never three
        assert h._batch == []
    finally:
        h.release_all()
        await _cancel(run)


async def test_batches_start_in_build_order_and_may_finish_in_either(monkeypatch):
    h = _Gated()
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)
        await h.enqueue({"seq": 2})
        await _until(lambda: h.queue.qsize() == 0)
        await h.enqueue({"seq": 3})

        h.release(1)  # the later batch commits first
        await _until(lambda: h.entered == [0, 1, 2])
        h.release(0)
        await _until(lambda: h.entered == [0, 1, 2, 3])
        h.release_all()
        await _until(lambda: len(h.finished) == 4)

        assert h.entered == [0, 1, 2, 3]  # started in the order built
        assert h.finished[:2] == [1, 0]  # committed out of order
        assert sorted(h.written) == [0, 1, 2, 3]
        assert h.peak == 2
    finally:
        h.release_all()
        await _cancel(run)


async def test_a_handler_with_one_writer_flushes_one_batch_at_a_time(monkeypatch):
    """The default (every handler but the shared option-trade one): the second
    batch is not started, or even taken off the queue, until the first returns.
    """
    h = _OneWriter()
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await h.enqueue({"seq": 1})
        await _quiet()

        assert h.entered == [0]
        assert h._batch == [(0,)]  # held through the flush, as before

        h.release(0)
        await _until(lambda: h.entered == [0, 1])
        assert h.peak == 1
    finally:
        h.release_all()
        await _cancel(run)


# ----------------------------------------------------------------------
# Bookkeeping per flush is unchanged
# ----------------------------------------------------------------------


async def test_a_failing_flush_is_counted_and_logged_and_the_rest_carries_on(monkeypatch, reports):
    h = _Gated()
    h.fail_on = {0}
    errors: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        base_mod.log, "error", lambda msg, *a, **kw: errors.append((msg, kw.get("extra") or {}))
    )
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)

        h.release(0)  # flush 0 raises while flush 1 is still in flight
        await _until(lambda: state.handler(h.name).lost_rows == 1)

        metrics = state.handler(h.name)
        assert [(exc.__class__, kw["tags"]["stage"]) for exc, kw in reports.exceptions] == [
            (TimeoutError, "flush")
        ]
        assert [(msg, extra["batch_size"]) for msg, extra in errors] == [("flush failed", 1)]
        assert h.finished == []  # flush 1 is still running
        assert not run.done()  # and so is the consumer

        # The consumer takes the freed writer for the next batch.
        await _enqueue_and_wait_entered(h, 2)
        h.release_all()
        await _until(lambda: sorted(h.finished) == [1, 2])

        assert metrics.write_attempted == 3
        assert metrics.write_count == 2
        assert metrics.lost_rows == 1  # no row both written and lost
        assert metrics.flushes == 3  # the failed flush counts, as before
    finally:
        h.release_all()
        await _cancel(run)


async def test_flush_stats_add_up_across_overlapping_flushes(monkeypatch):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(base_mod, "time", SimpleNamespace(monotonic=lambda: clock.now))
    h = _Gated()
    run = _start(monkeypatch, h, batch_size=3)
    try:
        for seq in (0, 1, 2):  # one batch of three rows, named 0
            await h.enqueue({"seq": seq})
        await _until(lambda: h.entered == [0])
        monkeypatch.setattr(h, "_batch_size", 1)
        await _enqueue_and_wait_entered(h, 10)  # one batch of one row, named 10

        clock.now = 101.5
        h.release(10)  # 1.5 s
        await _until(lambda: h.finished == [10])
        clock.now = 104.0
        h.release(0)  # 4.0 s
        await _until(lambda: h.finished == [10, 0])

        m = state.handler(h.name)
        assert m.flushes == 2
        assert m.flush_rows == 4
        assert m.flush_seconds == pytest.approx(5.5)  # the two flushes' times add, overlapped
        assert m.interval_flush_max_s == pytest.approx(4.0)
        assert m.interval_batch_max == 3
        assert (m.write_attempted, m.write_count, m.lost_rows) == (4, 4, 0)
    finally:
        h.release_all()
        await _cancel(run)


async def test_a_flush_task_that_dies_unexpectedly_is_reported_and_never_left_unretrieved(
    monkeypatch, reports
):
    """_safe_flush swallows what a flush raises, so a task that still ends with
    an exception means the bookkeeping itself failed. Nobody awaits the task, so
    the done callback must retrieve and report it: an unretrieved exception only
    shows as "Task exception was never retrieved" at garbage collection.
    """
    loop = asyncio.get_running_loop()
    unretrieved: list[dict] = []
    loop.set_exception_handler(lambda _loop, context: unretrieved.append(context))
    h = _Gated()

    async def _broken(rows: list[tuple]) -> None:
        raise RuntimeError("flush bookkeeping failed")

    monkeypatch.setattr(h, "_safe_flush", _broken)
    run = _start(monkeypatch, h)
    try:
        await h.enqueue({"seq": 0})
        await _until(lambda: len(reports.exceptions) == 1)
        await h.enqueue({"seq": 1})  # the consumer survived, and the slot came back
        await _until(lambda: len(reports.exceptions) == 2)
        gc.collect()
        await _quiet()
        gc.collect()

        assert [(str(exc), kw["tags"]["stage"]) for exc, kw in reports.exceptions] == [
            ("flush bookkeeping failed", "flush_task")
        ] * 2
        assert unretrieved == []
    finally:
        loop.set_exception_handler(None)
        await _cancel(run)


# ----------------------------------------------------------------------
# Shutdown: drain waits for the flushes in flight, the deadline cancels them
# ----------------------------------------------------------------------


async def test_drain_waits_for_the_flushes_in_flight_then_flushes_the_rest(monkeypatch):
    h = _Gated()
    run = _start(monkeypatch, h)
    drain = None
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)
        await h.enqueue({"seq": 2})
        await _until(lambda: h.queue.qsize() == 0)  # held, waiting for a writer
        await h.enqueue({"seq": 3})  # still queued

        drain = asyncio.create_task(h.drain(deadline_s=5.0))
        h.release(0)  # a writer frees: the held batch starts, the consumer exits
        await _until(lambda: h.entered == [0, 1, 2])
        await _quiet()

        # Flushes 1 and 2 are in flight: drain has not started its own flush.
        assert not drain.done()
        assert h.entered == [0, 1, 2]

        h.release_all()
        flushed = await asyncio.wait_for(drain, timeout=2.0)

        assert flushed == 1  # the queued row; the rest were already written
        assert h.entered == [0, 1, 2, 3]
        assert sorted(h.written) == [0, 1, 2, 3]  # every row exactly once
        assert run.done()
        metrics = state.handler(h.name)
        assert (metrics.write_attempted, metrics.write_count, metrics.lost_rows) == (4, 4, 0)
    finally:
        h.release_all()
        if drain is not None:
            await _cancel(drain)
        await _cancel(run)


@pytest.mark.parametrize("held", [False, True], ids=["consumer-idle", "consumer-holding-a-batch"])
async def test_the_drain_deadline_cancels_every_in_flight_flush(monkeypatch, reports, held):
    """Past its deadline drain reports the rows it will lose and cancels the
    flushes it gave up on, as it cancels the consumer: left running they would
    write rows the event called lost, or fail later and count them again.
    Nothing is left pending, and the cancelled flushes count nothing.
    """
    before = asyncio.all_tasks()
    h = _Gated()
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)
        if held:
            await h.enqueue({"seq": 2})
            # The consumer holds [2], parked for a writer.
            await _until(lambda: h.queue.qsize() == 0)
            await h.enqueue({"seq": 3})
            expected_lost = 4  # two in flight, one held, one queued
        else:
            expected_lost = 2

        assert await h.drain(deadline_s=0.2) == 0

        assert [(msg, kw["tags"]["stage"]) for msg, kw in reports.messages] == [
            ("uw-stream drain deadline hit; unflushed rows lost", "consumer_busy")
        ]
        context = reports.messages[0][1]["context"]
        assert context["lost_rows"] == expected_lost
        assert context["in_flight_flushes"] == 2

        await _until(lambda: sorted(h.cancelled) == [0, 1])
        await _quiet()
        assert _stray_tasks(before | {run}) == set()
        assert h.entered == [0, 1]  # the held batch never started
        m = state.handler(h.name)
        assert (m.flushes, m.write_count, m.lost_rows) == (0, 0, 0)  # counted once, by the drain
        assert reports.exceptions == []
    finally:
        await _cancel(run)


async def test_a_cancel_a_flush_turns_into_an_exception_is_not_reported_as_a_failure(
    monkeypatch, reports
):
    """Unwinding a cancelled query asyncpg raises InterfaceError, not
    CancelledError. The flush task then ends with an exception, but the cancel is
    what ended it: it is neither counted lost nor sent to Sentry.
    """
    loop = asyncio.get_running_loop()
    unretrieved: list[dict] = []
    loop.set_exception_handler(lambda _loop, context: unretrieved.append(context))
    h = _Gated()
    h.cancel_as_error = True
    run = _start(monkeypatch, h)
    try:
        await _enqueue_and_wait_entered(h, 0)
        await _enqueue_and_wait_entered(h, 1)

        assert await h.drain(deadline_s=0.2) == 0
        await _until(lambda: sorted(h.cancelled) == [0, 1])
        await _quiet()
        gc.collect()
        await _quiet()

        assert reports.exceptions == []
        assert state.handler(h.name).lost_rows == 0
        assert unretrieved == []
    finally:
        loop.set_exception_handler(None)
        await _cancel(run)


async def test_cancelling_the_consumer_cancels_its_in_flight_flushes(monkeypatch):
    before = asyncio.all_tasks()
    h = _Gated()
    run = _start(monkeypatch, h)
    await _enqueue_and_wait_entered(h, 0)
    await _enqueue_and_wait_entered(h, 1)

    await _cancel(run)
    await _until(lambda: sorted(h.cancelled) == [0, 1])
    await _quiet()

    assert run.cancelled()
    assert _stray_tasks(before) == set()
    assert (state.handler(h.name).flushes, state.handler(h.name).lost_rows) == (0, 0)


# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------


def test_a_flush_concurrency_below_one_is_rejected():
    class _Zero(_Gated):
        flush_concurrency = 0

    with pytest.raises(ValueError, match="flush_concurrency"):
        _Zero()


def test_queue_size_defaults_to_the_setting_when_the_handler_does_not_set_one(monkeypatch):
    monkeypatch.setattr(settings, "ws_queue_size", 123)

    assert _OneWriter().queue.maxsize == 123


def test_a_handler_can_set_its_own_queue_size(monkeypatch):
    class _Big(_OneWriter):
        queue_size = 777

    monkeypatch.setattr(settings, "ws_queue_size", 123)

    assert _Big().queue.maxsize == 777


def _every_concrete_handler_class() -> list[type[Handler]]:
    """The handler classes the channel registry can hand out, except the option-trade family."""
    from handlers.flow_alerts import FlowAlertsHandler
    from handlers.futures_blocks import FuturesBlocksHandler
    from handlers.futures_trades import FuturesTradesHandler
    from handlers.gex_strike_expiry import GexStrikeExpiryHandler
    from handlers.net_flow import NetFlowHandler
    from handlers.off_lit_trades import OffLitTradesHandler

    return [
        FlowAlertsHandler,
        FuturesBlocksHandler,
        FuturesTradesHandler,
        GexStrikeExpiryHandler,
        NetFlowHandler,
        OffLitTradesHandler,
    ]


@pytest.mark.parametrize("cls", _every_concrete_handler_class(), ids=lambda cls: cls.__name__)
def test_every_other_handler_keeps_the_default_queue_and_one_writer(monkeypatch, cls):
    monkeypatch.setattr(settings, "ws_queue_size", 4321)

    h = cls()

    assert h.queue.maxsize == 4321
    assert h.flush_concurrency == 1
