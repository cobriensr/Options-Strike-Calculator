"""The outcome check: alert when a recent session's fires came back with no outcomes.

The enrich crons fill `peak_ceiling_pct` for Lottery Finder fires and Silent Boom alerts
after each close (21:40-23:45 UTC), so by this job's 07:15 UTC start the last session's
rows have their outcomes. A session where none do means the enrich failed silently, and one
where fewer than LOW_OUTCOME_SHARE do means it half-failed.

One statement counts both tables over the last OUTCOME_CHECK_SESSIONS sessions, so the
budget is one statement timeout. Only (table, day) pairs that have rows come back: a day
with no fires is not an alert. Alerts, all through `report_shares`:
- a pair with no outcomes is an error of its own, fingerprinted by table and day, so it is
  its own issue and alerts as one: at most len(OUTCOME_TABLES) * OUTCOME_CHECK_SESSIONS a run;
- all pairs below the share floor together are one warning per run.

`run` fails the step on a null pair, which `monitoring.report_step` reports as well
(`nightly step failed`, a fixed fingerprint); the per-day errors name the day. A database
error propagates: `steps.run_steps` turns it into a `failed` outcome carrying the class
name and sends the exception, scrubbed (a psycopg2 connect error names the Neon host).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Literal

import sentry_sdk

from calendar_nyse import previous_trading_day
from constants import LOW_OUTCOME_SHARE, OUTCOME_CHECK_SESSIONS
from resources import connect_db
from steps import StepContext, StepResult

if TYPE_CHECKING:
    from psycopg2.extensions import connection

# The only table names that reach SQL, and the order of the UNION ALL branches.
OUTCOME_TABLES = ("lottery_finder_fires", "silent_boom_alerts")

# `%(days)s` is one date[] parameter, repeated for each table. The table names come only
# from OUTCOME_TABLES, never from input.
_SHARES_SQL = " UNION ALL ".join(
    f"SELECT '{table}'::text AS source, date, count(*) AS n_rows, "
    "count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL) AS n_with_outcome "
    f"FROM {table} WHERE date = ANY(%(days)s::date[]) GROUP BY date"
    for table in OUTCOME_TABLES
)


@dataclass(frozen=True)
class DayShare:
    """How many of one table's fires on one day have an outcome."""

    table: str
    day: date
    rows: int
    with_outcome: int


def outcome_shares(conn: connection, days: Sequence[date]) -> list[DayShare]:
    """One share per (table, day) in `days` that has rows, from a single statement."""
    with conn.cursor() as cursor:
        cursor.execute(_SHARES_SQL, {"days": list(days)})
        rows = cursor.fetchall()
    return [DayShare(table, day, n_rows, n_with) for table, day, n_rows, n_with in rows]


def classify_share(share: DayShare) -> Literal["null", "low", "ok"]:
    """`null` when no row has an outcome, `low` when less than LOW_OUTCOME_SHARE do.

    Pure and silent: the alerts are `report_shares`'s alone.
    """
    if share.with_outcome == 0:
        return "null"
    if share.with_outcome / share.rows < LOW_OUTCOME_SHARE:
        return "low"
    return "ok"


def report_shares(shares: Sequence[DayShare]) -> tuple[int, int]:
    """Send the alerts for `shares` and return `(null_days, low_days)`, counted in pairs."""
    null_days = 0
    low: list[str] = []
    for share in shares:
        kind = classify_share(share)
        if kind == "null":
            null_days += 1
            day = share.day.isoformat()
            sentry_sdk.capture_message(
                "nightly outcomes all null",
                level="error",
                tags={"table": share.table, "day": day},
                extras={"rows": share.rows, "with_outcome": share.with_outcome},
                fingerprint=["nightly-outcomes", "null", share.table, day],
            )
        elif kind == "low":
            low.append(f"{share.table}:{share.day.isoformat()}")
    if low:
        days = sorted(low)
        sentry_sdk.capture_message(
            "nightly outcomes mostly null",
            level="warning",
            extras={"count": len(days), "days": days},
            fingerprint=["nightly-outcomes", "low", *days],
        )
    return null_days, len(low)


def recent_sessions(last_session: date, n: int) -> list[date]:
    """The `n` trading days ending on `last_session`, ascending."""
    days: list[date] = []
    day = last_session
    for _ in range(n):
        day = previous_trading_day(day)
        days.append(day)
        day -= timedelta(days=1)
    days.reverse()
    return days


def run(ctx: StepContext) -> StepResult:
    sessions = recent_sessions(ctx.last_session, OUTCOME_CHECK_SESSIONS)
    # Alerts go out after the connection closes, so a slow Sentry never holds it open.
    with connect_db(ctx.settings) as conn:
        shares = outcome_shares(conn, sessions)
    null_days, low_days = report_shares(shares)
    # A day here is one (table, day) pair with rows, in all three counts.
    counts = {"days_checked": len(shares), "null_days": null_days, "low_days": low_days}
    if null_days:
        # The detail is part of the `nightly step failed` fingerprint: keep it fixed.
        return StepResult("failed", counts, "a recent session has no outcomes")
    return StepResult("ok", counts)
