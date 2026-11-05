"""Entrypoint for the nightly tape job: `python -m main`.

Runs the tape job once under the `nightly-tape` Sentry cron monitor and exits:
- 0 when every planned day landed, re-landed or was correctly marked unavailable;
- 1 when any day failed, was not posted, or was skipped for disk or deadline, and
  when the run failed before its first day;
- 2 on bad config. With a valid SENTRY_DSN, an error check-in and one fixed event
  name the invalid fields; without one, the monitor reports the run as missed;
- 3 from the watchdog, which ends a run still going WATCHDOG_GRACE_SECONDS past its
  deadline, after an error check-in;
- 143 on SIGTERM, raised as SystemExit so each day's cleanup and an error check-in
  still run.

Each day is reported to Sentry as soon as it finishes, so a run killed mid-way loses
at most the day in flight.

Logs follow the service rule: counts, sizes, dates, durations, field names and
exception class names, never exception text, signed URLs or tape values.
"""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import sys
import threading
from collections import Counter
from datetime import UTC, date, datetime
from time import monotonic
from types import FrameType
from typing import NoReturn, get_args

import sentry_sdk
from pydantic import ValidationError
from sentry_sdk.crons import MonitorStatus, capture_checkin

from calendar_nyse import table_expiry_warning
from config import Settings, load_sentry_dsn, load_settings
from constants import RUN_DEADLINE_SECONDS, WATCHDOG_GRACE_SECONDS
from monitoring import init_sentry, report_outcome
from tape_job import DayOutcome, DayStatus, run_tape

log = logging.getLogger(__name__)

MONITOR_SLUG = "nightly-tape"
# The crontab must match the cron schedule set on the Railway `nightly` service (there
# is no railway.toml): changing one means changing both. Margin and runtime are
# minutes; 330 covers the 5 h run deadline plus the watchdog's grace.
MONITOR_CONFIG = {
    "schedule": {"type": "crontab", "value": "15 7 * * 2-6"},
    "timezone": "UTC",
    "checkin_margin": 30,
    "max_runtime": 330,
}
_SUCCESS: frozenset[DayStatus] = frozenset({"landed", "relanded", "unavailable"})


def main() -> int:
    """Run the job once and return the process exit code."""
    try:
        return _main()
    finally:
        # Sends whatever is queued before the container exits, on every path.
        sentry_sdk.flush(10)


def _main() -> int:
    # stdout, not basicConfig's default stderr: Railway labels every stderr line an
    # error, so each INFO line would show red. The level is in the line itself.
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # httpx logs every request line, signed GCS URL included, at INFO.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        settings = load_settings()
    except ValidationError as exc:
        _report_bad_config(exc)
        return 2
    init_sentry(settings.sentry_dsn)
    return _monitored_run(settings)


def _on_sigterm(signum: int, frame: FrameType | None) -> NoReturn:
    """Railway stops a container with SIGTERM. As SystemExit (128 + 15) it unwinds
    through each day's work-dir cleanup and the error check-in."""
    raise SystemExit(143)


def _report_bad_config(exc: ValidationError) -> None:
    """Log the invalid fields, and tell Sentry when SENTRY_DSN alone is usable.

    Never str(exc): it quotes input values, which for a missing field is every other
    setting, secrets included. Only each field's name (and, in the log, its error
    type) leaves the process.
    """
    errors = exc.errors(include_input=False, include_url=False, include_context=False)
    fields = [".".join(map(str, e["loc"])) for e in errors]
    kinds = ", ".join(f"{f} ({e['type']})" for f, e in zip(fields, errors, strict=True))
    log.error("config invalid: %s", kinds)
    dsn = load_sentry_dsn()
    if dsn is None:
        return
    init_sentry(dsn)
    capture_checkin(
        monitor_slug=MONITOR_SLUG, status=MonitorStatus.ERROR, monitor_config=MONITOR_CONFIG
    )
    sentry_sdk.capture_message("nightly config invalid", level="error", extras={"fields": fields})


def _monitored_run(settings: Settings) -> int:
    started = monotonic()
    now_utc = datetime.now(UTC)
    check_in_id = capture_checkin(
        monitor_slug=MONITOR_SLUG,
        status=MonitorStatus.IN_PROGRESS,
        monitor_config=MONITOR_CONFIG,
    )
    watchdog = threading.Timer(
        RUN_DEADLINE_SECONDS + WATCHDOG_GRACE_SECONDS, _expire, (check_in_id, started)
    )
    watchdog.daemon = True
    watchdog.start()
    try:
        try:
            code = _run(settings, now_utc, started)
        finally:
            watchdog.cancel()
    except BaseException:
        # A hard stop (SIGTERM, Ctrl-C) or a bug: say so now rather than leave the
        # monitor to time out. main's flush sends it before the exception goes on.
        _final_checkin(check_in_id, MonitorStatus.ERROR, started)
        raise
    _warn_table_expiry(now_utc.date())
    _final_checkin(check_in_id, MonitorStatus.OK if code == 0 else MonitorStatus.ERROR, started)
    return code


def _final_checkin(check_in_id: str | None, status: str, started: float) -> None:
    capture_checkin(
        monitor_slug=MONITOR_SLUG,
        check_in_id=check_in_id,
        status=status,
        duration=monotonic() - started,
    )


def _expire(check_in_id: str | None, started: float) -> None:
    """Watchdog target: report the hung run as an error, then end the process.

    os._exit, not sys.exit: it ends the process even while the main thread is stuck
    in a read, which is the case the watchdog exists for. Nothing before it may stop
    it, so a failing Sentry call is ignored.
    """
    with contextlib.suppress(BaseException):
        log.error("watchdog: run still going %ds past its deadline", WATCHDOG_GRACE_SECONDS)
        _final_checkin(check_in_id, MonitorStatus.ERROR, started)
        sentry_sdk.flush(5)
    os._exit(3)


def _run(settings: Settings, now_utc: datetime, started: float) -> int:
    try:
        # Each day is reported from the callback as it finishes, never again here.
        outcomes = run_tape(settings, now_utc, on_outcome=report_outcome)
    except Exception as exc:
        # Raised before any day started (see run_tape). The scrubbed event carries
        # the traceback; the log line names the class only.
        sentry_sdk.capture_exception(exc)
        log.error("tape run failed before the first day: %s", type(exc).__name__)
        return 1
    _log_summary(outcomes, monotonic() - started)
    return 0 if all(o.status in _SUCCESS for o in outcomes) else 1


def _log_summary(outcomes: list[DayOutcome], duration: float) -> None:
    counts = Counter(o.status for o in outcomes)
    per_status = " ".join(f"{s}={counts[s]}" for s in get_args(DayStatus) if counts[s])
    log.info(
        "tape run summary: %s; bytes=%d; duration=%.1fs",
        per_status or "no days planned",
        sum(o.bytes or 0 for o in outcomes),
        duration,
    )


def _warn_table_expiry(today: date) -> None:
    text = table_expiry_warning(today)
    if text:
        log.warning("%s", text)
        sentry_sdk.capture_message(text, level="warning")


if __name__ == "__main__":
    sys.exit(main())
