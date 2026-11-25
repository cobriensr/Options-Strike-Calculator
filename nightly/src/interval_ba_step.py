"""The interval-ba-tape step: correct the live Interval B/A rows of each new session from the tape.

Spec: docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, section 6.6. Each night,
for every trading day from INSERT_MISSED_FROM (2026-10-29) through the last session that has no
`interval_ba_tape_days` row, newest first, it runs `interval_ba_replay.heal_day` with the missed
alerts on: the sweep and floor flags and a blank SPXW spot on the live rows are corrected from the
tape, the alerts live missed are added as `source = 'replay'`, stale replay rows are removed, and
the day's row in `interval_ba_tape_days` records the counts. heal_day does all of that in one
transaction, so a day either commits with its marker or leaves nothing and is retried.

The work list:
- A day the tape job put in R2 tonight (`landed` or `relanded`) has its marker deleted first, on
  the setup connection, so it is redone on the new tape (a deleted object lands again as
  `landed`; a first land has no marker, so for it the delete changes nothing). Days before
  INSERT_MISSED_FROM are never cleared: the step never works them, so the delete would only lose
  the record the one-off tool wrote. If the delete does not run that night (the step is skipped,
  or raises before it, or the run is killed after the land) the next night's tape job no longer
  reports the day, and its marker stays until someone deletes it.
- A day with no tape in R2 yet waits (`days_waiting_tape`). That is not an alert.
- A day whose inserts were held (heal_day's `inserts_held`) keeps the marker heal_day wrote: a
  retry would hold again. Its health alert asks the owner to fix the settings or change the
  constants; deleting the marker then redoes the day.

Each day downloads its tape first (the Neon connection must not idle through a download, which is
held to FETCH_DEADLINE_SECONDS or the step's deadline if nearer), then opens a fresh DuckDB
connection with the step's limits and a fresh Neon connection, reads the live settings that
cover the day on it, and runs heal_day on the downloaded file. Both connections close before the
tape is released.

Failures: an Exception in a day (its download, a tape R2 no longer has, either connection, the
settings read, heal_day, including replay_day's ValueError for a tape with no 0DTE rows, which is
a broken tape and never a day with no alerts) is counted in `days_failed`, sent once through
`capture_exception` tagged with the step and the day (`monitoring.scrub_event` cuts a data
library's text), and the loop goes on. It stops, leaving the rest as `days_left`, after
INTERVAL_BA_MAX_DAY_FAILURES failed days or with less than INTERVAL_BA_DAY_BUDGET_SECONDS left.
Only the setup is not a day's: a failure of its connection, the marker delete or read, the reader
or the tape listing propagates to `run_steps`.

Health alerts: the StepResult carries one detail, which a failed day or days left would hide, so
after each day commits `_report_health` sends at most one Sentry message for that day (level
error, fingerprint `interval-ba-live-health`, the phrase and the day), whatever the step ends as.
The fingerprint names the day, so each day opens, and mails as, its own issue.

Status: `failed` if a day failed, else `partial` if days are left, else `ok`; the details are
fixed phrases (they are part of the Sentry fingerprint). A health alert does not change it.

Logs carry one line per day: the date, a status word (`failed (<ExceptionClass>)`, else the
health phrase, else `ok`), the day's non-zero counts and the seconds. Never an exception's text
(it can carry the Neon host) or row data.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date
from time import monotonic
from typing import TYPE_CHECKING

import duckdb
import sentry_sdk
from _tape_reader import FETCH_DEADLINE_SECONDS

from calendar_nyse import trading_days
from constants import (
    INTERVAL_BA_CACHE_DIR,
    INTERVAL_BA_DAY_BUDGET_SECONDS,
    INTERVAL_BA_DUCKDB_MEMORY,
    INTERVAL_BA_DUCKDB_THREADS,
    INTERVAL_BA_MAX_DAY_FAILURES,
)
from interval_ba_replay import INSERT_MISSED_FROM, DayPlan, heal_day, read_covering_settings
from resources import connect_db, open_reader
from steps import StepContext, StepResult

if TYPE_CHECKING:
    from _tape_reader import TapeReader
    from psycopg2.extensions import connection

log = logging.getLogger(__name__)

# The `step` tag on a day's exception and health message: the name pipeline.STEPS registers.
_STEP = "interval-ba-tape"
# Fixed phrases: they are part of the `nightly step failed` / `partial` fingerprint.
_FAILED_DETAIL = "a day failed"
_PARTIAL_DETAIL = "days left for the next night"
# A day `landed_days` listed whose object R2 no longer has. Fixed, so no key, path or date
# reaches Sentry.
_MISSING_TAPE = "landed tape missing from R2"
# The tape job's statuses for a day it put in R2 tonight.
_LANDED_STATUSES = frozenset({"landed", "relanded"})

# What one day adds to the night's counts, and then every count the step reports.
_DAY_COUNT_NAMES = ("inserted", "flags_changed", "spot_filled", "root_label_mismatch")
_COUNT_NAMES = (
    "days_done",
    "days_failed",
    "days_left",
    "days_waiting_tape",
    *_DAY_COUNT_NAMES,
    "health_alerts",
)
# A day's DayPlan counts: in its health message's `interval_ba_day` context and its log line.
_PLAN_COUNT_NAMES = (
    "tape_alerts",
    "live_rows",
    "live_missed",
    "live_only",
    "matched",
    "value_mismatched",
    "inserted",
    "removed",
    "acknowledged_kept",
    "flags_changed",
    "flags_unmatched",
    "spot_filled",
    "root_label_mismatch",
)

_CLEAR_MARKERS_SQL = "DELETE FROM interval_ba_tape_days WHERE day = ANY(%(days)s::date[])"
_MARKED_DAYS_SQL = "SELECT day FROM interval_ba_tape_days WHERE day >= %(first)s"


def clear_markers(conn: connection, days: Sequence[date]) -> int:
    """Delete the `interval_ba_tape_days` rows of `days`, so they are worked again; the rows
    deleted. One statement on the autocommit connection."""
    if not days:
        return 0
    with conn.cursor() as cursor:
        # A list, never a tuple: psycopg2 adapts a tuple as a row, which `::date[]` rejects.
        cursor.execute(_CLEAR_MARKERS_SQL, {"days": list(days)})
        return cursor.rowcount


def marked_days(conn: connection) -> set[date]:
    """The days from INSERT_MISSED_FROM on that have an `interval_ba_tape_days` row."""
    with conn.cursor() as cursor:
        cursor.execute(_MARKED_DAYS_SQL, {"first": INSERT_MISSED_FROM})
        return {day for (day,) in cursor.fetchall()}


def run(ctx: StepContext) -> StepResult:
    counts = dict.fromkeys(_COUNT_NAMES, 0)
    landed = [
        outcome.day
        for outcome in ctx.tape
        if outcome.status in _LANDED_STATUSES and outcome.day >= INSERT_MISSED_FROM
    ]
    # One short connection for the setup; each day opens its own after its download.
    with connect_db(ctx.settings) as conn:
        cleared = clear_markers(conn, landed)
        done = marked_days(conn)
    if cleared:
        log.info("interval-ba %d day markers cleared for tonight's tapes", cleared)
    days = [
        day
        for day in reversed(trading_days(INSERT_MISSED_FROM, ctx.last_session))
        if day not in done
    ]
    if days:
        _heal_days(ctx, days, counts)
    return _result(counts)


def _heal_days(ctx: StepContext, days: Sequence[date], counts: dict[str, int]) -> None:
    """Heal `days` (newest first) until the budget, the failure cap or the work runs out."""
    with open_reader(ctx.settings, INTERVAL_BA_CACHE_DIR) as reader:
        landed = reader.landed_days()
        for position, day in enumerate(days):
            if _must_stop(ctx, counts):
                counts["days_left"] = len(days) - position
                return
            if day not in landed:
                counts["days_waiting_tape"] += 1
                log.info("interval-ba %s waiting for the tape", day.isoformat())
                continue
            _heal_one(ctx, reader, day, counts)


def _must_stop(ctx: StepContext, counts: dict[str, int]) -> bool:
    """Less than a day's budget left, or the failure cap reached."""
    return (
        ctx.seconds_left() < INTERVAL_BA_DAY_BUDGET_SECONDS
        or counts["days_failed"] >= INTERVAL_BA_MAX_DAY_FAILURES
    )


def _heal_one(ctx: StepContext, reader: TapeReader, day: date, counts: dict[str, int]) -> None:
    """One landed day: healed and judged, or failed and sent once; its tape released either way."""
    iso = day.isoformat()
    started = monotonic()
    plan: DayPlan | None = None
    error: str | None = None
    try:
        plan = _heal(ctx, reader, day)
    except Exception as exc:
        # The event is scrubbed in before_send; the log and the counts keep the class only.
        error = type(exc).__name__
        sentry_sdk.capture_exception(exc, tags={"step": _STEP, "day": iso})
    else:
        counts["health_alerts"] += int(_report_health(day, plan))
    finally:
        reader.release(day)
    if plan is None:
        counts["days_failed"] += 1
    else:
        counts["days_done"] += 1
        for name in _DAY_COUNT_NAMES:
            counts[name] += getattr(plan, name)
    _log_day(iso, plan, error, monotonic() - started)


def _heal(ctx: StepContext, reader: TapeReader, day: date) -> DayPlan:
    # The download comes first: neither connection may idle through it.
    path = reader.fetch_day(day, deadline=_fetch_deadline(ctx))
    if path is None:
        raise RuntimeError(_MISSING_TAPE)
    with _duckdb_connection() as con, connect_db(ctx.settings) as conn:
        # Autocommit, so the read leaves the connection idle, as heal_day needs it.
        settings = read_covering_settings(conn, day)
        return heal_day(conn, con, str(path), day, settings, insert_missed=True, apply=True)


def _duckdb_connection() -> duckdb.DuckDBPyConnection:
    """A fresh in-memory DuckDB connection with the step's memory limit, threads and spill
    directory. heal_day sets no limits of its own.

    DuckDB creates only the last level of its spill directory, and removes it on close, so the
    spill sits directly in the cache directory, which open_reader creates before any day runs
    (and empties at the next run's start, whatever a killed run left there).
    """
    return duckdb.connect(
        config={
            "memory_limit": INTERVAL_BA_DUCKDB_MEMORY,
            "threads": INTERVAL_BA_DUCKDB_THREADS,
            "temp_directory": str(INTERVAL_BA_CACHE_DIR / "duckdb-tmp"),
        }
    )


def _fetch_deadline(ctx: StepContext) -> float:
    """The deadline for one download: FETCH_DEADLINE_SECONDS from now, or the step's if sooner.

    INTERVAL_BA_DAY_BUDGET_SECONDS assumes a download of at most that long; without the bound a
    slow one could spend everything up to the step's deadline. "Now" is read off
    `ctx.seconds_left()`, the clock the step's own deadline is on.
    """
    now = ctx.deadline - ctx.seconds_left()
    return min(ctx.deadline, now + FETCH_DEADLINE_SECONDS)


def _health_phrase(plan: DayPlan) -> str | None:
    """What is wrong with live on the plan's day, the first that applies, or None.

    The counts are over the tickers live had on (heal_day). The thresholds are spec 6.6's: live
    missed 2 keys in 13 sessions from 2026-10-29, and 34 of 108 on 2026-05-20.
    """
    if plan.inserts_held is not None:
        return plan.inserts_held
    if plan.tape_alerts == 0 and plan.live_rows > 0:
        return "tape fired no alerts"  # the replay or the tape read broke
    if plan.tape_alerts > 0 and plan.live_rows == 0:
        return "live wrote no alerts"
    # At least 5, and more than 10% of the tape's alerts.
    if plan.live_missed >= 5 and plan.live_missed * 10 > plan.tape_alerts:
        return "live missed alerts"
    # A rule change the settings record does not show: more than 5% of at least 20 matched keys
    # differ, or at least 5 live rows, more than 10% of them, have no tape alert.
    if (plan.matched >= 20 and plan.value_mismatched * 20 > plan.matched) or (
        plan.live_only >= 5 and plan.live_only * 10 > plan.live_rows
    ):
        return "live and tape rows disagree"
    return None


def _report_health(day: date, plan: DayPlan) -> bool:
    """Send at most one Sentry message for `day`'s live health; whether one was sent.

    The fingerprint names the day, as report_outcome does for a re-land, so each day opens its
    own issue, which the nightly new-issue rule (events tagged service=nightly) mails. The day's
    counts, and nothing else, go in the `interval_ba_day` context, not in extras: the SDK trims
    `extra` to its first 10 keys (MAX_DATABAG_BREADTH), which would drop 3 of the 13, and it does
    not trim a context.
    """
    phrase = _health_phrase(plan)
    if phrase is None:
        return False
    iso = day.isoformat()
    sentry_sdk.capture_message(
        f"nightly interval-ba live health: {phrase}",
        level="error",
        tags={"service": "nightly", "step": _STEP, "day": iso},
        contexts={"interval_ba_day": {name: getattr(plan, name) for name in _PLAN_COUNT_NAMES}},
        fingerprint=["interval-ba-live-health", phrase, iso],
    )
    return True


def _log_day(iso: str, plan: DayPlan | None, error: str | None, seconds: float) -> None:
    phrase = None if plan is None else _health_phrase(plan)
    if error is not None:
        status = f"failed ({error})"
    elif phrase is not None:
        status = phrase
    else:
        status = "ok"
    shown = (
        ""
        if plan is None
        else "".join(
            f" {name}={getattr(plan, name)}" for name in _PLAN_COUNT_NAMES if getattr(plan, name)
        )
    )
    level = logging.INFO if status == "ok" else logging.WARNING
    log.log(level, "interval-ba %s %s%s in %.1fs", iso, status, shown, seconds)


def _result(counts: dict[str, int]) -> StepResult:
    if counts["days_failed"]:
        return StepResult("failed", counts, _FAILED_DETAIL)
    if counts["days_left"]:
        return StepResult("partial", counts, _PARTIAL_DETAIL)
    return StepResult("ok", counts)
