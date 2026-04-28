"""Theta Data Terminal subprocess launcher.

Runs Theta Terminal (a Java jar) as a co-resident subprocess on the
Railway sidecar so the existing Python runtime can make local HTTP
requests against its v2 API at :25503.

Boot sequence:
  1. Abort if THETA_EMAIL or THETA_PASSWORD is unset (matches the
     sentry_setup no-op pattern — local dev works without creds).
  2. Write creds.txt into THETA_DATA_DIR with 0600 perms.
  3. Popen `java -jar ThetaTerminalv3.jar` with cwd at that dir.
  4. Poll http://127.0.0.1:25503/v2/list/roots/stock for up to 60s until
     HTTP 200.
  5. Spawn daemon threads that:
       - Tail stderr and forward lines matching java.*Exception / FATAL /
         SEVERE to Sentry (rate-limited 1/min per signature).
       - Drain stdout so the pipe buffer never fills.
       - Watch proc.poll() and restart on unexpected exit with backoff.

Never raises. Every failure path reports via sentry_setup.capture_*
with tag `component=theta` so the sidecar's Databento relay keeps
running even if Theta dies — Theta is additive, not critical.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from logger_setup import log
from sentry_setup import capture_exception, capture_message

# Paths & ports. /app is the sidecar WORKDIR (set in Dockerfile).
# THETA_DATA_DIR can override the working dir for tests/local runs.
_THETA_HOME = Path(os.environ.get("THETA_DATA_DIR", "/app/theta_data/ThetaTerminal"))
_JAR_PATH = Path(os.environ.get("THETA_JAR_PATH", "/app/ThetaTerminalv3.jar"))
_HTTP_BASE = "http://127.0.0.1:25503"
_READINESS_PATH = "/v2/list/roots/stock"
_READINESS_TIMEOUT_S = 60
_READINESS_POLL_INTERVAL_S = 2

# Stderr lines matching these signatures get forwarded to Sentry.
# Scoped tight enough to avoid false positives from normal log output.
_ERROR_SIGNATURES = re.compile(
    r"(java\.\S+(?:Exception|Error)|FATAL|SEVERE)",
    re.IGNORECASE,
)

# Monitor state (guarded by _state_lock). Kept as a dict so helpers
# can introspect without exposing module-level globals elsewhere.
_state: dict[str, Any] = {
    "proc": None,
    "started_at": 0.0,
    "last_ready_at": 0.0,
    "last_error": None,
    "stderr_tail": deque(maxlen=50),
    "shutdown": False,
}
_state_lock = threading.Lock()
_last_sentry_by_signature: dict[str, float] = {}


def start() -> bool:
    """Launch Theta Terminal if credentials are configured.

    Returns True when the subprocess started and HTTP is reachable.
    Returns False (without raising) if disabled, misconfigured, or the
    jar fails to come up. All failures are captured via Sentry.
    """
    email = os.environ.get("THETA_EMAIL", "").strip()
    password = os.environ.get("THETA_PASSWORD", "").strip()

    if not email or not password:
        log.info("THETA_EMAIL or THETA_PASSWORD not set — Theta disabled")
        return False

    if not _JAR_PATH.exists():
        capture_message(
            "Theta jar missing at launcher init",
            level="error",
            context={"expected_path": str(_JAR_PATH)},
            tags={"component": "theta"},
        )
        return False

    try:
        _write_creds(email, password)
        _spawn_subprocess()
    except Exception as exc:
        capture_exception(
            exc,
            context={"phase": "theta_launch"},
            tags={"component": "theta"},
        )
        return False

    if not _wait_for_ready():
        with _state_lock:
            stderr_tail = list(_state["stderr_tail"])
        capture_message(
            "Theta HTTP server failed to come up within timeout",
            level="error",
            context={
                "timeout_s": _READINESS_TIMEOUT_S,
                "stderr_tail": stderr_tail,
            },
            tags={"component": "theta"},
        )
        return False

    threading.Thread(target=_monitor_loop, name="theta-monitor", daemon=True).start()
    log.info("Theta Terminal launched and serving on %s", _HTTP_BASE)
    return True


def is_running() -> bool:
    """True if the subprocess is currently alive."""
    with _state_lock:
        proc = _state["proc"]
    return bool(proc and proc.poll() is None)


def last_ready_at() -> float:
    """Epoch timestamp of the most recent successful readiness probe."""
    with _state_lock:
        return float(_state["last_ready_at"])


def last_error() -> str | None:
    """Most recent error line forwarded to Sentry, or None."""
    with _state_lock:
        return _state["last_error"]


def shutdown() -> None:
    """Terminate the subprocess for graceful container shutdown.

    Called from the sidecar's SIGTERM handler. Uses SIGTERM first,
    escalates to SIGKILL after 5s if the jar ignores the polite signal.
    """
    with _state_lock:
        _state["shutdown"] = True
        proc = _state["proc"]
    if proc and proc.poll() is None:
        log.info("Terminating Theta Terminal subprocess")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _write_creds(email: str, password: str) -> None:
    """Write creds.txt where the jar looks for it, with 0600 perms.

    Plaintext-on-disk is unavoidable: the third-party Theta Terminal jar
    reads `creds.txt` from disk at boot (no stdin / keystore alternative
    exists in v3). The mitigations are:
      - File mode 0600 (only the container's own uid can read).
      - Parent dir mode 0700 (no traversal via parent listing).
      - Lives on the container's writable layer only — not the mounted
        /data volume — so it dies with the container.
      - Password is NEVER logged; only the path and email are.
      - Railway env var panel is the canonical secret store; this file
        is a derived artifact, not a source of truth.

    CodeQL will flag this as clear-text storage of sensitive data. The
    finding is acknowledged and intentional — the constraint is the
    upstream jar, not this code path.
    """
    _THETA_HOME.mkdir(parents=True, exist_ok=True)
    _THETA_HOME.chmod(0o700)
    creds = _THETA_HOME / "creds.txt"
    creds.write_text(f"{email}\n{password}\n")  # noqa: S105
    creds.chmod(0o600)
    log.info("Wrote Theta creds.txt at %s (user=%s)", creds, email)


def _spawn_subprocess() -> None:
    """Popen the jar and kick off stderr/stdout drain threads."""
    with _state_lock:
        _state["proc"] = subprocess.Popen(
            ["java", "-jar", str(_JAR_PATH)],
            cwd=str(_THETA_HOME),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        _state["started_at"] = time.time()

    threading.Thread(target=_stderr_tail_loop, name="theta-stderr", daemon=True).start()
    threading.Thread(
        target=_stdout_drain_loop, name="theta-stdout", daemon=True
    ).start()


def _wait_for_ready() -> bool:
    """Block until the jar's HTTP server responds 2xx or the deadline hits."""
    deadline = time.time() + _READINESS_TIMEOUT_S
    url = f"{_HTTP_BASE}{_READINESS_PATH}"
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as resp:  # noqa: S310 — localhost only
                if 200 <= resp.status < 300:
                    with _state_lock:
                        _state["last_ready_at"] = time.time()
                    return True
        except (URLError, TimeoutError, OSError):
            # Expected during boot — keep polling.
            pass
        time.sleep(_READINESS_POLL_INTERVAL_S)
    return False


def _stderr_tail_loop() -> None:
    """Capture stderr into a rolling buffer + forward errors to Sentry."""
    with _state_lock:
        proc = _state["proc"]
    if not proc or not proc.stderr:
        return
    for line in proc.stderr:
        stripped = line.rstrip()
        if not stripped:
            continue
        with _state_lock:
            _state["stderr_tail"].append(stripped)
        match = _ERROR_SIGNATURES.search(stripped)
        if match:
            _maybe_forward_to_sentry(match.group(1), stripped)


def _stdout_drain_loop() -> None:
    """Drain stdout so the OS pipe buffer never fills and stalls the jar."""
    with _state_lock:
        proc = _state["proc"]
    if not proc or not proc.stdout:
        return
    for _line in proc.stdout:
        # We don't care about stdout content — jar logs important
        # events to stderr. Reading just keeps the pipe flowing.
        pass


def _maybe_forward_to_sentry(signature: str, line: str) -> None:
    """Forward an error line to Sentry with per-signature rate limiting."""
    now = time.time()
    last = _last_sentry_by_signature.get(signature, 0.0)
    if now - last < 60:
        return
    _last_sentry_by_signature[signature] = now
    with _state_lock:
        tail = list(_state["stderr_tail"])
        _state["last_error"] = line
    capture_message(
        f"Theta Terminal stderr: {signature}",
        level="error",
        context={"line": line, "recent_lines": tail[-20:]},
        tags={"component": "theta"},
    )


def _monitor_loop() -> None:
    """Watch for unexpected subprocess exit and restart with backoff."""
    backoff = 5
    max_backoff = 60
    while True:
        with _state_lock:
            if _state["shutdown"]:
                return
            proc = _state["proc"]
        if not proc:
            return

        rc = proc.poll()
        if rc is None:
            time.sleep(5)
            continue

        with _state_lock:
            uptime = time.time() - _state["started_at"]
            stderr_tail = list(_state["stderr_tail"])
        capture_message(
            "Theta Terminal subprocess exited",
            level="error",
            context={
                "exit_code": rc,
                "uptime_s": round(uptime, 1),
                "stderr_tail": stderr_tail,
            },
            tags={"component": "theta"},
        )

        log.warning(
            "Theta subprocess exited (rc=%s, uptime=%.1fs); restarting in %ds",
            rc,
            uptime,
            backoff,
        )
        time.sleep(backoff)

        with _state_lock:
            if _state["shutdown"]:
                return
        try:
            _spawn_subprocess()
            if not _wait_for_ready():
                log.warning("Theta restart did not reach ready state within timeout")
        except Exception as exc:
            capture_exception(
                exc,
                context={"phase": "theta_restart"},
                tags={"component": "theta"},
            )

        backoff = min(backoff * 2, max_backoff)
