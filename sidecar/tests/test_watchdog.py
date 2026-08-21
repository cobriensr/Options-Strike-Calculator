"""Tests for sidecar/src/watchdog.py — the stale-data watchdog.

The watchdog exists because of a real incident (2026-08-20 01:31–01:45
UTC): the Databento consume loop froze silently — no bars, no logs, no
exception — while `is_connected()` stayed True and the threaded health
server kept answering. Railway only restarts on crash, so nothing acted
on the freeze. The watchdog turns that condition into `os._exit(1)`.

It also carries a daily false positive (2026-08-20 22:01:03Z, 3654s):
the Globex maintenance halt's staleness was charged to the reopen. The
grace baseline is now re-armed on that transition — see the
"Post-maintenance grace" section.

Mock strategy:
- `_run_loop` is exercised directly (not through a spawned thread) with
  `time.sleep` replaced by a fake that raises `_StopLoopError` after N ticks,
  so each test drives a bounded number of iterations deterministically.
  Tests that care about *when* something happens use `_install_fake_clock`,
  which additionally advances monotonic + wall time per tick.
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


# Wall-clock origin for the fake clock. Any constant works — the tests
# only ever compare differences — but a fixed value keeps failures
# readable.
_WALL_START = 1_000_000.0


def _install_fake_clock(monkeypatch: pytest.MonkeyPatch, *, max_ticks: int) -> dict[str, float]:
    """Drive `_run_loop` with a deterministic clock and a bounded tick count.

    Every `time.sleep(seconds)` advances BOTH the monotonic clock (which
    the grace window measures) and the wall clock (which staleness
    measures) by `seconds`, then the (max_ticks + 1)-th call raises
    `_StopLoopError` to end the otherwise-infinite loop. Returns the
    mutable clock state so tests can read `mono` / `wall` / `ticks`.
    """
    state = {"mono": 0.0, "wall": _WALL_START, "ticks": 0.0}

    def _sleep(seconds: float) -> None:
        state["ticks"] += 1
        if state["ticks"] > max_ticks:
            raise _StopLoopError
        state["mono"] += seconds
        state["wall"] += seconds

    monkeypatch.setattr(watchdog.time, "sleep", _sleep)
    monkeypatch.setattr(watchdog.time, "monotonic", lambda: state["mono"])
    monkeypatch.setattr(watchdog.time, "time", lambda: state["wall"])
    return state


def _calendar_open_from_tick(clock: dict[str, float], open_tick: int) -> MagicMock:
    """Fake `_is_data_expected`: closed until `open_tick`, open from then on.

    Models the Globex maintenance halt (16:00–17:00 CT): the calendar
    returns False for the closed ticks and flips True on the tick the
    session reopens.
    """
    return MagicMock(side_effect=lambda: clock["ticks"] >= open_tick)


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


def test_no_trigger_during_boot_grace() -> None:
    """Inside the grace window nothing triggers, however stale."""
    result = watchdog._staleness_if_frozen(
        now_monotonic=100.0,
        started_at_monotonic=0.0,
        boot_grace_s=600.0,
        stale_exit_s=300.0,
        data_expected=True,
        is_connected=lambda: True,
        last_bar_at=lambda: 0.0,  # maximally stale
    )

    assert result is None


def test_no_trigger_when_data_not_expected() -> None:
    """Weekend / maintenance hour (calendar says no data) never triggers."""
    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        data_expected=False,
        is_connected=lambda: True,
        last_bar_at=lambda: 0.0,
    )

    assert result is None


def test_no_trigger_when_disconnected() -> None:
    """A disconnected client has its own reconnect logic — never exit."""
    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        data_expected=True,
        is_connected=lambda: False,
        last_bar_at=lambda: 0.0,
    )

    assert result is None


def test_no_trigger_when_data_fresh() -> None:
    """Bars newer than the threshold never trigger."""
    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        data_expected=True,
        is_connected=lambda: True,
        last_bar_at=lambda: time.time() - 30.0,
    )

    assert result is None


def test_no_trigger_at_exact_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    """Staleness must EXCEED the threshold (strict >), not merely reach it."""
    frozen_now = time.time()
    monkeypatch.setattr(watchdog.time, "time", lambda: frozen_now)

    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=0.0,
        stale_exit_s=300.0,
        data_expected=True,
        is_connected=lambda: True,
        last_bar_at=lambda: frozen_now - 300.0,
    )

    assert result is None


def test_returns_staleness_when_frozen() -> None:
    """Connected + data expected + stale bar → the staleness is returned."""
    result = watchdog._staleness_if_frozen(
        now_monotonic=10_000.0,
        started_at_monotonic=0.0,
        boot_grace_s=600.0,
        stale_exit_s=300.0,
        data_expected=True,
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


# ---------------------------------------------------------------------------
# Post-maintenance grace — the 17:01 CT false positive (FINDING 1)
# ---------------------------------------------------------------------------
#
# Globex halts 16:00-17:00 CT. `_is_data_expected()` is False for that
# hour so the watchdog is inert; the instant it flips True the measured
# staleness spans the whole closed hour. Live on 2026-08-20 22:01:03Z it
# reported 3654s and exited — a pointless restart, every weekday.


def test_loop_does_not_exit_when_the_session_reopens(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """False→True on the calendar re-arms the grace instead of exiting.

    The bar is an hour old at the reopen (nothing landed during the
    halt), which is exactly the pre-fix trigger.
    """
    clock = _install_fake_clock(monkeypatch, max_ticks=15)
    monkeypatch.setattr("health._is_data_expected", _calendar_open_from_tick(clock, 11))
    log_mock = MagicMock()
    monkeypatch.setattr(watchdog, "log", log_mock)

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: _WALL_START,  # last bar landed as the halt began
            stale_exit_s=300.0,
            boot_grace_s=600.0,
        )

    no_exit.assert_not_called()
    capture_mock.assert_not_called()
    # Exactly one re-arm log — on the transition tick, not every tick
    # the session stays open.
    assert log_mock.info.call_count == 1
    rendered = log_mock.info.call_args.args[0] % tuple(log_mock.info.call_args.args[1:])
    assert "re-arm" in rendered
    assert "600" in rendered


def test_loop_exits_when_the_feed_never_resumes_after_the_reopen(
    monkeypatch: pytest.MonkeyPatch,
    capture_mock: MagicMock,
) -> None:
    """The re-armed grace is a delay, not blindness: no bars → still exits."""
    clock = _install_fake_clock(monkeypatch, max_ticks=30)
    monkeypatch.setattr("health._is_data_expected", _calendar_open_from_tick(clock, 11))

    exit_codes: list[int] = []

    def fake_exit(code: int) -> None:
        exit_codes.append(code)
        raise _StopLoopError

    monkeypatch.setattr(watchdog.os, "_exit", fake_exit)

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: _WALL_START,
            stale_exit_s=300.0,
            boot_grace_s=600.0,
        )

    assert exit_codes == [1]
    # Re-armed at tick 11 (mono 660); the grace expires 600s later at
    # mono 1260, where the bar is 1260s old.
    assert clock["ticks"] == 21
    assert capture_mock.call_args.kwargs["context"]["staleness_s"] == 1260.0


def test_loop_exits_when_a_freeze_starts_after_the_reopen(
    monkeypatch: pytest.MonkeyPatch,
    capture_mock: MagicMock,
) -> None:
    """Bars resume, then stop — the genuine post-reopen freeze still fires."""
    clock = _install_fake_clock(monkeypatch, max_ticks=40)
    monkeypatch.setattr("health._is_data_expected", _calendar_open_from_tick(clock, 3))
    log_mock = MagicMock()
    monkeypatch.setattr(watchdog, "log", log_mock)

    exit_codes: list[int] = []

    def fake_exit(code: int) -> None:
        exit_codes.append(code)
        raise _StopLoopError

    monkeypatch.setattr(watchdog.os, "_exit", fake_exit)

    # Bars flow normally until mono 900 — well past the grace re-armed
    # at the tick-3 reopen (mono 180, expiring at mono 780) — then the
    # consume loop freezes.
    freeze_at = _WALL_START + 900.0

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: min(clock["wall"], freeze_at),
            stale_exit_s=300.0,
            boot_grace_s=600.0,
        )

    assert exit_codes == [1]
    # First tick past mono 1200 (freeze + threshold) is mono 1260.
    assert clock["ticks"] == 21
    assert capture_mock.call_args.kwargs["context"]["staleness_s"] == 360.0
    # The reopen path really did run — this is not a "grace never
    # re-armed" pass in disguise.
    assert log_mock.info.call_count == 1


def test_boot_grace_still_delays_the_first_exit(
    monkeypatch: pytest.MonkeyPatch,
    capture_mock: MagicMock,
) -> None:
    """Data expected from the first tick → the boot grace is unchanged."""
    _install_fake_clock(monkeypatch, max_ticks=20)
    calendar = MagicMock(return_value=True)
    monkeypatch.setattr("health._is_data_expected", calendar)
    log_mock = MagicMock()
    monkeypatch.setattr(watchdog, "log", log_mock)

    exit_codes: list[int] = []

    def fake_exit(code: int) -> None:
        exit_codes.append(code)
        raise _StopLoopError

    monkeypatch.setattr(watchdog.os, "_exit", fake_exit)

    with pytest.raises(_StopLoopError):
        watchdog._run_loop(
            is_connected=lambda: True,
            last_bar_at=lambda: _WALL_START,  # maximally stale from tick 1
            stale_exit_s=300.0,
            boot_grace_s=600.0,
        )

    # Ticks 1-9 (mono 60..540) held inside the grace; tick 10 (mono 600)
    # is the first evaluation and it exits.
    assert calendar.call_count == 10
    assert exit_codes == [1]
    assert capture_mock.call_args.kwargs["context"]["staleness_s"] == 600.0
    # No calendar transition happened, so no re-arm log.
    log_mock.info.assert_not_called()


# ---------------------------------------------------------------------------
# Thread dump — freeze diagnosis (FINDING 2)
# ---------------------------------------------------------------------------
#
# The freeze root cause is still unknown (tcp_user_timeout=30000 did not
# stop it), and the loop goes silent with no traceback. The exit path
# dumps every thread's stack so the next occurrence names the frame the
# consume loop is parked in.


def test_thread_stack_texts_labels_live_threads_by_name() -> None:
    """Threads are labelled by name — the reason for the _current_frames route."""
    started = threading.Event()
    release = threading.Event()

    def _park() -> None:
        started.set()
        release.wait(timeout=5.0)

    parked = threading.Thread(target=_park, name="pytest-frozen-consume-loop", daemon=True)
    parked.start()
    assert started.wait(timeout=2.0)
    try:
        dump, tops = watchdog._thread_stack_texts()
    finally:
        release.set()
        parked.join(timeout=2.0)

    assert dump.startswith(watchdog.THREAD_DUMP_HEADER)
    assert dump.rstrip().endswith(watchdog.THREAD_DUMP_FOOTER)
    assert "pytest-frozen-consume-loop" in dump
    assert "MainThread" in dump
    assert 'File "' in dump  # real frames, not just labels
    assert any(line.startswith("pytest-frozen-consume-loop: ") for line in tops.splitlines())


def test_dump_thread_stacks_writes_to_stderr_and_returns_extras(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """stderr gets the full dump (Railway); the extras carry it to Sentry."""
    faulthandler_mock = MagicMock()
    monkeypatch.setattr(watchdog.faulthandler, "dump_traceback", faulthandler_mock)

    extras = watchdog._dump_thread_stacks()

    err = capsys.readouterr().err
    assert err.count(watchdog.THREAD_DUMP_HEADER) == 1
    assert watchdog.THREAD_DUMP_FOOTER in err
    assert extras is not None
    assert watchdog.THREAD_DUMP_HEADER in extras["thread_dump"]
    assert "MainThread" in extras["thread_top_frames"]
    # The happy path must not double-dump via faulthandler.
    faulthandler_mock.assert_not_called()


def test_dump_thread_stacks_falls_back_to_faulthandler(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """If frame formatting fails, the stdlib dumper still lands in the logs."""
    monkeypatch.setattr(
        watchdog, "_thread_stack_texts", MagicMock(side_effect=RuntimeError("no frames"))
    )
    faulthandler_mock = MagicMock()
    monkeypatch.setattr(watchdog.faulthandler, "dump_traceback", faulthandler_mock)

    extras = watchdog._dump_thread_stacks()

    assert extras is None
    faulthandler_mock.assert_called_once()
    assert faulthandler_mock.call_args.kwargs["all_threads"] is True
    assert watchdog.THREAD_DUMP_HEADER in capsys.readouterr().err


def test_dump_thread_stacks_survives_a_dead_faulthandler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both dump routes broken → None, never an exception."""
    monkeypatch.setattr(
        watchdog, "_thread_stack_texts", MagicMock(side_effect=RuntimeError("no frames"))
    )
    monkeypatch.setattr(
        watchdog.faulthandler, "dump_traceback", MagicMock(side_effect=OSError("bad fd"))
    )
    monkeypatch.setattr(watchdog, "log", MagicMock())

    assert watchdog._dump_thread_stacks() is None


def test_dump_thread_stacks_returns_extras_when_stderr_is_broken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dead stderr must not cost us the Sentry copy — that is the durable one."""

    class _BrokenStderr:
        def write(self, _text: str) -> int:
            raise OSError("stderr gone")

        def flush(self) -> None:
            pass

    monkeypatch.setattr(watchdog, "log", MagicMock())
    monkeypatch.setattr(watchdog.sys, "stderr", _BrokenStderr())

    extras = watchdog._dump_thread_stacks()

    assert extras is not None
    assert watchdog.THREAD_DUMP_HEADER in extras["thread_dump"]


def test_dump_truncates_the_sentry_copy_but_not_stderr(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Sentry's copy is bounded; the Railway log keeps the whole dump."""
    huge = "X" * (watchdog._SENTRY_DUMP_MAX_CHARS + 5_000)
    monkeypatch.setattr(watchdog, "_thread_stack_texts", lambda: (huge, "top frames"))

    extras = watchdog._dump_thread_stacks()

    assert huge in capsys.readouterr().err
    assert extras is not None
    dump = extras["thread_dump"]
    assert dump.startswith("X" * 100)
    assert len(dump) < len(huge)
    assert "truncated" in dump


def test_exit_for_restart_dumps_threads_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """One dump per exit — it runs on an already-broken process."""
    watchdog._exit_for_restart(987.0, 300.0)

    assert capsys.readouterr().err.count(watchdog.THREAD_DUMP_HEADER) == 1
    context = capture_mock.call_args.kwargs["context"]
    assert watchdog.THREAD_DUMP_HEADER in context["thread_dump"]
    assert "MainThread" in context["thread_top_frames"]
    assert context["staleness_s"] == 987.0
    assert capture_mock.call_args.kwargs["level"] == "error"
    no_exit.assert_called_once_with(1)


def test_exit_for_restart_still_exits_when_the_dump_raises(
    monkeypatch: pytest.MonkeyPatch,
    no_exit: MagicMock,
    capture_mock: MagicMock,
) -> None:
    """A diagnostic must never prevent the restart it is diagnosing."""
    monkeypatch.setattr(
        watchdog, "_dump_thread_stacks", MagicMock(side_effect=RuntimeError("dump exploded"))
    )
    monkeypatch.setattr(watchdog, "log", MagicMock())

    watchdog._exit_for_restart(999.0, 300.0)

    no_exit.assert_called_once_with(1)
    capture_mock.assert_called_once()
    context = capture_mock.call_args.kwargs["context"]
    assert "thread_dump" not in context
    assert context["staleness_s"] == 999.0


def test_exit_for_restart_dumps_before_reporting_and_exiting(
    monkeypatch: pytest.MonkeyPatch,
    capture_mock: MagicMock,
) -> None:
    """Order matters: the dump has to be out before the process dies."""
    dump_mock = MagicMock(return_value={"thread_dump": "d", "thread_top_frames": "t"})
    flush_mock = MagicMock()
    exit_mock = MagicMock()
    monkeypatch.setattr(watchdog, "_dump_thread_stacks", dump_mock)
    monkeypatch.setattr(watchdog, "_flush_sentry", flush_mock)
    monkeypatch.setattr(watchdog.os, "_exit", exit_mock)

    recorder = MagicMock()
    recorder.attach_mock(dump_mock, "dump")
    recorder.attach_mock(capture_mock, "capture")
    recorder.attach_mock(flush_mock, "flush")
    recorder.attach_mock(exit_mock, "exit")

    watchdog._exit_for_restart(999.0, 300.0)

    assert [call[0] for call in recorder.mock_calls] == ["dump", "capture", "flush", "exit"]
