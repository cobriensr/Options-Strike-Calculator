"""The mode-agnostic machinery of scripts/interval_ba_tape.py (spec 6.5).

The tool's modes (verify, rebuild, heal, export and undo) share what is here:

- loading the replay module nightly/src/interval_ba_replay.py and the trading calendar
  nightly/src/calendar_nyse.py, each by its path;
- the refusal windows and the trading calendar;
- the deployed-code guard: a write of replay day files runs only when the replay module is the
  one on origin/main, which is the code the nightly job runs;
- output that never shows a secret, the env file, and the Neon, DuckDB and R2 connections;
- run folders, plans, blob hashes, the per-day `.applied` and `.undone` markers;
- the verified backup, local and in R2, and a verified R2 put for any object;
- the apply driver: the start checks (windows, an undone run, every code file's blob hash,
  plan.json's per-ticker counts, each pending day file against plan.json, the --expect totals
  over the days not yet applied), the backup once per run, and the per-day loop with its
  markers. A mode hands in how to load and apply a day.

Neon: every connection goes to the direct host. The pooler runs in transaction mode, so a
session-level setting (psycopg2's `SET default_transaction_read_only` for an autocommit
read-only session, for one) sticks to whichever pooled backend took it and reaches later
writers there. Read-only work therefore runs in psycopg2 `BEGIN READ ONLY` transactions, rolled
back after each read. Every connection starts with a 60 s statement_timeout as a startup option,
as nightly's connect_db does (the pooler rejects one; the direct host takes it): that bounds the
one transaction the tool does not open itself, heal_day's. Every transaction the tool opens that
writes, or that holds a snapshot, also sets `SET LOCAL statement_timeout` and `lock_timeout`.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import itertools
import json
import os
import re
import subprocess
import sys
import tempfile
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
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
CALENDAR_PATH = REPO_ROOT / "nightly" / "src" / "calendar_nyse.py"
# Every file of the tool, by its repo path. plan.json records each one's blob hash, and an apply
# refuses when any of them, or the replay module, changed since the dry run. The calendar is the
# tool's too: it decides which days a range holds.
TOOL_FILES: dict[str, Path] = {
    "scripts/interval_ba_tape.py": REPO_ROOT / "scripts" / "interval_ba_tape.py",
    "scripts/interval_ba_tape_runs.py": Path(__file__).resolve(),
    "nightly/src/calendar_nyse.py": CALENDAR_PATH,
}
RUNS_DIR = REPO_ROOT / "docs" / "tmp" / "interval-ba-rebuild"

# ml/src holds utils.r2 (the tape over httpfs) and the --env-file resolution the tool shares
# with the anchor backfill. -I keeps both off sys.path, so add the folder here.
_ML_SRC = str(REPO_ROOT / "ml" / "src")
if _ML_SRC not in sys.path:
    sys.path.insert(0, _ML_SRC)

from anchor_backfill_extract import parse_env_file, resolve_env_file  # noqa: E402
from utils.r2 import fulltape_connection, r2_url  # noqa: E402


def _load_nightly_module(name: str, path: Path) -> ModuleType:
    """A module of nightly/src, by its path. nightly/src never goes on sys.path: its other
    modules would shadow this suite's. The module is registered under its name before it runs,
    because @dataclass under `from __future__ import annotations` looks it up there."""
    loaded = sys.modules.get(name)
    if loaded is not None and Path(loaded.__file__ or "").resolve() == path.resolve():
        return loaded
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    return module


ibr = _load_nightly_module("interval_ba_replay", MODULE_PATH)
# The calendar the nightly job plans its days with. Standard library only, so the tool takes
# nothing else of nightly.
calendar_nyse = _load_nightly_module("calendar_nyse", CALENDAR_PATH)


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


def utc_now() -> datetime:
    return datetime.now(UTC)


def stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def nightly_window_end(now: datetime) -> datetime | None:
    """When the nightly run's window (07:15-12:30 UTC) closes, as an aware UTC instant, if `now`
    is inside it; else None. The readers' repair names it as the time to retry."""
    utc = now.astimezone(UTC)
    if _NIGHTLY_START <= utc.time() < _NIGHTLY_END:
        return datetime.combine(utc.date(), _NIGHTLY_END, tzinfo=UTC)
    return None


def window_refusal(now: datetime, *, allow_market_hours: bool) -> str | None:
    """Why a writing mode may not run at `now`, or None."""
    utc = now.astimezone(UTC)
    if nightly_window_end(now) is not None:
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
    """The NYSE trading days from start to end, both included, by nightly's calendar. A range
    past the years its holiday table covers is a bad argument: it refuses to guess a holiday."""
    if start > end:
        raise UsageError(f"--from {start} is after --to {end}")
    try:
        return calendar_nyse.trading_days(start, end)
    except calendar_nyse.CalendarExhausted as exc:
        raise UsageError(str(exc)) from None


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


_STATEMENT_TIMEOUT_MS = 60_000
# A startup option, not a SET: the session is the direct host's own, never a pooled backend's.
_SESSION_OPTIONS = f"-c statement_timeout={_STATEMENT_TIMEOUT_MS}"


def connect(env: dict[str, str], *, readonly: bool) -> Any:
    """A connection to Neon's direct host, never the pooler, autocommit off, every statement
    bounded at 60 s. With `readonly`, psycopg2 opens each transaction with BEGIN READ ONLY;
    nothing is set on the session. The caller rolls back after each read."""
    conn = psycopg2.connect(
        direct_dsn(env["DATABASE_URL"]),
        connect_timeout=30,
        application_name="interval-ba-tape",
        # Replaces any options= the URL carries, as in nightly's connect_db.
        options=_SESSION_OPTIONS,
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


_STATEMENT_TIMEOUT_SQL = f"SET LOCAL statement_timeout = '{_STATEMENT_TIMEOUT_MS // 1000}s'"
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


# --- The deployed-code guard ------------------------------------------------------------------

_DEPLOYED_REMOTE, _DEPLOYED_BRANCH = "origin", "main"
_DEPLOYED_REF = f"{_DEPLOYED_REMOTE}/{_DEPLOYED_BRANCH}"
# Bounds each git call, chiefly the one `git fetch` of origin/main: a stalled remote then
# refuses the write instead of hanging a backfill that has not started its first replay.
_GIT_TIMEOUT_SECONDS = 60


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    """`git -C <repo> <args>` with its output captured, never stopping to ask for credentials.
    Its own output is not shown by callers: a remote's URL can carry them."""
    unchecked = f"so the replay module cannot be checked against {_DEPLOYED_REF}"
    try:
        return subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except subprocess.TimeoutExpired as exc:
        raise RefusedError(
            f"git did not finish within {_GIT_TIMEOUT_SECONDS} s ({type(exc).__name__}),"
            f" {unchecked}"
        ) from None
    except OSError as exc:
        raise RefusedError(f"git did not run ({type(exc).__name__}), {unchecked}") from None


def refuse_unless_deployed_code() -> None:
    """Refuse (RefusedError) unless the replay module is the code the nightly job runs: no
    uncommitted change to it, and its git blob the one `origin/main` holds (replay-days spec,
    "Deployed code only").

    Every write of a replay day file runs this first. A work-in-progress change to what
    `replay_day` outputs, without a `REPLAY_VERSION` bump, would pass the readers' rule check
    and stay in R2 for good. `origin/main` is fetched first, so a stale remote-tracking branch
    cannot pass a module the nightly job no longer runs. The blob is git's own
    (`git hash-object`), not a hash of the bytes on disk, so a checkout's line-ending
    conversion does not count as a change.
    """
    rel = MODULE_PATH.relative_to(REPO_ROOT).as_posix()
    hint = f"Run from a checkout at {_DEPLOYED_REF}."
    fetch = _git(
        "fetch",
        "--quiet",
        _DEPLOYED_REMOTE,
        f"+refs/heads/{_DEPLOYED_BRANCH}:refs/remotes/{_DEPLOYED_REF}",
    )
    if fetch.returncode != 0:
        raise RefusedError(
            f"git fetch {_DEPLOYED_REMOTE} {_DEPLOYED_BRANCH} failed (exit {fetch.returncode}),"
            f" so {rel} cannot be checked against {_DEPLOYED_REF}. {hint}"
        )
    status = _git("status", "--porcelain", "--untracked-files=all", "--", rel)
    if status.returncode != 0:
        raise RefusedError(f"git status failed (exit {status.returncode}) on {rel}. {hint}")
    if status.stdout.strip():
        raise RefusedError(
            f"{rel} has an uncommitted change, so it is not the deployed code. {hint}"
        )
    local = _git("hash-object", "--", rel)
    deployed = _git("rev-parse", "--verify", "--quiet", f"{_DEPLOYED_REF}:{rel}")
    if local.returncode != 0 or deployed.returncode != 0:
        raise RefusedError(f"{rel} cannot be read, here or at {_DEPLOYED_REF}. {hint}")
    if local.stdout.strip() != deployed.stdout.strip():
        raise RefusedError(
            f"{rel} is not {_DEPLOYED_REF}'s (blob {local.stdout.strip()[:12]}, deployed"
            f" {deployed.stdout.strip()[:12]}): the nightly job runs {_DEPLOYED_REF}'s. {hint}"
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


def undone_path(run: Path, day: str) -> Path:
    return run / f"{day}.undone"


def mark(run: Path, day: date, how: str, counts: dict[str, int]) -> None:
    write_json(
        marker_path(run, day.isoformat()),
        {"day": day.isoformat(), "how": how, **counts, "at": utc_now().isoformat()},
    )


def mark_undone(run: Path, day: date, counts: dict[str, int]) -> None:
    write_json(
        undone_path(run, day.isoformat()),
        {"day": day.isoformat(), **counts, "at": utc_now().isoformat()},
    )


def planned_months(plan: dict[str, Any]) -> dict[tuple[str, str], tuple[int, int]]:
    """(month, ticker) -> (rows before, rows after), summed over plan.json's per-day,
    per-ticker counts. Raises KeyError or TypeError on counts that are not there."""
    counts: dict[tuple[str, str], tuple[int, int]] = {}
    for day, entry in plan["days"].items():
        tickers = entry["tickers"]
        if not isinstance(tickers, dict):
            raise TypeError(f"{day}: tickers is not a mapping")
        for ticker, c in tickers.items():
            before, after = counts.get((day[:7], ticker), (0, 0))
            counts[(day[:7], ticker)] = (before + c["before"], after + c["after"])
    return counts


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
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != sha256:
        raise BackupFailedError("backup: backup.jsonl changed between its read-back and the upload")
    put_verified(
        r2,
        key,
        body,
        {"sha256": sha256, "rows": str(rows)},
        content_type="application/x-ndjson",
        what="backup",
        error=BackupFailedError,
    )


def put_verified(
    r2: R2Bucket,
    key: str,
    body: bytes,
    metadata: dict[str, str],
    *,
    content_type: str,
    what: str,
    error: type[CheckFailedError] = CheckFailedError,
) -> None:
    """One single-part put, then a HEAD: the size, the ETag (the body's MD5 for a single-part
    put) and every metadata value must read back. A failed check leaves the object in place
    (the owner decides on deletes in the bucket) and raises `error`, naming each check."""
    r2.client.put_object(
        Bucket=r2.name, Key=key, Body=body, Metadata=metadata, ContentType=content_type
    )
    head = r2.client.head_object(Bucket=r2.name, Key=key)
    stored = head.get("Metadata", {})
    checks = [
        ("size", head.get("ContentLength") == len(body)),
        (
            "ETag",
            head.get("ETag", "").strip('"') == hashlib.md5(body, usedforsecurity=False).hexdigest(),
        ),
        *((f"{name} metadata", stored.get(name) == value) for name, value in metadata.items()),
    ]
    problems = [name for name, ok in checks if not ok]
    if problems:
        raise error(f"{what}: the R2 copy {key} does not verify ({', '.join(problems)})")


def list_objects(r2: R2Bucket, prefix: str) -> dict[str, datetime]:
    """Every key under `prefix` with its LastModified, as aware UTC. One paginated list, so a
    prefix of any size comes back whole; the listing's own errors propagate. The readers' repair
    compares a day file's time with its tape's."""
    found: dict[str, datetime] = {}
    for page in r2.client.get_paginator("list_objects_v2").paginate(Bucket=r2.name, Prefix=prefix):
        for obj in page.get("Contents", []):
            at = obj["LastModified"]
            found[obj["Key"]] = at.replace(tzinfo=UTC) if at.tzinfo is None else at.astimezone(UTC)
    return found


def object_exists(r2: R2Bucket, key: str) -> bool:
    """Whether the bucket holds `key`, by a HEAD. Any error but "not found" propagates."""
    try:
        r2.client.head_object(Bucket=r2.name, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise
    return True


def check_backup_kept(run: Path) -> None:
    """A resumed run's backup still matches its record (it is what undo restores from)."""
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    with (run / "backup.jsonl").open("rb") as handle:
        sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
    if sha256 != record["sha256"]:
        raise BackupFailedError("backup: backup.jsonl no longer matches backup.json; the run stops")


def read_backup(run: Path) -> Iterator[Any]:
    """The records of the run's backup.jsonl, one at a time, from bytes checked here, before the
    first, against backup.json's sha256 (one read, so the check and the parse see the same
    file). BackupFailedError when they do not match, or when a line does not parse."""
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    data = (run / "backup.jsonl").read_bytes()
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise BackupFailedError("backup: backup.jsonl no longer matches backup.json; the run stops")
    return _backup_records(data)


def _backup_records(data: bytes) -> Iterator[Any]:
    for n, line in enumerate(io.BytesIO(data), start=1):
        try:
            parsed = json.loads(line)
        except ValueError:
            raise BackupFailedError(f"backup: line {n} of backup.jsonl does not parse") from None
        yield parsed


# --- The apply driver -------------------------------------------------------------------------


@dataclass(frozen=True)
class DayDone:
    """What a mode's apply_day did: how ("applied", or "end state" for a day already in it), the
    counts the database reported (they go in the marker), and a line for the log. `problem`
    names a day that committed other than its plan: the driver marks it, since it committed,
    and then stops the run."""

    how: str
    counts: dict[str, int]
    line: str
    problem: str | None = None


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

    Refuses (RefusedError) when a window is open, the run was undone, a code file's blob hash
    moved, plan.json or a pending day file is damaged or disagrees with the other, or an
    --expect total is not the plan's over the days with no marker. Then the backup on the run's
    first apply (or a check that the kept one still matches), and each pending day in date
    order, marked once applied.
    """
    plan = load_plan(run)
    if plan.get("mode") != mode.name:
        raise UsageError(f"{run} holds a {plan.get('mode')} plan, not a {mode.name} plan")
    refuse_in_window(allow_market_hours)
    if any(run.glob("*.undone")):
        raise RefusedError(
            f"{run.name} was undone: its backup is no longer the state before it. Run a new dry run"
        )
    try:
        check_code_blobs(plan)
        planned_months(plan)  # the measured report reads these after the writes
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
                if done.problem is not None:
                    out.say(f"{when}: the run stops at this day", err=True)
                    raise CheckFailedError(done.problem)
        finally:
            con.close()
        if mode.finish is not None:
            mode.finish(conn, run, plan)
    finally:
        conn.close()
    out.say(f"applied {len(pending)} day(s); markers and report in {run}")
    return 0
