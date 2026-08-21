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

- the grace window has elapsed — a slow Theta boot + Databento
  connect must not cause a restart loop, and neither must the first
  minute after a closed session reopens (see "Grace window" below);
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

Grace window
------------

One window, armed twice. ``_run_loop`` keeps a monotonic *baseline*
and ignores everything until ``WATCHDOG_BOOT_GRACE_S`` has elapsed
since it. The baseline is set at thread start (the boot grace) and
re-armed whenever ``health._is_data_expected()`` transitions
False -> True — i.e. when a closed session reopens.

The re-arm fixes a daily false positive. Globex halts 16:00-17:00 CT;
during the halt the calendar gate keeps the watchdog inert, so the
staleness accumulating across the closed hour is never measured. The
instant the calendar flips True the watchdog saw an hour-old bar and
exited immediately — observed live on 2026-08-20 22:01:03Z reporting
3654s, a pointless restart that would have recurred every weekday.
Re-arming means the feed gets the same window to produce its first bar
that a fresh boot gets. It is a delay, not blindness: if no bar lands
within the window the watchdog still exits, and a freeze that starts
after the reopen is caught on the normal threshold.

Thread dump
-----------

The freeze root cause is still unknown. ``ea1466ab`` added
``tcp_user_timeout=30000`` on the Postgres pool on the theory that the
consume loop was blocking in kernel TCP retransmission on a DB write;
the freeze recurred 3x in the following 10.7h, so that theory is wrong
or incomplete. The loop goes silent with no traceback. So before it
exits, the watchdog dumps every thread's Python stack — to stderr for
the Railway log, and into the Sentry event because Railway's retention
is ~2h and Sentry's is not. The next freeze should name the frame the
consume loop is parked in. See ``_dump_thread_stacks``.

Env knobs (read at ``start_watchdog()`` call time; guarded by
``health._env_int`` — the THETA_INDEX_CONCURRENCY pattern — so a bad
value degrades with a warning instead of raising):

- ``WATCHDOG_STALE_EXIT_S`` — staleness threshold in seconds.
  Default 300, clamped to >= 180 so a typo can't make routine bar
  gaps fatal.
- ``WATCHDOG_BOOT_GRACE_S`` — length of the grace window, in seconds:
  after thread start, and again after each session reopen. Default
  600, clamped to >= 0.
"""

from __future__ import annotations

import faulthandler
import os
import sys
import threading
import time
import traceback
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

# Markers around the thread dump. Deliberately loud and stable: they
# are the grep target in Railway's log stream, where the dump is the
# only plain-text output (logger_setup writes JSON lines to stdout).
THREAD_DUMP_HEADER = "=== WATCHDOG THREAD DUMP (freeze diagnosis) ==="
THREAD_DUMP_FOOTER = "=== END WATCHDOG THREAD DUMP ==="

# Cap on the copy that rides along in the Sentry event. The full dump
# always goes to stderr; this bound keeps one wedged process from
# posting a multi-hundred-KB event (and from writing the same payload
# a second time through capture_message's context log line).
_SENTRY_DUMP_MAX_CHARS = 8000


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
    data_expected: bool,
    is_connected: Callable[[], bool],
    last_bar_at: Callable[[], float],
) -> float | None:
    """Return the bar staleness in seconds when the freeze condition holds.

    Returns None when any gate says "don't restart": still inside the
    grace window (`started_at_monotonic` is the baseline `_run_loop`
    re-arms on session reopen), data not expected (weekend /
    maintenance hour), client not connected, or bars fresh enough.
    `last_bar_at()` of 0.0 (no bar ever received) reads as maximally
    stale on purpose — connected with zero bars for grace + threshold
    during a session IS the wedged case.

    `data_expected` is passed in rather than read here so the caller
    can evaluate the session calendar exactly once per tick: it also
    needs the value to detect the reopen transition.
    """
    if now_monotonic - started_at_monotonic < boot_grace_s:
        return None
    if not data_expected:
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


def _thread_stack_texts() -> tuple[str, str]:
    """Render every live thread's Python stack.

    Returns ``(full_dump, top_frames)``. Both are built from a single
    ``sys._current_frames()`` snapshot so the one-line-per-thread
    summary can never describe a different instant than the full dump.
    """
    names = {t.ident: t.name for t in threading.enumerate() if t.ident is not None}
    frames = sorted(sys._current_frames().items())

    blocks = [THREAD_DUMP_HEADER, f"live threads: {len(frames)}"]
    tops = []
    for ident, frame in frames:
        name = names.get(ident, "unknown")
        stack = traceback.extract_stack(frame)
        blocks.append(f"--- thread {name!r} (id={ident}) - newest frame last ---")
        blocks.append("".join(traceback.format_list(stack)).rstrip())
        if stack:
            innermost = stack[-1]
            tops.append(f"{name}: {innermost.filename}:{innermost.lineno} in {innermost.name}()")
    blocks.append(THREAD_DUMP_FOOTER)
    return "\n".join(blocks), "\n".join(tops)


def _faulthandler_fallback() -> None:
    """Dump via the stdlib C-level dumper when frame formatting failed.

    ``faulthandler`` allocates nothing and needs no Python-level frame
    walking, so it still works when ``_thread_stack_texts`` cannot. Its
    output is unnamed (``Thread 0x00007f...``), which is why it is the
    fallback and not the primary.
    """
    try:
        sys.stderr.write(f"{THREAD_DUMP_HEADER} (faulthandler fallback)\n")
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
        sys.stderr.write(f"{THREAD_DUMP_FOOTER}\n")
        sys.stderr.flush()
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never block the exit
        log.error("Watchdog: faulthandler dump failed: %s", exc)


def _dump_thread_stacks() -> dict[str, str] | None:
    """Dump every thread's stack to stderr; return the Sentry extras.

    Two destinations because they fail differently: stderr is what
    Railway shows immediately (and it is the only unbounded copy), and
    the Sentry extras are what still exist tomorrow — Railway's log
    retention is ~2h.

    ``sys._current_frames()`` + ``traceback`` is the primary route
    rather than plain ``faulthandler.dump_traceback`` because it labels
    each stack with the *thread name*: telling "databento-consume" from
    "stale-data-watchdog" from a ThreadingHTTPServer worker is the
    entire point of the dump, and faulthandler only prints thread ids.
    It is also the only route whose text we can capture for Sentry
    (faulthandler writes to a file descriptor, not a buffer). It needs
    the GIL, which is not a limitation here: if some thread held the
    GIL forever the watchdog thread could not have reached this line.
    ``faulthandler`` remains the fallback for the case where frame
    formatting itself raises.

    Returns None when no dump could be produced. Never raises: the
    caller is on its way to ``os._exit`` and must get there.
    """
    try:
        dump, tops = _thread_stack_texts()
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never block the exit
        log.error("Watchdog: thread dump failed (%s); trying faulthandler", exc)
        _faulthandler_fallback()
        return None

    try:
        # Written and flushed before the Sentry round-trip: stderr is
        # unbuffered-ish and cheap, and this must survive the exit even
        # if everything after it fails.
        sys.stderr.write(f"{dump}\n")
        sys.stderr.flush()
    except Exception as exc:  # noqa: BLE001 — the Sentry copy is still worth returning
        log.error("Watchdog: writing the thread dump to stderr failed: %s", exc)

    if len(dump) > _SENTRY_DUMP_MAX_CHARS:
        dropped = len(dump) - _SENTRY_DUMP_MAX_CHARS
        dump = (
            f"{dump[:_SENTRY_DUMP_MAX_CHARS]}\n"
            f"... [truncated {dropped} chars - the full dump is on stderr]"
        )
    return {"thread_dump": dump, "thread_top_frames": tops}


def _exit_for_restart(staleness_s: float, stale_exit_s: float) -> None:
    """Log, dump every thread, report to Sentry, and hard-exit for restart."""
    log.critical(
        "Watchdog: last bar is %.0fs old (threshold %.0fs) while connected "
        "and data expected — exiting 1 so Railway restarts the container",
        staleness_s,
        stale_exit_s,
    )
    # Belt and braces: `_dump_thread_stacks` already swallows its own
    # failures, but the restart must not depend on the diagnostic layer
    # staying correct. A freeze we can't diagnose is bad; a freeze we
    # don't restart from is worse.
    try:
        dump_extras = _dump_thread_stacks() or {}
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never block the exit
        log.error("Watchdog: thread dump raised, exiting anyway: %s", exc)
        dump_extras = {}
    capture_message(
        "sidecar watchdog: data stale, exiting for restart",
        level="error",
        tags={"component": "watchdog"},
        context={
            "staleness_s": round(staleness_s, 1),
            "threshold_s": stale_exit_s,
            **dump_extras,
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

    Owns the grace baseline: set here at thread start, re-armed on each
    False -> True transition of the session calendar so the staleness
    accumulated across a closed session is never charged to the reopen
    (see "Grace window" in the module docstring).

    No per-tick logging by design — the healthy case must stay silent
    or the watchdog becomes 1,440 log lines a day of noise. The one
    exception is the re-arm, which fires at most once per session (~1
    line a day) and is what makes the 17:00 CT behaviour auditable.
    """
    grace_started_at = time.monotonic()
    # Seeded True so a process that boots mid-session keeps the plain
    # boot grace (baseline = thread start) instead of re-arming a
    # minute later on a transition that never happened. A boot during a
    # closed session flips this False on tick 1 and re-arms at reopen.
    data_expected_prev = True
    while True:
        time.sleep(WATCHDOG_INTERVAL_S)
        try:
            now_monotonic = time.monotonic()
            # Evaluated once per tick — `_staleness_if_frozen` takes the
            # value rather than re-reading the calendar — and evaluated
            # BEFORE the grace check so a reopen during the grace window
            # is still observed.
            data_expected = health._is_data_expected()
            if data_expected and not data_expected_prev:
                grace_started_at = now_monotonic
                log.info(
                    "Watchdog: market data expected again after a closed "
                    "session — re-arming the %.0fs grace window before the "
                    "next staleness check",
                    boot_grace_s,
                )
            data_expected_prev = data_expected
            staleness = _staleness_if_frozen(
                now_monotonic=now_monotonic,
                started_at_monotonic=grace_started_at,
                boot_grace_s=boot_grace_s,
                stale_exit_s=stale_exit_s,
                data_expected=data_expected,
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
        "%.0fs grace (at boot and after each session reopen), "
        "%.0fs check interval",
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
