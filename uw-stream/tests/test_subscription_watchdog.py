"""Tests for the subscription watchdog's pure strike/alert logic.

The watchdog detects SILENT per-channel subscription failures (the 2026-06-02
50-channel-cap outage went unnoticed for ~20h). ``_evaluate`` is the pure core:
it accumulates a consecutive-unsubscribed strike count per channel and reports
channels that NEWLY cross the alert threshold, without re-spamming. These pin
that behavior so a regression can't silently re-open the detection gap.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

import subscription_watchdog
from subscription_watchdog import (
    _CHECK_INTERVAL_S,
    _STARTUP_GRACE_S,
    _STRIKES_TO_ALERT,
    _evaluate,
    run_subscription_watchdog,
)


def test_subscribed_channels_never_strike_or_alert():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    newly = _evaluate({"a": True, "b": True}, strikes, alerted)
    assert newly == []
    assert strikes == {"a": 0, "b": 0}
    assert alerted == set()


def test_single_unsubscribed_check_does_not_alert():
    # One missed check tolerates a transient reconnect — must NOT alert yet.
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    newly = _evaluate({"a": False}, strikes, alerted)
    assert newly == []
    assert strikes["a"] == 1
    assert _STRIKES_TO_ALERT >= 2  # guards the "tolerate one reconnect" intent


def test_alerts_after_consecutive_strikes():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    subscribed = {"a": False}
    # Strike up to the threshold; the check that crosses it returns the channel.
    for _ in range(_STRIKES_TO_ALERT - 1):
        assert _evaluate(subscribed, strikes, alerted) == []
    assert _evaluate(subscribed, strikes, alerted) == ["a"]
    assert "a" in alerted


def test_does_not_realert_while_still_stuck():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    subscribed = {"a": False}
    for _ in range(_STRIKES_TO_ALERT):
        _evaluate(subscribed, strikes, alerted)
    assert "a" in alerted
    # Still stuck on later checks — no repeat alert (we don't spam Sentry).
    assert _evaluate(subscribed, strikes, alerted) == []
    assert _evaluate(subscribed, strikes, alerted) == []


def test_resubscribe_resets_and_allows_realert():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    # Get it stuck + alerted.
    for _ in range(_STRIKES_TO_ALERT):
        _evaluate({"a": False}, strikes, alerted)
    assert "a" in alerted
    # It re-subscribes: strikes reset, alerted flag cleared.
    assert _evaluate({"a": True}, strikes, alerted) == []
    assert strikes["a"] == 0
    assert "a" not in alerted
    # A later re-failure must be able to alert again.
    for _ in range(_STRIKES_TO_ALERT - 1):
        assert _evaluate({"a": False}, strikes, alerted) == []
    assert _evaluate({"a": False}, strikes, alerted) == ["a"]


def test_independent_channels_strike_independently():
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    # 'a' stuck, 'b' healthy across all checks.
    for _ in range(_STRIKES_TO_ALERT - 1):
        _evaluate({"a": False, "b": True}, strikes, alerted)
    newly = _evaluate({"a": False, "b": True}, strikes, alerted)
    assert newly == ["a"]
    assert strikes["b"] == 0
    assert "b" not in alerted


# --- run_subscription_watchdog loop (lines 63-80) -----------------------------
#
# The loop is `while True: await asyncio.sleep(...)`, so each test patches
# asyncio.sleep with a counter that raises CancelledError after a fixed number
# of iterations — the same loop-exit pattern as test_connector.py — and asserts
# on the observable side effects (log.warning / capture_message spies). state,
# log, and capture_message are all module-level imports in subscription_watchdog
# so we patch them there (not at their definition site).


@dataclass
class _FakeChannel:
    subscribed: bool


@dataclass
class _FakeState:
    """Minimal stand-in for state.State used by the watchdog loop."""

    started_at: datetime
    ws_any_connected: bool = True
    channels: dict[str, _FakeChannel] = field(default_factory=dict)


class _Spy:
    """Records every call's (args, kwargs) for later assertions."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __call__(self, *args, **kwargs) -> None:
        self.calls.append((args, kwargs))


def _patch_loop(monkeypatch, fake_state, *, iterations: int):
    """Wire up the watchdog's module globals and bound the infinite loop.

    asyncio.sleep is replaced with a no-op that raises CancelledError after
    ``iterations`` calls so the `while True` loop terminates deterministically.
    Returns (log_spy, capture_spy) so callers can assert on the alert path.
    """
    count = {"n": 0}

    async def _fake_sleep(_seconds: float) -> None:
        count["n"] += 1
        if count["n"] > iterations:
            raise asyncio.CancelledError()

    log_spy = type("_Log", (), {"warning": staticmethod(_Spy()), "info": staticmethod(_Spy())})()
    capture_spy = _Spy()

    monkeypatch.setattr(subscription_watchdog.asyncio, "sleep", _fake_sleep)
    monkeypatch.setattr(subscription_watchdog, "state", fake_state)
    monkeypatch.setattr(subscription_watchdog, "log", log_spy)
    monkeypatch.setattr(subscription_watchdog, "capture_message", capture_spy)
    return log_spy, capture_spy


async def test_loop_skips_during_startup_grace(monkeypatch):
    # Daemon just booted — uptime < grace — so even a stuck channel is ignored.
    fake_state = _FakeState(
        started_at=datetime.now(UTC),  # ~0s uptime
        ws_any_connected=True,
        channels={"a": _FakeChannel(subscribed=False)},
    )
    _, capture_spy = _patch_loop(monkeypatch, fake_state, iterations=2)
    with pytest.raises(asyncio.CancelledError):
        await run_subscription_watchdog()
    assert capture_spy.calls == []


async def test_loop_skips_when_fully_disconnected(monkeypatch):
    # Past the grace window, but the socket is fully down — the connector's
    # reconnect/health path owns that case, so the watchdog stays quiet.
    fake_state = _FakeState(
        started_at=datetime.now(UTC) - timedelta(seconds=_STARTUP_GRACE_S + 60),
        ws_any_connected=False,
        channels={"a": _FakeChannel(subscribed=False)},
    )
    _, capture_spy = _patch_loop(monkeypatch, fake_state, iterations=2)
    with pytest.raises(asyncio.CancelledError):
        await run_subscription_watchdog()
    assert capture_spy.calls == []


async def test_loop_no_alert_when_all_subscribed(monkeypatch):
    # Past grace, connected, every channel subscribed — _evaluate returns no
    # newly-stuck channels, so neither log.warning nor capture_message fire.
    fake_state = _FakeState(
        started_at=datetime.now(UTC) - timedelta(seconds=_STARTUP_GRACE_S + 60),
        ws_any_connected=True,
        channels={"a": _FakeChannel(subscribed=True), "b": _FakeChannel(subscribed=True)},
    )
    log_spy, capture_spy = _patch_loop(monkeypatch, fake_state, iterations=3)
    with pytest.raises(asyncio.CancelledError):
        await run_subscription_watchdog()
    assert capture_spy.calls == []
    assert log_spy.warning.calls == []


async def test_loop_alerts_after_consecutive_stuck_checks(monkeypatch):
    # Past grace, connected, one channel stuck unsubscribed across enough checks
    # to cross _STRIKES_TO_ALERT. Run exactly that many evaluating iterations so
    # the strike threshold is reached and the alert branch (lines 74-89) fires.
    fake_state = _FakeState(
        started_at=datetime.now(UTC) - timedelta(seconds=_STARTUP_GRACE_S + 60),
        ws_any_connected=True,
        channels={"a": _FakeChannel(subscribed=False), "b": _FakeChannel(subscribed=True)},
    )
    log_spy, capture_spy = _patch_loop(monkeypatch, fake_state, iterations=_STRIKES_TO_ALERT)
    with pytest.raises(asyncio.CancelledError):
        await run_subscription_watchdog()

    # Exactly one alert — fired on the check that crossed the threshold, then
    # suppressed on subsequent stuck checks (no Sentry spam).
    assert len(capture_spy.calls) == 1
    args, kwargs = capture_spy.calls[0]
    assert args[0] == "uw-stream channels stuck unsubscribed"
    assert kwargs["level"] == "warning"
    assert kwargs["tags"] == {"component": "subscription_watchdog"}
    ctx = kwargs["context"]
    assert ctx["newly_count"] == 1
    assert ctx["stuck_total"] == 1  # only 'a' is unsubscribed
    assert ctx["sample"] == ["a"]

    # The structured log warning mirrors the alert.
    assert len(log_spy.warning.calls) == 1
    log_args, log_kwargs = log_spy.warning.calls[0]
    assert log_args[0] == "channels stuck unsubscribed"
    assert log_kwargs["extra"]["newly"] == ["a"]
    assert log_kwargs["extra"]["stuck_total"] == 1


async def test_loop_uses_check_interval_for_sleep(monkeypatch):
    # The loop sleeps the configured cadence between checks (guards against an
    # accidental zero/tight-loop regression).
    fake_state = _FakeState(
        started_at=datetime.now(UTC),
        ws_any_connected=True,
        channels={},
    )
    sleeps: list[float] = []

    async def _record_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        raise asyncio.CancelledError()

    monkeypatch.setattr(subscription_watchdog.asyncio, "sleep", _record_sleep)
    monkeypatch.setattr(subscription_watchdog, "state", fake_state)
    with pytest.raises(asyncio.CancelledError):
        await run_subscription_watchdog()
    assert sleeps == [_CHECK_INTERVAL_S]
