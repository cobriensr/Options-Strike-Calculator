"""Tests for theta_launcher — subprocess lifecycle + readiness probe.

We stub `subprocess.Popen` and `urlopen` so no real Java or network
runs. The module holds global `_state` + `_last_sentry_by_signature`
so each test resets both via the `_reset_state` autouse fixture.

Coverage:
  - `start()` no-ops when credentials are missing or jar is absent
  - `_write_creds()` writes the exact content with 0o600 perms
  - `_wait_for_ready()` times out cleanly when the HTTP server is silent
  - `_wait_for_ready()` records `last_ready_at` on success
  - `shutdown()` is safe when no subprocess is running
  - `shutdown()` escalates SIGTERM → SIGKILL after timeout
  - `_maybe_forward_to_sentry` rate-limits per signature (1/min)
"""

from __future__ import annotations

import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Reset module state and redirect paths to a tmp dir per test."""
    import theta_launcher

    # Phase 5c: _state is now a typed dataclass (_LauncherState).
    # Attribute access replaces the prior `_state["key"]` form so
    # typos surface at type-check time.
    theta_launcher._state.proc = None
    theta_launcher._state.started_at = 0.0
    theta_launcher._state.last_ready_at = 0.0
    theta_launcher._state.last_error = None
    theta_launcher._state.stderr_tail.clear()
    theta_launcher._state.shutdown = False
    theta_launcher._last_sentry_by_signature.clear()

    # Redirect working dir + default jar path to tmp. Tests override _JAR_PATH
    # per-scenario when they need to simulate a missing jar.
    monkeypatch.setattr(theta_launcher, "_THETA_HOME", tmp_path)
    jar_path = tmp_path / "ThetaTerminalv3.jar"
    jar_path.write_bytes(b"pretend jar bytes")
    monkeypatch.setattr(theta_launcher, "_JAR_PATH", jar_path)

    # Ensure env is clean of credentials by default.
    monkeypatch.delenv("THETA_EMAIL", raising=False)
    monkeypatch.delenv("THETA_PASSWORD", raising=False)


# ---------------------------------------------------------------------------
# start() — guard conditions
# ---------------------------------------------------------------------------


def test_start_returns_false_when_email_missing() -> None:
    import theta_launcher

    # THETA_EMAIL is unset from fixture; THETA_PASSWORD also unset.
    assert theta_launcher.start() is False


def test_start_returns_false_when_password_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import theta_launcher

    monkeypatch.setenv("THETA_EMAIL", "user@example.com")
    # Password still missing.
    assert theta_launcher.start() is False


def test_start_returns_false_when_jar_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import theta_launcher

    monkeypatch.setenv("THETA_EMAIL", "user@example.com")
    monkeypatch.setenv("THETA_PASSWORD", "secret")
    monkeypatch.setattr(theta_launcher, "_JAR_PATH", Path("/definitely/not/here.jar"))

    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_message",
        lambda msg, **kw: captured.append((msg, kw)),
    )

    assert theta_launcher.start() is False
    # Should have reported the missing jar, tagged for Theta filtering.
    assert len(captured) == 1
    assert "jar missing" in captured[0][0]
    assert captured[0][1].get("tags") == {"component": "theta"}


# ---------------------------------------------------------------------------
# _write_creds — perms + exact content
# ---------------------------------------------------------------------------


def test_write_creds_writes_email_and_password_then_chmods_600(
    tmp_path: Path,
) -> None:
    import theta_launcher

    theta_launcher._THETA_HOME = tmp_path  # belt + suspenders over fixture
    theta_launcher._write_creds("user@example.com", "hunter2")

    creds = tmp_path / "creds.txt"
    assert creds.read_text() == "user@example.com\nhunter2\n"
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600


# ---------------------------------------------------------------------------
# _wait_for_ready — readiness polling
# ---------------------------------------------------------------------------


def test_wait_for_ready_returns_false_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import theta_launcher

    def _always_refuse(*_args: object, **_kw: object) -> object:
        raise OSError("connection refused")

    monkeypatch.setattr(theta_launcher, "urlopen", _always_refuse)
    monkeypatch.setattr(theta_launcher, "_READINESS_TIMEOUT_S", 0.3)
    monkeypatch.setattr(theta_launcher, "_READINESS_POLL_INTERVAL_S", 0.05)

    assert theta_launcher._wait_for_ready() is False
    # last_ready_at remains 0.0 — we never saw a successful probe.
    assert theta_launcher._state.last_ready_at == 0.0


def test_wait_for_ready_returns_true_and_records_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import theta_launcher

    class _FakeResp:
        status = 200

        def __enter__(self) -> "_FakeResp":
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

    monkeypatch.setattr(theta_launcher, "urlopen", lambda *_a, **_kw: _FakeResp())

    assert theta_launcher._wait_for_ready() is True
    assert theta_launcher._state.last_ready_at > 0.0


# ---------------------------------------------------------------------------
# shutdown — graceful termination
# ---------------------------------------------------------------------------


def test_shutdown_is_noop_when_no_subprocess() -> None:
    import theta_launcher

    # No proc set; should not raise.
    theta_launcher.shutdown()
    assert theta_launcher._state.shutdown is True


def test_shutdown_terminates_running_subprocess() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None  # still running
    theta_launcher._state.proc = proc

    theta_launcher.shutdown()

    proc.terminate.assert_called_once()
    proc.wait.assert_called_once_with(timeout=5)
    proc.kill.assert_not_called()


def test_shutdown_escalates_to_sigkill_when_wait_times_out() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None
    proc.wait.side_effect = subprocess.TimeoutExpired(cmd="java", timeout=5)
    theta_launcher._state.proc = proc

    theta_launcher.shutdown()

    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()


def test_shutdown_skips_terminate_if_process_already_exited() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 0  # already exited
    theta_launcher._state.proc = proc

    theta_launcher.shutdown()

    proc.terminate.assert_not_called()
    proc.kill.assert_not_called()


# ---------------------------------------------------------------------------
# _maybe_forward_to_sentry — rate limiting
# ---------------------------------------------------------------------------


def test_maybe_forward_rate_limits_repeat_signatures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import theta_launcher

    captured: list[str] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_message",
        lambda msg, **_kw: captured.append(msg),
    )

    # Fill the stderr tail so the context payload is realistic.
    theta_launcher._state.stderr_tail.append("FATAL: something bad")

    # First call captures; second within 60s is suppressed.
    theta_launcher._maybe_forward_to_sentry("FATAL", "FATAL: something bad")
    theta_launcher._maybe_forward_to_sentry("FATAL", "FATAL: still bad")
    assert len(captured) == 1

    # A DIFFERENT signature bypasses rate-limit.
    theta_launcher._maybe_forward_to_sentry(
        "java.lang.NullPointerException", "java.lang.NullPointerException at X"
    )
    assert len(captured) == 2


def test_maybe_forward_records_last_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Forwarded lines populate _state.last_error for the read accessor."""
    import theta_launcher

    monkeypatch.setattr(theta_launcher, "capture_message", lambda *_a, **_kw: None)

    theta_launcher._maybe_forward_to_sentry("SEVERE", "SEVERE: disk full")
    assert theta_launcher._state.last_error == "SEVERE: disk full"


# ---------------------------------------------------------------------------
# Status accessors — is_running / last_ready_at / last_error
# ---------------------------------------------------------------------------


def test_is_running_false_when_no_proc() -> None:
    import theta_launcher

    assert theta_launcher.is_running() is False


def test_is_running_true_when_proc_alive() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None
    theta_launcher._state.proc = proc

    assert theta_launcher.is_running() is True


def test_is_running_false_when_proc_exited() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 137
    theta_launcher._state.proc = proc

    assert theta_launcher.is_running() is False


def test_last_ready_at_returns_state_value() -> None:
    import theta_launcher

    theta_launcher._state.last_ready_at = 12345.5
    assert theta_launcher.last_ready_at() == 12345.5


def test_last_error_returns_none_by_default() -> None:
    import theta_launcher

    assert theta_launcher.last_error() is None


def test_last_error_returns_state_value() -> None:
    import theta_launcher

    theta_launcher._state.last_error = "boom"
    assert theta_launcher.last_error() == "boom"


# ---------------------------------------------------------------------------
# _spawn_subprocess — Popen call shape + thread spawn
# ---------------------------------------------------------------------------


def test_spawn_subprocess_calls_popen_with_jar_and_starts_threads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """_spawn_subprocess() builds the right java argv and starts daemon threads."""
    import theta_launcher

    fake_proc = MagicMock()
    popen_calls: list[tuple[tuple, dict]] = []

    def _fake_popen(*args: object, **kwargs: object) -> MagicMock:
        popen_calls.append((args, kwargs))
        return fake_proc

    monkeypatch.setattr(theta_launcher.subprocess, "Popen", _fake_popen)

    started_threads: list[object] = []
    real_thread = theta_launcher.threading.Thread

    def _capture_thread(*args: object, **kwargs: object) -> object:
        t = real_thread(*args, **kwargs)
        started_threads.append(kwargs.get("name"))
        # Don't actually start the thread — the target loops would block on
        # the mock's stderr/stdout iterators forever in some setups.
        t.start = lambda: None  # type: ignore[method-assign]
        return t

    monkeypatch.setattr(theta_launcher.threading, "Thread", _capture_thread)

    theta_launcher._spawn_subprocess()

    # Popen received the right argv shape.
    assert len(popen_calls) == 1
    args, kwargs = popen_calls[0]
    assert args[0][0] == "java"
    assert args[0][1] == "-jar"
    assert args[0][2].endswith("ThetaTerminalv3.jar")
    assert kwargs["stdout"] == subprocess.PIPE
    assert kwargs["stderr"] == subprocess.PIPE
    assert kwargs["text"] is True

    # State was populated.
    assert theta_launcher._state.proc is fake_proc
    assert theta_launcher._state.started_at > 0.0

    # Both daemon threads were spawned.
    assert "theta-stderr" in started_threads
    assert "theta-stdout" in started_threads


# ---------------------------------------------------------------------------
# _spawn_subprocess — FINDING A: respawn closes old pipes + joins old threads
# ---------------------------------------------------------------------------


def test_spawn_subprocess_reaps_old_proc_before_replacing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On respawn the old pipes are closed and old drain threads joined."""
    import theta_launcher

    # Seed state with a "previous" proc + its drain threads.
    old_proc = MagicMock()
    old_stdout = MagicMock()
    old_stderr = MagicMock()
    old_proc.stdout = old_stdout
    old_proc.stderr = old_stderr
    old_t1 = MagicMock()
    old_t2 = MagicMock()
    theta_launcher._state.proc = old_proc
    theta_launcher._state.drain_threads = [old_t1, old_t2]

    new_proc = MagicMock()
    monkeypatch.setattr(theta_launcher.subprocess, "Popen", lambda *_a, **_kw: new_proc)

    # Stub out Thread so the new drain loops don't actually run.
    real_thread = theta_launcher.threading.Thread

    def _capture_thread(*args: object, **kwargs: object) -> object:
        t = real_thread(*args, **kwargs)
        t.start = lambda: None  # type: ignore[method-assign]
        return t

    monkeypatch.setattr(theta_launcher.threading, "Thread", _capture_thread)

    theta_launcher._spawn_subprocess()

    # Old pipes were closed so the old drain loops hit EOF.
    old_stdout.close.assert_called_once()
    old_stderr.close.assert_called_once()
    # Old drain threads were joined with a bounded timeout.
    old_t1.join.assert_called_once_with(timeout=theta_launcher._DRAIN_JOIN_TIMEOUT_S)
    old_t2.join.assert_called_once_with(timeout=theta_launcher._DRAIN_JOIN_TIMEOUT_S)

    # New proc installed; drain_threads replaced (exactly two fresh handles).
    assert theta_launcher._state.proc is new_proc
    assert len(theta_launcher._state.drain_threads) == 2
    assert old_t1 not in theta_launcher._state.drain_threads
    assert old_t2 not in theta_launcher._state.drain_threads


def test_spawn_subprocess_drain_threads_bounded_across_respawns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N respawns never grow _state.drain_threads past two handles."""
    import theta_launcher

    monkeypatch.setattr(
        theta_launcher.subprocess, "Popen", lambda *_a, **_kw: MagicMock()
    )

    real_thread = theta_launcher.threading.Thread

    def _capture_thread(*args: object, **kwargs: object) -> object:
        t = real_thread(*args, **kwargs)
        t.start = lambda: None  # type: ignore[method-assign]
        return t

    monkeypatch.setattr(theta_launcher.threading, "Thread", _capture_thread)

    for _ in range(5):
        theta_launcher._spawn_subprocess()
        assert len(theta_launcher._state.drain_threads) == 2


def test_reap_old_proc_is_noop_when_no_old_proc() -> None:
    """First-ever spawn (no prior proc) reaps cleanly without raising."""
    import theta_launcher

    # Should not raise with None proc and empty thread list.
    theta_launcher._reap_old_proc(None, [])


def test_reap_old_proc_swallows_pipe_close_errors() -> None:
    """A close() that raises OSError is swallowed (best-effort)."""
    import theta_launcher

    proc = MagicMock()
    proc.stdout.close.side_effect = OSError("already closed")
    proc.stderr = None
    # Should not raise.
    theta_launcher._reap_old_proc(proc, [])


# ---------------------------------------------------------------------------
# _monitor_loop — FINDING B: half-up restart is killed + reported to Sentry
# ---------------------------------------------------------------------------


def test_monitor_loop_kills_proc_when_restart_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Restart spawns a proc but readiness fails -> proc killed + Sentry fired."""
    import theta_launcher

    dead_proc = MagicMock()
    dead_proc.poll.return_value = 1  # original proc exited
    theta_launcher._state.proc = dead_proc

    monkeypatch.setattr(theta_launcher.time, "sleep", lambda _s: None)

    captured: list[str] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_message",
        lambda msg, **_kw: captured.append(msg),
    )

    # The respawned (half-up) proc: process alive, HTTP never came up.
    half_up = MagicMock()
    half_up.poll.return_value = None  # alive

    def _fake_spawn() -> None:
        theta_launcher._state.proc = half_up
        # Stop the loop after this restart attempt.
        theta_launcher._state.shutdown = True

    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", _fake_spawn)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: False)

    theta_launcher._monitor_loop()

    # Half-up proc was terminated so is_running() reflects reality.
    half_up.terminate.assert_called_once()
    half_up.wait.assert_called_once_with(timeout=5)
    # Sentry got the not-ready signal.
    assert any("did not reach ready state" in m for m in captured)

    # is_running() now returns False (process killed -> poll reports exit).
    half_up.poll.return_value = 143  # SIGTERM exit
    assert theta_launcher.is_running() is False


def test_handle_restart_not_ready_escalates_to_kill_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If terminate()'d proc ignores the timeout, escalate to kill()."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None
    # First wait() (after terminate) times out -> escalate to kill(); the
    # second wait() (reap after kill) succeeds so the child isn't defunct.
    proc.wait.side_effect = [subprocess.TimeoutExpired(cmd="java", timeout=5), 0]
    theta_launcher._state.proc = proc

    monkeypatch.setattr(theta_launcher, "capture_message", lambda *_a, **_kw: None)

    theta_launcher._handle_restart_not_ready()

    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()
    assert proc.wait.call_count == 2


# ---------------------------------------------------------------------------
# _stderr_tail_loop — line capture + sentry forwarding
# ---------------------------------------------------------------------------


def test_stderr_tail_loop_returns_when_no_proc() -> None:
    import theta_launcher

    # No proc set; loop should bail without raising.
    theta_launcher._stderr_tail_loop()  # no assertions — just shouldn't hang


def test_stderr_tail_loop_returns_when_proc_has_no_stderr() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.stderr = None
    theta_launcher._state.proc = proc

    theta_launcher._stderr_tail_loop()  # no-op


def test_stderr_tail_loop_appends_lines_and_forwards_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-empty lines are buffered; matching ones go to Sentry."""
    import theta_launcher

    forwarded: list[tuple[str, str]] = []
    monkeypatch.setattr(
        theta_launcher,
        "_maybe_forward_to_sentry",
        lambda sig, line: forwarded.append((sig, line)),
    )

    proc = MagicMock()
    # Mix benign lines, blank, and one matching error signature.
    proc.stderr = iter(
        [
            "INFO: starting up\n",
            "\n",  # blank — should be skipped
            "FATAL: out of memory\n",
            "DEBUG: heartbeat\n",
        ]
    )
    theta_launcher._state.proc = proc

    theta_launcher._stderr_tail_loop()

    tail = list(theta_launcher._state.stderr_tail)
    assert "INFO: starting up" in tail
    assert "FATAL: out of memory" in tail
    assert "DEBUG: heartbeat" in tail
    # Blank line was skipped.
    assert "" not in tail

    # Only the FATAL line was forwarded.
    assert len(forwarded) == 1
    assert forwarded[0][0] == "FATAL"


# ---------------------------------------------------------------------------
# _stdout_drain_loop — pipe drain
# ---------------------------------------------------------------------------


def test_stdout_drain_loop_returns_when_no_proc() -> None:
    import theta_launcher

    theta_launcher._stdout_drain_loop()  # no-op


def test_stdout_drain_loop_returns_when_proc_has_no_stdout() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.stdout = None
    theta_launcher._state.proc = proc

    theta_launcher._stdout_drain_loop()  # no-op


def test_stdout_drain_loop_consumes_all_lines() -> None:
    """The loop iterates the pipe to keep the OS buffer flowing."""
    import theta_launcher

    consumed: list[str] = []

    class _StdoutTracker:
        def __init__(self, lines: list[str]) -> None:
            self._lines = iter(lines)

        def __iter__(self) -> "_StdoutTracker":
            return self

        def __next__(self) -> str:
            line = next(self._lines)
            consumed.append(line)
            return line

    proc = MagicMock()
    proc.stdout = _StdoutTracker(["heartbeat\n", "ok\n", "done\n"])
    theta_launcher._state.proc = proc

    theta_launcher._stdout_drain_loop()
    assert consumed == ["heartbeat\n", "ok\n", "done\n"]


# ---------------------------------------------------------------------------
# start() — happy path + readiness failure paths
# ---------------------------------------------------------------------------


def test_start_returns_false_when_spawn_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If _spawn_subprocess explodes, start() captures it and returns False."""
    import theta_launcher

    monkeypatch.setenv("THETA_EMAIL", "user@example.com")
    monkeypatch.setenv("THETA_PASSWORD", "secret")

    monkeypatch.setattr(theta_launcher, "_write_creds", lambda *_a, **_kw: None)

    def _boom() -> None:
        raise RuntimeError("popen exploded")

    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", _boom)

    captured: list[Exception] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_exception",
        lambda exc, **_kw: captured.append(exc),
    )

    assert theta_launcher.start() is False
    assert len(captured) == 1
    assert isinstance(captured[0], RuntimeError)


def test_start_returns_false_when_readiness_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Successful spawn but readiness fails -> sentry message + False."""
    import theta_launcher

    monkeypatch.setenv("THETA_EMAIL", "user@example.com")
    monkeypatch.setenv("THETA_PASSWORD", "secret")

    monkeypatch.setattr(theta_launcher, "_write_creds", lambda *_a, **_kw: None)
    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", lambda: None)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: False)

    # Pre-populate stderr tail to verify it makes it into the context.
    theta_launcher._state.stderr_tail.append("STARTUP FAILED")

    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_message",
        lambda msg, **kw: captured.append((msg, kw)),
    )

    assert theta_launcher.start() is False
    assert len(captured) == 1
    msg, kw = captured[0]
    assert "failed to come up" in msg
    assert kw.get("tags") == {"component": "theta"}
    assert "STARTUP FAILED" in kw["context"]["stderr_tail"]


def test_start_returns_true_on_happy_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All boot steps succeed -> start() spawns monitor thread and returns True."""
    import theta_launcher

    monkeypatch.setenv("THETA_EMAIL", "user@example.com")
    monkeypatch.setenv("THETA_PASSWORD", "secret")

    monkeypatch.setattr(theta_launcher, "_write_creds", lambda *_a, **_kw: None)
    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", lambda: None)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: True)

    started_threads: list[str] = []
    real_thread = theta_launcher.threading.Thread

    def _capture_thread(*args: object, **kwargs: object) -> object:
        t = real_thread(*args, **kwargs)
        started_threads.append(kwargs.get("name", ""))
        t.start = lambda: None  # type: ignore[method-assign]
        return t

    monkeypatch.setattr(theta_launcher.threading, "Thread", _capture_thread)

    assert theta_launcher.start() is True
    assert "theta-monitor" in started_threads


# ---------------------------------------------------------------------------
# _monitor_loop — restart, backoff, shutdown
# ---------------------------------------------------------------------------


def test_monitor_loop_returns_immediately_if_shutdown_set() -> None:
    """Shutdown flag short-circuits the loop on first iteration."""
    import theta_launcher

    theta_launcher._state.shutdown = True
    # No proc, no infinite loop — returns cleanly.
    theta_launcher._monitor_loop()


def test_monitor_loop_returns_when_no_proc() -> None:
    """No proc set after acquiring lock -> loop returns."""
    import theta_launcher

    # shutdown=False, proc=None → second guard returns.
    theta_launcher._state.proc = None
    theta_launcher._state.shutdown = False
    theta_launcher._monitor_loop()


def test_monitor_loop_sleeps_when_proc_alive_then_exits_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """proc.poll() returns None -> loop sleeps; shutdown flips, loop exits."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None  # alive
    theta_launcher._state.proc = proc

    sleep_calls: list[float] = []

    def _fake_sleep(secs: float) -> None:
        sleep_calls.append(secs)
        # After the first sleep, set shutdown to break the loop.
        theta_launcher._state.shutdown = True

    monkeypatch.setattr(theta_launcher.time, "sleep", _fake_sleep)

    theta_launcher._monitor_loop()

    # First iteration slept (proc alive); second iteration short-circuited via shutdown.
    assert sleep_calls == [5]


def test_monitor_loop_restarts_after_unexpected_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-None poll() triggers sentry + restart via _spawn_subprocess."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 1  # exited with rc=1
    theta_launcher._state.proc = proc
    theta_launcher._state.started_at = 1000.0

    captured_messages: list[str] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_message",
        lambda msg, **_kw: captured_messages.append(msg),
    )

    spawn_calls: list[int] = []

    def _fake_spawn() -> None:
        spawn_calls.append(1)
        # After respawn, set shutdown so the loop terminates after the post-restart guard.
        theta_launcher._state.shutdown = True

    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", _fake_spawn)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: True)
    monkeypatch.setattr(theta_launcher.time, "sleep", lambda _s: None)

    theta_launcher._monitor_loop()

    assert any("exited" in m for m in captured_messages)
    assert spawn_calls == [1]


def test_monitor_loop_logs_warning_when_restart_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If restart doesn't reach ready, loop continues but logs warning."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 1
    theta_launcher._state.proc = proc

    monkeypatch.setattr(theta_launcher, "capture_message", lambda *_a, **_kw: None)
    monkeypatch.setattr(theta_launcher.time, "sleep", lambda _s: None)

    def _fake_spawn() -> None:
        # Stop the loop after this restart attempt.
        theta_launcher._state.shutdown = True

    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", _fake_spawn)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: False)

    # Should not raise even though ready failed.
    theta_launcher._monitor_loop()


def test_monitor_loop_captures_exception_during_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A raise during _spawn_subprocess is captured to Sentry, not propagated."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 137
    theta_launcher._state.proc = proc

    monkeypatch.setattr(theta_launcher, "capture_message", lambda *_a, **_kw: None)
    monkeypatch.setattr(theta_launcher.time, "sleep", lambda _s: None)

    captured_exc: list[Exception] = []
    monkeypatch.setattr(
        theta_launcher,
        "capture_exception",
        lambda exc, **_kw: captured_exc.append(exc),
    )

    raise_count = {"n": 0}

    def _raise_once() -> None:
        raise_count["n"] += 1
        # Stop the loop on the next iteration.
        theta_launcher._state.shutdown = True
        raise RuntimeError("respawn boom")

    monkeypatch.setattr(theta_launcher, "_spawn_subprocess", _raise_once)
    monkeypatch.setattr(theta_launcher, "_wait_for_ready", lambda: True)

    theta_launcher._monitor_loop()

    assert len(captured_exc) == 1
    assert isinstance(captured_exc[0], RuntimeError)


def test_monitor_loop_returns_after_sleep_if_shutdown_during_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shutdown set during the backoff sleep -> loop exits before respawn."""
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 1
    theta_launcher._state.proc = proc

    monkeypatch.setattr(theta_launcher, "capture_message", lambda *_a, **_kw: None)

    # Flip shutdown DURING the backoff sleep so the post-sleep guard returns.
    def _flip_shutdown(_secs: float) -> None:
        theta_launcher._state.shutdown = True

    monkeypatch.setattr(theta_launcher.time, "sleep", _flip_shutdown)

    spawn_calls: list[int] = []
    monkeypatch.setattr(
        theta_launcher, "_spawn_subprocess", lambda: spawn_calls.append(1)
    )

    theta_launcher._monitor_loop()
    # _spawn_subprocess should NOT have been called.
    assert spawn_calls == []
