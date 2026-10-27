"""Tests for the 60 s backpressure drop reporter.

The handler queues and the receive queue count every payload they evict, but
those counters were only visible on /metrics, so a stalled Neon could shed
rows for hours with nothing in Sentry. ``run_drop_reporter`` sends the drops
since its last report, once per queue per interval.

The loop is ``while True: await asyncio.sleep(...)``. Each test replaces
asyncio.sleep with a scripted stand-in (the pattern in
test_subscription_watchdog.py): call N runs ``steps[N]`` to change the drop
counters before the reporter's Nth check, and the call after the last step
raises CancelledError to end the loop.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

import drop_reporter
from drop_reporter import _REPORT_INTERVAL_S, run_drop_reporter
from state import State


class _CaptureSpy:
    """Records each capture_message call; optionally raises on chosen calls."""

    def __init__(self, fail_on: set[int] | None = None) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self._fail_on = fail_on or set()
        self._n = 0

    def __call__(self, *args, **kwargs) -> None:
        self._n += 1
        if self._n in self._fail_on:
            raise RuntimeError("sentry transport down")
        self.calls.append((args, kwargs))


def _run_script(monkeypatch, steps: list[Callable[[State], None]], capture: _CaptureSpy):
    """Wire a fresh State + capture spy into the reporter, script its sleeps.

    Returns (state, sleeps) so callers can assert on the sleep cadence.
    """
    fresh = State()
    sleeps: list[float] = []

    async def _scripted_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        i = len(sleeps) - 1
        if i >= len(steps):
            raise asyncio.CancelledError()
        steps[i](fresh)

    monkeypatch.setattr(drop_reporter.asyncio, "sleep", _scripted_sleep)
    monkeypatch.setattr(drop_reporter, "state", fresh)
    monkeypatch.setattr(drop_reporter, "capture_message", capture)
    return fresh, sleeps


def _drops(handler: str, n: int) -> Callable[[State], None]:
    def _apply(s: State) -> None:
        s.handler(handler).drop_count += n

    return _apply


def _receive_drops(n: int) -> Callable[[State], None]:
    def _apply(s: State) -> None:
        s.receive_queue_drops += n

    return _apply


def _nothing(_s: State) -> None:
    return None


def _handler_events(capture: _CaptureSpy) -> list[dict]:
    return [kw for _a, kw in capture.calls if kw["tags"].get("queue") == "handler"]


def _receive_events(capture: _CaptureSpy) -> list[dict]:
    return [kw for _a, kw in capture.calls if kw["tags"].get("queue") == "receive"]


async def test_emits_once_per_delta_per_handler(monkeypatch):
    capture = _CaptureSpy()
    _run_script(
        monkeypatch,
        [_drops("option_trades", 5), _drops("option_trades", 3), _nothing],
        capture,
    )

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    events = _handler_events(capture)
    # Two checks saw new drops (5, then 3), the third saw none.
    assert [e["context"]["dropped"] for e in events] == [5, 3]
    assert [e["context"]["drop_total"] for e in events] == [5, 8]
    for e in events:
        assert e["level"] == "warning"
        assert e["tags"]["component"] == "backpressure"
        assert e["tags"]["handler"] == "option_trades"
        assert e["context"]["interval_s"] == _REPORT_INTERVAL_S


async def test_one_event_per_handler_with_new_drops(monkeypatch):
    capture = _CaptureSpy()

    def _mixed(s: State) -> None:
        s.handler("option_trades").drop_count += 2
        s.handler("net_flow").drop_count += 7
        s.handler("flow-alerts")  # registered, zero drops: no event

    _run_script(monkeypatch, [_mixed], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    by_handler = {e["tags"]["handler"]: e["context"]["dropped"] for e in _handler_events(capture)}
    assert by_handler == {"option_trades": 2, "net_flow": 7}


async def test_silent_without_new_drops(monkeypatch):
    capture = _CaptureSpy()

    def _registered_only(s: State) -> None:
        s.handler("option_trades")
        s.handler("net_flow")

    _run_script(monkeypatch, [_registered_only, _nothing, _nothing], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    assert capture.calls == []


async def test_old_drops_are_not_re_reported(monkeypatch):
    # Drops that were already reported stay in the cumulative counter, but a
    # later quiet interval must not send them again.
    capture = _CaptureSpy()
    _run_script(monkeypatch, [_drops("net_flow", 4), _nothing, _nothing], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    assert len(capture.calls) == 1


async def test_includes_receive_queue_drops(monkeypatch):
    capture = _CaptureSpy()
    _run_script(monkeypatch, [_receive_drops(11), _receive_drops(4), _nothing], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    events = _receive_events(capture)
    assert [e["context"]["dropped"] for e in events] == [11, 4]
    assert [e["context"]["drop_total"] for e in events] == [11, 15]
    for e in events:
        assert e["level"] == "warning"
        assert e["tags"]["component"] == "backpressure"
        assert "handler" not in e["tags"]
    assert _handler_events(capture) == []


async def test_survives_a_capture_failure_and_carries_the_delta(monkeypatch):
    # The first report raises. The task must keep running, and the drops it
    # failed to report must go out with the next one rather than vanish.
    capture = _CaptureSpy(fail_on={1})
    _run_script(monkeypatch, [_drops("option_trades", 5), _drops("option_trades", 2)], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    events = _handler_events(capture)
    assert [e["context"]["dropped"] for e in events] == [7]
    assert events[0]["context"]["drop_total"] == 7


async def test_one_failed_capture_does_not_block_the_other_queues(monkeypatch):
    capture = _CaptureSpy(fail_on={1})

    def _both(s: State) -> None:
        s.handler("option_trades").drop_count += 3
        s.receive_queue_drops += 9

    _run_script(monkeypatch, [_both], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    # The handler event raised; the receive-queue event still went out.
    assert [e["context"]["dropped"] for e in _receive_events(capture)] == [9]


async def test_sleeps_the_report_interval(monkeypatch):
    capture = _CaptureSpy()
    _, sleeps = _run_script(monkeypatch, [_nothing, _nothing], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    assert _REPORT_INTERVAL_S == 60.0
    assert sleeps == [_REPORT_INTERVAL_S] * 3


# --- lost rows (P1): rows whose flush failed after the db retries ------------


def _lost(handler: str, n: int) -> Callable[[State], None]:
    def _apply(s: State) -> None:
        s.handler(handler).lost_rows += n

    return _apply


async def test_reports_lost_rows_deltas(monkeypatch):
    capture = _CaptureSpy()
    _run_script(
        monkeypatch, [_lost("option_trades", 500), _lost("option_trades", 250), _nothing], capture
    )

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    events = _handler_events(capture)
    assert [e["context"]["lost_rows"] for e in events] == [500, 250]
    assert [e["context"]["lost_rows_total"] for e in events] == [500, 750]
    assert [e["context"]["dropped"] for e in events] == [0, 0]
    assert all(e["tags"]["handler"] == "option_trades" for e in events)


async def test_drops_and_lost_rows_in_one_interval_send_one_event(monkeypatch):
    capture = _CaptureSpy()

    def _both(s: State) -> None:
        s.handler("net_flow").drop_count += 3
        s.handler("net_flow").lost_rows += 500

    _run_script(monkeypatch, [_both], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    events = _handler_events(capture)
    assert len(events) == 1
    ctx = events[0]["context"]
    assert (ctx["dropped"], ctx["lost_rows"]) == (3, 500)


async def test_failed_capture_carries_the_lost_rows_delta(monkeypatch):
    capture = _CaptureSpy(fail_on={1})
    _run_script(monkeypatch, [_lost("net_flow", 500), _lost("net_flow", 100)], capture)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    assert [e["context"]["lost_rows"] for e in _handler_events(capture)] == [600]
