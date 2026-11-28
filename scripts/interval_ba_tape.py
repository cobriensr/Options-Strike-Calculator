"""Interval B/A history from the UW Full Tape: compare it with the table, rebuild the days the
live feed never covered, heal the live days, export the full-year replay, and undo a run.

Spec: docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, sections 6.4 and 6.5;
export --per-day: docs/superpowers/specs/2026-11-26-interval-ba-replay-days-design.md.
The detector is the shared replay module nightly/src/interval_ba_replay.py, and the trading
calendar is nightly's nightly/src/calendar_nyse.py (2025 to 2028), each loaded by its path.
The tape is read from R2 through DuckDB's httpfs (ml/src/utils/r2.py); the table is production
Neon. The mode-agnostic machinery (connections, windows, run folders, the backup, verified R2
puts and the apply driver) is in interval_ba_tape_runs.py beside this file; this file holds the
command line and the modes.

Modes:

- `verify --from D --to D`: read-only. Replays each trading day and compares it with the stored
  rows on the key (option_chain, bucket_start), then on every column except fired_at,
  confluence_tickers, the two flags and the SPXW spot. On 2026-05-13 and 2026-07-22 it compares
  only the rebuild's window (below) against the day's replay rows. Prints a per-day table and
  each differing row. Exit 0 when every day matches, 1 when any differs.
- `rebuild [--from D --to D]`: a dry run of the delete-and-insert over the days with no live
  rows (spec 5.1). Writes a run folder with the plan and changes nothing. With neither --from
  nor --to it works every rebuild day (the two ranges and the two edge days, below) and never a
  live day; a range that holds a live day is refused.
- `rebuild --apply --run <folder> --expect-delete N --expect-insert N`: applies that plan.
- `heal --from D --to D [--assume-default-settings]`: a dry run of heal_day (spec 6.4) over the
  live days, 2026-05-13 on; it refuses an earlier day. It fixes the two flags and a blank SPXW
  spot on live rows and removes stale replay rows; from 2026-10-29 it also inserts the alerts
  live missed, under the day's covering interval_ba_live_settings rows, which hold the inserts
  when they ran another rule, had the detector off, or are missing. The flag assumes the code's
  rule, all three tickers on, for a day no row covers, and only for such a day. A day whose
  inserts are held, or with a stale replay row kept because it holds an acknowledgement, is
  flagged (exit 1).
- `heal --apply --run <folder> --expect-insert N --expect-remove N --expect-flags N
  --expect-spot N`: applies that plan, one heal_day per day with the plan's sha256 as
  expect_sha256.
- `export --from D --to D`: read-only for Neon (it never connects). Replays every trading day,
  all three tickers, and writes the alerts as parquet (the TapeAlert fields in order, times as
  UTC TIMESTAMPTZ from epoch microseconds) to the run folder and to R2 at
  research/interval-ba/replay-<to>.parquet, put once and verified. It never overwrites an
  object. The file's metadata and the object's hold the module's blob hash and the rule
  (the constants and the replay version, `ibr.rule()`); the object's also sha256 and rows. The
  table is built by the replay module (`ibr.export_table`), as the nightly step builds each
  session's day file.
- `export --per-day --from D --to D`: the same replay, written as one file per session, the
  files the nightly step writes (the replay-days spec): R2 `research/interval-ba/replay/
  <day>.parquet`, built by the replay module (`ibr.export_table`, footer `ibr.day_meta`), put and
  checked. It overwrites, because a day file is an output that a re-run rewrites; it does not
  look at the snapshot's key. It never touches Neon. It is `write_replay_days(days, *,
  allow_market_hours)`, which the studies' readers also call to repair a missing or stale day.
  Every such write refuses unless nightly/src/interval_ba_replay.py has no uncommitted change
  and is the blob origin/main holds (fetched first), because that is the code the nightly job
  runs: run it from a checkout at origin/main. A run's record is export.json in a run folder
  (the day, key, rows, size and sha256 of each file). A day that fired no alerts still gets its
  zero-row file, and the run ends 1 and names it.
- `undo --run <folder>`: puts a rebuild or heal run's days back to its backup: the days marked
  `.applied`, and those whose rows equal the plan's end state. A rebuild day's replay rows
  become the backup's, ids and all. A heal day's inserts are deleted (only rows the backup never
  held, still as written), its removed replay rows go back with their ids, and its flags and
  spots go back to the backup's where they still hold what the heal wrote. A live row is never
  deleted or inserted, and interval_ba_tape_days is left alone. Each day is one transaction and
  then a `<day>.undone` marker; an undone run is never applied again.

The rebuild's days: every trading day from 2026-01-02 to 2026-05-12 and from 2026-07-23 to
2026-09-04, plus 2026-05-13 for the tape alerts that fired before that day's first live row and
2026-07-22 for those after its last live row. It refuses any other day. Per day it deletes the
day's unacknowledged `source = 'replay'` rows and inserts the tape alerts in the window as
`source = 'replay'`. A tape key that already has a live row is skipped and listed on the two
edge days; on any other day a live row stops the dry run, because live never ran there. The two
edge days' bounds must be the ones spec section 4 names (the first live row in 15:55:37Z on
05-13; 11 live rows on 07-22, the last in 14:52:46Z), or the run stops. A live row is never
deleted.

A run folder, docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/, holds:

- plan.json (rebuild, heal): per day and ticker the counts, one sha256 per day over the day and
  its exact write set, the git blob hash of the replay module and of every file of the tool, and
  root_label_mismatch; a heal plan also records each day's settings source;
- days/<day>.json: the day's full write lists (a heal day's is DayPlan.to_json());
- report.md: the counts per day, the flags, and before/after per ticker and month;
- once applied: backup.jsonl and backup.json (the backup), and a <day>.applied marker per day;
  once undone, a <day>.undone marker per day;
- an export's folder: the parquet file and export.json, its record.

An apply refuses (exit 3) when a refusal window is open, when the run was undone, when a code
file's blob hash differs from the plan's, when plan.json or a pending day file is damaged or
disagrees with the other, or when an --expect total differs from the plan's total over the days
not yet applied. Its first apply writes every row of interval_ba_alerts to backup.jsonl, reads
it back, copies it to R2 at backups/interval-ba-alerts/<UTC stamp>.jsonl and checks the copy,
before any write; a later apply of the same run takes no new backup. Then, per day not yet
marked:

1. if the day's rows already equal the plan's end state (for a heal day, with its
   interval_ba_tape_days row), write the marker and go on;
2. rebuild: replay the day and, in the day's transaction before any write, re-plan it and
   compare the sha256 with the plan's (PlanChanged, exit 3, on a difference); then check the
   refusal windows again; then delete and insert, check the counts the database reports, and
   commit. heal: check the windows, then heal_day, which owns the transaction and re-plans,
   compares the sha256 (PlanChanged before any write), writes and commits; a day it committed
   other than planned is marked and stops the run (exit 1);
3. write the marker.

Any failed day stops the run; the days before it keep their markers, so a rerun resumes.

Refusal windows, for every mode but verify: weekdays 08:15 to 16:00 CT (`--allow-market-hours`
overrides it, for a market holiday) and every day 07:15 to 12:30 UTC, the nightly run. An apply
and an undo check them again before each day's write, and export --per-day before each day's
put.

Secrets: DATABASE_URL and the four R2_* names come from --env-file, else this checkout's
.env.local, else the main checkout's. No value is ever printed; every line of output is
redacted, and a database or R2 client error prints its class only. DATABASE_URL is production;
the tool connects to its direct host, never the pooler.

Usage, from the repo root, with ml/.venv (Windows):

    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py verify \\
        --from 2026-10-29 --to 2026-11-23
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py rebuild
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py rebuild --apply \\
        --run docs/tmp/interval-ba-rebuild/<stamp>-rebuild --expect-delete N --expect-insert N
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py heal \\
        --from 2026-05-13 --to 2026-11-24 --assume-default-settings
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py heal --apply \\
        --run docs/tmp/interval-ba-rebuild/<stamp>-heal --expect-insert N --expect-remove N \\
        --expect-flags N --expect-spot N
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py export \\
        --from 2026-01-02 --to 2026-11-24
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py export --per-day \\
        --from 2026-01-02 --to 2026-11-24
    ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py undo \\
        --run docs/tmp/interval-ba-rebuild/<stamp>-heal

Exit codes: 0 ok, 1 an error or a failed check, 2 bad arguments, 3 refused.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import sys
import traceback
from collections.abc import Sequence
from dataclasses import dataclass, fields
from datetime import UTC, date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
import psycopg2
import psycopg2.extras
import pyarrow.parquet as pq

# The shared machinery sits beside this file; -I keeps this folder off sys.path. Appended, so
# no module of this folder can shadow a standard or installed one.
_SCRIPTS = str(Path(__file__).resolve().parent)
if _SCRIPTS not in sys.path:
    sys.path.append(_SCRIPTS)

import interval_ba_tape_runs as runs  # noqa: E402
from interval_ba_tape_runs import CheckFailedError, RefusedError, UsageError  # noqa: E402

ibr = runs.ibr

# The rebuild's days (spec 6.5 and 9). On the two edge days only the stretch with no live rows.
FULL = "full"
BEFORE_FIRST_LIVE = "before first live row"
AFTER_LAST_LIVE = "after last live row"
FIRST_LIVE_DAY = ibr.LIVE_START  # 2026-05-13
LAST_LIVE_DAY_BEFORE_OUTAGE = date(2026, 7, 22)
_FULL_REBUILD_RANGES = (
    (date(2026, 1, 2), date(2026, 5, 12)),
    (date(2026, 7, 23), date(2026, 9, 4)),
)
# The two edges as spec section 4 ("Live day edges") measured them, to the second. A table
# that no longer holds them is not the one the windows were checked against.
FIRST_LIVE_ROW_AT = datetime(2026, 5, 13, 15, 55, 37, tzinfo=UTC)
LAST_LIVE_ROW_AT = datetime(2026, 7, 22, 14, 52, 46, tzinfo=UTC)
LIVE_ROWS_ON_LAST_LIVE_DAY = 11

# The feed shows at most this many alerts a day, between 08:30 and 15:00 CT (Review Focus 5).
FEED_CAP = 500
_FEED_START, _FEED_END = time(8, 30), time(15, 0)

_PAGE_ROWS = 500  # rows per write statement (spec 9)


def rebuild_kind(day: date) -> str | None:
    """FULL, BEFORE_FIRST_LIVE or AFTER_LAST_LIVE for a rebuild day, None for any other."""
    if day == FIRST_LIVE_DAY:
        return BEFORE_FIRST_LIVE
    if day == LAST_LIVE_DAY_BEFORE_OUTAGE:
        return AFTER_LAST_LIVE
    if any(first <= day <= last for first, last in _FULL_REBUILD_RANGES):
        return FULL
    return None


REBUILD_DAYS: tuple[date, ...] = tuple(
    day
    for day in runs.trading_days(_FULL_REBUILD_RANGES[0][0], _FULL_REBUILD_RANGES[-1][1])
    if rebuild_kind(day) is not None
)


def rebuild_days(start: date | None, end: date | None) -> list[date]:
    """The rebuild's own days, all of them, when no range is given: its two ranges and its two
    edge days, which the live days between them are not part of. A range, even one end of it,
    is the trading days from start to end (a missing end is the list's first or last day), and
    it is refused when it holds any day outside the rebuild's list."""
    if start is None and end is None:
        return list(REBUILD_DAYS)
    days = runs.trading_days(start or REBUILD_DAYS[0], end or REBUILD_DAYS[-1])
    outside = [day for day in days if rebuild_kind(day) is None]
    if outside:
        listed = ", ".join(day.isoformat() for day in outside[:5])
        more = f" and {len(outside) - 5} more" if len(outside) > 5 else ""
        raise RefusedError(
            f"rebuild refuses {listed}{more}: not a rebuild day. Its days are 2026-01-02 to"
            " 2026-05-12, 2026-05-13 before the first live row, 2026-07-22 after the last live"
            " row, and 2026-07-23 to 2026-09-04"
        )
    if not days:
        raise UsageError("no trading day in that range")
    return days


# --- The table's rows -------------------------------------------------------------------------

_TAPE_FIELDS: tuple[str, ...] = tuple(f.name for f in fields(ibr.TapeAlert))
_DAY_ROWS_SQL = (
    "SELECT id, source, acknowledged, "
    + ", ".join(_TAPE_FIELDS)
    + " FROM interval_ba_alerts WHERE expiry = %(day)s ORDER BY id"
)


@dataclass(frozen=True)
class StoredRow:
    """An interval_ba_alerts row: its id, source and acknowledgement, and the TapeAlert fields
    as the table holds them."""

    id: int
    source: str
    acknowledged: bool
    values: dict[str, Any]

    @property
    def key(self) -> tuple[str, datetime]:
        return (self.values["option_chain"], self.values["bucket_start"])

    @property
    def ticker(self) -> str:
        return self.values["ticker"]

    @property
    def fired_at(self) -> datetime:
        return self.values["fired_at"]


def read_day_rows(conn: Any, day: date) -> list[StoredRow]:
    """Every row of `day`, live and replay, by id. The caller ends the transaction."""
    with conn.cursor() as cur:
        cur.execute(_DAY_ROWS_SQL, {"day": day})
        return [
            StoredRow(
                id=row[0],
                source=row[1],
                acknowledged=row[2],
                values=dict(zip(_TAPE_FIELDS, row[3:], strict=True)),
            )
            for row in cur.fetchall()
        ]


def _comparable(name: str, value: Any) -> Any:
    """A value as both sides can compare it: times in UTC, the tag list as a tuple. Decimals
    compare by value, so a NUMERIC's scale does not matter."""
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    if name == "confluence_tickers" and value is not None:
        return tuple(value)
    return value


def _alert_values(alert: Any) -> dict[str, Any]:
    return {name: _comparable(name, getattr(alert, name)) for name in _TAPE_FIELDS}


def _row_values(row: StoredRow) -> dict[str, Any]:
    return {name: _comparable(name, row.values[name]) for name in _TAPE_FIELDS}


def _in_feed_window(fired_at: datetime, day: date) -> bool:
    local = fired_at.astimezone(runs.CT)
    return local.date() == day and _FEED_START <= local.time() < _FEED_END


def _show(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value)


# --- One rebuild day --------------------------------------------------------------------------


@dataclass(frozen=True)
class Twin:
    """A tape alert in an edge day's window whose key already has a live row: skipped."""

    option_chain: str
    bucket_start: datetime
    live_id: int
    tape_fired_at: datetime
    live_fired_at: datetime

    def to_json(self) -> dict[str, Any]:
        return {
            "option_chain": self.option_chain,
            "bucket_start": self.bucket_start.astimezone(UTC).isoformat(),
            "live_id": self.live_id,
            "tape_fired_at": self.tape_fired_at.astimezone(UTC).isoformat(),
            "live_fired_at": self.live_fired_at.astimezone(UTC).isoformat(),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Twin:
        return cls(
            option_chain=d["option_chain"],
            bucket_start=datetime.fromisoformat(d["bucket_start"]),
            live_id=d["live_id"],
            tape_fired_at=datetime.fromisoformat(d["tape_fired_at"]),
            live_fired_at=datetime.fromisoformat(d["live_fired_at"]),
        )


@dataclass(frozen=True)
class RebuildDay:
    """One rebuild day's plan: the counts and the exact write set.

    `tickers` holds, per ticker: the replay's alerts (`tape`), those in the window, the planned
    inserts and deletes, the twins skipped, and the day's rows before and after. `feed_rows` is
    the end state's count between 08:30 and 15:00 CT. sha256 is the replay module's hash over the
    day and the write set (the inserts in key order, the delete ids sorted), the same form a
    heal day's DayPlan has.
    """

    day: date
    kind: str
    bound: datetime | None  # the first (05-13) or last (07-22) live fired_at; None on a full day
    root_label_mismatch: int
    tickers: dict[str, dict[str, int]]
    feed_rows: int
    inserts: tuple[Any, ...]  # TapeAlert
    deletes: tuple[int, ...]
    twins: tuple[Twin, ...]
    sha256: str

    def to_json(self) -> dict[str, Any]:
        return {
            "day": self.day.isoformat(),
            "kind": self.kind,
            "bound": None if self.bound is None else self.bound.astimezone(UTC).isoformat(),
            "root_label_mismatch": self.root_label_mismatch,
            "tickers": self.tickers,
            "feed_rows": self.feed_rows,
            "inserts": [ibr._alert_json(alert) for alert in self.inserts],
            "deletes": list(self.deletes),
            "twins": [twin.to_json() for twin in self.twins],
            "sha256": self.sha256,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> RebuildDay:
        """The plan `to_json` gave. Raises ValueError when its write lists do not hash to its
        sha256: an edited or damaged day file is refused."""
        day = date.fromisoformat(d["day"])
        inserts = tuple(ibr._alert_from_json(alert) for alert in d["inserts"])
        deletes = tuple(d["deletes"])
        sha256 = _write_set_sha(day, inserts, deletes)
        if sha256 != d["sha256"]:
            raise ValueError(f"days/{d['day']}.json: its write lists do not match its sha256")
        return cls(
            day=day,
            kind=d["kind"],
            bound=None if d["bound"] is None else datetime.fromisoformat(d["bound"]),
            root_label_mismatch=d["root_label_mismatch"],
            tickers=d["tickers"],
            feed_rows=d["feed_rows"],
            inserts=inserts,
            deletes=deletes,
            twins=tuple(Twin.from_json(twin) for twin in d["twins"]),
            sha256=sha256,
        )


def _write_set_sha(day: date, inserts: Sequence[Any], deletes: Sequence[int]) -> str:
    """The replay module's canonical hash (DayPlan's): the day and the four write lists, of
    which a rebuild uses two."""
    return ibr._write_set_sha(day, inserts, deletes, (), ())


def _to_second(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(microsecond=0)


def _edge_window(
    day: date, kind: str, alerts: Sequence[Any], live: Sequence[StoredRow]
) -> tuple[datetime, list[Any]]:
    """An edge day's bound and the tape alerts on the rebuild's side of it. The bound must be
    the one spec section 4 measured, or the run stops."""
    if not live:
        raise CheckFailedError(
            f"{day}: no live rows, so the rebuild window ({kind}) has no bound."
            " Live started on 2026-05-13 and stopped on 2026-07-22; the table disagrees"
        )
    if kind == BEFORE_FIRST_LIVE:
        bound = min(row.fired_at for row in live)
        if _to_second(bound) != FIRST_LIVE_ROW_AT:
            raise CheckFailedError(
                f"{day}: the first live row fired at {_show(bound)}, not in the second"
                f" {_show(FIRST_LIVE_ROW_AT)} that spec section 4 names. The table is not the"
                " one the window was checked against; the run stops"
            )
        return bound, [alert for alert in alerts if alert.fired_at < bound]
    bound = max(row.fired_at for row in live)
    if len(live) != LIVE_ROWS_ON_LAST_LIVE_DAY or _to_second(bound) != LAST_LIVE_ROW_AT:
        raise CheckFailedError(
            f"{day}: {len(live)} live rows, the last at {_show(bound)}; spec section 4 has"
            f" {LIVE_ROWS_ON_LAST_LIVE_DAY}, the last in the second {_show(LAST_LIVE_ROW_AT)}."
            " The table is not the one the window was checked against; the run stops"
        )
    return bound, [alert for alert in alerts if alert.fired_at > bound]


def plan_rebuild_day(day: date, replay: Any, rows: Sequence[StoredRow]) -> RebuildDay:
    """The day's delete-and-insert (spec 5.1 and 6.5), from its replay and its rows.

    Raises CheckFailedError for a live row on a full rebuild day, an edge day whose bound is not
    the spec's, or a replay row to delete that holds an acknowledgement. Each stops the run.
    """
    kind = rebuild_kind(day)
    if kind is None:
        raise RefusedError(f"{day} is not a rebuild day")
    live = [row for row in rows if row.source == "live"]
    if kind == FULL:
        if live:
            fired = {alert.key for alert in replay.alerts}
            at_keys = [row for row in live if row.key in fired]
            shown = "; ".join(
                f"{row.key[0]} {_show(row.key[1])} (id {row.id})" for row in at_keys[:5]
            )
            raise CheckFailedError(
                f"{day}: {len(live)} live row(s) on a full rebuild day, where live never ran;"
                f" {len(at_keys)} at a tape key{': ' + shown if shown else ''}. The dry run"
                " stops: this day does not belong in the rebuild as the table stands"
            )
        bound, window = None, list(replay.alerts)
    else:
        bound, window = _edge_window(day, kind, replay.alerts, live)

    live_at = {row.key: row for row in live}
    twinned = [alert for alert in window if alert.key in live_at]
    twins = tuple(
        Twin(
            option_chain=alert.option_chain,
            bucket_start=alert.bucket_start,
            live_id=live_at[alert.key].id,
            tape_fired_at=alert.fired_at,
            live_fired_at=live_at[alert.key].fired_at,
        )
        for alert in twinned
    )
    inserts = tuple(alert for alert in window if alert.key not in live_at)
    replay_rows = [row for row in rows if row.source == "replay"]
    acknowledged = [row.id for row in replay_rows if row.acknowledged]
    if acknowledged:
        raise CheckFailedError(
            f"{day}: replay row(s) {', '.join(map(str, acknowledged[:10]))} hold an"
            " acknowledgement, which the delete would lose. The dry run stops"
        )
    deletes = tuple(sorted(row.id for row in replay_rows))

    kept = [row for row in rows if row.source != "replay"]
    feed_rows = sum(
        _in_feed_window(fired_at, day)
        for fired_at in [*(a.fired_at for a in inserts), *(r.fired_at for r in kept)]
    )
    tickers: dict[str, dict[str, int]] = {}
    for ticker in ibr.TICKERS:
        before = sum(row.ticker == ticker for row in rows)
        insert = sum(alert.ticker == ticker for alert in inserts)
        delete = sum(row.ticker == ticker for row in replay_rows)
        tickers[ticker] = {
            "tape": sum(alert.ticker == ticker for alert in replay.alerts),
            "window": sum(alert.ticker == ticker for alert in window),
            "insert": insert,
            "delete": delete,
            "twins": sum(alert.ticker == ticker for alert in twinned),
            "before": before,
            "after": before - delete + insert,
        }
    return RebuildDay(
        day=day,
        kind=kind,
        bound=bound,
        root_label_mismatch=replay.root_label_mismatch,
        tickers=tickers,
        feed_rows=feed_rows,
        inserts=inserts,
        deletes=deletes,
        twins=twins,
        sha256=_write_set_sha(day, inserts, deletes),
    )


def in_end_state(rows: Sequence[StoredRow], planned: RebuildDay) -> bool:
    """Whether the day already holds the plan's end state: its replay rows are exactly the
    planned inserts, key for key and value for value. Live rows are never written."""
    stored = {row.key: _row_values(row) for row in rows if row.source == "replay"}
    wanted = {alert.key: _alert_values(alert) for alert in planned.inserts}
    return stored == wanted


# --- verify -----------------------------------------------------------------------------------

# Every column but the key, fired_at (live's is wall clock), confluence (live's comes from that
# clock), the two flags (live's were never set) and the SPXW spot (live writes none).
_VERIFY_COLUMNS = tuple(
    name
    for name in _TAPE_FIELDS
    if name
    not in {
        "option_chain",
        "bucket_start",
        "fired_at",
        "confluence_tickers",
        "top_trade_is_sweep",
        "top_trade_is_floor",
    }
)


@dataclass
class DayCompare:
    day: date
    stored: int
    tape: int
    common: int
    value_differs: int
    stored_only: int
    tape_only: int
    root_label_mismatch: int
    note: str
    lines: list[str]

    @property
    def differs(self) -> bool:
        return bool(self.value_differs or self.stored_only or self.tape_only)


def compare_day(day: date, replay: Any, rows: Sequence[StoredRow]) -> DayCompare:
    """The stored rows against the replay, on the key and then the compared columns. On an
    edge day, the rebuild's window against the day's replay rows."""
    kind = rebuild_kind(day)
    note = ""
    if kind in (BEFORE_FIRST_LIVE, AFTER_LAST_LIVE):
        live = [row for row in rows if row.source == "live"]
        bound, window = _edge_window(day, kind, replay.alerts, live)
        live_keys = {row.key for row in live}
        tape = {alert.key: alert for alert in window if alert.key not in live_keys}
        stored = {row.key: row for row in rows if row.source == "replay"}
        note = f"rebuild window only ({kind}, {_show(bound)}); live rows not compared"
    else:
        tape = {alert.key: alert for alert in replay.alerts}
        stored = {row.key: row for row in rows}

    lines: list[str] = []
    common = sorted(stored.keys() & tape.keys())
    value_differs = 0
    for key in common:
        row, alert = stored[key], tape[key]
        diffs = [
            f"{name} table {_show(row.values[name])} tape {_show(getattr(alert, name))}"
            for name in _VERIFY_COLUMNS
            if not (name == "underlying_price" and row.ticker == "SPXW")
            and _comparable(name, row.values[name]) != _comparable(name, getattr(alert, name))
        ]
        if diffs:
            value_differs += 1
            lines.append(f"  value {key[0]} {_show(key[1])} id {row.id}: {'; '.join(diffs)}")
    for key in sorted(stored.keys() - tape.keys()):
        row = stored[key]
        lines.append(f"  table only {key[0]} {_show(key[1])} id {row.id} ({row.source})")
    for key in sorted(tape.keys() - stored.keys()):
        lines.append(f"  tape only {key[0]} {_show(key[1])} fired {_show(tape[key].fired_at)}")
    return DayCompare(
        day=day,
        stored=len(stored),
        tape=len(tape),
        common=len(common),
        value_differs=value_differs,
        stored_only=len(stored.keys() - tape.keys()),
        tape_only=len(tape.keys() - stored.keys()),
        root_label_mismatch=replay.root_label_mismatch,
        note=note,
        lines=lines,
    )


def _verify(args: argparse.Namespace, out: runs.Output) -> int:
    days = runs.trading_days(args.start, args.end)
    if not days:
        raise UsageError("no trading day in that range")
    env = runs.load_env(args.env_file)
    out.hide(env)
    conn = runs.connect(env, readonly=True)
    try:
        con = runs.tape_connection()
        try:
            out.say(
                "| Day | Stored rows | Tape alerts | Keys in common"
                " | Common rows with a different value | Stored only | Tape only"
                " | root_label_mismatch | Note |"
            )
            out.say("|---|---|---|---|---|---|---|---|---|")
            results: list[DayCompare] = []
            for day in days:
                with runs.stops_at(out, day):
                    replay = ibr.replay_day(con, runs.tape_url(day), day)
                    with runs.rolled_back(conn):  # no transaction idles through the next replay
                        rows = read_day_rows(conn, day)
                    result = compare_day(day, replay, rows)
                results.append(result)
                out.say(
                    f"| {day} | {result.stored} | {result.tape} | {result.common}"
                    f" | {result.value_differs} | {result.stored_only} | {result.tape_only}"
                    f" | {result.root_label_mismatch} | {result.note} |"
                )
        finally:
            con.close()
    finally:
        conn.close()
    differing = [result for result in results if result.differs]
    for result in differing:
        out.say(f"\n{result.day}:")
        for line in result.lines:
            out.say(line)
    count = len(results)
    out.say(
        f"\nverify: {count} day{'s' if count != 1 else ''}, {len(differing)} with differences;"
        f" root_label_mismatch: {sum(r.root_label_mismatch for r in results)}"
        " (kept tape rows whose underlying_symbol is not their OCC root)"
    )
    return 1 if differing else 0


# --- rebuild: the plan and its report ---------------------------------------------------------


def _plan_json(days: Sequence[RebuildDay]) -> dict[str, Any]:
    largest = max(days, key=lambda d: d.feed_rows)
    return {
        "mode": "rebuild",
        "created_at": runs.utc_now().isoformat(),
        **runs.code_blobs(),
        "root_label_mismatch": sum(d.root_label_mismatch for d in days),
        "totals": {
            "delete": sum(len(d.deletes) for d in days),
            "insert": sum(len(d.inserts) for d in days),
            "twins": sum(len(d.twins) for d in days),
        },
        "largest_day": {"day": largest.day.isoformat(), "feed_rows": largest.feed_rows},
        "over_feed_cap": [d.day.isoformat() for d in days if d.feed_rows > FEED_CAP],
        "days": {
            d.day.isoformat(): {
                "kind": d.kind,
                "bound": None if d.bound is None else d.bound.astimezone(UTC).isoformat(),
                "sha256": d.sha256,
                "delete": len(d.deletes),
                "insert": len(d.inserts),
                "twins": len(d.twins),
                "feed_rows": d.feed_rows,
                "root_label_mismatch": d.root_label_mismatch,
                "tickers": d.tickers,
            }
            for d in days
        },
    }


def _signed(n: int) -> str:
    return f"+{n}" if n > 0 else str(n)


def _month_table(counts: dict[tuple[str, str], tuple[int, int]]) -> list[str]:
    lines = ["| Month | Ticker | Before | After | Change |", "|---|---|---|---|---|"]
    for month in sorted({month for month, _ in counts}):
        for ticker in ibr.TICKERS:
            before, after = counts.get((month, ticker), (0, 0))
            lines.append(f"| {month} | {ticker} | {before} | {after} | {_signed(after - before)} |")
    return lines


def _report(run: Path, plan: dict[str, Any], days: Sequence[RebuildDay]) -> str:
    totals = plan["totals"]
    largest = plan["largest_day"]
    tool_blobs = ", ".join(f"{name} `{blob}`" for name, blob in plan["tool_blobs"].items())
    lines = [
        f"# Interval B/A rebuild: dry run {run.name}",
        "",
        f"- Days: {len(days)}, {days[0].day} to {days[-1].day}.",
        f"- Deletes {totals['delete']} replay rows, inserts {totals['insert']} tape alerts,"
        f" skips {totals['twins']} live twins.",
        f"- Replay module blob `{plan['module_blob']}`; tool blobs: {tool_blobs}.",
        f"- root_label_mismatch: {plan['root_label_mismatch']} (kept tape rows whose"
        " underlying_symbol is not their OCC root; counted, never dropped).",
        f"- Largest day: {largest['day']}, {largest['feed_rows']} rows between 08:30 and"
        f" 15:00 CT. The feed shows at most {FEED_CAP} a day.",
        "",
        "## Flags",
        "",
    ]
    flags = [
        f"- **{d.day}: {d.feed_rows} rows between 08:30 and 15:00 CT, over the feed's"
        f" {FEED_CAP}-row cap.**"
        for d in days
        if d.feed_rows > FEED_CAP
    ]
    flags += [
        f"- **{d.day}: the tape fires no alert; the plan deletes {len(d.deletes)} rows and"
        " inserts none.**"
        for d in days
        if sum(c["tape"] for c in d.tickers.values()) == 0
    ]
    lines += flags or ["None."]
    lines += [
        "",
        "## Days",
        "",
        "The bound is the edge day's first (05-13) or last (07-22) live fired_at.",
        "",
        "| Day | Kind | Bound (UTC) | Delete | Insert | Insert SPXW | Insert SPY | Insert QQQ"
        " | Live twins skipped | Feed rows (08:30-15:00 CT) | root_label_mismatch |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for d in days:
        per = " | ".join(str(d.tickers[t]["insert"]) for t in ibr.TICKERS)
        bound = "-" if d.bound is None else _show(d.bound)
        lines.append(
            f"| {d.day} | {d.kind} | {bound} | {len(d.deletes)} | {len(d.inserts)} | {per}"
            f" | {len(d.twins)} | {d.feed_rows} | {d.root_label_mismatch} |"
        )
    lines += ["", "## Live twins skipped (edge days)", ""]
    twins = [(d.day, twin) for d in days for twin in d.twins]
    if twins:
        lines += [
            "A tape alert in the window whose key already has a live row. Live's fired_at is"
            " wall clock, so its row can have a tape twin just inside the window.",
            "",
            "| Day | Option chain | Bucket start (UTC) | Live id | Tape fired_at | Live fired_at |",
            "|---|---|---|---|---|---|",
        ]
        lines += [
            f"| {day} | {t.option_chain} | {_show(t.bucket_start)} | {t.live_id}"
            f" | {_show(t.tape_fired_at)} | {_show(t.live_fired_at)} |"
            for day, t in twins
        ]
    else:
        lines.append("None.")
    lines += ["", "## Before and after, per ticker and month", ""]
    lines += _month_table(runs.planned_months(plan))
    lines += [
        "",
        "## Apply",
        "",
        "```",
        f"rebuild --apply --run {run} --expect-delete {totals['delete']}"
        f" --expect-insert {totals['insert']}",
        "```",
        "",
    ]
    return "\n".join(lines)


def _day_line(d: RebuildDay) -> str:
    bound = "" if d.bound is None else f", bound {_show(d.bound)}"
    return (
        f"{d.day} {d.kind}{bound}: delete {len(d.deletes)}, insert {len(d.inserts)},"
        f" live twins {len(d.twins)}, feed rows {d.feed_rows}"
    )


# --- rebuild: the dry run ---------------------------------------------------------------------


def _rebuild_dry_run(args: argparse.Namespace, out: runs.Output) -> int:
    days = rebuild_days(args.start, args.end)
    runs.refuse_in_window(args.allow_market_hours)
    env = runs.load_env(args.env_file)
    out.hide(env)
    conn = runs.connect(env, readonly=True)
    try:
        con = runs.tape_connection()
        try:
            run = runs.new_run("rebuild")
            out.say(f"run folder: {run}")
            planned: list[RebuildDay] = []
            for day in days:
                with runs.stops_at(out, day):
                    replay = ibr.replay_day(con, runs.tape_url(day), day)
                    with runs.rolled_back(conn):  # no transaction idles through the next replay
                        rows = read_day_rows(conn, day)
                    plan_day = plan_rebuild_day(day, replay, rows)
                runs.write_json(run / "days" / f"{day}.json", plan_day.to_json())
                out.say(_day_line(plan_day))
                planned.append(plan_day)
        finally:
            con.close()
    finally:
        conn.close()

    plan = _plan_json(planned)
    runs.write_json(run / "plan.json", plan)
    runs.write_text(run / "report.md", _report(run, plan, planned))
    totals = plan["totals"]
    out.say(
        f"plan: {run / 'plan.json'}; delete {totals['delete']}, insert {totals['insert']},"
        f" live twins {totals['twins']}; root_label_mismatch {plan['root_label_mismatch']}"
    )
    out.say(f"report: {run / 'report.md'}")
    if plan["over_feed_cap"]:
        out.say(
            f"FLAG: {', '.join(plan['over_feed_cap'])} over the feed's {FEED_CAP}-row cap"
            " (report.md)",
            err=True,
        )
        return 1
    return 0


# --- rebuild: the apply's day -----------------------------------------------------------------

# A live row is never deleted, nor a row someone acknowledged, nor a row of another day.
_DELETE_SQL = (
    "DELETE FROM interval_ba_alerts AS a USING (VALUES %s) AS v(id, day)"
    " WHERE a.id = v.id AND a.expiry = v.day AND a.source = 'replay' AND NOT a.acknowledged"
    " RETURNING a.id"
)


def _delete_replay_rows(cur: Any, day: date, ids: Sequence[int]) -> int:
    """Delete the day's replay rows by id, 500 a statement; return how many went."""
    gone = psycopg2.extras.execute_values(
        cur,
        _DELETE_SQL,
        [(row_id, day) for row_id in ids],
        template="(%s::bigint, %s::date)",
        page_size=_PAGE_ROWS,
        fetch=True,
    )
    return len(gone)


def _load_rebuild_day(run: Path, day: date, entry: dict[str, Any]) -> RebuildDay:
    """days/<day>.json as a RebuildDay. Refused when it is damaged or edited, when its sha256 is
    not plan.json's, or when its counts are not the ones plan.json totals for --expect."""
    name = f"days/{day}.json"
    try:
        planned = RebuildDay.from_json(json.loads((run / name).read_text(encoding="utf-8")))
        sha256, delete, insert = entry["sha256"], entry["delete"], entry["insert"]
    # ArithmeticError: a malformed decimal raises decimal.InvalidOperation, not a ValueError.
    except (OSError, ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise RefusedError(
            f"{day}: {name} is not a day plan this run can apply ({type(exc).__name__}: {exc})"
        ) from None
    if planned.sha256 != sha256:
        raise RefusedError(f"{day}: {name} and plan.json hold different plans")
    if (len(planned.deletes), len(planned.inserts)) != (delete, insert):
        raise RefusedError(
            f"{day}: plan.json counts {delete} deletes and {insert} inserts, but {name} holds"
            f" {len(planned.deletes)} and {len(planned.inserts)}"
        )
    return planned


def _apply_rebuild_day(
    conn: Any,
    con: duckdb.DuckDBPyConnection,
    day: date,
    planned: RebuildDay,
    allow_market_hours: bool,
) -> runs.DayDone:
    """One day's apply, in the spec's order; the driver writes the marker after it."""
    # 1. A day already in its planned end state was applied by a run that died before its
    #    marker: say so, and the driver marks it.
    with runs.rolled_back(conn):
        with conn.cursor() as cur:
            runs.set_local_timeouts(cur)
        rows = read_day_rows(conn, day)
    if in_end_state(rows, planned):
        return runs.DayDone(
            "end state", {"deleted": 0, "inserted": 0}, f"{day}: already in its planned end state"
        )

    replay = ibr.replay_day(con, runs.tape_url(day), day)  # outside the transaction: seconds
    try:
        # 2. The day's transaction starts here, bounded. Re-plan, and apply only the plan the
        #    owner saw.
        with conn.cursor() as cur:
            runs.set_local_timeouts(cur)
        fresh = plan_rebuild_day(day, replay, read_day_rows(conn, day))
        if fresh.sha256 != planned.sha256:
            raise ibr.PlanChanged(
                f"{day}: the fresh plan's sha256 {fresh.sha256} is not the plan's"
                f" {planned.sha256}: the day's rows, its tape or the code moved since the dry"
                " run. Nothing was written for this day"
            )
        # 3. The windows again, right before the write.
        runs.refuse_in_window(allow_market_hours, f"{day}: ")
        # 4. The write, exactly the plan, or nothing.
        with conn.cursor() as cur:
            deleted = _delete_replay_rows(cur, day, fresh.deletes)
            inserted = ibr.insert_alerts(cur, fresh.inserts)
        if (deleted, inserted) != (len(fresh.deletes), len(fresh.inserts)):
            raise CheckFailedError(
                f"{day}: the database deleted {deleted} of {len(fresh.deletes)} and inserted"
                f" {inserted} of {len(fresh.inserts)}: another writer moved the day."
                " Rolled back"
            )
        conn.commit()
    except BaseException:
        # A failed rollback (a dead connection) must not hide the error that got here; the
        # server drops the transaction with the connection.
        with contextlib.suppress(psycopg2.Error):
            conn.rollback()
        raise
    return runs.DayDone(
        "applied",
        {"deleted": deleted, "inserted": inserted},
        f"{day}: deleted {deleted}, inserted {inserted}",
    )


_MONTH_COUNTS_SQL = (
    "SELECT to_char(expiry, 'YYYY-MM'), ticker, count(*) FROM interval_ba_alerts"
    " WHERE expiry = ANY(%s) GROUP BY 1, 2"
)


def _append_measured(conn: Any, run: Path, plan: dict[str, Any]) -> None:
    """report.md gains the table's counts now, per month and ticker, against the plan's before."""
    days = [date.fromisoformat(day) for day in plan["days"]]
    with runs.rolled_back(conn), conn.cursor() as cur:
        cur.execute(_MONTH_COUNTS_SQL, (days,))
        now = {(month, ticker): count for month, ticker, count in cur.fetchall()}
    measured = {
        key: (before, now.get(key, 0)) for key, (before, _) in runs.planned_months(plan).items()
    }
    with (run / "report.md").open("a", encoding="utf-8", newline="\n") as report:
        report.write(
            "\n".join(
                [
                    "",
                    f"## Measured after the apply ({runs.stamp(runs.utc_now())})",
                    "",
                    *_month_table(measured),
                    "",
                ]
            )
        )


REBUILD = runs.ApplyMode(
    name="rebuild",
    expect=("delete", "insert"),
    load_day=_load_rebuild_day,
    apply_day=_apply_rebuild_day,
    finish=_append_measured,
)


# --- heal: the live days ----------------------------------------------------------------------

# Where a heal day's settings came from (plan.json `settings`).
NOT_CONSULTED = "not consulted"  # before 2026-10-29: heal_day inserts nothing and reads none
LIVE_SETTINGS = "live"  # the day's covering interval_ba_live_settings rows
ASSUMED_DEFAULT = "assumed default"  # no covering row, and --assume-default-settings
NO_SETTINGS = "none"  # no covering row: heal_day holds the inserts
_SETTINGS_SOURCES = (NOT_CONSULTED, LIVE_SETTINGS, ASSUMED_DEFAULT, NO_SETTINGS)

# A heal day's planned writes, by their plan.json count and their DayPlan count.
_HEAL_EXPECT = ("insert", "remove", "flags", "spot")
HEAL_COUNTS = ("inserted", "removed", "flags_changed", "spot_filled")
# The DayPlan diagnostics plan.json and report.md carry per day.
_HEAL_DIAGNOSTICS = (
    "tape_alerts",
    "live_rows",
    "matched",
    "live_missed",
    "live_only",
    "value_mismatched",
    "flags_unmatched",
    "acknowledged_kept",
    "root_label_mismatch",
)

_TAPE_DAY_SQL = "SELECT day FROM interval_ba_tape_days WHERE day = %(day)s"


def heal_days(start: date, end: date) -> list[date]:
    """The trading days from start to end. Refuses a range with a day before the first live
    day: those days have no live rows, and the rebuild covers them."""
    days = runs.trading_days(start, end)
    early = [day for day in days if day < ibr.LIVE_START]
    if early:
        listed = ", ".join(day.isoformat() for day in early[:5])
        more = f" and {len(early) - 5} more" if len(early) > 5 else ""
        raise RefusedError(
            f"heal refuses {listed}{more}: before {ibr.LIVE_START}, the first live day. Those"
            " days have no live rows; rebuild covers them"
        )
    if not days:
        raise UsageError("no trading day in that range")
    return days


def _insert_missed(day: date) -> bool:
    """heal_day's insert_missed: live ran this rule from 2026-10-29 only."""
    return day >= ibr.INSERT_MISSED_FROM


def _settings_for(conn: Any, day: date, *, assume_default: bool) -> tuple[list[Any], str]:
    """The settings heal_day gets for `day`, and where they came from.

    Before 2026-10-29 none are read: heal_day inserts nothing then and does not consult them.
    From then on, the day's covering rows; a day with none gets [default_settings()] when
    assume_default is set, else none, and heal_day holds its inserts. The read's transaction
    is ended here, because heal_day needs an idle connection.
    """
    if not _insert_missed(day):
        return [], NOT_CONSULTED
    with runs.rolled_back(conn):
        covering = ibr.read_covering_settings(conn, day)
    if covering:
        return covering, LIVE_SETTINGS
    if assume_default:
        return [ibr.default_settings()], ASSUMED_DEFAULT
    return [], NO_SETTINGS


def _tape_day_recorded(conn: Any, day: date) -> bool:
    """Whether interval_ba_tape_days holds the day, which heal_day writes with its changes."""
    with conn.cursor() as cur:
        cur.execute(_TAPE_DAY_SQL, {"day": day})
        return bool(cur.fetchall())


def _write_counts(plan: Any) -> tuple[int, int, int, int]:
    """A DayPlan's planned writes: inserts, removes, flag updates and spot fills."""
    return (len(plan.inserts), len(plan.removes), len(plan.flag_updates), len(plan.spot_updates))


@dataclass(frozen=True)
class HealDay:
    """A heal day's approved plan (an ibr.DayPlan), and where the dry run's settings came from:
    the apply assumes the defaults again only for a day the dry run assumed them for."""

    plan: Any
    settings: str


def _heal_tickers(plan: Any, rows: Sequence[StoredRow]) -> dict[str, dict[str, int]]:
    """Per ticker: the day's rows before, the planned writes, and the rows after."""
    ticker_of = {row.id: row.ticker for row in rows}
    tickers: dict[str, dict[str, int]] = {}
    for ticker in ibr.TICKERS:
        before = sum(row.ticker == ticker for row in rows)
        insert = sum(alert.ticker == ticker for alert in plan.inserts)
        remove = sum(ticker_of.get(row_id) == ticker for row_id in plan.removes)
        tickers[ticker] = {
            "before": before,
            "insert": insert,
            "remove": remove,
            "flags": sum(ticker_of.get(update[0]) == ticker for update in plan.flag_updates),
            "spot": sum(ticker_of.get(update[0]) == ticker for update in plan.spot_updates),
            "after": before + insert - remove,
        }
    return tickers


def _heal_entry(plan: Any, settings: str, rows: Sequence[StoredRow]) -> dict[str, Any]:
    return {
        "sha256": plan.sha256,
        **dict(zip(_HEAL_EXPECT, _write_counts(plan), strict=True)),
        "insert_missed": _insert_missed(plan.day),
        "settings": settings,
        "inserts_held": plan.inserts_held,
        **{name: getattr(plan, name) for name in _HEAL_DIAGNOSTICS},
        "tickers": _heal_tickers(plan, rows),
    }


def heal_end_state(rows: Sequence[StoredRow], plan: Any) -> bool:
    """Whether the day's rows already hold every write of the plan: a row at each insert's key
    with the planned values (only the inserted replay row has them: a live row's fired_at is
    wall clock), each removed id gone, each flag and spot at the planned value. The apply also
    needs the day's interval_ba_tape_days row, which the same transaction writes."""
    by_id = {row.id: row for row in rows}
    by_key = {row.key: row for row in rows}
    for alert in plan.inserts:
        row = by_key.get(alert.key)
        if row is None or _row_values(row) != _alert_values(alert):
            return False
    if any(row_id in by_id for row_id in plan.removes):
        return False
    for row_id, sweep, floor in plan.flag_updates:
        row = by_id.get(row_id)
        if row is None or (
            row.values["top_trade_is_sweep"],
            row.values["top_trade_is_floor"],
        ) != (sweep, floor):
            return False
    for row_id, price in plan.spot_updates:
        row = by_id.get(row_id)
        if row is None or row.values["underlying_price"] != price:
            return False
    return True


def _heal_plan_json(entries: dict[str, dict[str, Any]], assume_default: bool) -> dict[str, Any]:
    return {
        "mode": "heal",
        "created_at": runs.utc_now().isoformat(),
        **runs.code_blobs(),
        "assume_default_settings": assume_default,
        "root_label_mismatch": sum(e["root_label_mismatch"] for e in entries.values()),
        "totals": {name: sum(e[name] for e in entries.values()) for name in _HEAL_EXPECT},
        "held": {day: e["inserts_held"] for day, e in entries.items() if e["inserts_held"]},
        # Stale replay rows the plan keeps because someone acknowledged them.
        "acknowledged_kept": {
            day: e["acknowledged_kept"] for day, e in entries.items() if e["acknowledged_kept"]
        },
        "days": entries,
    }


def _heal_apply_line(run: Path, totals: dict[str, int]) -> str:
    expects = " ".join(f"--expect-{name} {totals[name]}" for name in _HEAL_EXPECT)
    return f"heal --apply --run {run} {expects}"


def _heal_report(run: Path, plan: dict[str, Any]) -> str:
    days = plan["days"]
    totals = plan["totals"]
    tool_blobs = ", ".join(f"{name} `{blob}`" for name, blob in plan["tool_blobs"].items())
    lines = [
        f"# Interval B/A heal: dry run {run.name}",
        "",
        f"- Days: {len(days)}, {min(days)} to {max(days)}.",
        f"- Inserts {totals['insert']} tape alerts live missed (from {ibr.INSERT_MISSED_FROM}"
        f" only), removes {totals['remove']} stale replay rows, corrects the flags on"
        f" {totals['flags']} live rows and fills {totals['spot']} blank SPXW spots.",
        "- --assume-default-settings: "
        + ("on, for a day no settings row covers." if plan["assume_default_settings"] else "off."),
        f"- Replay module blob `{plan['module_blob']}`; tool blobs: {tool_blobs}.",
        f"- root_label_mismatch: {plan['root_label_mismatch']}.",
        "",
        "## Flags",
        "",
    ]
    flags = [f"- **{day}: inserts held: {reason}.**" for day, reason in plan["held"].items()]
    flags += [
        f"- **{day}: {kept} stale replay row(s) hold an acknowledgement; the plan keeps them"
        " rather than lose it.**"
        for day, kept in plan["acknowledged_kept"].items()
    ]
    flags += [
        f"- **{day}: the tape fires no alert, but the day has {e['live_rows']} live rows.**"
        for day, e in days.items()
        if e["tape_alerts"] == 0 and e["live_rows"] > 0
    ]
    lines += flags or ["None."]
    lines += [
        "",
        "## Days",
        "",
        "The comparison counts cover the tickers on in every covering settings row. Settings:"
        f" `{NOT_CONSULTED}` before {ibr.INSERT_MISSED_FROM}, `{LIVE_SETTINGS}` (the covering"
        f" rows), `{ASSUMED_DEFAULT}` or `{NO_SETTINGS}`.",
        "",
        "| Day | Settings | Inserts held | Tape alerts | Live rows | Matched | Live missed"
        " | Live only | Value mismatched | Insert | Remove | Flags | Flags unmatched | Spot"
        " | root_label_mismatch |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for day, e in days.items():
        lines.append(
            f"| {day} | {e['settings']} | {e['inserts_held'] or '-'} | {e['tape_alerts']}"
            f" | {e['live_rows']} | {e['matched']} | {e['live_missed']} | {e['live_only']}"
            f" | {e['value_mismatched']} | {e['insert']} | {e['remove']} | {e['flags']}"
            f" | {e['flags_unmatched']} | {e['spot']} | {e['root_label_mismatch']} |"
        )
    lines += ["", "## Before and after, per ticker and month", ""]
    lines += _month_table(runs.planned_months(plan))
    lines += ["", "## Apply", "", "```", _heal_apply_line(run, totals), "```", ""]
    return "\n".join(lines)


def _heal_day_line(day: date, e: dict[str, Any]) -> str:
    held = f", inserts held: {e['inserts_held']}" if e["inserts_held"] else ""
    return (
        f"{day} ({e['settings']}): insert {e['insert']}, remove {e['remove']}, flags"
        f" {e['flags']}, spot {e['spot']}; live missed {e['live_missed']}{held}"
    )


def _heal_dry_run(args: argparse.Namespace, out: runs.Output) -> int:
    if args.start is None or args.end is None:
        raise UsageError("heal needs --from and --to, or --apply with --run")
    days = heal_days(args.start, args.end)
    runs.refuse_in_window(args.allow_market_hours)
    env = runs.load_env(args.env_file)
    out.hide(env)
    conn = runs.connect(env, readonly=True)
    try:
        con = runs.tape_connection()
        try:
            run = runs.new_run("heal")
            out.say(f"run folder: {run}")
            entries: dict[str, dict[str, Any]] = {}
            for day in days:
                with runs.stops_at(out, day):
                    settings, source = _settings_for(
                        conn, day, assume_default=args.assume_default_settings
                    )
                    plan = ibr.heal_day(
                        conn,
                        con,
                        runs.tape_url(day),
                        day,
                        settings,
                        insert_missed=_insert_missed(day),
                        apply=False,
                    )
                    with runs.rolled_back(conn):
                        rows = read_day_rows(conn, day)
                runs.write_json(run / "days" / f"{day}.json", plan.to_json())
                entries[day.isoformat()] = _heal_entry(plan, source, rows)
                out.say(_heal_day_line(day, entries[day.isoformat()]))
        finally:
            con.close()
    finally:
        conn.close()

    plan_json = _heal_plan_json(entries, args.assume_default_settings)
    runs.write_json(run / "plan.json", plan_json)
    runs.write_text(run / "report.md", _heal_report(run, plan_json))
    totals = plan_json["totals"]
    out.say(
        f"plan: {run / 'plan.json'}; insert {totals['insert']}, remove {totals['remove']},"
        f" flags {totals['flags']}, spot {totals['spot']}"
    )
    out.say(f"report: {run / 'report.md'}")
    flagged = False
    if plan_json["held"]:
        held = ", ".join(f"{day} ({reason})" for day, reason in plan_json["held"].items())
        out.say(f"FLAG: inserts held on {held} (report.md)", err=True)
        flagged = True
    if plan_json["acknowledged_kept"]:
        kept = ", ".join(f"{day} ({n})" for day, n in plan_json["acknowledged_kept"].items())
        out.say(
            f"FLAG: stale replay rows that hold an acknowledgement, kept, on {kept} (report.md)",
            err=True,
        )
        flagged = True
    return 1 if flagged else 0


def _load_heal_day(run: Path, day: date, entry: dict[str, Any]) -> HealDay:
    """days/<day>.json as a HealDay. Refused when it is damaged or edited, when it is another
    day's, when its sha256 or counts are not plan.json's, or when plan.json's settings source
    is not one the dry run writes."""
    name = f"days/{day}.json"
    try:
        planned = ibr.DayPlan.from_json(json.loads((run / name).read_text(encoding="utf-8")))
        sha256, settings = entry["sha256"], entry["settings"]
        counts = tuple(entry[count] for count in _HEAL_EXPECT)
    except (OSError, ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise RefusedError(
            f"{day}: {name} is not a day plan this run can apply ({type(exc).__name__}: {exc})"
        ) from None
    if planned.day != day or planned.sha256 != sha256:
        raise RefusedError(f"{day}: {name} and plan.json hold different plans")
    if _write_counts(planned) != counts:
        raise RefusedError(
            f"{day}: plan.json counts {dict(zip(_HEAL_EXPECT, counts, strict=True))}, but"
            f" {name} holds {dict(zip(_HEAL_EXPECT, _write_counts(planned), strict=True))}"
        )
    if settings not in _SETTINGS_SOURCES:
        raise RefusedError(f"{day}: plan.json's settings {settings!r} is not one a dry run writes")
    return HealDay(planned, settings)


def _apply_heal_day(
    conn: Any,
    con: duckdb.DuckDBPyConnection,
    day: date,
    planned: HealDay,
    allow_market_hours: bool,
) -> runs.DayDone:
    """One heal day's apply; the driver writes the marker after it.

    The rebuild's order, except that heal_day owns the day's transaction: in it, it re-plans,
    compares the fresh sha256 with the approved one (PlanChanged, before any write), writes and
    commits. So the windows are checked just before heal_day, not between those two steps.
    """
    # 1. Already in its end state (a run that died between its commit and its marker).
    with runs.rolled_back(conn):
        with conn.cursor() as cur:
            runs.set_local_timeouts(cur)
        rows = read_day_rows(conn, day)
        recorded = _tape_day_recorded(conn, day)
    if recorded and heal_end_state(rows, planned.plan):
        return runs.DayDone(
            "end state", dict.fromkeys(HEAL_COUNTS, 0), f"{day}: already in its planned end state"
        )
    # 2. The windows, right before the day's transaction.
    runs.refuse_in_window(allow_market_hours, f"{day}: ")
    # 3. The approved plan exactly, or nothing.
    settings, _ = _settings_for(conn, day, assume_default=planned.settings == ASSUMED_DEFAULT)
    done = ibr.heal_day(
        conn,
        con,
        runs.tape_url(day),
        day,
        settings,
        insert_missed=_insert_missed(day),
        apply=True,
        expect_sha256=planned.plan.sha256,
    )
    counts = {name: getattr(done, name) for name in HEAL_COUNTS}
    wanted = dict(zip(HEAL_COUNTS, _write_counts(planned.plan), strict=True))
    shown = ", ".join(f"{name} {value}" for name, value in counts.items())
    problem = None
    if counts != wanted:
        planned_text = ", ".join(f"{name} {value}" for name, value in wanted.items())
        problem = (
            f"{day}: committed, but the database reported {shown} where the plan had"
            f" {planned_text}: another writer moved the day between heal_day's plan and its"
            " write. The day is marked as applied; check it before going on"
        )
    return runs.DayDone("applied", counts, f"{day}: {shown}", problem)


HEAL = runs.ApplyMode(
    name="heal",
    expect=_HEAL_EXPECT,
    load_day=_load_heal_day,
    apply_day=_apply_heal_day,
    finish=_append_measured,
)


# --- export: the full-year replay for studies -------------------------------------------------

EXPORT_PREFIX = "research/interval-ba/"


def export_key(end: date) -> str:
    return f"{EXPORT_PREFIX}replay-{end.isoformat()}.parquet"


def _refuse_overwrite(r2: runs.R2Bucket, key: str) -> None:
    if runs.object_exists(r2, key):
        raise RefusedError(
            f"R2 already holds {key}, and the tool does not overwrite an object (the owner"
            " decides on deletes in the bucket). Delete it, or export to another --to"
        )


def _export(args: argparse.Namespace, out: runs.Output) -> int:
    return _export_per_day(args, out) if args.per_day else _export_snapshot(args, out)


def _export_snapshot(args: argparse.Namespace, out: runs.Output) -> int:
    """Read-only for Neon: it never connects. Replays every day with today's rule and writes
    the alerts to the run folder and to R2, verified."""
    days = runs.trading_days(args.start, args.end)
    if not days:
        raise UsageError("no trading day in that range")
    runs.refuse_in_window(args.allow_market_hours)
    env = runs.load_env(args.env_file)
    out.hide(env)
    r2 = runs.r2_bucket(env)
    key = export_key(args.end)
    _refuse_overwrite(r2, key)  # before hours of replays, and again before the put
    run = runs.new_run("export")
    out.say(f"run folder: {run}")
    alerts: list[Any] = []
    per_day: dict[str, dict[str, Any]] = {}
    con = runs.tape_connection()
    try:
        for day in days:
            with runs.stops_at(out, day):
                replay = ibr.replay_day(con, runs.tape_url(day), day)
            alerts += replay.alerts
            per_day[day.isoformat()] = {
                "tickers": {t: sum(a.ticker == t for a in replay.alerts) for t in ibr.TICKERS},
                "root_label_mismatch": replay.root_label_mismatch,
            }
            out.say(f"{day}: {len(replay.alerts)} alerts")
    finally:
        con.close()

    blobs = runs.code_blobs()
    meta = {
        "from": args.start.isoformat(),
        "to": args.end.isoformat(),
        "rows": len(alerts),
        "module_blob": blobs["module_blob"],
        "tool_blobs": blobs["tool_blobs"],
        "rule": ibr.rule(),
        "created_at": runs.utc_now().isoformat(),
    }
    path = run / f"replay-{args.end}.parquet"
    pq.write_table(ibr.export_table(alerts, meta), path)
    body = path.read_bytes()  # what is hashed is what is put
    sha256 = hashlib.sha256(body).hexdigest()
    rows = len(alerts)
    _refuse_overwrite(r2, key)  # the object may have appeared during the replays
    runs.put_verified(
        r2,
        key,
        body,
        {
            "sha256": sha256,
            "rows": str(rows),
            "module-blob": blobs["module_blob"],
            "from": meta["from"],
            "to": meta["to"],
            **ibr.rule(),
        },
        content_type="application/vnd.apache.parquet",
        what="export",
    )
    runs.write_json(
        run / "export.json",
        {
            **{name: meta[name] for name in ("from", "to", "rows", "module_blob", "tool_blobs")},
            "rule": meta["rule"],
            "sha256": sha256,
            "bytes": len(body),
            "r2_key": key,
            "root_label_mismatch": sum(d["root_label_mismatch"] for d in per_day.values()),
            "days": per_day,
            "exported_at": runs.utc_now().isoformat(),
        },
    )
    out.say(f"export: {rows} alerts over {len(days)} days in {path}; R2 copy {key}, verified")
    return 0


# --- export --per-day: one replay file per session, the files the nightly step writes ---------

_PARQUET = "application/vnd.apache.parquet"


@dataclass(frozen=True)
class DayFile:
    """One day file as put and checked: its day and key, its alert count, its size and sha256,
    and the kept tape rows whose underlying_symbol was not their OCC root."""

    day: date
    key: str
    rows: int
    size: int
    sha256: str
    root_label_mismatch: int

    def to_json(self) -> dict[str, Any]:
        return {
            "day": self.day.isoformat(),
            "key": self.key,
            "rows": self.rows,
            "bytes": self.size,
            "sha256": self.sha256,
            "root_label_mismatch": self.root_label_mismatch,
        }


def _put_day_file(r2: runs.R2Bucket, replay: Any) -> DayFile:
    """The replay as its day's file: the replay module's table and footer, as the nightly step
    builds them, put to the day's key and checked (size and ETag). An existing object is
    overwritten, because a day file is an output that a re-run rewrites. The nightly step's put
    sets no object metadata, so this one sets none: the footer holds the day, rows, rule and
    time."""
    meta = ibr.day_meta(replay.day, len(replay.alerts), runs.utc_now())
    buffer = io.BytesIO()
    pq.write_table(ibr.export_table(replay.alerts, meta), buffer)
    body = buffer.getvalue()
    key = ibr.day_key(replay.day)
    runs.put_verified(r2, key, body, {}, content_type=_PARQUET, what="day file")
    return DayFile(
        replay.day,
        key,
        len(replay.alerts),
        len(body),
        hashlib.sha256(body).hexdigest(),
        replay.root_label_mismatch,
    )


def write_replay_days(
    days: Sequence[date],
    *,
    allow_market_hours: bool,
    env_file: str | None = None,
    out: runs.Output | None = None,
) -> list[DayFile]:
    """Replay each of `days` from its tape and write it as its day's file in R2,
    `research/interval-ba/replay/{day}.parquet`, the file the nightly step writes. The caller
    gives the trading days; a failed day stops the run, and the days before it keep their
    files, so running again over the same days resumes.

    It never touches Neon, and it overwrites. It refuses (RefusedError) when:
    - the replay module is not the one on origin/main, which is the code the nightly job runs
      (`runs.refuse_unless_deployed_code`);
    - a refusal window is open at the start, and again before each day's put: a run of many
      minutes must not write into the nightly window, where the step may rewrite a re-landed
      day and a late put of this run would bring back the old tape's file.

    `allow_market_hours` lifts the market-hours window only, as for the other writing modes.
    The readers' repair calls this with it set: it writes research files, never Neon.
    """
    if not days:
        return []
    out = out or runs.Output()
    runs.refuse_unless_deployed_code()
    runs.refuse_in_window(allow_market_hours)
    env = runs.load_env(env_file)
    out.hide(env)
    r2 = runs.r2_bucket(env)
    written: list[DayFile] = []
    con = runs.tape_connection()
    try:
        for day in days:
            with runs.stops_at(out, day):
                replay = ibr.replay_day(con, runs.tape_url(day), day)
                runs.refuse_in_window(allow_market_hours, f"{day}: ")  # the replay took a while
                done = _put_day_file(r2, replay)
            written.append(done)
            out.say(f"{day}: {done.rows} alerts, {done.size} bytes, {done.key}")
    finally:
        con.close()
    return written


def _export_per_day(args: argparse.Namespace, out: runs.Output) -> int:
    """`export --per-day`: write_replay_days over the range's trading days, then a record of
    the run. A day that fired no alerts still has its zero-row file, but it is a fault (no
    session has fired fewer than 19), so the run ends 1 and names it."""
    days = runs.trading_days(args.start, args.end)
    if not days:
        raise UsageError("no trading day in that range")
    written = write_replay_days(
        days, allow_market_hours=args.allow_market_hours, env_file=args.env_file, out=out
    )
    blobs = runs.code_blobs()
    run = runs.new_run("export-days")
    rows = sum(done.rows for done in written)
    runs.write_json(
        run / "export.json",
        {
            "per_day": True,
            "from": args.start.isoformat(),
            "to": args.end.isoformat(),
            "rows": rows,
            "module_blob": blobs["module_blob"],
            "tool_blobs": blobs["tool_blobs"],
            "rule": ibr.rule(),
            "days": [done.to_json() for done in written],
            "exported_at": runs.utc_now().isoformat(),
        },
    )
    out.say(
        f"export --per-day: {rows} alerts in {len(written)} day files under"
        f" {ibr.REPLAY_DAYS_PREFIX}, each put and checked; record {run / 'export.json'}"
    )
    empty = [done.day.isoformat() for done in written if done.rows == 0]
    if empty:
        out.say(
            f"FLAG: {', '.join(empty)} fired no alerts, and a zero-row file was written for"
            " each. Every session fires at least 19, so the replay or the tape read is at fault:"
            " fix the cause, then write the day again with export --per-day",
            err=True,
        )
        return 1
    return 0


# --- undo: a run's applied days, back to its backup -------------------------------------------

# Every column of interval_ba_alerts, as the backup holds it and the restore writes it back.
_RESTORE_COLUMNS: tuple[str, ...] = ("id", *_TAPE_FIELDS, "acknowledged", "source")
# How take_backup wrote each column: NUMERIC as a string, times and dates in ISO form.
_RESTORE_KINDS: dict[str, str] = {
    "id": "int",
    "option_chain": "str",
    "ticker": "str",
    "option_type": "str",
    "strike": "decimal",
    "expiry": "date",
    "bucket_start": "instant",
    "bucket_end": "instant",
    "fired_at": "instant",
    "ratio_pct": "decimal",
    "ask_premium": "decimal",
    "total_premium": "decimal",
    "trade_count": "int",
    "top_trade_premium": "decimal",
    "top_trade_size": "int",
    "top_trade_executed_at": "instant",
    "top_trade_is_sweep": "bool",
    "top_trade_is_floor": "bool",
    "underlying_price": "decimal",
    "confluence_tickers": "list",
    "acknowledged": "bool",
    "source": "str",
}

# A restored row keeps its id; any conflict, on the id or the key, skips it, and the count
# check after it stops the day.
_RESTORE_SQL = (
    "INSERT INTO interval_ba_alerts ("
    + ", ".join(_RESTORE_COLUMNS)
    + ") VALUES %s ON CONFLICT DO NOTHING RETURNING id"
)
# A live row's flags go back only while they still hold what the heal wrote.
_UNDO_FLAGS_SQL = (
    "UPDATE interval_ba_alerts AS a"
    " SET top_trade_is_sweep = v.old_sweep, top_trade_is_floor = v.old_floor"
    " FROM (VALUES %s) AS v(id, day, new_sweep, new_floor, old_sweep, old_floor)"
    " WHERE a.id = v.id AND a.expiry = v.day AND a.source = 'live'"
    " AND a.top_trade_is_sweep IS NOT DISTINCT FROM v.new_sweep"
    " AND a.top_trade_is_floor IS NOT DISTINCT FROM v.new_floor"
    " RETURNING a.id"
)
_UNDO_FLAGS_TEMPLATE = "(%s::bigint, %s::date, %s::boolean, %s::boolean, %s::boolean, %s::boolean)"
# A live SPXW spot goes back only while it still holds what the heal wrote.
_UNDO_SPOT_SQL = (
    "UPDATE interval_ba_alerts AS a SET underlying_price = v.old_price"
    " FROM (VALUES %s) AS v(id, day, new_price, old_price)"
    " WHERE a.id = v.id AND a.expiry = v.day AND a.source = 'live' AND a.ticker = 'SPXW'"
    " AND a.underlying_price = v.new_price"
    " RETURNING a.id"
)
_UNDO_SPOT_TEMPLATE = "(%s::bigint, %s::date, %s::numeric, %s::numeric)"
_UNDO_COUNTS = ("deleted", "reinserted", "flags_restored", "spot_restored")


def _restore_value(name: str, value: Any) -> Any:
    """A backup value as its column takes it back. Raises TypeError, ValueError or an
    ArithmeticError for a value take_backup would not have written."""
    if value is None:
        return None
    kind = _RESTORE_KINDS[name]
    if kind == "decimal" and isinstance(value, str):
        return Decimal(value)
    if kind == "date" and isinstance(value, str):
        return date.fromisoformat(value)
    if kind == "instant" and isinstance(value, str):
        at = datetime.fromisoformat(value)
        if at.tzinfo is None:
            raise ValueError(f"{name} {value} has no UTC offset")
        return at
    if kind == "list" and isinstance(value, list) and all(isinstance(v, str) for v in value):
        return value
    if (kind, type(value)) in {("int", int), ("str", str), ("bool", bool)}:
        return value
    raise TypeError(f"{name} holds a {type(value).__name__}, not a {kind}")


def _backup_rows(run: Path, days: set[date]) -> tuple[dict[date, dict[int, dict]], set[int]]:
    """The backup's rows on `days`, by day and id, as the table takes them back, and every id
    the backup holds. Refuses a backup whose rows are not the columns undo restores."""
    by_day: dict[date, dict[int, dict]] = {}
    ids: set[int] = set()
    for n, record in enumerate(runs.read_backup(run), start=1):
        try:
            if not isinstance(record, dict) or set(record) != set(_RESTORE_COLUMNS):
                raise TypeError("its columns are not the ones undo restores")
            row_id = _restore_value("id", record["id"])
            ids.add(row_id)
            expiry = _restore_value("expiry", record["expiry"])
            if expiry in days:
                by_day.setdefault(expiry, {})[row_id] = {
                    name: _restore_value(name, record[name]) for name in _RESTORE_COLUMNS
                }
        except (ValueError, TypeError, ArithmeticError) as exc:
            raise RefusedError(
                f"backup.jsonl line {n} is not a row undo can restore ({type(exc).__name__}: {exc})"
            ) from None
    return by_day, ids


@dataclass(frozen=True)
class UndoDay:
    """One day's restore: replay rows to delete, backup rows to put back with their ids, live
    flags and spots to set back, and how many planned restores were left because the row
    changed since the run. A flag is (id, day, heal's sweep, heal's floor, the backup's sweep,
    the backup's floor); a spot is (id, day, heal's spot, the backup's spot)."""

    deletes: tuple[int, ...]
    inserts: tuple[dict[str, Any], ...]
    flags: tuple[tuple[Any, ...], ...]
    spots: tuple[tuple[Any, ...], ...]
    left: int


def _undo_rebuild(rows: Sequence[StoredRow], backup: dict[int, dict]) -> UndoDay:
    """The day's replay rows deleted and the backup's replay rows put back, ids and all (spec
    6.5). Live rows are neither deleted nor taken from the backup. A backup row whose key a live
    row holds now cannot go back; the count check after the write stops the day then."""
    deletes = tuple(sorted(row.id for row in rows if row.source == "replay"))
    inserts = tuple(row for _, row in sorted(backup.items()) if row["source"] == "replay")
    return UndoDay(deletes, inserts, (), (), 0)


def _backup_row(day: date, backup: dict[int, dict], row_id: int, wrote: str) -> dict[str, Any]:
    """The backup's row `row_id` on `day`. Every row a run wrote was in its backup, so a missing
    one means the plan is not the run's: the undo stops."""
    row = backup.get(row_id)
    if row is None:
        raise CheckFailedError(
            f"{day}: the run {wrote} row {row_id}, which the backup does not hold on this day;"
            " the plan is not the one this run applied. The undo stops"
        )
    return row


def _undo_heal(
    day: date,
    rows: Sequence[StoredRow],
    plan: Any,
    backup: dict[int, dict],
    backup_ids: set[int],
    *,
    wrote_it: bool,
) -> UndoDay:
    """What a heal day wrote, put back where it still holds what the heal wrote: its inserts
    deleted (rows the backup never held, still with the inserted values), its removed replay
    rows put back with their ids where their key is free, and its flags and spots set back to
    the backup's where they still hold the heal's values. The rest is counted as left.

    `wrote_it` is a day this run's own transaction applied (marked "applied"). Every row it
    removed was in the backup, so one missing stops the undo. A day found in its end state was
    written by someone else before the backup, which then need not hold the rows they removed:
    there a missing one is only left.

    A live row is never deleted or inserted: the DELETE and the UPDATEs carry the source in their
    SQL, with the values they expect, so a row that moved during the undo fails the count check
    rather than be written."""
    by_id = {row.id: row for row in rows}
    by_key = {row.key: row for row in rows}
    left = 0
    deletes = []
    for alert in plan.inserts:
        row = by_key.get(alert.key)
        if (
            row is not None
            and row.id not in backup_ids
            and _row_values(row) == _alert_values(alert)
        ):
            deletes.append(row.id)
        else:
            left += 1
    kept_keys = {row.key for row in rows if row.id not in deletes}
    inserts = []
    for row_id in plan.removes:
        if row_id not in backup and not wrote_it:
            left += 1
            continue
        then = _backup_row(day, backup, row_id, "removed")
        if then["source"] != "replay":
            raise CheckFailedError(
                f"{day}: the run removed row {row_id}, which the backup holds as a live row; a"
                " heal removes only replay rows. The undo stops"
            )
        if (then["option_chain"], then["bucket_start"]) in kept_keys:  # this row, or another
            left += 1
        else:
            inserts.append(then)
    flags = []
    for row_id, sweep, floor in plan.flag_updates:
        then = _backup_row(day, backup, row_id, "updated")
        row = by_id.get(row_id)
        if row is not None and (
            row.values["top_trade_is_sweep"],
            row.values["top_trade_is_floor"],
        ) == (sweep, floor):
            flags.append(
                (row_id, day, sweep, floor, then["top_trade_is_sweep"], then["top_trade_is_floor"])
            )
        else:
            left += 1
    spots = []
    for row_id, price in plan.spot_updates:
        then = _backup_row(day, backup, row_id, "updated")
        row = by_id.get(row_id)
        if row is not None and row.values["underlying_price"] == price:
            spots.append((row_id, day, price, then["underlying_price"]))
        else:
            left += 1
    return UndoDay(tuple(sorted(deletes)), tuple(inserts), tuple(flags), tuple(spots), left)


def _undo_day(
    conn: Any,
    run: Path,
    mode: str,
    day: date,
    planned: Any,
    backup: tuple[dict[date, dict[int, dict]], set[int]],
    allow_market_hours: bool,
) -> tuple[dict[str, int], int] | None:
    """One day, in one transaction: None for a day left alone (the run neither marked it nor
    left it in its planned end state, or it is unmarked with nothing to restore), else the
    counts written and the restores left. The marker is written after the commit."""
    by_day, backup_ids = backup
    marker = runs.marker_path(run, day.isoformat())
    applied = marker.exists()
    try:
        with conn.cursor() as cur:
            runs.set_local_timeouts(cur)
        rows = read_day_rows(conn, day)
        if not applied:
            in_end = (
                in_end_state(rows, planned)
                if mode == "rebuild"
                else heal_end_state(rows, planned.plan)
            )
            if not in_end:
                conn.rollback()
                return None
        backup_day = by_day.get(day, {})
        undo = (
            _undo_rebuild(rows, backup_day)
            if mode == "rebuild"
            else _undo_heal(
                day,
                rows,
                planned.plan,
                backup_day,
                backup_ids,
                # "end state": the apply found the day already written, by someone else.
                wrote_it=applied
                and json.loads(marker.read_text(encoding="utf-8")).get("how") != "end state",
            )
        )
        if not applied and not (undo.deletes or undo.inserts or undo.flags or undo.spots):
            conn.rollback()  # in its end state with nothing to put back: no run wrote it
            return None
        acked = [row.id for row in rows if row.id in undo.deletes and row.acknowledged]
        if acked:
            raise CheckFailedError(
                f"{day}: row(s) {', '.join(map(str, acked[:10]))} hold an acknowledgement, which"
                " the undo's delete would lose. The undo stops"
            )
        runs.refuse_in_window(allow_market_hours, f"{day}: ")
        with conn.cursor() as cur:
            counts = {
                "deleted": _delete_replay_rows(cur, day, undo.deletes),
                "reinserted": len(
                    psycopg2.extras.execute_values(
                        cur,
                        _RESTORE_SQL,
                        [tuple(row[c] for c in _RESTORE_COLUMNS) for row in undo.inserts],
                        page_size=_PAGE_ROWS,
                        fetch=True,
                    )
                ),
                "flags_restored": len(
                    psycopg2.extras.execute_values(
                        cur,
                        _UNDO_FLAGS_SQL,
                        undo.flags,
                        template=_UNDO_FLAGS_TEMPLATE,
                        page_size=_PAGE_ROWS,
                        fetch=True,
                    )
                ),
                "spot_restored": len(
                    psycopg2.extras.execute_values(
                        cur,
                        _UNDO_SPOT_SQL,
                        undo.spots,
                        template=_UNDO_SPOT_TEMPLATE,
                        page_size=_PAGE_ROWS,
                        fetch=True,
                    )
                ),
            }
        wanted = dict(
            zip(
                _UNDO_COUNTS,
                (len(undo.deletes), len(undo.inserts), len(undo.flags), len(undo.spots)),
                strict=True,
            )
        )
        if counts != wanted:
            raise CheckFailedError(
                f"{day}: the database wrote {counts} where the undo planned {wanted}: another"
                " writer moved the day, or the plan names a row these writes may not touch."
                " Rolled back"
            )
        conn.commit()
    except BaseException:
        with contextlib.suppress(psycopg2.Error):
            conn.rollback()
        raise
    runs.mark_undone(run, day, {**counts, "left": undo.left})
    return counts, undo.left


def _undo(args: argparse.Namespace, out: runs.Output) -> int:
    run = Path(args.run)
    if (run / "export.json").is_file():
        raise UsageError(
            f"{run.name} is an export run: it wrote nothing to Neon, so nothing to undo"
        )
    plan = runs.load_plan(run)
    mode = {"rebuild": REBUILD, "heal": HEAL}.get(plan.get("mode"))
    if mode is None:
        raise UsageError(
            f"{run} holds a {plan.get('mode')} plan; undo restores rebuild and heal runs"
        )
    runs.refuse_in_window(args.allow_market_hours)
    if not (run / "backup.json").is_file():
        raise RefusedError(
            f"{run.name} holds no backup, which undo restores from: its apply never got past its"
            " start checks, so it wrote nothing"
        )
    try:
        days = [date.fromisoformat(day) for day in sorted(plan["days"])]
        planned = {day: mode.load_day(run, day, plan["days"][day.isoformat()]) for day in days}
    except (ValueError, KeyError, TypeError) as exc:
        raise RefusedError(
            f"{run / 'plan.json'} is not a plan undo can read ({type(exc).__name__}: {exc})"
        ) from None
    pending = [day for day in days if not runs.undone_path(run, day.isoformat()).exists()]
    if not pending:
        out.say(f"every day of {run.name} is undone")
        return 0
    backup = _backup_rows(run, set(pending))

    env = runs.load_env(args.env_file)
    out.hide(env)
    conn = runs.connect(env, readonly=False)
    undone = 0
    try:
        for day in pending:
            with runs.stops_at(out, day):
                result = _undo_day(
                    conn, run, mode.name, day, planned[day], backup, args.allow_market_hours
                )
            if result is None:
                out.say(
                    f"{day}: not applied by this run (no marker, and none of its writes to put"
                    " back); left alone"
                )
                continue
            counts, left = result
            undone += 1
            shown = ", ".join(f"{name} {value}" for name, value in counts.items())
            out.say(f"{day}: undone: {shown}; left {left} (changed since the run)")
    finally:
        conn.close()
    out.say(f"undid {undone} day(s) of {run.name}; markers in {run}")
    return 0


# --- The command line -------------------------------------------------------------------------


def _rebuild(args: argparse.Namespace, out: runs.Output) -> int:
    if args.apply:
        if args.start is not None or args.end is not None:
            raise UsageError("--apply takes its days from --run's plan, not --from/--to")
        if args.run is None or args.expect_delete is None or args.expect_insert is None:
            raise UsageError("--apply needs --run, --expect-delete and --expect-insert")
        return runs.apply_run(
            REBUILD,
            Path(args.run),
            {"delete": args.expect_delete, "insert": args.expect_insert},
            allow_market_hours=args.allow_market_hours,
            env_file=args.env_file,
            out=out,
        )
    if args.run is not None or args.expect_delete is not None or args.expect_insert is not None:
        raise UsageError("--run and --expect-* go with --apply")
    return _rebuild_dry_run(args, out)


def _heal(args: argparse.Namespace, out: runs.Output) -> int:
    expected = {name: getattr(args, f"expect_{name}") for name in _HEAL_EXPECT}
    if args.apply:
        if args.start is not None or args.end is not None:
            raise UsageError("--apply takes its days from --run's plan, not --from/--to")
        if args.assume_default_settings:
            raise UsageError(
                "--assume-default-settings goes with the dry run; its plan records the days it"
                " covered"
            )
        if args.run is None or None in expected.values():
            raise UsageError(
                "--apply needs --run, --expect-insert, --expect-remove, --expect-flags and"
                " --expect-spot"
            )
        return runs.apply_run(
            HEAL,
            Path(args.run),
            expected,
            allow_market_hours=args.allow_market_hours,
            env_file=args.env_file,
            out=out,
        )
    if args.run is not None or any(value is not None for value in expected.values()):
        raise UsageError("--run and --expect-* go with --apply")
    return _heal_dry_run(args, out)


def _count(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be 0 or more")
    return value


def _parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--env-file",
        help="the env file with DATABASE_URL and R2_* (default: .env.local here, else the"
        " main checkout's)",
    )
    # The modes that write (Neon or R2) refuse the two windows; this flag lifts the first.
    windows = argparse.ArgumentParser(add_help=False)
    windows.add_argument(
        "--allow-market-hours",
        action="store_true",
        help="run inside weekdays 08:15-16:00 CT (a market holiday); never 07:15-12:30 UTC",
    )
    parser = argparse.ArgumentParser(
        prog="interval_ba_tape.py",
        description="Interval B/A history from the UW Full Tape (spec 6.5).",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    verify = commands.add_parser("verify", parents=[common], help="compare the table with the tape")
    verify.add_argument("--from", dest="start", type=date.fromisoformat, required=True)
    verify.add_argument("--to", dest="end", type=date.fromisoformat, required=True)
    verify.set_defaults(handler=_verify)

    rebuild = commands.add_parser(
        "rebuild",
        parents=[common, windows],
        help="rebuild the days with no live rows (dry run by default)",
    )
    rebuild.add_argument("--from", dest="start", type=date.fromisoformat)
    rebuild.add_argument("--to", dest="end", type=date.fromisoformat)
    rebuild.add_argument("--apply", action="store_true", help="write a dry run's plan")
    rebuild.add_argument("--run", help="the dry run's folder")
    rebuild.add_argument("--expect-delete", type=_count)
    rebuild.add_argument("--expect-insert", type=_count)
    rebuild.set_defaults(handler=_rebuild)

    heal = commands.add_parser(
        "heal",
        parents=[common, windows],
        help="correct the live days' flags and SPXW spot, and from 2026-10-29 add the alerts"
        " live missed (dry run by default)",
    )
    heal.add_argument("--from", dest="start", type=date.fromisoformat)
    heal.add_argument("--to", dest="end", type=date.fromisoformat)
    heal.add_argument(
        "--assume-default-settings",
        action="store_true",
        help="for a day no interval_ba_live_settings row covers, assume the code's rule with all"
        " three tickers on",
    )
    heal.add_argument("--apply", action="store_true", help="write a dry run's plan")
    heal.add_argument("--run", help="the dry run's folder")
    for name in _HEAL_EXPECT:
        heal.add_argument(f"--expect-{name}", type=_count)
    heal.set_defaults(handler=_heal)

    export = commands.add_parser(
        "export",
        parents=[common, windows],
        help="write the replay of every day to R2 and a run folder (no Neon access)",
    )
    export.add_argument("--from", dest="start", type=date.fromisoformat, required=True)
    export.add_argument("--to", dest="end", type=date.fromisoformat, required=True)
    export.add_argument(
        "--per-day",
        action="store_true",
        help="write one file per day, research/interval-ba/replay/<day>.parquet, as the nightly"
        " step does, overwriting; only from a checkout at origin/main",
    )
    export.set_defaults(handler=_export)

    undo = commands.add_parser(
        "undo",
        parents=[common, windows],
        help="put a rebuild or heal run's applied days back to its backup",
    )
    undo.add_argument("--run", required=True, help="the run's folder")
    undo.set_defaults(handler=_undo)
    return parser


def main(argv: list[str] | None = None) -> int:
    out = runs.Output()
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse's own exit: 2 for an error, 0 for --help
        return exc.code if isinstance(exc.code, int) else 2
    try:
        return args.handler(args, out)
    except UsageError as exc:
        out.say(f"error: {exc}", err=True)
        return 2
    except (RefusedError, ibr.PlanChanged) as exc:
        out.say(f"REFUSED ({type(exc).__name__}): {exc}", err=True)
        return 3
    except CheckFailedError as exc:  # BackupFailedError included
        out.say(f"STOPPED ({type(exc).__name__}): {exc}", err=True)
        return 1
    except runs.QUIET_ERRORS as exc:
        out.say(
            f"FAILED: {type(exc).__name__} (its text is not shown: it can name a host)", err=True
        )
        return 1
    except (ValueError, duckdb.Error, OSError) as exc:
        out.say(f"FAILED: {type(exc).__name__}: {exc}", err=True)
        return 1
    except Exception:
        out.say(traceback.format_exc(), err=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
