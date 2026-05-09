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

_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "flow_alerts_sample.json"
)


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
            ("29ed5829-e4ce-4934-876b-51985d2f9b70",
             UUID("29ed5829-e4ce-4934-876b-51985d2f9b70")),
            (UUID("29ed5829-e4ce-4934-876b-51985d2f9b70"),
             UUID("29ed5829-e4ce-4934-876b-51985d2f9b70")),
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

    state.channels.clear()

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

    state.channels.clear()
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

    state.channels.clear()

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
        state.channels.clear()


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

    state.channels.clear()

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

    state.channels.clear()


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


@pytest.mark.asyncio
async def test_drain_aborts_when_run_does_not_stop_in_time(monkeypatch):
    """FIX 1 regression: if ``run()`` is parked inside a slow
    ``_safe_flush`` call when SIGTERM fires, ``drain()`` must NOT
    proceed to mutate ``self._batch`` — both code paths would otherwise
    call ``_safe_flush`` with overlapping rows, producing duplicate
    inserts on tables without ON CONFLICT DO NOTHING.

    Verifies: returns 0, warning logged, ``self._batch`` identity AND
    length are preserved across the drain() call.
    """
    from config import settings
    from handlers.base import Handler
    from state import state

    state.channels.clear()
    warnings = _record_warnings(monkeypatch)

    class _SlowFlushHandler(Handler):
        def __init__(self) -> None:
            super().__init__(name="drain-slow-flush-test")

        def _transform(self, payload: dict) -> tuple | None:
            return (payload.get("seq"),)

        async def _flush(self, rows: list[tuple]) -> None:
            # Simulate a slow DB on shutdown — longer than drain()'s
            # 1.0s grace window for ``_stopped.wait()``.
            await asyncio.sleep(2.0)

    monkeypatch.setattr(settings, "ws_queue_size", 16)
    monkeypatch.setattr(settings, "ws_batch_size", 1)
    monkeypatch.setattr(settings, "ws_batch_interval_ms", 60_000)

    h = _SlowFlushHandler()

    # Start run() and push an item so it lands in _safe_flush() and
    # parks there for 2s — _stopped will not fire within drain()'s
    # 1.0s grace window. With batch_size=1 the consumer appends the
    # transformed row to ``self._batch`` and then enters _safe_flush.
    task = asyncio.create_task(h.run())
    try:
        await h.enqueue({"seq": 0})
        # Give run() time to dequeue + start the slow _flush.
        await asyncio.sleep(0.05)

        # Snapshot AFTER run() has parked in _safe_flush — this is the
        # batch state drain() must not mutate while the consumer is
        # still alive holding a reference to it.
        pre_drain_id = id(h._batch)
        pre_drain_len = len(h._batch)
        assert pre_drain_len == 1, (
            "test setup: run() should have appended (0,) to _batch "
            f"before parking in _safe_flush; got {h._batch!r}"
        )

        flushed = await h.drain(deadline_s=5.0)

        # Drain bailed out without touching the batch.
        assert flushed == 0
        assert id(h._batch) == pre_drain_id
        assert len(h._batch) == pre_drain_len
        # Warning was logged mentioning the abort reason.
        assert any("consumer still running" in msg for msg, _ in warnings)
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        state.channels.clear()


@pytest.mark.asyncio
async def test_drain_exceeds_deadline_logs_warning(monkeypatch):
    """When the inner drain pipeline overruns ``deadline_s``, drain()
    must return 0 and log a warning that mentions the deadline.
    """
    from config import settings
    from handlers.base import Handler
    from state import state

    state.channels.clear()
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
    assert any(
        "deadline" in msg.lower() or "deadline_s" in extra
        for msg, extra in warnings
    )

    state.channels.clear()
