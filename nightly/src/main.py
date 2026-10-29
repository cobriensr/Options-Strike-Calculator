"""Entrypoint for the nightly tape job: `python -m main`.

Runs the tape job once under the `nightly-tape` Sentry cron monitor and exits:
- 0 when every planned day landed, re-landed or was correctly marked unavailable;
- 1 when any day failed, was not posted, or was skipped for disk or deadline, and
  when the run failed before its first day;
- 2 on bad config, before Sentry starts. With no check-in, the monitor reports the
  run as missed;
- 3 from the watchdog, which kills a run still going 15 minutes past its deadline.
  The monitor's max_runtime then reports the missing final check-in.

Logs follow the service rule: counts, sizes, dates, durations, field names and
exception class names, never exception text, signed URLs or tape values.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from collections import Counter
from datetime import UTC, date, datetime
from time import monotonic
from typing import get_args

import sentry_sdk
from pydantic import ValidationError
from sentry_sdk.crons import MonitorStatus, capture_checkin

from calendar_nyse import table_expiry_warning
from config import Settings, load_settings
from constants import RUN_DEADLINE_SECONDS
from monitoring import init_sentry, report_outcome
from tape_job import DayOutcome, DayStatus, run_tape

log = logging.getLogger(__name__)

MONITOR_SLUG = "nightly-tape"
# Matches railway.toml's cronSchedule. Margin and runtime are minutes; 330 covers the
# 5 h run deadline plus the watchdog's 15 minutes.
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
        # Sends whatever is queued before the container exits.
        sentry_sdk.flush(10)


def _main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # httpx logs every request line, signed GCS URL included, at INFO.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    try:
        settings = load_settings()
    except ValidationError as exc:
        log.error("config invalid: %s", _invalid_fields(exc))
        return 2
    init_sentry(settings.sentry_dsn)
    return _monitored_run(settings)


def _monitored_run(settings: Settings) -> int:
    started = monotonic()
    now_utc = datetime.now(UTC)
    check_in_id = capture_checkin(
        monitor_slug=MONITOR_SLUG,
        status=MonitorStatus.IN_PROGRESS,
        monitor_config=MONITOR_CONFIG,
    )
    # os._exit, not sys.exit: it ends the process even while the main thread is stuck
    # in a read, which is the case the watchdog exists for.
    watchdog = threading.Timer(RUN_DEADLINE_SECONDS + 900, os._exit, (3,))
    watchdog.daemon = True
    watchdog.start()
    try:
        code = _run(settings, now_utc, started)
    finally:
        watchdog.cancel()
    _warn_table_expiry(now_utc.date())
    capture_checkin(
        monitor_slug=MONITOR_SLUG,
        check_in_id=check_in_id,
        status=MonitorStatus.OK if code == 0 else MonitorStatus.ERROR,
        duration=monotonic() - started,
    )
    return code


def _run(settings: Settings, now_utc: datetime, started: float) -> int:
    try:
        outcomes = run_tape(settings, now_utc)
    except Exception as exc:
        # Raised before any day started (see run_tape). The scrubbed event carries
        # the traceback; the log line names the class only.
        sentry_sdk.capture_exception(exc)
        log.error("tape run failed before the first day: %s", type(exc).__name__)
        return 1
    for outcome in outcomes:
        report_outcome(outcome)
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


def _invalid_fields(exc: ValidationError) -> str:
    """Each invalid field and its error type. Never str(exc): it quotes input values,
    which for a missing field is every other setting, secrets included."""
    errors = exc.errors(include_input=False, include_url=False, include_context=False)
    return ", ".join(f"{'.'.join(map(str, e['loc']))} ({e['type']})" for e in errors)


if __name__ == "__main__":
    sys.exit(main())
