"""Tests for sidecar/src/batched_writer.py.

The base class is the load-bearing primitive under both
:class:`TradeProcessor` and the inner ``_TopOfBookWriter`` /
``_TradeTickWriter`` of :class:`QuoteProcessor`. Coverage targets the
contract those subclasses depend on:

- size-based auto-flush via ``add()``
- manual flush via ``flush()`` (no-op on empty buffer)
- DB write runs OUTSIDE the lock — the buffer-swap critical section
  must not include the write
- background flush thread cadence + idempotent ``start_background_flush``
- ``stop()`` drains the buffer + joins the thread
- per-instance lock isolation (no shared module state across instances)

Mock strategy mirrors test_trade_processor.py: ``conftest.py`` already
provides session-wide mocks for ``databento`` / ``psycopg2`` / ``sentry_sdk``,
and we just import ``batched_writer`` normally.
"""

from __future__ import annotations

import os
import threading
import time

# Required env vars for config.py's pydantic-settings validation, even
# though batched_writer itself doesn't reach config — its imports
# transitively touch logger_setup which is independent, but other
# sibling test modules may have set these already.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

from batched_writer import BatchedWriter  # noqa: E402


# ---------------------------------------------------------------------------
# Test subclasses
# ---------------------------------------------------------------------------


class _RecordingWriter(BatchedWriter[int]):
    """Minimal subclass that records each ``_write`` call into a list.

    Captures the rows written + the lock state observed inside the
    write so we can assert lock-then-release-before-IO ordering
    without relying on monkeypatched module globals.
    """

    def __init__(self, batch_size: int = 5) -> None:
        super().__init__(batch_size=batch_size)
        self.writes: list[list[int]] = []
        self.observed_lock_state: list[bool] = []

    def _write(self, rows: list[int]) -> None:
        # Record what we got and what the lock looked like at this moment.
        self.observed_lock_state.append(self._lock.locked())
        self.writes.append(list(rows))


class _SlowWriter(BatchedWriter[int]):
    """Subclass that holds the DB-write phase for a configurable delay.

    Used to verify that concurrent ``add`` calls don't serialize behind
    the slow write — the lock-then-release-before-IO invariant.
    """

    def __init__(self, batch_size: int = 5, *, delay_s: float = 0.1) -> None:
        super().__init__(batch_size=batch_size)
        self._delay_s = delay_s
        self.writes: list[list[int]] = []

    def _write(self, rows: list[int]) -> None:
        time.sleep(self._delay_s)
        self.writes.append(list(rows))


# ---------------------------------------------------------------------------
# Buffer growth + size-based auto-flush
# ---------------------------------------------------------------------------


class TestBufferGrowth:
    def test_below_threshold_does_not_flush(self) -> None:
        w = _RecordingWriter(batch_size=5)
        for i in range(4):
            w.add(i)
        assert w.writes == []
        # Buffer carries the unflushed items.
        assert w._buffer == [0, 1, 2, 3]

    def test_threshold_triggers_flush(self) -> None:
        w = _RecordingWriter(batch_size=5)
        for i in range(5):
            w.add(i)
        assert w.writes == [[0, 1, 2, 3, 4]]
        assert w._buffer == []

    def test_post_flush_buffer_continues_filling(self) -> None:
        """After an auto-flush, the next ``add`` lands in a fresh empty
        buffer; the second flush must NOT include the previous rows."""
        w = _RecordingWriter(batch_size=3)
        for i in range(6):
            w.add(i)
        assert w.writes == [[0, 1, 2], [3, 4, 5]]


class TestManualFlush:
    def test_flush_below_threshold_drains(self) -> None:
        w = _RecordingWriter(batch_size=10)
        for i in range(3):
            w.add(i)
        w.flush()
        assert w.writes == [[0, 1, 2]]
        assert w._buffer == []

    def test_flush_empty_is_noop(self) -> None:
        w = _RecordingWriter(batch_size=5)
        w.flush()
        assert w.writes == []

    def test_double_flush_does_not_re_emit(self) -> None:
        w = _RecordingWriter(batch_size=10)
        w.add(1)
        w.flush()
        w.flush()
        assert w.writes == [[1]]


# ---------------------------------------------------------------------------
# Lock-then-release-before-IO
# ---------------------------------------------------------------------------


class TestLockReleasedBeforeWrite:
    """The critical concurrency invariant: ``_write`` runs outside the
    buffer mutation lock. Without this, a slow Neon round trip would
    serialize every Databento callback behind one IO."""

    def test_auto_flush_observes_unlocked(self) -> None:
        w = _RecordingWriter(batch_size=2)
        w.add(1)
        w.add(2)
        # _write was called once; the lock was NOT held when it ran.
        assert w.observed_lock_state == [False]

    def test_manual_flush_observes_unlocked(self) -> None:
        w = _RecordingWriter(batch_size=10)
        w.add(1)
        w.flush()
        assert w.observed_lock_state == [False]

    def test_concurrent_add_during_slow_write_does_not_block(self) -> None:
        """A slow ``_write`` from thread 1 must not delay thread 2.
        With the lock-then-release pattern, thread 2's ``add`` only
        contends for the brief buffer-swap critical section."""
        w = _SlowWriter(batch_size=5, delay_s=0.2)

        # Pre-fill so the next add will trigger an auto-flush.
        for i in range(4):
            w.add(i)

        flusher_started: list[float] = []
        second_returned_at: list[float] = []

        def flusher() -> None:
            flusher_started.append(time.monotonic())
            w.add(100)  # crosses batch_size → triggers slow write

        def second() -> None:
            while not flusher_started:
                time.sleep(0.005)
            time.sleep(0.02)  # ensure flusher is in the slow write
            start = time.monotonic()
            w.add(200)
            second_returned_at.append(time.monotonic() - start)

        t1 = threading.Thread(target=flusher)
        t2 = threading.Thread(target=second)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert second_returned_at, "second thread never completed"
        assert second_returned_at[0] < 0.15, (
            f"second add() took {second_returned_at[0]:.3f}s — lock is "
            f"probably held through the DB write"
        )


# ---------------------------------------------------------------------------
# Contention under concurrent adds
# ---------------------------------------------------------------------------


class TestContention:
    def test_many_concurrent_adds_dont_lose_rows(self) -> None:
        """Stress: N threads each add M items. Total items written must
        equal N*M with no losses, no duplicates, regardless of how the
        auto-flushes interleave."""
        w = _RecordingWriter(batch_size=17)  # awkward size to force partial flushes

        n_threads = 8
        per_thread = 50

        def worker(tid: int) -> None:
            for i in range(per_thread):
                w.add(tid * per_thread + i)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        w.flush()  # drain the tail

        emitted: list[int] = []
        for batch in w.writes:
            emitted.extend(batch)
        assert sorted(emitted) == list(range(n_threads * per_thread))


# ---------------------------------------------------------------------------
# Background flush thread cadence + idempotency
# ---------------------------------------------------------------------------


def _wait_until(predicate, timeout: float = 2.0, poll: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(poll)
    return False


class TestBackgroundFlush:
    def test_periodic_flush_drains_sub_batch_buffer(self) -> None:
        """A tick must flush buffered items even when count < batch_size."""
        w = _RecordingWriter(batch_size=1000)  # huge so size-flush won't fire
        w.start_background_flush(interval_s=0.05)
        try:
            for i in range(3):
                w.add(i)
            assert w.writes == []  # no tick yet
            assert _wait_until(lambda: len(w.writes) >= 1)
            assert w.writes[0] == [0, 1, 2]
        finally:
            w.stop()

    def test_periodic_tick_with_empty_buffer_is_noop(self) -> None:
        w = _RecordingWriter(batch_size=1000)
        w.start_background_flush(interval_s=0.05)
        try:
            time.sleep(0.2)  # several ticks
            assert w.writes == []
        finally:
            w.stop()

    def test_start_background_flush_is_idempotent(self) -> None:
        w = _RecordingWriter(batch_size=1000)
        w.start_background_flush(interval_s=0.05)
        first = w._flush_thread
        w.start_background_flush(interval_s=0.05)
        try:
            assert w._flush_thread is first
            assert first is not None and first.is_alive()
        finally:
            w.stop()


class TestStop:
    def test_stop_drains_buffer(self) -> None:
        """``stop`` must always perform a final flush so we don't lose
        rows on shutdown, even if no background thread was running."""
        w = _RecordingWriter(batch_size=1000)
        w.add(1)
        w.add(2)
        w.stop()
        assert w.writes == [[1, 2]]

    def test_stop_joins_background_thread(self) -> None:
        w = _RecordingWriter(batch_size=1000)
        w.start_background_flush(interval_s=10.0)  # long → no tick
        w.add(99)
        assert w.writes == []
        w.stop()
        assert w.writes == [[99]]
        assert w._flush_thread is not None
        assert not w._flush_thread.is_alive()

    def test_stop_without_start_is_safe(self) -> None:
        w = _RecordingWriter(batch_size=1000)
        w.add(7)
        w.stop()
        assert w.writes == [[7]]
        assert w._flush_thread is None


# ---------------------------------------------------------------------------
# Per-instance isolation
# ---------------------------------------------------------------------------


class TestIsolation:
    def test_two_instances_have_independent_buffers_and_locks(self) -> None:
        """Sanity: BatchedWriter holds no module-level state, so two
        instances don't cross-contaminate. This is the property
        QuoteProcessor depends on when it composes _TopOfBookWriter +
        _TradeTickWriter."""
        a = _RecordingWriter(batch_size=2)
        b = _RecordingWriter(batch_size=2)
        a.add(1)
        b.add(99)
        a.flush()
        b.flush()
        assert a.writes == [[1]]
        assert b.writes == [[99]]
        assert a._lock is not b._lock


# ---------------------------------------------------------------------------
# ABC-ness
# ---------------------------------------------------------------------------


class TestAbstract:
    def test_cannot_instantiate_base_class_directly(self) -> None:
        """``BatchedWriter`` is abstract — instantiating without
        overriding ``_write`` must fail at construction time."""
        with pytest.raises(TypeError):
            BatchedWriter(batch_size=5)  # type: ignore[abstract]
