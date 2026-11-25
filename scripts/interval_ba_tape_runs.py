"""The mode-agnostic machinery of scripts/interval_ba_tape.py (spec 6.5).

The tool's modes (verify and rebuild now; heal, export and undo later) share what is here:

- loading the replay module nightly/src/interval_ba_replay.py by its path;
- the refusal windows and the 2026 trading calendar;
- output that never shows a secret, the env file, and the Neon, DuckDB and R2 connections;
- run folders, plans, blob hashes and the per-day `.applied` markers;
- the verified backup, local and in R2;
- the apply driver: the start checks (windows, every code file's blob hash, each pending day
  file against plan.json, the --expect totals over the days not yet applied), the backup once
  per run, and the per-day loop with its markers. A mode hands in how to load and apply a day.

Neon: every connection goes to the direct host. The pooler runs in transaction mode, so a
session-level setting (psycopg2's `SET default_transaction_read_only` for an autocommit
read-only session, for one) sticks to whichever pooled backend took it and reaches later
writers there. Read-only work therefore runs in psycopg2 `BEGIN READ ONLY` transactions, rolled
back after each read, and every transaction that writes, or that holds a snapshot, sets
`SET LOCAL statement_timeout` and `lock_timeout` first.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import itertools
import json
import os
import re
import sys
import tempfile
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass
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
from boto3.exceptions import Boto3Error
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from urllib3.exceptions import InsecureRequestWarning

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "nightly" / "src" / "interval_ba_replay.py"
# Every file of the tool, by its repo path. plan.json records each one's blob hash, and an apply
# refuses when any of them, or the replay module, changed since the dry run.
TOOL_FILES: dict[str, Path] = {
    "scripts/interval_ba_tape.py": REPO_ROOT / "scripts" / "interval_ba_tape.py",
    "scripts/interval_ba_tape_runs.py": Path(__file__).resolve(),
}
RUNS_DIR = REPO_ROOT / "docs" / "tmp" / "interval-ba-rebuild"

# ml/src holds utils.r2 (the tape over httpfs) and the --env-file resolution the tool shares
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


class UsageError(Exception):
    """Exit 2."""


class RefusedError(Exception):
    """Exit 3: a window, a hash, the plan files, an --expect total or the day list says no."""


class CheckFailedError(Exception):
    """Exit 1: a check on the data failed. Its text names days, keys, ids and counts only."""


class BackupFailedError(CheckFailedError):
    """The backup did not verify; nothing was written."""


# --- Time, windows and the calendar -----------------------------------------------------------

CT = ZoneInfo("America/Chicago")

# Refusal windows: weekdays in CT, every day in UTC (the nightly run).
_MARKET_START, _MARKET_END = time(8, 15), time(16, 0)
_NIGHTLY_START, _NIGHTLY_END = time(7, 15), time(12, 30)

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


def utc_now() -> datetime:
    return datetime.now(UTC)


def stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def window_refusal(now: datetime, *, allow_market_hours: bool) -> str | None:
    """Why a writing mode may not run at `now`, or None."""
    utc = now.astimezone(UTC)
    if _NIGHTLY_START <= utc.time() < _NIGHTLY_END:
        return (
            f"{utc:%H:%M} UTC is inside 07:15-12:30 UTC, the nightly run's window"
            " (--allow-market-hours does not cover it)"
        )
    local = now.astimezone(CT)
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


def refuse_in_window(allow_market_hours: bool, label: str = "") -> None:
    reason = window_refusal(utc_now(), allow_market_hours=allow_market_hours)
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


# --- Output -----------------------------------------------------------------------------------


class Output:
    """stdout and stderr with every secret value, and each part of the two URLs (and of the
    direct Neon URL the tool connects to), redacted."""

    def __init__(self) -> None:
        self._secrets: list[str] = []

    def hide(self, env: dict[str, str]) -> None:
        parts: set[str] = set()
        for name, value in env.items():
            parts.add(value)
            if not name.endswith("_URL"):
                continue
            for url_text in {value, direct_dsn(value)}:
                parts.add(url_text)
                url = urlsplit(url_text)
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
QUIET_ERRORS = (psycopg2.Error, BotoCoreError, ClientError, Boto3Error)


@contextlib.contextmanager
def stops_at(out: Output, day: date) -> Iterator[None]:
    try:
        yield
    except BaseException:
        out.say(f"{day}: the run stops at this day", err=True)
        raise


# --- Environment and connections --------------------------------------------------------------

_ENV_NAMES = (
    "DATABASE_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
)
_R2_ENV_NAMES = _ENV_NAMES[1:]


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


# "-pooler" ending the first host label of a postgres URL, a label that runs to the first ".",
# ":", "/", "?" or "#". The user-info group is possessive (`?+`): once an "@" has closed it the
# match never retries without it, so a user name ending in "-pooler" is not taken for a host
# label. A copy of nightly/src/resources.py's `direct_dsn`; the tool imports nothing of nightly
# but the replay module.
_POOLED_FIRST_LABEL = re.compile(
    r"^(postgres(?:ql)?://(?:[^/?#]*@)?+[^.:/?#]*?)-pooler(?=[.:/?#]|$)", re.IGNORECASE
)


def direct_dsn(url: str) -> str:
    """The URL with `-pooler` removed from the end of its first host label: Neon's direct host,
    same credentials. Every other byte is kept. A substitution on the raw string, because a
    urlsplit round trip can raise with the host in its message."""
    return _POOLED_FIRST_LABEL.sub(r"\1", url, count=1)


def connect(env: dict[str, str], *, readonly: bool) -> Any:
    """A connection to Neon's direct host, never the pooler, autocommit off. With `readonly`,
    psycopg2 opens each transaction with BEGIN READ ONLY; nothing is set on the session. The
    caller rolls back after each read."""
    conn = psycopg2.connect(
        direct_dsn(env["DATABASE_URL"]), connect_timeout=30, application_name="interval-ba-tape"
    )
    if readonly:
        conn.set_session(readonly=True, autocommit=False)
    return conn


@contextlib.contextmanager
def rolled_back(conn: Any) -> Iterator[None]:
    """A transaction that ends in a rollback. On an error the rollback is attempted and its own
    failure (a dead connection) never hides the error that got here."""
    try:
        yield
    except BaseException:
        with contextlib.suppress(psycopg2.Error):
            conn.rollback()
        raise
    conn.rollback()


_STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '60s'"
_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'"


def set_local_timeouts(cur: Any) -> None:
    """Bound the open transaction: no statement past 60 s, no lock wait past 5 s. LOCAL, so it
    ends with the transaction and never reaches a pooled session."""
    cur.execute(_STATEMENT_TIMEOUT_SQL)
    cur.execute(_LOCK_TIMEOUT_SQL)


def tape_connection() -> duckdb.DuckDBPyConnection:
    """DuckDB over the R2 tape, at the spec's limits. Spills go to the system temp folder, not
    the in-memory default `.tmp` under the working directory (the repo root)."""
    con = fulltape_connection(threads=4, memory_limit="3000MiB")
    spill = (Path(tempfile.gettempdir()) / "interval-ba-tape-duckdb").as_posix()
    con.execute(f"SET temp_directory = '{spill.replace(chr(39), chr(39) * 2)}'")
    return con


def tape_url(day: date) -> str:
    return r2_url(day.isoformat())


@dataclass(frozen=True)
class R2Bucket:
    client: Any  # one boto3 S3 client, used from one thread
    name: str


def r2_bucket(env: dict[str, str]) -> R2Bucket:
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


# --- Run folders, plans and markers -----------------------------------------------------------


def blob_hash(path: Path) -> str:
    """The git blob id of the file's bytes, as `git hash-object --no-filters` gives it."""
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def code_blobs() -> dict[str, Any]:
    """The blob hash of the replay module and of every file of the tool, for plan.json."""
    return {
        "module_blob": blob_hash(MODULE_PATH),
        "tool_blobs": {name: blob_hash(path) for name, path in TOOL_FILES.items()},
    }


def check_code_blobs(plan: dict[str, Any]) -> None:
    """Refuse when the replay module or any file of the tool changed since the dry run."""
    now = code_blobs()
    if plan["module_blob"] != now["module_blob"]:
        raise RefusedError(
            f"the replay module's blob hash {now['module_blob']} is not the plan's"
            f" {plan['module_blob']}: the code changed since the dry run. Run a new one"
        )
    recorded = plan["tool_blobs"]
    if not isinstance(recorded, dict):
        raise TypeError("tool_blobs is not a mapping")
    changed = sorted(
        name
        for name in recorded.keys() | now["tool_blobs"].keys()
        if recorded.get(name) != now["tool_blobs"].get(name)
    )
    if changed:
        raise RefusedError(
            f"{', '.join(changed)}: the blob hash is not the plan's: the tool changed since the"
            " dry run. Run a new one"
        )


def new_run(mode: str) -> Path:
    """A fresh run folder, docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/, with days/."""
    run_stamp = stamp(utc_now())
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    for n in itertools.count(1):
        run = RUNS_DIR / (f"{run_stamp}-{mode}" if n == 1 else f"{run_stamp}-{mode}-{n}")
        try:
            run.mkdir()
        except FileExistsError:
            continue
        (run / "days").mkdir()
        return run
    raise AssertionError("unreachable")


def load_plan(run: Path) -> dict[str, Any]:
    """A run folder's plan.json. UsageError when the folder holds none or it does not parse;
    RefusedError when it parses to something that is not a plan."""
    path = run / "plan.json"
    if not path.is_file():
        raise UsageError(f"{run} holds no plan.json: run the dry run first")
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise UsageError(f"{path} does not parse as JSON") from None
    if not isinstance(plan, dict) or not isinstance(plan.get("days"), dict):
        raise RefusedError(f"{path} is not a plan")
    return plan


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def write_json(path: Path, value: Any) -> None:
    write_text(path, json.dumps(value, indent=2) + "\n")


def marker_path(run: Path, day: str) -> Path:
    return run / f"{day}.applied"


def mark(run: Path, day: date, how: str, counts: dict[str, int]) -> None:
    write_json(
        marker_path(run, day.isoformat()),
        {"day": day.isoformat(), "how": how, **counts, "at": utc_now().isoformat()},
    )


# --- The backup -------------------------------------------------------------------------------

BACKUP_PREFIX = "backups/interval-ba-alerts/"
_BACKUP_PAGE = 2000
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
        with rolled_back(conn):  # ends the read-only snapshot
            with conn.cursor() as cur:
                cur.execute(_SNAPSHOT_SQL)  # the transaction's first statement
                set_local_timeouts(cur)
                cur.execute(_COUNT_SQL)
                (table_rows,) = cur.fetchone()
            with conn.cursor(name="interval_ba_backup") as cur, path.open("wb") as handle:
                cur.itersize = _BACKUP_PAGE
                cur.execute(_BACKUP_SQL)
                page = cur.fetchmany(_BACKUP_PAGE)
                columns = [column[0] for column in cur.description]  # set once a fetch ran
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
    sha256 = digest.hexdigest()
    rows = _read_back(path, table_rows, sha256)
    key = f"{BACKUP_PREFIX}{stamp(utc_now())}.jsonl"
    _upload_backup(r2, key, path, rows, sha256)
    write_json(
        run / "backup.json",
        {
            "rows": rows,
            "sha256": sha256,
            "bytes": path.stat().st_size,
            "r2_key": key,
            "taken_at": utc_now().isoformat(),
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


def check_backup_kept(run: Path) -> None:
    """A resumed run's backup still matches its record (it is what undo restores from)."""
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    with (run / "backup.jsonl").open("rb") as handle:
        sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
    if sha256 != record["sha256"]:
        raise BackupFailedError("backup: backup.jsonl no longer matches backup.json; the run stops")


# --- The apply driver -------------------------------------------------------------------------


@dataclass(frozen=True)
class DayDone:
    """What a mode's apply_day did: how ("applied", or "end state" for a day already in it), the
    counts the database reported (they go in the marker), and a line for the log."""

    how: str
    counts: dict[str, int]
    line: str


@dataclass(frozen=True)
class ApplyMode:
    """What the driver needs from a writing mode.

    - `name`: the plan.json mode;
    - `expect`: the per-day plan.json counts that each take an --expect-<name> total;
    - `load_day(run, day, entry)`: the day's planned write set from days/<day>.json, refusing
      (RefusedError) a file that is damaged, edited, or whose counts are not plan.json's;
    - `apply_day(conn, con, day, planned, allow_market_hours)`: one day in its own transaction,
      raising on any failure; the driver writes the marker after it returns;
    - `finish(conn, run, plan)`: after every pending day is applied, if given.
    """

    name: str
    expect: tuple[str, ...]
    load_day: Callable[[Path, date, dict[str, Any]], Any]
    apply_day: Callable[[Any, duckdb.DuckDBPyConnection, date, Any, bool], DayDone]
    finish: Callable[[Any, Path, dict[str, Any]], None] | None = None


def apply_run(
    mode: ApplyMode,
    run: Path,
    expected: dict[str, int],
    *,
    allow_market_hours: bool,
    env_file: str | None,
    out: Output,
) -> int:
    """Apply a dry run's plan (spec 6.5, "Run folders, plans and applies").

    Refuses (RefusedError) when a window is open, a code file's blob hash moved, plan.json or a
    pending day file is damaged or disagrees with the other, or an --expect total is not the
    plan's over the days with no marker. Then the backup on the run's first apply (or a check
    that the kept one still matches), and each pending day in date order, marked once applied.
    """
    plan = load_plan(run)
    if plan.get("mode") != mode.name:
        raise UsageError(f"{run} holds a {plan.get('mode')} plan, not a {mode.name} plan")
    refuse_in_window(allow_market_hours)
    try:
        check_code_blobs(plan)
        pending = sorted(day for day in plan["days"] if not marker_path(run, day).exists())
        planned = {
            day: mode.load_day(run, date.fromisoformat(day), plan["days"][day]) for day in pending
        }
        totals = {
            name: sum(int(plan["days"][day][name]) for day in pending) for name in mode.expect
        }
    except (ValueError, KeyError, TypeError) as exc:
        raise RefusedError(
            f"{run / 'plan.json'} is not a {mode.name} plan this run can apply"
            f" ({type(exc).__name__}: {exc})"
        ) from None
    for name in mode.expect:
        if expected[name] != totals[name]:
            raise RefusedError(
                f"--expect-{name} {expected[name]} is not the plan's {totals[name]} over the"
                f" {len(pending)} day(s) not yet applied"
            )
    if not pending:
        out.say(f"every day of {run.name} is applied")
        return 0

    env = load_env(env_file)
    out.hide(env)
    conn = connect(env, readonly=False)
    try:
        if (run / "backup.json").exists():
            check_backup_kept(run)
            out.say("backup: taken by this run's first apply; none taken now")
        else:
            backup = take_backup(conn, run, r2_bucket(env))
            record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
            out.say(f"backup: {record['rows']} rows in {backup}, R2 copy {record['r2_key']}")
        con = tape_connection()
        try:
            for day in pending:
                when = date.fromisoformat(day)
                with stops_at(out, when):
                    done = mode.apply_day(conn, con, when, planned[day], allow_market_hours)
                mark(run, when, done.how, done.counts)
                out.say(done.line)
        finally:
            con.close()
        if mode.finish is not None:
            mode.finish(conn, run, plan)
    finally:
        conn.close()
    out.say(f"applied {len(pending)} day(s); markers and report in {run}")
    return 0
