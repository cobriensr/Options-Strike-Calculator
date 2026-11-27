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
- A day before FIRST_SETTINGS_DAY (2026-11-25) has no `interval_ba_live_settings` row: the first
  one was written at uw-stream's start that evening. Live ran the code's rule on those days (that
  is why INSERT_MISSED_FROM is 2026-10-29), so a day there with no covering row is healed on
  `default_settings()`, the same assumption the one-off tool's `--assume-default-settings` makes
  for the days it healed. Held, it would send a false "no live settings record" alert whenever
  the tape job re-lands one of them. From FIRST_SETTINGS_DAY on, no covering row is real (the
  table lost its rows) and the inserts are held.

Each day downloads its tape first (the Neon connection must not idle through a download, which is
held to FETCH_DEADLINE_SECONDS or the step's deadline if nearer), then opens a fresh DuckDB
connection with the step's limits, and in this order:

1. replays the day once (`replay_day`);
2. writes the replay as the day's file in the research store, `research/interval-ba/replay/
   {day}.parquet`, and checks it (`ResearchStore.put_file`; spec
   docs/superpowers/specs/2026-11-26-interval-ba-replay-days-design.md). The file is what the
   code's rule fires, for all three tickers, whatever live ran that day: the settings that can
   hold the day's inserts do not apply to it. A day with no alerts still gets a file, of zero
   rows. A re-landed day writes its key again;
3. opens a fresh Neon connection, reads the live settings that cover the day on it, and runs
   heal_day on the downloaded file with that same replay (`replay=`), so the file and the heal
   agree and the day is not replayed twice.

Both connections close before the tape is released.

The file goes before the heal because heal_day's commit writes the day's marker, and the marker
is what stops the step working the day again. A put that fails therefore leaves no marker, and
the day is retried the next night, which rewrites the file; a heal_day that fails after a good
put is retried the same way. The cost, accepted: a put that fails every night (a key bug, a
token without write rights) also holds back that day's heal and its live-health alert, and the
exception sent for the day is the only sign. The local Parquet sits in INTERVAL_BA_CACHE_DIR and
is removed after the put, whether it worked or not.

Failures: an Exception in a day (its download, a tape R2 no longer has, either connection, the
replay, the day file's write, the settings read, heal_day, including replay_day's ValueError for
a tape with no 0DTE rows, which is a broken tape and never a day with no alerts) is counted in
`days_failed`, sent once through `capture_exception` tagged with the step and the day
(`monitoring.scrub_event` cuts a data library's text), and the loop goes on. It stops, leaving
the rest as `days_left`, after INTERVAL_BA_MAX_DAY_FAILURES failed days or with less than
INTERVAL_BA_DAY_BUDGET_SECONDS left. Only the setup is not a day's: a failure of its connection,
the marker delete or read, the reader, the research store or the tape listing propagates to
`run_steps`.

Health alerts: the StepResult carries one detail, which a failed day or days left would hide, so
after each day commits `_report_health` sends at most one Sentry message for that day (level
error, fingerprint `interval-ba-live-health`, the phrase and the day), whatever the step ends as.
The fingerprint names the day, so each day opens, and mails as, its own issue.

Status: `failed` if a day failed, else `partial` if days are left, else `ok`; the details are
fixed phrases (they are part of the Sentry fingerprint). A health alert does not change it.

Logs carry one line per day: the date, a status word (`failed (<ExceptionClass>)`, else the
health phrase, else `ok`), the day's non-zero counts and the seconds. A day whose file write
failed has one more line before it, naming the class. Never an exception's text (it can carry the
Neon host or the R2 endpoint) or row data.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date
from time import monotonic
from typing import TYPE_CHECKING

import duckdb
import pyarrow.parquet as pq
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
from interval_ba_replay import (
    INSERT_MISSED_FROM,
    DayPlan,
    day_key,
    default_settings,
    export_table,
    heal_day,
    read_covering_settings,
    replay_day,
    rule,
)
from research_store import ResearchStore
from resources import connect_db, open_reader
from steps import StepContext, StepResult

if TYPE_CHECKING:
    from _tape_reader import TapeReader
    from psycopg2.extensions import connection

    from interval_ba_replay import LiveSettings, Replay

log = logging.getLogger(__name__)

# The first session an `interval_ba_live_settings` row covers: uw-stream wrote its first row at
# 2026-11-25 21:36Z, before the 16:00 CT cut that day, so the row is the day's. A day before it
# with no covering row is not a lost table but the days live ran the code's rule without a
# record, and the step heals it on default_settings().
FIRST_SETTINGS_DAY = date(2026, 11, 25)

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
    "replay_days_written",  # day files put and verified; a day whose heal then failed counts
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
        store = ResearchStore(ctx.settings)
        landed = reader.landed_days()
        for position, day in enumerate(days):
            if _must_stop(ctx, counts):
                counts["days_left"] = len(days) - position
                return
            if day not in landed:
                counts["days_waiting_tape"] += 1
                log.info("interval-ba %s waiting for the tape", day.isoformat())
                continue
            _heal_one(ctx, reader, store, day, counts)


def _must_stop(ctx: StepContext, counts: dict[str, int]) -> bool:
    """Less than a day's budget left, or the failure cap reached."""
    return (
        ctx.seconds_left() < INTERVAL_BA_DAY_BUDGET_SECONDS
        or counts["days_failed"] >= INTERVAL_BA_MAX_DAY_FAILURES
    )


def _heal_one(
    ctx: StepContext, reader: TapeReader, store: ResearchStore, day: date, counts: dict[str, int]
) -> None:
    """One landed day: healed and judged, or failed and sent once; its tape released either way."""
    iso = day.isoformat()
    started = monotonic()
    plan: DayPlan | None = None
    error: str | None = None
    try:
        plan = _heal(ctx, reader, store, day, counts)
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


def _heal(
    ctx: StepContext, reader: TapeReader, store: ResearchStore, day: date, counts: dict[str, int]
) -> DayPlan:
    # The download comes first: no connection may idle through it.
    path = reader.fetch_day(day, deadline=_fetch_deadline(ctx))
    if path is None:
        raise RuntimeError(_MISSING_TAPE)
    with _duckdb_connection() as con:
        replay = replay_day(con, str(path), day)
        # The file goes before heal_day commits the day's marker, and before Neon is opened, so
        # that connection does not idle through the put either.
        _put_day_file(ctx, store, replay)
        counts["replay_days_written"] += 1
        with connect_db(ctx.settings) as conn:
            # Autocommit, so the read leaves the connection idle, as heal_day needs it.
            settings = _covering_settings(conn, day)
            return heal_day(
                conn, con, str(path), day, settings, insert_missed=True, apply=True, replay=replay
            )


def _covering_settings(conn: connection, day: date) -> list[LiveSettings]:
    """The live settings that cover `day`; the code's defaults for a day before the first row
    that no row covers (FIRST_SETTINGS_DAY). `conn` is autocommit, so the read leaves it idle."""
    covering = read_covering_settings(conn, day)
    if not covering and day < FIRST_SETTINGS_DAY:
        return [default_settings()]
    return covering


def _put_day_file(ctx: StepContext, store: ResearchStore, replay: Replay) -> None:
    """Write `replay` as its day's file in the research store and have the store check it.

    The file holds every alert the code's rule fires that day, whatever the live settings were.
    The local copy is removed whether or not the put worked. A failure is logged here by class
    alone, with the stage the day's own line cannot name, then raised for the day to fail on.
    """
    day = replay.day
    path = INTERVAL_BA_CACHE_DIR / f"replay-{day.isoformat()}.parquet"
    meta = {
        "day": day.isoformat(),
        "rows": len(replay.alerts),
        "rule": rule(),
        "created_at": ctx.now_utc.isoformat(),
    }
    try:
        pq.write_table(export_table(replay.alerts, meta), path)
        store.put_file(day_key(day), path)
    except Exception as exc:
        log.warning(
            "interval-ba %s day file write failed (%s)", day.isoformat(), type(exc).__name__
        )
        raise
    finally:
        path.unlink(missing_ok=True)


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

    A replay that fires nothing is always a fault, with or without live rows: every session fires
    at least 19 alerts (the lowest, 2026-08-14), and replay_day raises only for a tape with no
    0DTE rows, so a tape that reads but fires nothing (a premium column that casts to NULL after
    a layout change) would otherwise pass as a quiet day.
    """
    if plan.inserts_held is not None:
        return plan.inserts_held
    if plan.tape_alerts == 0:
        return "tape fired no alerts"  # the replay or the tape read broke
    if plan.live_rows == 0:
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
