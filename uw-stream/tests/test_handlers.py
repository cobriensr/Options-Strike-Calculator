"""Unit tests for FlowAlertsHandler._transform.

DB writes are not exercised here — those are covered by the soak
window described in
docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md
where daemon and cron co-write the same data and a parity report is
generated.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from handlers.flow_alerts import (
    _COLUMNS,
    FlowAlertsHandler,
    _ms_epoch_to_dt,
    _to_bool,
    _to_decimal,
    _to_int,
    _to_uuid,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "flow_alerts_sample.json"


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> FlowAlertsHandler:
    return FlowAlertsHandler()


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_parsed_ticker_and_issue_type(self, handler, payload):
        row = handler._transform(payload)
        # Column index lookups via name.
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["ticker"]] == "DIA"
        assert row[idx["issue_type"]] == "ETF"  # DIA is in the lookup

    def test_parsed_occ_fields(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["expiry"]] == date(2024, 10, 18)
        assert row[idx["strike"]] == Decimal("415.000")
        assert row[idx["option_type"]] == "C"
        # Original symbol preserved verbatim for /option-contract/{symbol}/* lookups.
        assert row[idx["option_chain"]] == "DIA241018C00415000"

    def test_created_at_from_executed_at_ms_epoch(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        # 1726670212748 ms = 2024-09-18T14:36:52.748+00:00
        ts = row[idx["created_at"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        # Sanity check: same to-the-second value the fixture encodes.
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_string_priced_fields_become_decimal(self, handler, payload):
        # `bid` and `ask` arrive as strings on the wire even though the
        # rest of the numerics are JSON numbers.
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["bid"]] == Decimal("7.15")
        assert row[idx["ask"]] == Decimal("7.3")

    def test_raw_payload_round_trips(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        # The raw payload is stored as a dict for asyncpg's JSONB codec.
        assert row[idx["raw_payload"]] is payload


class TestTransformRejection:
    def test_missing_option_chain_returns_none(self, handler, payload):
        del payload["option_chain"]
        assert handler._transform(payload) is None

    def test_malformed_option_chain_returns_none(self, handler, payload):
        payload["option_chain"] = "NOTANOCC"
        assert handler._transform(payload) is None

    def test_missing_executed_at_returns_none(self, handler, payload):
        del payload["executed_at"]
        assert handler._transform(payload) is None

    def test_missing_id_returns_none(self, handler, payload):
        # ws_alert_id is the table's NOT NULL UNIQUE key; missing UUID
        # must reject the row rather than risk a NULL violation later.
        del payload["id"]
        assert handler._transform(payload) is None

    def test_malformed_id_returns_none(self, handler, payload):
        payload["id"] = "not-a-uuid"
        assert handler._transform(payload) is None

    def test_ws_alert_id_is_typed_uuid(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert isinstance(row[idx["ws_alert_id"]], UUID)


class TestTypeCoercion:
    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            ("", None),
            (123, Decimal("123")),
            (1.5, Decimal("1.5")),
            ("1.5", Decimal("1.5")),
            ("not-a-number", None),
        ],
    )
    def test_to_decimal(self, v, expected):
        assert _to_decimal(v) == expected

    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            ("", None),
            (5, 5),
            (5.7, 5),  # truncates via Decimal cast
            ("5", 5),
            ("not", None),
        ],
    )
    def test_to_int(self, v, expected):
        assert _to_int(v) == expected

    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            (True, True),
            (False, False),
            ("true", True),
            ("FALSE", False),
            ("1", True),
            ("0", False),
            (1, True),
            (0, False),
            ("garbage", None),
        ],
    )
    def test_to_bool(self, v, expected):
        assert _to_bool(v) == expected

    def test_ms_epoch_to_dt(self):
        ts = _ms_epoch_to_dt(1726670212748)
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_ms_epoch_handles_string_input(self):
        ts = _ms_epoch_to_dt("1726670212748")
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_ms_epoch_returns_none_on_garbage(self):
        assert _ms_epoch_to_dt("not-a-number") is None
        assert _ms_epoch_to_dt(None) is None
        assert _ms_epoch_to_dt("") is None

    @pytest.mark.parametrize(
        "v,expected",
        [
            ("29ed5829-e4ce-4934-876b-51985d2f9b70", UUID("29ed5829-e4ce-4934-876b-51985d2f9b70")),
            (
                UUID("29ed5829-e4ce-4934-876b-51985d2f9b70"),
                UUID("29ed5829-e4ce-4934-876b-51985d2f9b70"),
            ),
            (None, None),
            ("", None),
            ("not-a-uuid", None),
            (12345, None),
        ],
    )
    def test_to_uuid(self, v, expected):
        assert _to_uuid(v) == expected


# ----------------------------------------------------------------------
# Phase 1 / H4: Handler.drain()
# ----------------------------------------------------------------------


class _DrainTestHandler:
    """Tiny concrete Handler that records every flushed batch.

    Imported lazily inside the test module to avoid pulling the abstract
    ``Handler`` into the FlowAlertsHandler class scope above.
    """

    pass


@pytest.mark.asyncio
async def test_drain_flushes_in_memory_batch_and_remaining_queue(monkeypatch):
    """Regression for H4: SIGTERM must not silently drop the in-memory
    batch or items still in the queue. ``Handler.drain()`` should pull
    everything together and call ``_safe_flush`` exactly once with the
    combined rows.
    """
    import asyncio as _asyncio

    from config import settings
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _RecordingHandler(Handler):
        def __init__(self, name: str = "drain-test") -> None:
            super().__init__(name=name)
            self.flush_calls: list[list[tuple]] = []

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> None:
            # Copy the list so subsequent mutations in run() don't
            # affect the recorded snapshot.
            self.flush_calls.append(list(rows))

    monkeypatch.setattr(settings, "ws_queue_size", 16)

    h = _RecordingHandler()

    # Simulate steady-state where ``run()`` already accumulated a partial
    # batch (rows 0 + 1) below the size threshold, AND there are still
    # 3 unprocessed payloads sitting in the queue.
    h._batch = [(0,), (1,)]
    for seq in range(2, 5):
        h.queue.put_nowait({"seq": seq})

    # Mark _stopped so drain() doesn't wait for run() (we never started
    # it — this test is for the drain path in isolation).
    h._stopped.set()

    flushed = await h.drain()

    # All 5 rows (2 in-memory + 3 from queue) flushed in one call.
    assert flushed == 5
    assert len(h.flush_calls) == 1
    assert h.flush_calls[0] == [(0,), (1,), (2,), (3,), (4,)]
    # Queue is now empty and the in-memory batch was reset.
    assert h.queue.qsize() == 0
    assert h._batch == []

    state.handlers.clear()
    _ = _asyncio  # silence unused-import for linters

    # Reference _DrainTestHandler so ruff doesn't flag it (placeholder
    # documenting where future drain tests go).
    _ = _DrainTestHandler


@pytest.mark.asyncio
async def test_drain_signals_running_consumer_to_stop(monkeypatch):
    """When ``run()`` is actively consuming, ``drain()`` must set
    ``_stopping`` so the loop exits cleanly, then collect both the
    consumer-built batch AND any tail items still in the queue.
    """
    from config import settings
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    flush_event = asyncio.Event()

    class _SlowHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="drain-running-test")
            self.flush_calls: list[list[tuple]] = []

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> None:
            self.flush_calls.append(list(rows))
            flush_event.set()

    # Long batch interval so run() never time-flushes; large batch size
    # so the consumer accumulates without flushing on its own.
    monkeypatch.setattr(settings, "ws_batch_size", 1000)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)

    h = _SlowHandler()
    task = asyncio.create_task(h.run())
    try:
        for seq in range(3):
            await h.enqueue({"seq": seq})
        # Give the consumer a moment to drain the queue into _batch.
        for _ in range(20):
            if not h.queue.empty() or len(h._batch) < 3:
                await asyncio.sleep(0.01)
            else:
                break

        flushed = await h.drain()
        assert flushed == 3
        assert h.flush_calls == [[(0,), (1,), (2,)]]
        assert task.done()
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        state.handlers.clear()


# ----------------------------------------------------------------------
# Phase 1 / FIX 1 + FIX 3: drain() failure-path coverage
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_drain_handles_safe_flush_raising(monkeypatch):
    """When ``_flush`` raises, ``_safe_flush`` must swallow the exception
    AND ``drain()`` must still clear ``self._batch`` so a subsequent
    drain or flush attempt won't re-emit the same rows.

    Pairs with FIX 4 — the returned count is rows ATTEMPTED, not rows
    successfully flushed; we verify that contract here.
    """
    from config import settings
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _RaisingHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="drain-raise-test")
            self.flush_attempts = 0

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> None:
            self.flush_attempts += 1
            raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(settings, "ws_queue_size", 16)

    h = _RaisingHandler()
    h._batch = [(0,), (1,)]
    for seq in range(2, 5):
        h.queue.put_nowait({"seq": seq})

    # Mark _stopped so drain() doesn't wait for a non-existent run().
    h._stopped.set()

    # Must not propagate the RuntimeError — _safe_flush swallows.
    flushed = await h.drain()

    # Returned count is "rows attempted" — non-zero even though _flush raised.
    assert flushed == 5
    assert h.flush_attempts == 1
    # Batch was cleared so subsequent calls don't re-emit stale rows.
    assert h._batch == []

    state.handlers.clear()


def _record_warnings(monkeypatch) -> list[tuple[str, dict]]:
    """Patch ``handlers.base.log.warning`` to capture (msg, extra) tuples.

    The project logger sets ``propagate=False`` and writes JSON lines to
    a StreamHandler captured at import time, so neither ``caplog`` nor
    ``capsys`` reliably observes its output. Patching the bound ``log``
    name on the module under test is the most direct contract check.
    """
    import handlers.base as base_mod

    captured: list[tuple[str, dict]] = []

    def _warning(msg, *args, **kwargs):
        captured.append((msg, kwargs.get("extra") or {}))

    monkeypatch.setattr(base_mod.log, "warning", _warning)
    return captured


class _SeqHandler:
    """Factory for a concrete Handler whose ``_flush`` awaits ``flush_s``.

    Records every flushed batch, so a test can check that no row is written
    twice. Built lazily so ``Handler`` is imported inside the test, like the
    other drain tests here.
    """

    @staticmethod
    def build(name: str, flush_s: float):
        from handlers.base import Handler

        class _H(Handler):
            def __init__(self) -> None:
                super().__init__(name=name)
                self.flush_calls: list[list[tuple]] = []

            def _transform(self, payload: dict) -> tuple | None:
                return (payload.get("seq"),)

            async def _flush(self, rows: list[tuple]) -> None:
                self.flush_calls.append(list(rows))
                await asyncio.sleep(flush_s)

        return _H()


async def _park_run_in_flush(monkeypatch, h) -> asyncio.Task:
    """Start ``run()`` with batch size 1 and push row 0, so the consumer is
    inside ``_safe_flush`` holding ``self._batch == [(0,)]`` when this returns.
    """
    monkeypatch.setattr(h, "_batch_size", 1)
    monkeypatch.setattr(h, "_batch_interval", 60.0)
    task = asyncio.create_task(h.run())
    await h.enqueue({"seq": 0})
    await asyncio.sleep(0.05)
    assert h._batch == [(0,)], f"test setup: run() should be mid-flush; got {h._batch!r}"
    return task


async def _cancel(task: asyncio.Task) -> None:
    if not task.done():
        task.cancel()
        with contextlib.suppress(BaseException):
            await task


@pytest.mark.asyncio
async def test_drain_waits_for_in_flight_flush_and_never_double_flushes(monkeypatch):
    """FIX 1 invariant, kept: while ``run()`` is inside a flush, ``drain()``
    must not touch ``self._batch``, or both could write the same rows. Instead
    of giving up after 1 s (which lost the queue and the batch), drain now
    waits for the in-flight flush, inside its own deadline, then flushes the
    rows still queued. Every row is written exactly once.
    """
    from state import state

    state.handlers.clear()
    h = _SeqHandler.build("drain-wait-test", flush_s=1.2)
    task = await _park_run_in_flush(monkeypatch, h)
    try:
        await h.enqueue({"seq": 1})
        await h.enqueue({"seq": 2})

        flushed = await h.drain(deadline_s=5.0)

        assert flushed == 2
        assert h.flush_calls == [[(0,)], [(1,), (2,)]]
        assert task.done()
    finally:
        await _cancel(task)
        state.handlers.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["consumer_busy", "final_flush"])
async def test_drain_timeout_reports_sentry_with_lost_rows(monkeypatch, path):
    """Whenever the deadline is hit, drain sends one Sentry event with the
    rows it is about to lose: the in-memory batch plus what is still queued.

    consumer_busy: ``run()`` is stuck in a flush of row 0 and rows 1-3 are
    queued (the wake-up sentinel must not count as a row).
    final_flush: the consumer has stopped and drain's own final flush of
    rows 0-4 is too slow.
    """
    import handlers.base as base_mod
    from state import state

    state.handlers.clear()
    messages: list[tuple[str, dict]] = []
    monkeypatch.setattr(base_mod, "capture_message", lambda msg, **kw: messages.append((msg, kw)))

    h = _SeqHandler.build(f"drain-timeout-{path}", flush_s=10.0)
    task = None
    try:
        if path == "consumer_busy":
            task = await _park_run_in_flush(monkeypatch, h)
            for seq in (1, 2, 3):
                await h.enqueue({"seq": seq})
            batch_before = h._batch
            expected = {"in_memory_batch": 1, "queue_remaining": 3, "lost_rows": 4}
        else:
            h._batch = [(0,), (1,)]
            for seq in (2, 3, 4):
                h.queue.put_nowait({"seq": seq})
            h._stopped.set()
            expected = {"in_memory_batch": 5, "queue_remaining": 0, "lost_rows": 5}

        flushed = await h.drain(deadline_s=0.2)

        assert flushed == 0
        assert len(messages) == 1
        msg, kw = messages[0]
        assert "drain deadline" in msg
        assert kw["level"] == "warning"
        assert kw["tags"] == {"component": "handler", "channel": h.name, "stage": path}
        ctx = kw["context"]
        assert {k: ctx[k] for k in expected} == expected
        assert ctx["deadline_s"] == 0.2
        if path == "consumer_busy":
            # The in-flight batch was left alone: no double-flush race.
            assert h._batch is batch_before
    finally:
        if task is not None:
            await _cancel(task)
        state.handlers.clear()


@pytest.mark.asyncio
async def test_drain_flush_does_not_retry():
    """The drain's final flush makes ONE attempt. A retry (0.5 s backoff and
    another 30 s command_timeout) would only run past Railway's SIGKILL.
    Steady-state flushes still retry, so the single-attempt scope must not
    leak out of drain().
    """
    from unittest.mock import AsyncMock, MagicMock, patch

    import db
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _DbHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="drain-no-retry-test")

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> int:
            return await db.bulk_insert_ignore_conflict("t", ["seq"], rows, ["seq"])

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=TimeoutError("command_timeout"))
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    txn_cm = MagicMock()
    txn_cm.__aenter__ = AsyncMock(return_value=None)
    txn_cm.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=txn_cm)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)

    h = _DbHandler()
    h._batch = [(0,), (1,)]
    h._stopped.set()
    try:
        with patch("db.get_pool", return_value=pool), patch("db.asyncio.sleep", new=AsyncMock()):
            await h.drain()
            drain_attempts = conn.execute.await_count
            # A steady-state flush after the drain still gets all 3 attempts.
            await h._safe_flush([(9,)])

        assert drain_attempts == 1
        assert conn.execute.await_count == 1 + db._DB_RETRY_MAX_ATTEMPTS
    finally:
        state.handlers.clear()


def test_drain_deadline_fits_railway_draining_seconds():
    """Railway SIGKILLs the old deploy ``drainingSeconds`` after SIGTERM
    (default 0). _shutdown releases the lease (up to its 5 s HTTP budget),
    drains every handler concurrently (up to the drain deadline), then flushes
    push notifications (up to 2 s). All of it must fit in the window.
    """
    import inspect
    import tomllib

    import main
    import notify
    from handlers.base import DRAIN_DEADLINE_S, Handler

    railway = tomllib.loads((Path(__file__).resolve().parents[1] / "railway.toml").read_text())
    draining_s = railway["deploy"]["drainingSeconds"]
    notify_s = inspect.signature(notify.drain_pending).parameters["timeout"].default

    assert inspect.signature(Handler.drain).parameters["deadline_s"].default == DRAIN_DEADLINE_S
    assert DRAIN_DEADLINE_S >= 30.0  # at least one full command_timeout
    assert main._LEASE_HTTP_TIMEOUT_S + DRAIN_DEADLINE_S + notify_s < draining_s


@pytest.mark.asyncio
async def test_drain_exceeds_deadline_logs_warning(monkeypatch):
    """When the inner drain pipeline overruns ``deadline_s``, drain()
    must return 0 and log a warning that mentions the deadline.
    """
    from config import settings
    from handlers.base import Handler
    from state import state

    state.handlers.clear()
    warnings = _record_warnings(monkeypatch)

    class _NoopHandler(Handler):
        def _transform(self, payload: dict) -> tuple | None:
            return None

        async def _flush(self, rows: list[tuple]) -> None:
            return None

    monkeypatch.setattr(settings, "ws_queue_size", 4)

    h = _NoopHandler(name="drain-deadline-test")

    async def _slow_inner() -> int:
        await asyncio.sleep(10)
        return 0

    monkeypatch.setattr(h, "_drain_inner", _slow_inner)

    flushed = await h.drain(deadline_s=0.1)

    assert flushed == 0
    assert any("deadline" in msg.lower() or "deadline_s" in extra for msg, extra in warnings)

    state.handlers.clear()


# ----------------------------------------------------------------------
# Phase 3 / M2: write_attempted vs write_count separation
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_safe_flush_increments_attempted_and_actual_separately():
    """``write_attempted`` counts every row the handler tried to flush;
    ``write_count`` counts only the rows the database actually wrote
    (i.e. what ``_flush`` returned). The delta is the dedup rate.
    """
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _ConflictHandler(Handler):
        """Pretends N-2 of every batch landed (2 ON CONFLICT skips)."""

        def __init__(self) -> None:
            super().__init__(name="m2-attempted-vs-actual")

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> int:
            # Simulate N-2 of every batch landing — the other 2 are
            # ON CONFLICT DO NOTHING dedup skips.
            return max(0, len(rows) - 2)

    h = _ConflictHandler()
    rows = [(i,) for i in range(10)]

    await h._safe_flush(rows)

    metrics = state.handlers[h.name]
    assert metrics.write_attempted == 10
    # 8 = 10 - 2 (the simulated dedup skips).
    assert metrics.write_count == 8

    # Second batch — counters accumulate, not reset.
    await h._safe_flush(rows)
    assert metrics.write_attempted == 20
    assert metrics.write_count == 16

    state.handlers.clear()


@pytest.mark.asyncio
async def test_safe_flush_falls_back_to_len_when_flush_returns_none():
    """Backwards compat: a subclass whose ``_flush`` returns nothing
    should still see ``write_count`` increment by ``len(rows)``.
    """
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _LegacyHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="m2-legacy-flush")

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> None:  # type: ignore[override]
            return None

    h = _LegacyHandler()
    await h._safe_flush([(1,), (2,), (3,)])

    metrics = state.handlers[h.name]
    assert metrics.write_attempted == 3
    assert metrics.write_count == 3

    state.handlers.clear()


@pytest.mark.asyncio
async def test_flush_failure_counts_lost_rows():
    """A flush that raises (after the db retries are spent) loses its rows.
    ``lost_rows`` counts them, so /metrics and the drop reporter can show a
    stalled Neon. A dedup skip (fewer rows written than attempted) is not a
    loss and must not count.
    """
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _Handler(Handler):
        def __init__(self) -> None:
            super().__init__(name="lost-rows-test")
            self.fail = False

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> int:
            if self.fail:
                raise TimeoutError("command_timeout")
            return len(rows) - 1  # one ON CONFLICT skip

    h = _Handler()
    metrics = state.handlers[h.name]
    try:
        await h._safe_flush([(1,), (2,), (3,)])
        assert metrics.lost_rows == 0

        h.fail = True
        await h._safe_flush([(4,), (5,)])
        assert metrics.lost_rows == 2
        await h._safe_flush([(6,)])
        assert metrics.lost_rows == 3
        assert metrics.write_attempted == 6
        assert metrics.write_count == 2
    finally:
        state.handlers.clear()


@pytest.mark.asyncio
async def test_safe_flush_attempted_increments_even_when_flush_raises():
    """If ``_flush`` raises, ``write_attempted`` must still bump (we
    tried), but ``write_count`` must NOT — those rows didn't land.
    """
    from handlers.base import Handler
    from state import state

    state.handlers.clear()

    class _RaisingHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="m2-raising-flush")

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> int:
            raise RuntimeError("simulated DB failure")

    h = _RaisingHandler()
    # _safe_flush swallows the exception per the existing contract.
    await h._safe_flush([(1,), (2,)])

    metrics = state.handlers[h.name]
    assert metrics.write_attempted == 2
    assert metrics.write_count == 0

    state.handlers.clear()
