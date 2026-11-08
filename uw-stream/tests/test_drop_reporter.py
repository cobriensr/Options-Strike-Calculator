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
    """Records each capture_message call."""

    def __init__(self) -> None:
        self.calls: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs) -> None:
        self.calls.append((args, kwargs))


def _run_script(
    monkeypatch,
    steps: list[Callable[[State], None]],
    capture: _CaptureSpy | None,
    *,
    at_cancel: Callable[[State], None] | None = None,
):
    """Wire a fresh State + capture spy into the reporter, script its sleeps.

    ``at_cancel`` changes the counters just before the final sleep raises
    CancelledError, i.e. after the last check and before shutdown cancels the
    task. Returns (state, sleeps) so callers can assert on the sleep cadence.
    """
    fresh = State()
    sleeps: list[float] = []

    async def _scripted_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        i = len(sleeps) - 1
        if i >= len(steps):
            if at_cancel is not None:
                at_cancel(fresh)
            raise asyncio.CancelledError()
        steps[i](fresh)

    monkeypatch.setattr(drop_reporter.asyncio, "sleep", _scripted_sleep)
    monkeypatch.setattr(drop_reporter, "state", fresh)
    if capture is not None:
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


async def test_a_failing_sentry_forward_does_not_stop_the_reporter(monkeypatch):
    # The reporter has no handler of its own around capture_message because
    # capture_message never raises: sentry_setup catches an SDK failure and
    # logs it. This runs the real capture_message with the SDK raising.
    import sentry_sdk

    import sentry_setup

    forwarded: list[str] = []

    def _sdk_down(message, **_kwargs):
        forwarded.append(message)
        raise RuntimeError("sentry transport down")

    monkeypatch.setattr(sentry_setup, "_sentry_enabled", True)
    monkeypatch.setattr(sentry_sdk, "capture_message", _sdk_down)
    _, sleeps = _run_script(
        monkeypatch, [_drops("option_trades", 5), _drops("option_trades", 2)], capture=None
    )

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    # Both intervals were attempted: the first failure did not end the loop.
    assert len(forwarded) == 2
    assert len(sleeps) == 3


async def test_cancel_reports_the_drops_since_the_last_check(monkeypatch):
    # Shutdown cancels the reporter after the handlers drain. Whatever dropped or
    # was lost since the last 60 s check is what a deploy causes, so the cancel
    # runs one more pass before the task exits.
    capture = _CaptureSpy()

    def _last_minute(s: State) -> None:
        s.handler("option_trades").drop_count += 2
        s.handler("net_flow").lost_rows += 500
        s.receive_queue_drops += 7

    _run_script(monkeypatch, [_drops("option_trades", 5)], capture, at_cancel=_last_minute)

    with pytest.raises(asyncio.CancelledError):
        await run_drop_reporter()

    contexts = [
        (e["tags"]["handler"], e["context"]["dropped"], e["context"]["lost_rows"])
        for e in _handler_events(capture)
    ]
    # option_trades: 5 at the check, then only the 2 since. net_flow: its lost rows.
    assert contexts == [("option_trades", 5, 0), ("option_trades", 2, 0), ("net_flow", 0, 500)]
    assert [e["context"]["drop_total"] for e in _receive_events(capture)] == [7]


async def test_cancelling_the_running_task_reports_before_it_exits(monkeypatch):
    # The real cancel path: a task parked in its 60 s sleep, cancelled by shutdown.
    capture = _CaptureSpy()
    fresh = State()
    monkeypatch.setattr(drop_reporter, "state", fresh)
    monkeypatch.setattr(drop_reporter, "capture_message", capture)

    task = asyncio.create_task(run_drop_reporter())
    await asyncio.sleep(0)  # let it reach its first sleep
    fresh.handler("net_flow").drop_count += 4
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert task.cancelled()
    assert [e["context"]["dropped"] for e in _handler_events(capture)] == [4]


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
