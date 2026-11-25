"""Interval B/A history from the UW Full Tape: compare it with the table, and rebuild the days
the live feed never covered.

Spec: docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, section 6.5. The
detector is the shared replay module nightly/src/interval_ba_replay.py, loaded by its path. The
tape is read from R2 through DuckDB's httpfs (ml/src/utils/r2.py); the table is production Neon.
The mode-agnostic machinery (connections, windows, run folders, the backup and the apply
driver) is in interval_ba_tape_runs.py beside this file; this file holds the command line and
the modes.

Modes:

- `verify --from D --to D`: read-only. Replays each trading day and compares it with the stored
  rows on the key (option_chain, bucket_start), then on every column except fired_at,
  confluence_tickers, the two flags and the SPXW spot. On 2026-05-13 and 2026-07-22 it compares
  only the rebuild's window (below) against the day's replay rows. Prints a per-day table and
  each differing row. Exit 0 when every day matches, 1 when any differs.
- `rebuild [--from D --to D]`: a dry run of the delete-and-insert over the days with no live
  rows (spec 5.1). Writes a run folder with the plan and changes nothing.
- `rebuild --apply --run <folder> --expect-delete N --expect-insert N`: applies that plan.
- `heal`, `export` and `undo` exit 2: they are not built yet.

The rebuild's days: every trading day from 2026-01-02 to 2026-05-12 and from 2026-07-23 to
2026-09-04, plus 2026-05-13 for the tape alerts that fired before that day's first live row and
2026-07-22 for those after its last live row. It refuses any other day. Per day it deletes the
day's unacknowledged `source = 'replay'` rows and inserts the tape alerts in the window as
`source = 'replay'`. A tape key that already has a live row is skipped and listed on the two
edge days; on any other day a live row stops the dry run, because live never ran there. The two
edge days' bounds must be the ones spec section 4 names (the first live row in 15:55:37Z on
05-13; 11 live rows on 07-22, the last in 14:52:46Z), or the run stops. A live row is never
deleted.

A run folder, docs/tmp/interval-ba-rebuild/<UTC stamp>-rebuild/, holds:

- plan.json: per day and ticker the counts, one sha256 per day over the day and its exact write
  set, the git blob hash of the replay module and of every file of the tool, and
  root_label_mismatch;
- days/<day>.json: the day's full write lists;
- report.md: the counts and bound per day, the live twins skipped, and before/after per ticker
  and month;
- once applied: backup.jsonl and backup.json (the backup), and a <day>.applied marker per day.

An apply refuses (exit 3) when a refusal window is open, when a code file's blob hash differs
from the plan's, when plan.json or a pending day file is damaged or disagrees with the other,
or when an --expect total differs from the plan's total over the days not yet applied. Its first
apply writes every row of interval_ba_alerts to backup.jsonl, reads it back, copies it to R2 at
backups/interval-ba-alerts/<UTC stamp>.jsonl and checks the copy, before any write; a later
apply of the same run takes no new backup. Then, per day not yet marked:

1. if the day's rows already equal the plan's end state, write the marker and go on;
2. replay the day and, in the day's transaction before any write, re-plan it and compare the
   sha256 with the plan's (PlanChanged, exit 3, on a difference);
3. check the refusal windows again;
4. delete and insert, check the counts the database reports, and commit;
5. write the marker.

Any failed day stops the run; the days before it keep their markers, so a rerun resumes.

Refusal windows, for both rebuild runs: weekdays 08:15 to 16:00 CT (`--allow-market-hours`
overrides it, for a market holiday) and every day 07:15 to 12:30 UTC, the nightly run.

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

Exit codes: 0 ok, 1 an error or a failed check, 2 bad arguments, 3 refused.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import traceback
from collections.abc import Sequence
from dataclasses import dataclass, fields
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any

import duckdb
import psycopg2
import psycopg2.extras

# The shared machinery sits beside this file; -I keeps this folder off sys.path.
_SCRIPTS = str(Path(__file__).resolve().parent)
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

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
    """The trading days from start to end (the whole list by default). Refuses a range that
    holds any day outside the rebuild's list."""
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


def _planned_months(plan: dict[str, Any]) -> dict[tuple[str, str], tuple[int, int]]:
    counts: dict[tuple[str, str], tuple[int, int]] = {}
    for day, entry in plan["days"].items():
        for ticker, c in entry["tickers"].items():
            before, after = counts.get((day[:7], ticker), (0, 0))
            counts[(day[:7], ticker)] = (before + c["before"], after + c["after"])
    return counts


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
    lines += _month_table(_planned_months(plan))
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
    except (OSError, ValueError, KeyError, TypeError) as exc:
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
        key: (before, now.get(key, 0)) for key, (before, _) in _planned_months(plan).items()
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


def _not_yet(args: argparse.Namespace, out: runs.Output) -> int:
    out.say(f"{args.command}: not yet (it comes with the tool's part 2)", err=True)
    return 2


_PART_TWO = ("heal", "export", "undo")


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
        "rebuild", parents=[common], help="rebuild the days with no live rows (dry run by default)"
    )
    rebuild.add_argument("--from", dest="start", type=date.fromisoformat)
    rebuild.add_argument("--to", dest="end", type=date.fromisoformat)
    rebuild.add_argument("--apply", action="store_true", help="write a dry run's plan")
    rebuild.add_argument("--run", help="the dry run's folder")
    rebuild.add_argument("--expect-delete", type=_count)
    rebuild.add_argument("--expect-insert", type=_count)
    rebuild.add_argument(
        "--allow-market-hours",
        action="store_true",
        help="run inside weekdays 08:15-16:00 CT (a market holiday); never 07:15-12:30 UTC",
    )
    rebuild.set_defaults(handler=_rebuild)

    for name in _PART_TWO:
        commands.add_parser(name, help="not yet").set_defaults(handler=_not_yet)
    return parser


def main(argv: list[str] | None = None) -> int:
    out = runs.Output()
    parser = _parser()
    try:
        args, extra = parser.parse_known_args(argv)
        if extra and args.command not in _PART_TWO:
            parser.error(f"unrecognized arguments: {' '.join(extra)}")
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
