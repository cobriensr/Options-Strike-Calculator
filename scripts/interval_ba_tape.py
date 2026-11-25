"""Interval B/A history from the UW Full Tape: compare it with the table, and rebuild the days
the live feed never covered.

Spec: docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, section 6.5. The
detector is the shared replay module nightly/src/interval_ba_replay.py, loaded by its path. The
tape is read from R2 through DuckDB's httpfs (ml/src/utils/r2.py); the table is production Neon.

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
day's `source = 'replay'` rows and inserts the tape alerts in the window as `source = 'replay'`.
A tape key that already has a live row is skipped and listed on the two edge days; on any other
day a live row stops the dry run, because live never ran there. A live row is never deleted.

A run folder, docs/tmp/interval-ba-rebuild/<UTC stamp>-rebuild/, holds:

- plan.json: per day and ticker the counts, one sha256 per day over the day and its exact write
  set, the git blob hashes of the module and this tool, and root_label_mismatch;
- days/<day>.json: the day's full write lists;
- report.md: the counts per day, the live twins skipped, and before/after per ticker and month;
- once applied: backup.jsonl and backup.json (the backup), and a <day>.applied marker per day.

An apply refuses (exit 3) when a refusal window is open, when the module's or the tool's blob
hash differs from the plan's, or when an --expect total differs from the plan's total over the
days not yet applied. Its first apply writes every row of interval_ba_alerts to backup.jsonl,
reads it back, copies it to R2 at backups/interval-ba-alerts/<UTC stamp>.jsonl and checks the
copy's metadata, before any write; a later apply of the same run takes no new backup. Then, per
day not yet marked:

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
redacted, and a database or R2 client error prints its class only. DATABASE_URL is production.

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
import hashlib
import importlib.util
import itertools
import json
import os
import sys
import tempfile
import traceback
import warnings
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, fields
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

import boto3
import duckdb
import psycopg2
import psycopg2.extras
from boto3.exceptions import Boto3Error
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from urllib3.exceptions import InsecureRequestWarning

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "nightly" / "src" / "interval_ba_replay.py"
TOOL_PATH = Path(__file__).resolve()
RUNS_DIR = REPO_ROOT / "docs" / "tmp" / "interval-ba-rebuild"

# ml/src holds utils.r2 (the tape over httpfs) and the --env-file resolution this tool shares
# with the anchor backfill. -I keeps both off sys.path, so add the folder here.
_ML_SRC = str(REPO_ROOT / "ml" / "src")
if _ML_SRC not in sys.path:
    sys.path.insert(0, _ML_SRC)

from anchor_backfill_extract import parse_env_file, resolve_env_file  # noqa: E402
from utils.r2 import fulltape_connection, r2_url  # noqa: E402


def _load_replay_module() -> ModuleType:
    """nightly/src/interval_ba_replay.py, by its path. nightly/src never goes on sys.path: its
    other modules would shadow this suite's. The module is registered under its name before it
    runs, because @dataclass under `from __future__ import annotations` looks it up there."""
    name = "interval_ba_replay"
    loaded = sys.modules.get(name)
    if loaded is not None and Path(loaded.__file__ or "").resolve() == MODULE_PATH.resolve():
        return loaded
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    return module


ibr = _load_replay_module()

_CT = ZoneInfo("America/Chicago")

# The rebuild's days (spec 6.5 and 9). On the two edge days only the stretch with no live rows.
FULL = "full"
BEFORE_FIRST_LIVE = "before first live row"
AFTER_LAST_LIVE = "after last live row"
FIRST_LIVE_DAY = ibr.LIVE_START  # 2026-05-13, first live row 15:55:37Z
LAST_LIVE_DAY_BEFORE_OUTAGE = date(2026, 7, 22)  # last live row 14:52:46Z
_FULL_REBUILD_RANGES = (
    (date(2026, 1, 2), date(2026, 5, 12)),
    (date(2026, 7, 23), date(2026, 9, 4)),
)
# NYSE full-day closures in 2026, copied from MARKET_CLOSED_DATES in src/data/marketHours.ts.
# The tool covers 2026 only and refuses other years.
_CLOSED_2026 = frozenset(
    date.fromisoformat(day)
    for day in (
        "2026-01-01",
        "2026-01-19",
        "2026-02-16",
        "2026-04-03",
        "2026-05-25",
        "2026-06-19",
        "2026-07-03",
        "2026-09-07",
        "2026-11-26",
        "2026-12-25",
    )
)
_CALENDAR_YEAR = 2026

# The feed shows at most this many alerts a day, between 08:30 and 15:00 CT (Review Focus 5).
FEED_CAP = 500
_FEED_START, _FEED_END = time(8, 30), time(15, 0)

# Refusal windows: weekdays in CT, every day in UTC (the nightly run).
_MARKET_START, _MARKET_END = time(8, 15), time(16, 0)
_NIGHTLY_START, _NIGHTLY_END = time(7, 15), time(12, 30)

BACKUP_PREFIX = "backups/interval-ba-alerts/"
_BACKUP_PAGE = 2000
_PAGE_ROWS = 500  # rows per write statement (spec 9)

_ENV_NAMES = (
    "DATABASE_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
)
_R2_ENV_NAMES = _ENV_NAMES[1:]


class UsageError(Exception):
    """Exit 2."""


class RefusedError(Exception):
    """Exit 3: a window, a hash, an --expect total or the day list says no."""


class CheckFailedError(Exception):
    """Exit 1: a check on the data failed. Its text names days, keys, ids and counts only."""


class BackupFailedError(CheckFailedError):
    """The backup did not verify; nothing was written."""


# --- Time and days ----------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def window_refusal(now: datetime, *, allow_market_hours: bool) -> str | None:
    """Why a writing mode may not run at `now`, or None."""
    utc = now.astimezone(UTC)
    if _NIGHTLY_START <= utc.time() < _NIGHTLY_END:
        return (
            f"{utc:%H:%M} UTC is inside 07:15-12:30 UTC, the nightly run's window"
            " (--allow-market-hours does not cover it)"
        )
    local = now.astimezone(_CT)
    if (
        not allow_market_hours
        and local.weekday() < 5
        and _MARKET_START <= local.time() < _MARKET_END
    ):
        return (
            f"{local:%a %H:%M} CT is inside weekdays 08:15-16:00 CT"
            " (pass --allow-market-hours on a market holiday)"
        )
    return None


def _refuse_in_window(allow_market_hours: bool, label: str = "") -> None:
    reason = window_refusal(_utc_now(), allow_market_hours=allow_market_hours)
    if reason is not None:
        raise RefusedError(f"{label}{reason}")


def trading_days(start: date, end: date) -> list[date]:
    """The NYSE trading days from start to end, both included."""
    if start > end:
        raise UsageError(f"--from {start} is after --to {end}")
    if start.year != _CALENDAR_YEAR or end.year != _CALENDAR_YEAR:
        raise UsageError(f"the tool's holiday table covers {_CALENDAR_YEAR} only")
    days, day = [], start
    while day <= end:
        if day.weekday() < 5 and day not in _CLOSED_2026:
            days.append(day)
        day += timedelta(days=1)
    return days


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
    for day in trading_days(_FULL_REBUILD_RANGES[0][0], _FULL_REBUILD_RANGES[-1][1])
    if rebuild_kind(day) is not None
)


def rebuild_days(start: date | None, end: date | None) -> list[date]:
    """The trading days from start to end (the whole list by default). Refuses a range that
    holds any day outside the rebuild's list."""
    days = trading_days(start or REBUILD_DAYS[0], end or REBUILD_DAYS[-1])
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


# --- Output -----------------------------------------------------------------------------------


class Output:
    """stdout and stderr with every secret value, and each part of the two URLs, redacted."""

    def __init__(self) -> None:
        self._secrets: list[str] = []

    def hide(self, env: dict[str, str]) -> None:
        parts: set[str] = set()
        for name, value in env.items():
            parts.add(value)
            if name.endswith("_URL"):
                url = urlsplit(value)
                host = url.hostname or ""
                # The host's first label is the R2 account id or the Neon endpoint id.
                parts.update(
                    filter(
                        None,
                        (url.netloc, host, host.split(".")[0], url.username, url.password),
                    )
                )
                if url.password:
                    parts.add(unquote(url.password))
        # Longest first, so a whole URL goes before its host. A part too short to be a secret
        # would only mangle the output.
        self._secrets = sorted((p for p in parts if len(p) >= 4), key=len, reverse=True)

    def redact(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "<redacted>")
        return text

    def say(self, text: str = "", *, err: bool = False) -> None:
        print(self.redact(text), file=sys.stderr if err else sys.stdout, flush=True)


# Their text can carry the database host or the R2 account; only their class is printed.
_QUIET_ERRORS = (psycopg2.Error, BotoCoreError, ClientError, Boto3Error)


@contextlib.contextmanager
def _stops_at(out: Output, day: date) -> Iterator[None]:
    try:
        yield
    except BaseException:
        out.say(f"{day}: the run stops at this day", err=True)
        raise


# --- Environment and connections --------------------------------------------------------------


def load_env(cli_path: str | None) -> dict[str, str]:
    """DATABASE_URL and the four R2 names from the env file. The R2 names are copied into
    os.environ, where utils.r2 reads them. Nothing is printed."""
    try:
        path = resolve_env_file(cli_path)
    except SystemExit as exc:  # an --env-file that is not a file
        raise UsageError(str(exc.code)) from None
    if path is None:
        raise UsageError("no .env.local in this checkout or the main one; pass --env-file")
    values = parse_env_file(path)
    env = {name: values.get(name, "").strip() for name in _ENV_NAMES}
    missing = [name for name, value in env.items() if not value]
    if missing:
        raise UsageError(f"{path.name} lacks {', '.join(missing)}")
    for name in _R2_ENV_NAMES:
        os.environ[name] = env[name]
    return env


def _connect(env: dict[str, str], *, readonly: bool) -> Any:
    conn = psycopg2.connect(
        env["DATABASE_URL"], connect_timeout=30, application_name="interval-ba-tape"
    )
    if readonly:
        conn.set_session(readonly=True, autocommit=True)
    return conn


def _tape_connection() -> duckdb.DuckDBPyConnection:
    """DuckDB over the R2 tape, at the spec's limits. Spills go to the system temp folder, not
    the in-memory default `.tmp` under the working directory (the repo root)."""
    con = fulltape_connection(threads=4, memory_limit="3000MiB")
    spill = (Path(tempfile.gettempdir()) / "interval-ba-tape-duckdb").as_posix()
    con.execute(f"SET temp_directory = '{spill.replace(chr(39), chr(39) * 2)}'")
    return con


def _tape(day: date) -> str:
    return r2_url(day.isoformat())


@dataclass(frozen=True)
class R2Bucket:
    client: Any  # one boto3 S3 client, used from one thread
    name: str


def _r2_bucket(env: dict[str, str]) -> R2Bucket:
    # One client, single-threaded puts: a client shared across threads once sent requests
    # without certificate checks. Should that ever happen here, the warning becomes an error.
    warnings.simplefilter("error", InsecureRequestWarning)
    client = boto3.client(
        "s3",
        endpoint_url=env["R2_ENDPOINT_URL"],
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        verify=True,
        config=Config(signature_version="s3v4", retries={"mode": "standard", "max_attempts": 5}),
    )
    return R2Bucket(client, env["R2_BUCKET_FULLTAPE"])


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
    """Every row of `day`, live and replay, by id."""
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
    local = fired_at.astimezone(_CT)
    return local.date() == day and _FEED_START <= local.time() < _FEED_END


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


def _edge_window(
    day: date, kind: str, alerts: Sequence[Any], live: Sequence[StoredRow]
) -> tuple[datetime, list[Any]]:
    """An edge day's bound and the tape alerts on the rebuild's side of it."""
    if not live:
        raise CheckFailedError(
            f"{day}: no live rows, so the rebuild window ({kind}) has no bound."
            " Live started on 2026-05-13 and stopped on 2026-07-22; the table disagrees"
        )
    if kind == BEFORE_FIRST_LIVE:
        bound = min(row.fired_at for row in live)
        return bound, [alert for alert in alerts if alert.fired_at < bound]
    bound = max(row.fired_at for row in live)
    return bound, [alert for alert in alerts if alert.fired_at > bound]


def plan_rebuild_day(day: date, replay: Any, rows: Sequence[StoredRow]) -> RebuildDay:
    """The day's delete-and-insert (spec 5.1 and 6.5), from its replay and its rows.

    Raises CheckFailedError for a live row on a full rebuild day, an edge day with no live row, or a
    replay row to delete that holds an acknowledgement. Each stops the dry run.
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
                f"{row.key[0]} {row.key[1].astimezone(UTC).isoformat()} (id {row.id})"
                for row in at_keys[:5]
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


def _show(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value)


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


def _verify(args: argparse.Namespace, out: Output) -> int:
    days = trading_days(args.start, args.end)
    if not days:
        raise UsageError("no trading day in that range")
    env = load_env(args.env_file)
    out.hide(env)
    conn = _connect(env, readonly=True)
    try:
        con = _tape_connection()
        try:
            out.say(
                "| Day | Stored rows | Tape alerts | Keys in common"
                " | Common rows with a different value | Stored only | Tape only"
                " | root_label_mismatch | Note |"
            )
            out.say("|---|---|---|---|---|---|---|---|---|")
            results: list[DayCompare] = []
            for day in days:
                with _stops_at(out, day):
                    replay = ibr.replay_day(con, _tape(day), day)
                    result = compare_day(day, replay, read_day_rows(conn, day))
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


# --- Run folders and plans --------------------------------------------------------------------


def blob_hash(path: Path) -> str:
    """The git blob id of the file's bytes, as `git hash-object --no-filters` gives it."""
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def new_run(mode: str) -> Path:
    """A fresh run folder, docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/, with days/."""
    stamp = _stamp(_utc_now())
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    for n in itertools.count(1):
        run = RUNS_DIR / (f"{stamp}-{mode}" if n == 1 else f"{stamp}-{mode}-{n}")
        try:
            run.mkdir()
        except FileExistsError:
            continue
        (run / "days").mkdir()
        return run
    raise AssertionError("unreachable")


def load_plan(run: Path) -> dict[str, Any]:
    """A run folder's plan.json. UsageError when the folder holds none."""
    path = run / "plan.json"
    if not path.is_file():
        raise UsageError(f"{run} holds no plan.json: run the dry run first")
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise UsageError(f"{path} does not parse as JSON") from None
    if not isinstance(plan, dict) or not isinstance(plan.get("days"), dict):
        raise UsageError(f"{path} is not a plan")
    return plan


def _write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, value: Any) -> None:
    _write_text(path, json.dumps(value, indent=2) + "\n")


def _marker(run: Path, day: str) -> Path:
    return run / f"{day}.applied"


def _mark(run: Path, day: date, how: str, deleted: int, inserted: int) -> None:
    _write_json(
        _marker(run, day.isoformat()),
        {
            "day": day.isoformat(),
            "how": how,
            "deleted": deleted,
            "inserted": inserted,
            "at": _utc_now().isoformat(),
        },
    )


def _plan_json(days: Sequence[RebuildDay]) -> dict[str, Any]:
    largest = max(days, key=lambda d: d.feed_rows)
    return {
        "mode": "rebuild",
        "created_at": _utc_now().isoformat(),
        "module_blob": blob_hash(MODULE_PATH),
        "tool_blob": blob_hash(TOOL_PATH),
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
    lines = [
        f"# Interval B/A rebuild: dry run {run.name}",
        "",
        f"- Days: {len(days)}, {days[0].day} to {days[-1].day}.",
        f"- Deletes {totals['delete']} replay rows, inserts {totals['insert']} tape alerts,"
        f" skips {totals['twins']} live twins.",
        f"- Module blob `{plan['module_blob']}`, tool blob `{plan['tool_blob']}`.",
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
        "| Day | Kind | Delete | Insert | Insert SPXW | Insert SPY | Insert QQQ"
        " | Live twins skipped | Feed rows (08:30-15:00 CT) | root_label_mismatch |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for d in days:
        per = " | ".join(str(d.tickers[t]["insert"]) for t in ibr.TICKERS)
        lines.append(
            f"| {d.day} | {d.kind} | {len(d.deletes)} | {len(d.inserts)} | {per}"
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


def _rebuild_dry_run(args: argparse.Namespace, out: Output) -> int:
    days = rebuild_days(args.start, args.end)
    _refuse_in_window(args.allow_market_hours)
    env = load_env(args.env_file)
    out.hide(env)
    conn = _connect(env, readonly=True)
    try:
        con = _tape_connection()
        try:
            run = new_run("rebuild")
            out.say(f"run folder: {run}")
            planned: list[RebuildDay] = []
            for day in days:
                with _stops_at(out, day):
                    replay = ibr.replay_day(con, _tape(day), day)
                    plan_day = plan_rebuild_day(day, replay, read_day_rows(conn, day))
                _write_json(run / "days" / f"{day}.json", plan_day.to_json())
                out.say(_day_line(plan_day))
                planned.append(plan_day)
        finally:
            con.close()
    finally:
        conn.close()

    plan = _plan_json(planned)
    _write_json(run / "plan.json", plan)
    _write_text(run / "report.md", _report(run, plan, planned))
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


# --- The backup -------------------------------------------------------------------------------

_SNAPSHOT_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
_COUNT_SQL = "SELECT count(*) FROM interval_ba_alerts"
_BACKUP_SQL = "SELECT * FROM interval_ba_alerts ORDER BY id"


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"no JSON form for a {type(value).__name__} value")


def take_backup(conn: Any, run: Path, r2: R2Bucket) -> Path:
    """Every row of interval_ba_alerts, all columns with id, to the run's backup.jsonl; then
    read it back, copy it to R2 and check the copy. backup.json records it once all of that
    holds. Raises BackupFailedError, before any write, when a check fails.

    The count and the rows come from one REPEATABLE READ snapshot, so the count checks the
    stream. A named cursor pages the rows instead of holding the table in memory.
    """
    path = run / "backup.jsonl"
    digest = hashlib.sha256()
    try:
        with conn.cursor() as cur:
            cur.execute(_SNAPSHOT_SQL)  # the transaction's first statement
            cur.execute(_COUNT_SQL)
            (table_rows,) = cur.fetchone()
        with conn.cursor(name="interval_ba_backup") as cur, path.open("wb") as handle:
            cur.itersize = _BACKUP_PAGE
            cur.execute(_BACKUP_SQL)
            page = cur.fetchmany(_BACKUP_PAGE)
            columns = [column[0] for column in cur.description]  # set once a named cursor fetched
            while page:
                for row in page:
                    record = dict(zip(columns, row, strict=True))
                    line = (
                        json.dumps(record, default=_json_value, separators=(",", ":")) + "\n"
                    ).encode("utf-8")
                    handle.write(line)
                    digest.update(line)
                page = cur.fetchmany(_BACKUP_PAGE)
            handle.flush()
            os.fsync(handle.fileno())
    except TypeError as exc:
        raise BackupFailedError(f"backup: {exc}") from None
    finally:
        conn.rollback()  # ends the read-only snapshot
    sha256 = digest.hexdigest()
    rows = _read_back(path, table_rows, sha256)
    key = f"{BACKUP_PREFIX}{_stamp(_utc_now())}.jsonl"
    _upload_backup(r2, key, path, rows, sha256)
    _write_json(
        run / "backup.json",
        {
            "rows": rows,
            "sha256": sha256,
            "bytes": path.stat().st_size,
            "r2_key": key,
            "taken_at": _utc_now().isoformat(),
        },
    )
    return path


def _read_back(path: Path, table_rows: int, sha256: str) -> int:
    """The file as it reads back: the sha256 of what was written, and one row per line, as
    many as the snapshot's count(*). Returns the row count."""
    with path.open("rb") as handle:
        again = hashlib.file_digest(handle, "sha256").hexdigest()
    if again != sha256:
        raise BackupFailedError("backup: read back, backup.jsonl does not hash to what was written")
    count = 0
    with path.open("rb") as handle:
        for count, line in enumerate(handle, start=1):
            try:
                record = json.loads(line)
            except ValueError:
                raise BackupFailedError(
                    f"backup: line {count} of backup.jsonl does not parse"
                ) from None
            if not isinstance(record, dict) or "id" not in record:
                raise BackupFailedError(f"backup: line {count} of backup.jsonl is not a row")
    if count != table_rows:
        raise BackupFailedError(
            f"backup: backup.jsonl reads back {count} rows, but the table holds {table_rows}"
        )
    return count


def _upload_backup(r2: R2Bucket, key: str, path: Path, rows: int, sha256: str) -> None:
    """One single-part put, then a HEAD: the size, the ETag (the body's MD5 for a single-part
    put) and the sha256 and rows metadata must all read back. A failed check leaves the object
    in place (the owner decides on deletes in the bucket) and stops the run."""
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha256:
        raise BackupFailedError("backup: backup.jsonl changed between its read-back and the upload")
    r2.client.put_object(
        Bucket=r2.name,
        Key=key,
        Body=body,
        Metadata={"sha256": sha256, "rows": str(rows)},
        ContentType="application/x-ndjson",
    )
    head = r2.client.head_object(Bucket=r2.name, Key=key)
    metadata = head.get("Metadata", {})
    problems = [
        what
        for what, ok in (
            ("size", head.get("ContentLength") == len(body)),
            (
                "ETag",
                head.get("ETag", "").strip('"')
                == hashlib.md5(body, usedforsecurity=False).hexdigest(),
            ),
            ("sha256 metadata", metadata.get("sha256") == sha256),
            ("rows metadata", metadata.get("rows") == str(rows)),
        )
        if not ok
    ]
    if problems:
        raise BackupFailedError(
            f"backup: the R2 copy {key} does not verify ({', '.join(problems)})"
        )


def _check_backup_kept(run: Path) -> None:
    """A resumed run's backup still matches its record (it is what undo restores from)."""
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    with (run / "backup.jsonl").open("rb") as handle:
        sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
    if sha256 != record["sha256"]:
        raise BackupFailedError("backup: backup.jsonl no longer matches backup.json; the run stops")


# --- rebuild: the apply -----------------------------------------------------------------------

_DELETE_SQL = (
    "DELETE FROM interval_ba_alerts AS a USING (VALUES %s) AS v(id, day)"
    " WHERE a.id = v.id AND a.expiry = v.day AND a.source = 'replay'"
    " RETURNING a.id"
)


def _delete_replay_rows(cur: Any, day: date, ids: Sequence[int]) -> int:
    """Delete the day's replay rows by id, 500 a statement; return how many went. A live row
    is never deleted: the WHERE names source = 'replay'."""
    gone = psycopg2.extras.execute_values(
        cur,
        _DELETE_SQL,
        [(row_id, day) for row_id in ids],
        template="(%s::bigint, %s::date)",
        page_size=_PAGE_ROWS,
        fetch=True,
    )
    return len(gone)


def _apply_day(
    conn: Any,
    con: duckdb.DuckDBPyConnection,
    run: Path,
    day: date,
    entry: dict[str, Any],
    *,
    allow_market_hours: bool,
) -> str:
    """One day's apply, in the spec's order; returns a line for the log."""
    try:
        planned = RebuildDay.from_json(
            json.loads((run / "days" / f"{day}.json").read_text(encoding="utf-8"))
        )
    except ValueError as exc:  # an edited or damaged day file, or JSON that does not parse
        raise RefusedError(f"{day}: {exc}") from None
    if planned.sha256 != entry["sha256"]:
        raise RefusedError(f"{day}: days/{day}.json and plan.json hold different plans")

    # 1. A day already in its planned end state was applied by a run that died before its
    #    marker: mark it and go on.
    try:
        rows = read_day_rows(conn, day)
    finally:
        conn.rollback()
    if in_end_state(rows, planned):
        _mark(run, day, "end state", 0, 0)
        return f"{day}: already in its planned end state; marked"

    replay = ibr.replay_day(con, _tape(day), day)  # outside the transaction: it takes seconds
    try:
        # 2. The day's transaction starts with this read. Re-plan, and apply only the plan the
        #    owner saw.
        fresh = plan_rebuild_day(day, replay, read_day_rows(conn, day))
        if fresh.sha256 != entry["sha256"]:
            raise ibr.PlanChanged(
                f"{day}: the fresh plan's sha256 {fresh.sha256} is not the plan's"
                f" {entry['sha256']}: the day's rows, its tape or the code moved since the dry"
                " run. Nothing was written for this day"
            )
        # 3. The windows again, right before the write.
        _refuse_in_window(allow_market_hours, f"{day}: ")
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
    # 5. The marker.
    _mark(run, day, "applied", deleted, inserted)
    return f"{day}: deleted {deleted}, inserted {inserted}"


def _measured_months(conn: Any, plan: dict[str, Any]) -> dict[tuple[str, str], tuple[int, int]]:
    """The plan's before counts and the table's counts now, per month and ticker."""
    counts = _planned_months(plan)
    now: Counter[tuple[str, str]] = Counter()
    try:
        for day in plan["days"]:
            for row in read_day_rows(conn, date.fromisoformat(day)):
                now[(day[:7], row.ticker)] += 1
    finally:
        conn.rollback()
    return {key: (before, now[key]) for key, (before, _) in counts.items()}


def _rebuild_apply(args: argparse.Namespace, out: Output) -> int:
    run = Path(args.run)
    plan = load_plan(run)
    if plan.get("mode") != "rebuild":
        raise UsageError(f"{run} holds a {plan.get('mode')} plan, not a rebuild plan")
    _refuse_in_window(args.allow_market_hours)
    for name, path in (("module", MODULE_PATH), ("tool", TOOL_PATH)):
        if blob_hash(path) != plan[f"{name}_blob"]:
            raise RefusedError(
                f"the {name}'s blob hash {blob_hash(path)} is not the plan's"
                f" {plan[f'{name}_blob']}: the code changed since the dry run. Run a new one"
            )
    pending = sorted(day for day in plan["days"] if not _marker(run, day).exists())
    totals = {
        "delete": sum(plan["days"][day]["delete"] for day in pending),
        "insert": sum(plan["days"][day]["insert"] for day in pending),
    }
    for name, expected in (("delete", args.expect_delete), ("insert", args.expect_insert)):
        if expected != totals[name]:
            raise RefusedError(
                f"--expect-{name} {expected} is not the plan's {totals[name]} over the"
                f" {len(pending)} day(s) not yet applied"
            )
    if not pending:
        out.say(f"every day of {run.name} is applied")
        return 0

    env = load_env(args.env_file)
    out.hide(env)
    conn = _connect(env, readonly=False)
    try:
        if (run / "backup.json").exists():
            _check_backup_kept(run)
            out.say("backup: taken by this run's first apply; none taken now")
        else:
            backup = take_backup(conn, run, _r2_bucket(env))
            record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
            out.say(f"backup: {record['rows']} rows in {backup}, R2 copy {record['r2_key']}")
        con = _tape_connection()
        try:
            for day in pending:
                with _stops_at(out, date.fromisoformat(day)):
                    line = _apply_day(
                        conn,
                        con,
                        run,
                        date.fromisoformat(day),
                        plan["days"][day],
                        allow_market_hours=args.allow_market_hours,
                    )
                out.say(line)
        finally:
            con.close()
        measured = _measured_months(conn, plan)
    finally:
        conn.close()
    with (run / "report.md").open("a", encoding="utf-8", newline="\n") as report:
        report.write(
            "\n".join(
                [
                    "",
                    f"## Measured after the apply ({_stamp(_utc_now())})",
                    "",
                    *_month_table(measured),
                    "",
                ]
            )
        )
    out.say(f"applied {len(pending)} day(s); markers and report in {run}")
    return 0


# --- The command line -------------------------------------------------------------------------


def _rebuild(args: argparse.Namespace, out: Output) -> int:
    if args.apply:
        if args.start is not None or args.end is not None:
            raise UsageError("--apply takes its days from --run's plan, not --from/--to")
        if args.run is None or args.expect_delete is None or args.expect_insert is None:
            raise UsageError("--apply needs --run, --expect-delete and --expect-insert")
        return _rebuild_apply(args, out)
    if args.run is not None or args.expect_delete is not None or args.expect_insert is not None:
        raise UsageError("--run and --expect-* go with --apply")
    return _rebuild_dry_run(args, out)


def _not_yet(args: argparse.Namespace, out: Output) -> int:
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
    out = Output()
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
    except CheckFailedError as exc:
        out.say(f"STOPPED ({type(exc).__name__}): {exc}", err=True)
        return 1
    except _QUIET_ERRORS as exc:
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
