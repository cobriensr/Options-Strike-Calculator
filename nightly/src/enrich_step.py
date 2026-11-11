"""The enrichment step: fill Lottery Finder and Silent Boom outcomes from the tape lake.

Each night, after the tape job, it works every day that has outcome work in either table,
newest first, back to TAPE_START. The work is the shared enrich scripts' `select="all"`
set for the Full Tape: every fire the tape has not examined at the current OUTCOME_VERSION.
That makes it both the backstop for a day the closing crons missed and the backfill of the
history, drained over the nights until no day has work left.

Order matters in two places:
- Both scripts are configured for the tape before the work days are listed, because
  `list_work_dates` reads the module's SOURCE_TAG when it runs.
- A day the tape job re-landed tonight has its `outcome_tape_version` marker cleared first
  (both tables in one statement, so both clear or neither does), because its rows carry the
  marker of the tape it replaced and the work set would never look at them again. Only the
  marker is cleared, so the old outcomes stay until the new tape replaces them. Inversions
  are not reset: their work set needs the value to be NULL, and clearing values is
  destructive. If the statement fails nothing is cleared and the step fails; the next night
  the tape job no longer reports the day as re-landed, so its rows keep the old tape's
  outcomes until OUTCOME_VERSION is next bumped.

A day with no landed tape waits (`days_waiting_tape`). For a landed one the step fetches the
tape (before opening a connection, so Neon never idles through a download; the download is
bounded at FETCH_DEADLINE_SECONDS, or by the step's deadline if that is nearer), runs both
passes on one fresh connection, and counts the (table, day) pairs whose fires all came back
without an outcome (`null_days`) or mostly so (`low_days`, a count only). Pass 3, the ticker
refit, never runs: the ticker EMA is retired.

Failures: an Exception in a day (its download, its own connection, either pass, the shares
query) is counted in `days_failed`, sent once through `capture_exception` tagged with the
step and the day (`monitoring.scrub_event` cuts a data library's text), and the loop goes
on. The loop stops, leaving the rest as `days_left`, when `days_failed + null_days` reaches
ENRICH_MAX_DAY_FAILURES: a broken tape layout or chain format makes every day fail or come
back all-NULL, and each would cost a download. A landed day whose file the scripts cannot
find is the same case, so it fails the day. It also stops when less than
ENRICH_DAY_BUDGET_SECONDS is left. Only the setup is not a day's: a failure of its
connection, the marker UPDATE, the listing of the days or the listing of the tape
propagates to `run_steps`.

The step sends no share alert. The outcome check reports the last three sessions, so the
latest session would be reported twice, and a long backfill would send an email a day.

Status: `failed` if a day failed or came back all-NULL, else `partial` if days are left,
else `ok`; the details are fixed phrases (they are part of the Sentry fingerprint).

Logs carry one line per day: the date, a status word (`ok`, `no outcomes` for a day with an
all-NULL pair, or `failed (<ExceptionClass>)`), the day's non-zero counts and the seconds.
Never an exception's text (it can carry the Neon host) or row data.

Import order: the lottery script before the silent boom one. The silent boom script puts
<repo>/ml/src first on sys.path, which holds an older enrich_lottery_outcomes.py.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date
from time import monotonic
from typing import TYPE_CHECKING

import sentry_sdk
from _tape_reader import FETCH_DEADLINE_SECONDS
from enrich_lottery_outcomes import configure_archive as configure_lottery_archive
from enrich_lottery_outcomes import enrich_one_date as enrich_lottery_day
from enrich_lottery_outcomes import list_work_dates as list_lottery_work_dates
from enrich_silent_boom_outcomes import configure_archive as configure_silent_boom_archive
from enrich_silent_boom_outcomes import enrich_one_date as enrich_silent_boom_day
from enrich_silent_boom_outcomes import list_work_dates as list_silent_boom_work_dates

from constants import (
    ENRICH_CACHE_DIR,
    ENRICH_DAY_BUDGET_SECONDS,
    ENRICH_MAX_DAY_FAILURES,
    TAPE_START,
)
from outcome_check import OUTCOME_TABLES, classify_share, outcome_shares
from resources import connect_db, open_reader
from steps import StepContext, StepResult

if TYPE_CHECKING:
    from _tape_reader import TapeReader
    from enrich_lottery_outcomes import DayResult as LotteryDayResult
    from enrich_silent_boom_outcomes import DayResult as SilentBoomDayResult
    from psycopg2.extensions import connection

log = logging.getLogger(__name__)

# The `step` tag on a day's exception: the name pipeline.STEPS registers this step under.
_STEP = "enrich-outcomes"
# Fixed phrases: they are part of the `nightly step failed` / `partial` fingerprint.
_FAILED_DETAIL = "a day failed or came back with no outcomes"
_PARTIAL_DETAIL = "days left for the next night"
# A landed day whose file the scripts did not find: the cache layout and the scripts'
# file pattern disagree, or the object vanished. Fixed, so no path or date reaches Sentry.
_MISSING_FILE = "landed tape missing from the enrich cache"

# (DayResult field, step count), per script. The two scripts name their fields differently.
_LOTTERY_COUNTS = (
    ("outcomes_written", "lottery_outcomes_written"),
    ("stamped_no_outcome", "lottery_stamped_no_outcome"),
    ("flow_written", "lottery_inversion_written"),
    ("flow_stamped_undefined", "lottery_inversion_stamped"),
    ("flow_input_missing", "lottery_inversion_input_missing"),
    ("outcomes_replaced", "lottery_outcomes_replaced"),
    ("outcomes_kept", "lottery_outcomes_kept"),
)
_SILENT_BOOM_COUNTS = (
    ("outcomes_written", "silent_boom_outcomes_written"),
    ("stamped_no_outcome", "silent_boom_stamped_no_outcome"),
    ("alerts_replaced", "silent_boom_outcomes_replaced"),
    ("alerts_kept", "silent_boom_outcomes_kept"),
)
# What one day adds to the night's counts, and then every count the step reports.
_DAY_COUNT_NAMES = (
    "null_days",
    "low_days",
    *(name for _, name in _LOTTERY_COUNTS),
    *(name for _, name in _SILENT_BOOM_COUNTS),
)
_COUNT_NAMES = (
    "days_processed",
    "days_waiting_tape",
    "days_left",
    "days_failed",
    "tape_markers_reset",
    *_DAY_COUNT_NAMES,
)

# One statement for every table, so the clearing is atomic on an autocommit connection: a
# data-modifying CTE per table, each a full UPDATE whatever the final SELECT reads, and
# `%(days)s` (one date[]) in each branch. The table names come only from OUTCOME_TABLES,
# never from input.
_RESET_MARKERS_SQL = (
    "WITH "
    + ", ".join(
        f"t{n} AS (UPDATE {table} SET outcome_tape_version = NULL "
        "WHERE date = ANY(%(days)s::date[]) AND outcome_tape_version IS NOT NULL RETURNING 1)"
        for n, table in enumerate(OUTCOME_TABLES)
    )
    + " SELECT "
    + " + ".join(f"(SELECT count(*) FROM t{n})" for n in range(len(OUTCOME_TABLES)))
)


def reset_tape_markers(conn: connection, days: Sequence[date]) -> int:
    """Clear `outcome_tape_version` on the fires of `days` in both tables; the rows cleared.

    One statement, so both tables clear or neither does. Every row it clears is work again
    for the tape's guard, and stays work until a pass examines it.
    """
    if not days:
        return 0
    with conn.cursor() as cursor:
        # A list, never a tuple: psycopg2 adapts a tuple as a row, which `ANY(...::date[])` rejects.
        cursor.execute(_RESET_MARKERS_SQL, {"days": list(days)})
        (cleared,) = cursor.fetchone()
    return cleared


def work_days(conn: connection, through: date) -> list[date]:
    """The days from TAPE_START through `through` with tape outcome work in either table.

    Newest first, each day once. Run after `configure_archive(…, "fulltape")` on both
    scripts: `list_work_dates` reads their SOURCE_TAG at call time.
    """
    since, until = TAPE_START.isoformat(), through.isoformat()
    found = set(list_lottery_work_dates(conn, "all", since, until))
    found.update(list_silent_boom_work_dates(conn, "all", since, until))
    return sorted((date.fromisoformat(day) for day in found), reverse=True)


def run(ctx: StepContext) -> StepResult:
    counts = dict.fromkeys(_COUNT_NAMES, 0)
    for configure in (configure_lottery_archive, configure_silent_boom_archive):
        configure(ENRICH_CACHE_DIR, "fulltape")
    relanded = [outcome.day for outcome in ctx.tape if outcome.status == "relanded"]
    # One short connection for the setup; each day opens its own after its download.
    with connect_db(ctx.settings) as conn:
        counts["tape_markers_reset"] = reset_tape_markers(conn, relanded)
        days = work_days(conn, ctx.last_session)
    if days:
        _enrich_days(ctx, days, counts)
    return _result(counts)


def _enrich_days(ctx: StepContext, days: Sequence[date], counts: dict[str, int]) -> None:
    """Work `days` (newest first) until the budget, the failure cap or the work runs out."""
    with open_reader(ctx.settings, ENRICH_CACHE_DIR) as reader:
        landed = reader.landed_days()
        for position, day in enumerate(days):
            if _must_stop(ctx, counts):
                counts["days_left"] = len(days) - position
                return
            if day not in landed:
                counts["days_waiting_tape"] += 1
                log.info("enrich %s waiting for the tape", day.isoformat())
                continue
            _enrich_day(ctx, reader, day, counts)


def _must_stop(ctx: StepContext, counts: dict[str, int]) -> bool:
    """Less than a day's budget left, or the failure cap reached (failed and all-NULL days)."""
    return (
        ctx.seconds_left() < ENRICH_DAY_BUDGET_SECONDS
        or counts["days_failed"] + counts["null_days"] >= ENRICH_MAX_DAY_FAILURES
    )


def _enrich_day(ctx: StepContext, reader: TapeReader, day: date, counts: dict[str, int]) -> None:
    """One landed day: its counts join `counts` whether it finished or raised.

    The writes made before a raise are in the database, so they count.
    """
    iso = day.isoformat()
    started = monotonic()
    tally = dict.fromkeys(_DAY_COUNT_NAMES, 0)
    error: str | None = None
    try:
        _write_day(ctx, reader, day, tally)
    except Exception as exc:
        # The event is scrubbed in before_send; the log and the counts keep the class only.
        error = type(exc).__name__
        sentry_sdk.capture_exception(exc, tags={"step": _STEP, "day": iso})
    finally:
        reader.release(day)
    counts["days_failed" if error else "days_processed"] += 1
    for name, n in tally.items():
        counts[name] += n
    _log_day(iso, tally, error, monotonic() - started)


def _write_day(ctx: StepContext, reader: TapeReader, day: date, tally: dict[str, int]) -> None:
    iso = day.isoformat()
    # The download comes first: the connection must not idle through it.
    if reader.fetch_day(day, deadline=_fetch_deadline(ctx)) is None:
        raise RuntimeError(_MISSING_FILE)
    with connect_db(ctx.settings) as conn:
        lottery = enrich_lottery_day(conn, iso, select="all")
        _add_counts(tally, lottery, _LOTTERY_COUNTS)
        _require_file(lottery)
        silent_boom = enrich_silent_boom_day(conn, iso, select="all")
        _add_counts(tally, silent_boom, _SILENT_BOOM_COUNTS)
        _require_file(silent_boom)
        for share in outcome_shares(conn, [day]):
            kind = classify_share(share)
            if kind == "null":
                tally["null_days"] += 1
            elif kind == "low":
                tally["low_days"] += 1


def _fetch_deadline(ctx: StepContext) -> float:
    """The deadline for one download: FETCH_DEADLINE_SECONDS from now, or the step's if sooner.

    ENRICH_DAY_BUDGET_SECONDS assumes a download of at most that long; without the bound a
    slow one could spend everything up to the step's deadline. "Now" is read off
    `ctx.seconds_left()`, the clock the step's own deadline is on.
    """
    now = ctx.deadline - ctx.seconds_left()
    return min(ctx.deadline, now + FETCH_DEADLINE_SECONDS)


def _add_counts(
    tally: dict[str, int],
    result: LotteryDayResult | SilentBoomDayResult,
    fields: Sequence[tuple[str, str]],
) -> None:
    for field_name, count_name in fields:
        tally[count_name] += getattr(result, field_name)


def _require_file(result: LotteryDayResult | SilentBoomDayResult) -> None:
    if result.archive_missing:
        raise RuntimeError(_MISSING_FILE)


def _log_day(iso: str, tally: dict[str, int], error: str | None, seconds: float) -> None:
    if error is not None:
        status = f"failed ({error})"
    elif tally["null_days"]:
        status = "no outcomes"  # not "ok": this day fails the step
    else:
        status = "ok"
    shown = "".join(f" {name}={n}" for name, n in tally.items() if n)
    level = logging.WARNING if error or tally["null_days"] else logging.INFO
    log.log(level, "enrich %s %s%s in %.1fs", iso, status, shown, seconds)


def _result(counts: dict[str, int]) -> StepResult:
    if counts["days_failed"] or counts["null_days"]:
        return StepResult("failed", counts, _FAILED_DETAIL)
    if counts["days_left"]:
        return StepResult("partial", counts, _PARTIAL_DETAIL)
    return StepResult("ok", counts)
