"""Stale-data watchdog — turn a silent consume-loop freeze into a restart.

Real incident (2026-08-20 01:31-01:45 UTC): the Databento consume loop
froze completely — no bars written, no per-minute heartbeat logs, no
exception anywhere — while ``is_connected()`` stayed True and the
threaded health server kept answering 200/503. ``/health`` correctly
reported ``data_fresh: false`` but nothing acted on it: Railway only
restarts on crash, and a frozen process isn't a crash. A manual
``railway redeploy`` fixed it, and the Databento replay subscription
backfilled the gap losslessly.

This module closes that failure mode. A daemon thread (started from
``main.main()`` just before the blocking connect loop) checks once per
minute and exits the process when ALL of:

- the boot grace window has elapsed — a slow Theta boot + Databento
  connect must not cause a restart loop;
- market data is currently expected — the same session calendar the
  ``/health`` ``data_fresh`` check uses, so weekends and the daily
  maintenance hour can never trigger;
- the client reports connected — a disconnected client is handled by
  ``main.connect_with_retry`` and the SDK's own reconnect policy; the
  watchdog only covers the frozen-while-"connected" case; and
- the newest bar is older than the staleness threshold.

``os._exit(1)`` (not ``sys.exit``) is deliberate: the premise is that
the process is wedged, so the exit must not depend on any other thread
running cleanup. Sentry is flushed explicitly first because
``os._exit`` skips the SDK's atexit flush (no other capture_message
call site flushes — they all rely on that atexit hook). Railway's
restart policy then brings up a fresh container whose replay
subscription backfills the gap, as observed in the incident.

Env knobs (read at ``start_watchdog()`` call time; guarded by
``health._env_int`` — the THETA_INDEX_CONCURRENCY pattern — so a bad
value degrades with a warning instead of raising):

- ``WATCHDOG_STALE_EXIT_S`` — staleness threshold in seconds.
  Default 300, clamped to >= 180 so a typo can't make routine bar
  gaps fatal.
- ``WATCHDOG_BOOT_GRACE_S`` — seconds after thread start before the
  first evaluation. Default 600, clamped to >= 0.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable

# Deliberate reuse of two health.py module-private helpers rather than
# duplicating them (lifting them out was considered and rejected to
# keep health.py untouched): `_is_data_expected` is the session
# calendar — one copy means /health's `data_fresh` and the watchdog can
# never disagree about whether data is expected — and `_env_int` is the
# never-raise env guard. Resolved through the module at call time so
# the existing `patch("health._is_data_expected", ...)` test seam
# covers the watchdog too. main.py already imports health, so this
# adds no import-time work.
import health
from logger_setup import log
from sentry_setup import capture_message, is_enabled

# Cadence of the staleness check. Not env-tunable: it only needs to be
# comfortably below the exit threshold's 180s floor.
WATCHDOG_INTERVAL_S = 60.0

STALE_EXIT_DEFAULT_S = 300
STALE_EXIT_MIN_S = 180
BOOT_GRACE_DEFAULT_S = 600

# Bounded wait for the Sentry event to reach the transport before
# os._exit. Generous vs. the usual send latency, small vs. the outage.
_SENTRY_FLUSH_TIMEOUT_S = 5.0


def _stale_exit_seconds() -> float:
    """Read WATCHDOG_STALE_EXIT_S (default 300, clamped to >= 180)."""
    return float(
        health._env_int("WATCHDOG_STALE_EXIT_S", STALE_EXIT_DEFAULT_S, minimum=STALE_EXIT_MIN_S)
    )


def _boot_grace_seconds() -> float:
    """Read WATCHDOG_BOOT_GRACE_S (default 600, clamped to >= 0)."""
    return float(health._env_int("WATCHDOG_BOOT_GRACE_S", BOOT_GRACE_DEFAULT_S, minimum=0))


def _staleness_if_frozen(
    *,
    now_monotonic: float,
    started_at_monotonic: float,
    boot_grace_s: float,
    stale_exit_s: float,
    is_connected: Callable[[], bool],
    last_bar_at: Callable[[], float],
) -> float | None:
    """Return the bar staleness in seconds when the freeze condition holds.

    Returns None when any gate says "don't restart": still inside the
    boot grace, data not expected (weekend / maintenance hour), client
    not connected, or bars fresh enough. `last_bar_at()` of 0.0 (no bar
    ever received) reads as maximally stale on purpose — connected with
    zero bars for grace + threshold during a session IS the wedged case.
    """
    if now_monotonic - started_at_monotonic < boot_grace_s:
        return None
    if not health._is_data_expected():
        return None
    if not is_connected():
        return None
    # Wall clock, matching how last_bar_ts is stamped (time.time() in
    # databento_client) and how /health computes data_fresh. Reading
    # the float via the callable is atomic in CPython — deliberately no
    # lock here; a lock could itself deadlock against a wedged process.
    staleness = time.time() - last_bar_at()
    if staleness > stale_exit_s:
        return staleness
    return None


def _flush_sentry() -> None:
    """Push the captured event to Sentry's transport before os._exit.

    Every other capture_message call site relies on the SDK's atexit
    flush; os._exit skips atexit, so this path must flush explicitly.
    """
    if not is_enabled():
        return
    try:
        import sentry_sdk  # noqa: PLC0415 — optional dep, mirrors sentry_setup

        sentry_sdk.flush(timeout=_SENTRY_FLUSH_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 — telemetry must never block the restart exit
        log.error("Watchdog: Sentry flush failed: %s", exc)


def _exit_for_restart(staleness_s: float, stale_exit_s: float) -> None:
    """Log, report to Sentry, and hard-exit so Railway restarts us."""
    log.critical(
        "Watchdog: last bar is %.0fs old (threshold %.0fs) while connected "
        "and data expected — exiting 1 so Railway restarts the container",
        staleness_s,
        stale_exit_s,
    )
    capture_message(
        "sidecar watchdog: data stale, exiting for restart",
        level="error",
        tags={"component": "watchdog"},
        context={
            "staleness_s": round(staleness_s, 1),
            "threshold_s": stale_exit_s,
        },
    )
    _flush_sentry()
    os._exit(1)


def _run_loop(
    *,
    is_connected: Callable[[], bool],
    last_bar_at: Callable[[], float],
    stale_exit_s: float,
    boot_grace_s: float,
) -> None:
    """Run the watchdog check loop forever (daemon-thread body).

    No per-tick logging by design — the healthy case must stay silent
    or the watchdog becomes 1,440 log lines a day of noise.
    """
    started_at = time.monotonic()
    while True:
        time.sleep(WATCHDOG_INTERVAL_S)
        try:
            staleness = _staleness_if_frozen(
                now_monotonic=time.monotonic(),
                started_at_monotonic=started_at,
                boot_grace_s=boot_grace_s,
                stale_exit_s=stale_exit_s,
                is_connected=is_connected,
                last_bar_at=last_bar_at,
            )
        except Exception as exc:  # noqa: BLE001 — a probe crash must not kill the watchdog
            # Log-only (no Sentry): a persistent probe failure would
            # otherwise emit an event every 60s. Railway's log drain
            # still surfaces it.
            log.error("Watchdog probe failed: %s", exc)
            continue
        if staleness is not None:
            _exit_for_restart(staleness, stale_exit_s)


def start_watchdog(
    *,
    is_connected: Callable[[], bool],
    last_bar_at: Callable[[], float],
) -> threading.Thread:
    """Start the stale-data watchdog in a daemon thread and return it.

    Callables must be lock-free reads of client state (main.py passes
    the same lambdas the health server gets: `client.is_connected` and
    `client.last_bar_ts`) — the watchdog must stay deadlock-proof.
    """
    stale_exit_s = _stale_exit_seconds()
    boot_grace_s = _boot_grace_seconds()

    log.info(
        "Stale-data watchdog started: exit after %.0fs staleness, "
        "%.0fs boot grace, %.0fs check interval",
        stale_exit_s,
        boot_grace_s,
        WATCHDOG_INTERVAL_S,
    )

    thread = threading.Thread(
        target=_run_loop,
        kwargs={
            "is_connected": is_connected,
            "last_bar_at": last_bar_at,
            "stale_exit_s": stale_exit_s,
            "boot_grace_s": boot_grace_s,
        },
        name="stale-data-watchdog",
        daemon=True,
    )
    thread.start()
    return thread
