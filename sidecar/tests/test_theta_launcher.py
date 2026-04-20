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

    theta_launcher._state["proc"] = None
    theta_launcher._state["started_at"] = 0.0
    theta_launcher._state["last_ready_at"] = 0.0
    theta_launcher._state["last_error"] = None
    theta_launcher._state["stderr_tail"].clear()
    theta_launcher._state["shutdown"] = False
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
    assert theta_launcher._state["last_ready_at"] == 0.0


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
    assert theta_launcher._state["last_ready_at"] > 0.0


# ---------------------------------------------------------------------------
# shutdown — graceful termination
# ---------------------------------------------------------------------------


def test_shutdown_is_noop_when_no_subprocess() -> None:
    import theta_launcher

    # No proc set; should not raise.
    theta_launcher.shutdown()
    assert theta_launcher._state["shutdown"] is True


def test_shutdown_terminates_running_subprocess() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None  # still running
    theta_launcher._state["proc"] = proc

    theta_launcher.shutdown()

    proc.terminate.assert_called_once()
    proc.wait.assert_called_once_with(timeout=5)
    proc.kill.assert_not_called()


def test_shutdown_escalates_to_sigkill_when_wait_times_out() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = None
    proc.wait.side_effect = subprocess.TimeoutExpired(cmd="java", timeout=5)
    theta_launcher._state["proc"] = proc

    theta_launcher.shutdown()

    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()


def test_shutdown_skips_terminate_if_process_already_exited() -> None:
    import theta_launcher

    proc = MagicMock()
    proc.poll.return_value = 0  # already exited
    theta_launcher._state["proc"] = proc

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
    theta_launcher._state["stderr_tail"].append("FATAL: something bad")

    # First call captures; second within 60s is suppressed.
    theta_launcher._maybe_forward_to_sentry("FATAL", "FATAL: something bad")
    theta_launcher._maybe_forward_to_sentry("FATAL", "FATAL: still bad")
    assert len(captured) == 1

    # A DIFFERENT signature bypasses rate-limit.
    theta_launcher._maybe_forward_to_sentry(
        "java.lang.NullPointerException", "java.lang.NullPointerException at X"
    )
    assert len(captured) == 2
