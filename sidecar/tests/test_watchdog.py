"""Tests for sidecar/src/watchdog.py — the stale-data watchdog.

The watchdog exists because of a real incident (2026-08-20 01:31–01:45
UTC): the Databento consume loop froze silently — no bars, no logs, no
exception — while `is_connected()` stayed True and the threaded health
server kept answering. Railway only restarts on crash, so nothing acted
on the freeze. The watchdog turns that condition into `os._exit(1)`.

Mock strategy:
- `_run_loop` is exercised directly (not through a spawned thread) with
  `time.sleep` replaced by a fake that raises `_StopLoopError` after N ticks,
  so each test drives a bounded number of iterations deterministically.
- `os._exit` is monkeypatched — the real one would kill pytest.
- `health._is_data_expected` is monkeypatched per test (the watchdog
  resolves it through the `health` module at call time, same patch
  point test_health.py uses).
- Sentry: `capture_message` / `is_enabled` are patched on the watchdog
  module; the `sentry_sdk` module itself is conftest's session mock.
"""

from __future__ import annotations

import sys
import threading
import time
from unittest.mock import MagicMock

import pytest

import watchdog


class _StopLoopError(Exception):
    """Raised by fakes to break out of the otherwise-infinite loop."""


def _sleep_raising_after(max_ticks: int):
    """Build a fake time.sleep that raises _StopLoopError after max_ticks calls."""
    calls = {"n": 0}

    def _sleep(_seconds: float) -> None:
        calls["n"] += 1
        if calls["n"] > max_ticks:
            raise _StopLoopError

    return _sleep


@pytest.fixture()
def no_exit(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace os._exit so a triggered watchdog can't kill pytest."""
    exit_mock = MagicMock()
    monkeypatch.setattr(watchdog.os, "_exit", exit_mock)
    return exit_mock


@pytest.fixture()
def capture_mock(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace the watchdog's Sentry capture_message binding."""
    mock = MagicMock()
    monkeypatch.setattr(watchdog, "capture_message", mock)
    return mock


# ---------------------------------------------------------------------------
# _staleness_if_frozen — the pure decision function
# ---------------------------------------------------------------------------


def test_no_trigger_during_boot_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Inside the boot grace window nothing triggers, however stale."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)

    result = watchdog._staleness_if_frozen(
        now_monotonic=100.0,
        started_at_monotonic=0.0,
        boot_grace_s=600.0,
        stale_exit_s=300.0,
        is_connected=lambda: True,
        last_bar_at=lambda: 0.0,  # maximally stale
    )

    assert result is None


def test_no_trigger_when_data_not_expected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Weekend / maintenance hour (calendar says no data) never triggers."""
    monkeypatch.setattr("health._is_data_expected", lambda: False)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        is_connected=lambda: True,
        last_bar_at=lambda: 0.0,
    )

    assert result is None


def test_no_trigger_when_disconnected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A disconnected client has its own reconnect logic — never exit."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        is_connected=lambda: False,
        last_bar_at=lambda: 0.0,
    )

    assert result is None


def test_no_trigger_when_data_fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bars newer than the threshold never trigger."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        is_connected=lambda: True,
        last_bar_at=lambda: time.time() - 30.0,
    )

    assert result is None


def test_no_trigger_at_exact_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    """Staleness must EXCEED the threshold (strict >), not merely reach it."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)
    frozen_now = time.time()
    monkeypatch.setattr(watchdog.time, "time", lambda: frozen_now)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        is_connected=lambda: True,
        last_bar_at=lambda: frozen_now - 300.0,
    )

    assert result is None


def test_returns_staleness_when_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Connected + data expected + stale bar → the staleness is returned."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=600.0,
        stale_exit_s=300.0,
        is_connected=lambda: True,
        last_bar_at=lambda: time.time() - 1_000.0,
    )

    assert result is not None
    assert result == pytest.approx(1_000.0, abs=5.0)


# ---------------------------------------------------------------------------
# _run_loop — the thread body
# ---------------------------------------------------------------------------


def test_loop_does_not_exit_during_boot_grace(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """While inside the grace window the loop keeps ticking, never exits."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)
    monkeypatch.setattr(watchdog.time, "sleep", _sleep_raising_after(3))

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: 0.0,  # maximally stale
            stale_exit_s=300.0,
            boot_grace_s=1e9,
        )

    no_exit.assert_not_called()
    capture_mock.assert_not_called()


def test_loop_does_not_exit_when_data_not_expected(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """Weekend / maintenance-hour staleness never restarts the sidecar."""
    monkeypatch.setattr("health._is_data_expected", lambda: False)
    monkeypatch.setattr(watchdog.time, "sleep", _sleep_raising_after(3))

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: 0.0,
            stale_exit_s=300.0,
            boot_grace_s=0.0,
        )

    no_exit.assert_not_called()
    capture_mock.assert_not_called()


def test_loop_does_not_exit_when_disconnected(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """Disconnected + stale is the reconnect loop's job, not the watchdog's."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)
    monkeypatch.setattr(watchdog.time, "sleep", _sleep_raising_after(3))

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: False,
            last_bar_at=lambda: 0.0,
            stale_exit_s=300.0,
            boot_grace_s=0.0,
        )

    no_exit.assert_not_called()
    capture_mock.assert_not_called()


def test_loop_exits_when_connected_expected_and_stale(
    monkeypatch: pytest.MonkeyPatch,
    capture_mock: MagicMock,
) -> None:
    """The incident case: connected + data expected + frozen → os._exit(1)."""
    monkeypatch.setattr("health._is_data_expected", lambda: True)
    monkeypatch.setattr(watchdog.time, "sleep", lambda _s: None)

    exit_codes: list[int] = []

    def fake_exit(code: int) -> None:
        exit_codes.append(code)
        raise _StopLoopError  # the real os._exit never returns

    monkeypatch.setattr(watchdog.os, "_exit", fake_exit)

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: time.time() - 1_000.0,
            stale_exit_s=300.0,
            boot_grace_s=0.0,
        )

    assert exit_codes == [1]
    capture_mock.assert_called_once()
    assert capture_mock.call_args.args[0] == "sidecar watchdog: data stale, exiting for restart"
    assert capture_mock.call_args.kwargs["level"] == "error"
    context = capture_mock.call_args.kwargs["context"]
    assert context["staleness_s"] >= 300.0
    assert context["threshold_s"] == 300.0


def test_loop_survives_probe_exception(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """A crashing probe callable must not kill (or trip) the watchdog."""
    calendar_mock = MagicMock(side_effect=RuntimeError("boom"))
    monkeypatch.setattr("health._is_data_expected", calendar_mock)
    monkeypatch.setattr(watchdog.time, "sleep", _sleep_raising_after(3))

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: 0.0,
            stale_exit_s=300.0,
            boot_grace_s=0.0,
        )

    # Probed all 3 ticks — the first RuntimeError didn't end the loop.
    assert calendar_mock.call_count == 3
    no_exit.assert_not_called()
    capture_mock.assert_not_called()


# ---------------------------------------------------------------------------
# _exit_for_restart — logging, Sentry capture + flush, exit code
# ---------------------------------------------------------------------------


def test_exit_for_restart_logs_critical_with_staleness(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """The restart path logs CRITICAL including the staleness value."""
    log_mock = MagicMock()
    monkeypatch.setattr(watchdog, "log", log_mock)

    watchdog._exit_for_restart(987.0, 300.0)

    no_exit.assert_called_once_with(1)
    log_mock.critical.assert_called_once()
    rendered = log_mock.critical.call_args.args[0] % tuple(log_mock.critical.call_args.args[1:])
    assert "987" in rendered


def test_exit_for_restart_flushes_sentry_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """os._exit skips the SDK's atexit flush, so we must flush explicitly."""
    flush_mock = sys.modules["sentry_sdk"].flush
    flush_mock.reset_mock()
    monkeypatch.setattr(watchdog, "is_enabled", lambda: True)

    watchdog._exit_for_restart(999.0, 300.0)

    flush_mock.assert_called_once()
    assert flush_mock.call_args.kwargs["timeout"] == 5.0
    no_exit.assert_called_once_with(1)


def test_exit_for_restart_skips_flush_when_sentry_disabled(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """No DSN configured → nothing to flush, exit still happens."""
    flush_mock = sys.modules["sentry_sdk"].flush
    flush_mock.reset_mock()
    monkeypatch.setattr(watchdog, "is_enabled", lambda: False)

    watchdog._exit_for_restart(999.0, 300.0)

    flush_mock.assert_not_called()
    no_exit.assert_called_once_with(1)


def test_exit_happens_even_if_flush_raises(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """A Sentry transport failure must never block the restart exit."""
    flush_mock = sys.modules["sentry_sdk"].flush
    flush_mock.reset_mock()
    flush_mock.side_effect = ConnectionError("transport down")
    monkeypatch.setattr(watchdog, "is_enabled", lambda: True)

    try:
        watchdog._exit_for_restart(999.0, 300.0)
    finally:
        flush_mock.side_effect = None  # session-wide mock — restore

    no_exit.assert_called_once_with(1)


# ---------------------------------------------------------------------------
# Env knobs — WATCHDOG_STALE_EXIT_S / WATCHDOG_BOOT_GRACE_S
# ---------------------------------------------------------------------------


def test_stale_exit_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WATCHDOG_STALE_EXIT_S", raising=False)
    assert watchdog._stale_exit_seconds() == 300.0


def test_stale_exit_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHDOG_STALE_EXIT_S", "420")
    assert watchdog._stale_exit_seconds() == 420.0


def test_stale_exit_clamped_to_minimum(monkeypatch: pytest.MonkeyPatch) -> None:
    """Values below 180s clamp up — a typo can't make routine gaps fatal."""
    monkeypatch.setenv("WATCHDOG_STALE_EXIT_S", "60")
    assert watchdog._stale_exit_seconds() == 180.0


def test_stale_exit_non_numeric_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """Garbage env must degrade to the default, never raise."""
    monkeypatch.setenv("WATCHDOG_STALE_EXIT_S", "five minutes")
    assert watchdog._stale_exit_seconds() == 300.0


def test_boot_grace_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WATCHDOG_BOOT_GRACE_S", raising=False)
    assert watchdog._boot_grace_seconds() == 600.0


def test_boot_grace_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHDOG_BOOT_GRACE_S", "120")
    assert watchdog._boot_grace_seconds() == 120.0


def test_boot_grace_non_numeric_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHDOG_BOOT_GRACE_S", "soon")
    assert watchdog._boot_grace_seconds() == 600.0


def test_boot_grace_negative_clamped_to_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHDOG_BOOT_GRACE_S", "-5")
    assert watchdog._boot_grace_seconds() == 0.0


# ---------------------------------------------------------------------------
# start_watchdog — thread spawn + startup log
# ---------------------------------------------------------------------------


def test_start_watchdog_spawns_named_daemon_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ran = threading.Event()
    monkeypatch.setattr(watchdog, "_run_loop", lambda **_kw: ran.set())

    thread = watchdog.start_watchdog(
        is_connected=lambda: False,
        last_bar_at=lambda: 0.0,
    )

    assert thread.daemon is True
    assert thread.name == "stale-data-watchdog"
    assert ran.wait(timeout=2.0)
    thread.join(timeout=2.0)


def test_start_watchdog_passes_env_thresholds_and_logs_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Env is read at start time; one INFO log states the thresholds."""
    monkeypatch.setenv("WATCHDOG_STALE_EXIT_S", "444")
    monkeypatch.setenv("WATCHDOG_BOOT_GRACE_S", "55")

    seen: dict[str, object] = {}
    done = threading.Event()

    def fake_loop(**kwargs: object) -> None:
        seen.update(kwargs)
        done.set()

    monkeypatch.setattr(watchdog, "_run_loop", fake_loop)
    log_mock = MagicMock()
    monkeypatch.setattr(watchdog, "log", log_mock)

    thread = watchdog.start_watchdog(
        is_connected=lambda: True,
        last_bar_at=lambda: 0.0,
    )

    assert done.wait(timeout=2.0)
    thread.join(timeout=2.0)
    assert seen["stale_exit_s"] == 444.0
    assert seen["boot_grace_s"] == 55.0

    log_mock.info.assert_called_once()
    rendered = log_mock.info.call_args.args[0] % tuple(log_mock.info.call_args.args[1:])
    assert "444" in rendered
    assert "55" in rendered
