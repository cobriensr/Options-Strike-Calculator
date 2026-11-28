"""scripts/interval_ba_tape.py: verify, run folders, the backup, rebuild, heal, export and undo
(spec 6.5).

Each test runs the real replay module over a small tape written in tmp_path. The boundaries are
patched (R3):

- DuckDB's R2 side: `fulltape_connection` returns a local DuckDB connection and `r2_url` the
  local tape's path. The connection fails the test when a database transaction is open while it
  works: no transaction may idle through a replay;
- psycopg2.connect returns a fake connection over an in-memory `interval_ba_alerts`. Its
  transactions snapshot and restore the table, a read-only one rejects writes, a session-level
  read-only setting is refused (it would stick to a pooled backend), and psycopg2's own
  execute_values runs against its cursor, so each page of a batched write arrives as one
  statement with its rows;
- boto3.client returns a fake R2 client.

The tool's shared machinery (interval_ba_tape_runs.py) is patched where it lives. No test opens
a database or R2. Run from the repo root with ml/.venv:

    ml/.venv/Scripts/python -m pytest scripts/test_interval_ba_tape.py \\
        scripts/test_interval_ba_tape_runs.py -q
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, fields, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import interval_ba_tape as tool
import interval_ba_tape_runs as runs
import psycopg2
import psycopg2.errors
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from botocore.exceptions import ClientError

ibr = sys.modules["interval_ba_replay"]
# The deployed-code guard reads git, so the fixture patches it; one test runs the real one.
REAL_DEPLOYED_CODE_GUARD = runs.refuse_unless_deployed_code

CT = ZoneInfo("America/Chicago")
# A Wednesday, 17:30 CT: outside both refusal windows.
SAFE_NOW = datetime(2026, 11, 25, 23, 30, tzinfo=UTC)

FULL_A = date(2026, 3, 10)  # Tuesday, old backfill
FULL_A2 = date(2026, 3, 11)  # the next trading day
MARCH_END = date(2026, 3, 31)
APRIL_START = date(2026, 4, 1)
OUTAGE = date(2026, 8, 4)  # Tuesday, the uw-stream outage (CDT)
EDGE_FIRST = date(2026, 5, 13)
EDGE_LAST = date(2026, 7, 22)

SECRETS = {
    # The pooled host, as .env.local holds it; the tool connects to the direct one.
    "DATABASE_URL": (
        "postgresql://owner-sekret:pw-sekret-123@db-sekret-pooler.example.neon.tech/neondb"
        "?sslmode=require"
    ),
    "R2_ACCESS_KEY_ID": "akid-sekret-456",
    "R2_SECRET_ACCESS_KEY": "sak-sekret-789",
    "R2_ENDPOINT_URL": "https://acct-sekret.r2.cloudflarestorage.com",
    "R2_BUCKET_FULLTAPE": "bucket-sekret",
}
DIRECT_URL = SECRETS["DATABASE_URL"].replace("-pooler.", ".")
SECRET_PARTS = (
    *SECRETS.values(),
    DIRECT_URL,
    "owner-sekret",
    "pw-sekret-123",
    "db-sekret-pooler.example.neon.tech",
    "db-sekret.example.neon.tech",  # the direct host
    "db-sekret",
    "acct-sekret.r2.cloudflarestorage.com",
    "acct-sekret",  # the R2 account id: the endpoint host's first label
)

TAPE_FIELDS = tuple(f.name for f in fields(ibr.TapeAlert))
TABLE_COLUMNS = ("id", *TAPE_FIELDS, "acknowledged", "source")


# --- The tape ---------------------------------------------------------------------------------


def chain(root: str, cp: str, strike: int, day: date) -> str:
    return f"{root}{day:%y%m%d}{cp}{strike * 1000:08d}"


def at(day: date, clock: str) -> datetime:
    """An aware UTC instant on `day` from 'HH:MM:SS[.ffffff]'."""
    return datetime.fromisoformat(f"{day.isoformat()}T{clock}+00:00")


def tick(
    when: datetime,
    option_chain: str,
    *,
    price: float = 10.0,
    size: int = 250,
    side: str = "ask",
    flags: Sequence[str] = (),
    spot: float | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    """One tape row in the TIMESTAMPTZ layout. The default is an ask print of exactly $250,000,
    which fires its bucket on its own."""
    root = option_chain[:-15]
    return {
        "executed_at": when,
        "option_chain_id": option_chain,
        "underlying_symbol": label if label is not None else root,
        "expiry": datetime.strptime(option_chain[-15:-9], "%y%m%d").date(),
        "price": price,
        "size": size,
        "tags": "{" + f"{side}_side,bullish,etf" + "}",
        "report_flags": "{" + ",".join(flags) + "}",
        "upstream_condition_detail": "auto",
        "underlying_price": spot if spot is not None else (6700.0 if root == "SPXW" else 670.0),
        "canceled": False,
    }


def filler(day: date) -> dict[str, Any]:
    """A small bid print, so every tape holds a kept row for its day."""
    return tick(at(day, "13:31:00"), chain("SPY", "C", 999, day), price=0.5, size=1, side="bid")


_TAPE_SCHEMA = pa.schema(
    [
        ("executed_at", pa.timestamp("us", tz="UTC")),
        ("option_chain_id", pa.string()),
        ("underlying_symbol", pa.string()),
        ("expiry", pa.date32()),
        ("price", pa.float64()),
        ("size", pa.int32()),
        ("tags", pa.string()),
        ("report_flags", pa.string()),
        ("upstream_condition_detail", pa.string()),
        ("underlying_price", pa.float64()),
        ("canceled", pa.bool_()),
    ]
)


def write_tape(path: Path, ticks: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = {name: [t[name] for t in ticks] for name in _TAPE_SCHEMA.names}
    pq.write_table(pa.table(columns, schema=_TAPE_SCHEMA), path)


# --- The fake database ------------------------------------------------------------------------


@dataclass
class Statement:
    sql: str
    params: object  # a dict for an execute, the page's rows for an execute_values page
    readonly: bool


class FakeDb:
    """`interval_ba_alerts`, `interval_ba_live_settings` and `interval_ba_tape_days` in memory,
    behind fake psycopg2 connections.

    A statement with autocommit off opens a transaction; rollback restores the tables as they
    were when the transaction began. A DELETE or UPDATE applies only the predicates its SQL text
    names, so a dropped `source = 'replay'` would show. `fail_on` makes the first statement
    whose SQL contains it raise; `count_skew` makes the backup's count(*) disagree with its rows;
    and `before_insert` runs just before an INSERT page lands (a concurrent writer).
    """

    def __init__(self) -> None:
        self.rows: dict[int, dict[str, Any]] = {}
        self.next_id = 1
        self.settings: list[tuple[Any, ...]] = []  # in read_covering_settings' column order
        self.tape_days: dict[date, dict[str, Any]] = {}
        self.statements: list[Statement] = []
        self.conns: list[FakeConn] = []
        self.dsns: list[str] = []
        self.connect_kwargs: list[dict[str, Any]] = []
        self.fail_on: str | None = None
        self.count_skew = 0
        self.before_insert: Callable[[], None] | None = None

    def add(
        self,
        alert: Any,
        *,
        source: str,
        fired_at: datetime | None = None,
        acknowledged: bool = False,
        **changes: Any,
    ) -> int:
        row = {name: getattr(alert, name) for name in TAPE_FIELDS}
        row["confluence_tickers"] = list(alert.confluence_tickers)
        if fired_at is not None:
            row["fired_at"] = fired_at
        row.update(changes)
        row.update(id=self.next_id, source=source, acknowledged=acknowledged)
        self.rows[self.next_id] = row
        self.next_id += 1
        return row["id"]

    def connect(self, dsn: str, **kwargs: Any) -> FakeConn:
        self.dsns.append(dsn)
        self.connect_kwargs.append(kwargs)
        conn = FakeConn(self)
        self.conns.append(conn)
        return conn

    def day(self, day: date, source: str | None = None) -> list[dict[str, Any]]:
        return [
            row
            for row in self.rows.values()
            if row["expiry"] == day and (source is None or row["source"] == source)
        ]

    def writes(self) -> list[Statement]:
        return [s for s in self.statements if not s.sql.lstrip().startswith(_READS)]

    def writes_starting(self, prefix: str) -> list[Statement]:
        return [s for s in self.writes() if s.sql.lstrip().startswith(prefix)]

    def backup_reads(self) -> list[Statement]:
        return [s for s in self.statements if s.sql.startswith("SELECT * FROM interval_ba_alerts")]


class FakeConn:
    encoding = "UTF8"  # execute_values encodes its SQL with the connection's encoding

    def __init__(self, db: FakeDb) -> None:
        self.db = db
        self._autocommit = False
        self.readonly = False
        self.in_transaction = False
        self.txn: list[str] = []  # the open transaction's statements
        self._snapshot: tuple[Any, ...] | None = None
        self.closed = 0
        self.commits = 0
        self.rollbacks = 0

    @property
    def autocommit(self) -> bool:
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value: bool) -> None:
        if self.in_transaction:
            raise psycopg2.ProgrammingError("set_session cannot be used inside a transaction")
        self._autocommit = value

    def set_session(
        self, *, readonly: bool | None = None, autocommit: bool | None = None, **_: Any
    ) -> None:
        if self.in_transaction:
            raise psycopg2.ProgrammingError("set_session cannot be used inside a transaction")
        if readonly is not None:
            self.readonly = readonly
        if autocommit is not None:
            self._autocommit = autocommit
        if self.readonly and self._autocommit:
            # psycopg2 would SET default_transaction_read_only on the session, which through
            # Neon's transaction-mode pooler sticks to a backend that later writers reuse.
            raise AssertionError("a session-level read-only setting: it outlives the session")

    def cursor(self, name: str | None = None) -> FakeCursor:
        return FakeCursor(self)

    def begin(self) -> None:
        if not self._autocommit and not self.in_transaction:
            self.in_transaction = True
            self.txn = []
            self._snapshot = copy.deepcopy(
                (self.db.rows, self.db.next_id, self.db.settings, self.db.tape_days)
            )

    def commit(self) -> None:
        self.commits += 1
        self.in_transaction = False
        self.txn = []
        self._snapshot = None

    def rollback(self) -> None:
        self.rollbacks += 1
        if self._snapshot is not None:
            self.db.rows, self.db.next_id, self.db.settings, self.db.tape_days = self._snapshot
        self.in_transaction = False
        self.txn = []
        self._snapshot = None

    def close(self) -> None:
        self.closed = 1


_DAY_SELECT = re.compile(
    r"^SELECT (?P<columns>.+) FROM interval_ba_alerts WHERE expiry = %\(day\)s ORDER BY id$"
)
_MONTH_COUNTS = (
    "SELECT to_char(expiry, 'YYYY-MM'), ticker, count(*) FROM interval_ba_alerts"
    " WHERE expiry = ANY(%s) GROUP BY 1, 2"
)


def _covering(
    rows: Sequence[tuple[Any, ...]], start: datetime, session_end: datetime
) -> list[tuple[Any, ...]]:
    """read_covering_settings' WHERE: booted_at from the latest boot before `start` (or
    `start`) up to `session_end`, oldest first. booted_at is a row's first value."""
    earlier = [row[0] for row in rows if row[0] < start]
    lower = max(earlier) if earlier else start
    return sorted((row for row in rows if lower <= row[0] < session_end), key=lambda row: row[0])


_TAPE_DAY_SELECT = "SELECT day FROM interval_ba_tape_days WHERE day = %(day)s"
_INSERT_COLUMNS = re.compile(r"^INSERT INTO interval_ba_alerts \((?P<columns>[^)]+)\) VALUES ")
_UPDATE = re.compile(
    r"^UPDATE interval_ba_alerts AS a SET (?P<set>.+?) FROM \(VALUES .+?\)"
    r" AS v\((?P<names>[^)]*)\) WHERE (?P<where>.+) RETURNING a\.id$"
)
# What neither writes nor needs a writable transaction.
_READS = ("SELECT", "SET TRANSACTION", "SET LOCAL")


def _holds(predicate: str, row: dict[str, Any], v: dict[str, Any]) -> bool:
    """One WHERE predicate of an UPDATE, over a row and its VALUES row. SQL the fake does not
    know fails the test rather than pass by default."""
    if m := re.fullmatch(r"a\.(\w+) = v\.(\w+)", predicate):
        return row[m[1]] is not None and row[m[1]] == v[m[2]]
    if m := re.fullmatch(r"a\.(\w+) = '(\w+)'", predicate):
        return row[m[1]] == m[2]
    if m := re.fullmatch(r"a\.(\w+) IS NULL", predicate):
        return row[m[1]] is None
    if m := re.fullmatch(r"a\.(\w+) IS NOT DISTINCT FROM v\.(\w+)", predicate):
        return row[m[1]] == v[m[2]]
    if m := re.fullmatch(
        r"\(a\.(\w+), a\.(\w+)\) IS DISTINCT FROM \(v\.(\w+), v\.(\w+)\)", predicate
    ):
        return (row[m[1]], row[m[2]]) != (v[m[3]], v[m[4]])
    raise AssertionError(f"the fake does not know the predicate: {predicate}")


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self.connection = conn
        self._page: list[tuple[object, ...]] = []
        self._result: list[tuple[object, ...]] = []
        self.description: list[tuple[str, ...]] | None = None
        self.itersize = 2000

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def mogrify(self, template: object, args: Sequence[object]) -> bytes:
        self._page.append(tuple(args))
        return b"(...)"

    def execute(self, sql: str | bytes, params: object = None) -> None:
        conn, db = self.connection, self.connection.db
        text = sql.decode() if isinstance(sql, bytes) else sql
        if isinstance(sql, bytes):
            params, self._page = self._page, []
        conn.begin()
        if db.fail_on is not None and db.fail_on in text:
            raise psycopg2.OperationalError("server closed the connection unexpectedly")
        writes = not text.lstrip().startswith(_READS)
        if writes and conn.readonly:
            raise psycopg2.errors.ReadOnlySqlTransaction("cannot write in a read-only transaction")
        db.statements.append(Statement(text, params, conn.readonly))
        conn.txn.append(text)
        self._result, self.description = [], None
        if text.startswith(("SET TRANSACTION", "SET LOCAL")):
            return
        if text == ibr._COVERING_SETTINGS_SQL:
            assert isinstance(params, dict)
            self._result = _covering(db.settings, params["start"], params["session_end"])
        elif text == _TAPE_DAY_SELECT:
            assert isinstance(params, dict)
            self._result = [(params["day"],)] if params["day"] in db.tape_days else []
        elif text.startswith("INSERT INTO interval_ba_tape_days"):
            assert isinstance(params, dict)
            db.tape_days[params["day"]] = dict(params)
        elif text.startswith("UPDATE interval_ba_alerts"):
            assert isinstance(params, list)
            self._result = self._update(text, params)
        elif text == _MONTH_COUNTS:
            assert isinstance(params, tuple)
            (days,) = params
            counts: dict[tuple[str, str], int] = {}
            for row in db.rows.values():
                if row["expiry"] in days:
                    key = (row["expiry"].strftime("%Y-%m"), row["ticker"])
                    counts[key] = counts.get(key, 0) + 1
            self._result = [(*key, count) for key, count in counts.items()]
        elif text == "SELECT count(*) FROM interval_ba_alerts":
            self._result = [(len(db.rows) + db.count_skew,)]
        elif text == "SELECT * FROM interval_ba_alerts ORDER BY id":
            self.description = [(name,) for name in TABLE_COLUMNS]
            self._result = [tuple(db.rows[i][c] for c in TABLE_COLUMNS) for i in sorted(db.rows)]
        elif match := _DAY_SELECT.match(text):
            assert isinstance(params, dict)
            names = match["columns"].split(", ")
            self._result = [
                tuple(row[name] for name in names)
                for _, row in sorted(db.rows.items())
                if row["expiry"] == params["day"]
            ]
        elif text.startswith("DELETE FROM interval_ba_alerts"):
            assert isinstance(params, list)
            self._result = self._delete(text, params)
        elif text.startswith("INSERT INTO interval_ba_alerts"):
            assert isinstance(params, list)
            self._result = self._insert(text, params)
        else:
            raise AssertionError(f"unexpected SQL: {text}")

    def _delete(self, text: str, page: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
        """A page of (id,) or (id, day) rows; only the predicates the SQL names apply."""
        db = self.connection.db
        gone: list[tuple[object, ...]] = []
        for values in page:
            row_id = values[0]
            row = db.rows.get(row_id)
            if row is None:
                continue
            if "a.expiry = v.day" in text and row["expiry"] != values[1]:
                continue
            if "a.source = 'replay'" in text and row["source"] != "replay":
                continue
            if "NOT a.acknowledged" in text and row["acknowledged"]:
                continue
            del db.rows[row_id]
            gone.append((row_id,))
        return gone

    def _insert(self, text: str, page: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
        """The columns the SQL names. A row with its own id keeps it; a conflict on the key or
        the id is skipped (ON CONFLICT DO NOTHING) or, with only the key as the conflict
        target, an id conflict raises, as Postgres would."""
        db = self.connection.db
        if db.before_insert is not None:
            db.before_insert()
        match = _INSERT_COLUMNS.match(text)
        assert match, text
        columns = match["columns"].split(", ")
        landed: list[tuple[object, ...]] = []
        for values in page:
            row = dict(zip(columns, values, strict=True))
            key = (row["option_chain"], row["bucket_start"])
            if any((r["option_chain"], r["bucket_start"]) == key for r in db.rows.values()):
                continue
            row_id = row.get("id", db.next_id)
            if row_id in db.rows:
                if "ON CONFLICT DO NOTHING" in text:
                    continue
                raise psycopg2.IntegrityError("duplicate key value violates unique constraint")
            row.setdefault("acknowledged", False)
            row.setdefault("source", "live")
            row["id"] = row_id
            db.rows[row_id] = row
            landed.append((row_id,))
            db.next_id = max(db.next_id, row_id + 1)
        return landed

    def _update(self, text: str, page: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
        db = self.connection.db
        match = _UPDATE.match(text)
        assert match, text
        names = match["names"].split(", ")
        sets = [assignment.split(" = v.") for assignment in match["set"].split(", ")]
        predicates = match["where"].split(" AND ")
        assert "a.id = v.id" in predicates, text
        touched: list[tuple[object, ...]] = []
        for values in page:
            v = dict(zip(names, values, strict=True))
            row = db.rows.get(v["id"])
            if row is None or not all(_holds(p, row, v) for p in predicates):
                continue
            for column, name in sets:
                row[column] = v[name]
            touched.append((row["id"],))
        return touched

    def fetchall(self) -> list[tuple[object, ...]]:
        result, self._result = self._result, []
        return result

    def fetchone(self) -> tuple[object, ...] | None:
        return self._result.pop(0) if self._result else None

    def fetchmany(self, size: int) -> list[tuple[object, ...]]:
        page, self._result = self._result[:size], self._result[size:]
        return page


class FakeS3:
    """put_object and head_object over a dict. `tamper` changes what head_object reports: its
    "Metadata" merges into the object's metadata, any other key replaces that field. `fail`
    makes the named operation raise the given error."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, dict[str, str]]] = {}
        self.puts: list[str] = []
        self.tamper: dict[str, Any] = {}
        self.fail: dict[str, Exception] = {}
        self.after_head: Callable[[], None] | None = None  # runs once, after the next HEAD

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, Metadata: dict[str, str], **_: Any):  # noqa: N803
        if "put_object" in self.fail:
            raise self.fail["put_object"]
        self.puts.append(Key)
        self.objects[(Bucket, Key)] = (bytes(Body), dict(Metadata))
        return {}

    def head_object(self, *, Bucket: str, Key: str):  # noqa: N803
        try:
            return self._head(Bucket, Key)
        finally:
            if self.after_head is not None:
                hook, self.after_head = self.after_head, None
                hook()

    def _head(self, Bucket: str, Key: str):  # noqa: N803
        if "head_object" in self.fail:
            raise self.fail["head_object"]
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        body, metadata = self.objects[(Bucket, Key)]
        changes = dict(self.tamper)
        return {
            "ContentLength": len(body),
            "ETag": f'"{hashlib.md5(body).hexdigest()}"',
            **changes,
            "Metadata": {**metadata, **changes.get("Metadata", {})},
        }


# --- The world a test runs the tool in --------------------------------------------------------


@dataclass
class World:
    tmp: Path
    db: FakeDb
    s3: FakeS3
    capsys: pytest.CaptureFixture[str]
    env_file: Path
    tapes: dict[str, str] = field(default_factory=dict)
    alerts: dict[date, list[Any]] = field(default_factory=dict)
    clock: Callable[[], datetime] = lambda: SAFE_NOW
    guard_calls: int = 0  # how often the deployed-code guard ran
    tape_connections: int = 0  # how many DuckDB connections over the tape were opened

    @property
    def runs(self) -> Path:
        return self.tmp / "runs"

    def tape(self, day: date, ticks: Sequence[dict[str, Any]]) -> list[Any]:
        """Write `day`'s tape (with a filler print) and return the replay's alerts for it."""
        path = self.tmp / "tapes" / f"{day.isoformat()}-fulltape.parquet"
        write_tape(path, [filler(day), *ticks])
        self.tapes[day.isoformat()] = str(path)
        con = duckdb.connect()
        try:
            alerts = list(ibr.replay_day(con, str(path), day).alerts)
        finally:
            con.close()
        self.alerts[day] = alerts
        return alerts

    def run(self, command: str, *args: str) -> tuple[int, str]:
        code = tool.main([command, *args, "--env-file", str(self.env_file)])
        captured = self.capsys.readouterr()
        return code, captured.out + captured.err

    def dry_run(
        self,
        start: date,
        end: date | None = None,
        *,
        command: str = "rebuild",
        extra: Sequence[str] = (),
    ) -> tuple[int, str, Path]:
        """A dry run (or an export) and the run folder it made."""
        before = set(self.runs.glob("*")) if self.runs.exists() else set()
        code, out = self.run(
            command, "--from", start.isoformat(), "--to", (end or start).isoformat(), *extra
        )
        (run,) = set(self.runs.glob("*")) - before
        return code, out, run

    def apply(self, run: Path, *, command: str = "rebuild", **expected: int) -> tuple[int, str]:
        """`<command> --apply` with the plan's totals over the unapplied days, unless given."""
        names = EXPECTS[command]
        totals = {} if set(expected) >= set(names) else plan_totals(run, names)
        args = ["--apply", "--run", str(run)]
        for name in names:
            args += [f"--expect-{name}", str(expected.get(name, totals.get(name)))]
        return self.run(command, *args)

    def undo(self, run: Path, *extra: str) -> tuple[int, str]:
        return self.run("undo", "--run", str(run), *extra)


# Each writing mode's --expect totals, as plan.json counts them per day.
EXPECTS = {"rebuild": ("delete", "insert"), "heal": ("insert", "remove", "flags", "spot")}


def plan_totals(run: Path, names: Sequence[str] = EXPECTS["rebuild"]) -> dict[str, int]:
    """The plan's totals over the days with no marker yet."""
    plan = runs.load_plan(run)
    days = [e for day, e in plan["days"].items() if not (run / f"{day}.applied").exists()]
    return {name: sum(entry[name] for entry in days) for name in names}


class CheckedDuck:
    """A local DuckDB connection that fails the test when any database transaction is open while
    DuckDB works: a replay takes seconds, and no transaction may idle through one.

    The one exception is heal_day's own (Task 6): it reads the day's rows and then finds their
    flags and spots on the tape inside the transaction it writes in. A transaction that has run
    only that read passes; one that ran anything else fails, as everywhere."""

    def __init__(self, db: FakeDb) -> None:
        self._db = db
        self._con = duckdb.connect()

    def execute(self, *args: Any) -> Any:
        open_ = [
            conn
            for conn in self._db.conns
            if conn.in_transaction and conn.txn != [ibr._LIVE_ROWS_SQL]
        ]
        assert not open_, "a database transaction is open while DuckDB works"
        return self._con.execute(*args)

    def close(self) -> None:
        self._con.close()


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> World:
    env_file = tmp_path / "test.env"
    env_file.write_text("".join(f"{k}={v}\n" for k, v in SECRETS.items()), encoding="utf-8")
    w = World(tmp=tmp_path, db=FakeDb(), s3=FakeS3(), capsys=capsys, env_file=env_file)
    # The tool copies the R2 names into os.environ for utils.r2; set them here first so the
    # monkeypatch undoes the copy after the test.
    for name in SECRETS:
        if name != "DATABASE_URL":
            monkeypatch.setenv(name, "")
    monkeypatch.setattr(runs, "RUNS_DIR", w.runs)

    def tape_connection(**kwargs: Any) -> CheckedDuck:
        w.tape_connections += 1
        return CheckedDuck(w.db)

    monkeypatch.setattr(runs, "fulltape_connection", tape_connection)
    monkeypatch.setattr(runs, "r2_url", lambda day: w.tapes[day])
    monkeypatch.setattr(psycopg2, "connect", w.db.connect)
    monkeypatch.setattr(runs.boto3, "client", lambda *a, **k: w.s3)
    monkeypatch.setattr(runs, "utc_now", lambda: w.clock())

    def deployed_code() -> None:
        w.guard_calls += 1

    monkeypatch.setattr(runs, "refuse_unless_deployed_code", deployed_code)
    return w


def fires(day: date, *specs: tuple[str, str]) -> list[dict[str, Any]]:
    """One firing ask print per (clock, option chain)."""
    return [tick(at(day, clock), option_chain) for clock, option_chain in specs]


def keys(rows: Sequence[Any]) -> set[tuple[str, datetime]]:
    return {(r["option_chain"], r["bucket_start"]) if isinstance(r, dict) else r.key for r in rows}


# --- verify -----------------------------------------------------------------------------------


def test_verify_is_read_only(world: World):
    alerts = world.tape(
        FULL_A,
        fires(
            FULL_A,
            ("15:00:00", chain("SPY", "C", 670, FULL_A)),
            ("15:01:00", chain("QQQ", "P", 590, FULL_A)),
        ),
    )
    for alert in alerts:
        world.db.add(alert, source="replay")

    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")

    assert code == 0, out
    assert world.db.writes() == []
    (conn,) = world.db.conns
    # BEGIN READ ONLY per transaction, nothing set on the pooled session; rolled back after the
    # day's read, so no transaction is left open.
    assert conn.readonly and not conn.autocommit
    assert not conn.in_transaction and conn.rollbacks == 1
    assert all(s.readonly for s in world.db.statements)
    assert "| 2026-03-10 | 2 | 2 | 2 | 0 | 0 | 0 | 0 |" in out


def test_verify_lists_each_differing_row(world: World):
    spy, qqq = chain("SPY", "C", 670, FULL_A), chain("QQQ", "P", 590, FULL_A)
    alerts = world.tape(FULL_A, fires(FULL_A, ("15:00:00", spy), ("15:10:00", qqq)))
    world.db.add(alerts[0], source="replay", trade_count=7)
    stray = world.db.add(
        replace_alert(alerts[0], option_chain=chain("SPY", "C", 700, FULL_A)), source="replay"
    )
    # A changed fired_at, confluence, flags or SPXW spot is not a difference.
    spxw = chain("SPXW", "C", 6700, FULL_A)
    (spxw_alert,) = [
        a
        for a in world.tape(
            FULL_A, fires(FULL_A, ("15:00:00", spy), ("15:10:00", qqq), ("16:00:00", spxw))
        )
        if a.option_chain == spxw
    ]
    world.db.add(
        spxw_alert,
        source="live",
        fired_at=spxw_alert.fired_at + timedelta(seconds=1),
        confluence_tickers=["QQQ"],
        top_trade_is_sweep=True,
        underlying_price=None,
    )

    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")

    assert code == 1
    assert "trade_count table 7 tape 1" in out
    assert f"table only {chain('SPY', 'C', 700, FULL_A)}" in out and f"id {stray}" in out
    assert f"tape only {qqq}" in out
    assert spxw not in out
    assert "verify: 1 day, 1 with differences" in out


def replace_alert(alert: Any, **changes: Any) -> Any:
    return replace(alert, **changes)


def test_verify_reports_root_label_mismatch(world: World):
    spxw = chain("SPXW", "C", 6700, FULL_A)
    alerts = world.tape(
        FULL_A,
        [
            tick(at(FULL_A, "15:00:00"), spxw, label="SPX"),
            tick(at(FULL_A, "15:00:01"), spxw, side="bid", label="SPXW"),
        ],
    )
    for alert in alerts:
        world.db.add(alert, source="replay")

    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")

    assert code == 0, out
    assert "root_label_mismatch: 1" in out
    assert "| 2026-03-10 | 1 | 1 | 1 | 0 | 0 | 0 | 1 |" in out


# --- The rebuild's day list -------------------------------------------------------------------


def test_rebuild_day_list_is_the_spec_list():
    days = tool.REBUILD_DAYS
    assert len(days) == 124
    assert days[0] == date(2026, 1, 2) and days[-1] == date(2026, 9, 4)
    assert EDGE_FIRST in days and EDGE_LAST in days
    for closed in (date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 1, 3)):
        assert closed not in days
    for live in (date(2026, 5, 14), date(2026, 7, 21), date(2026, 9, 8)):
        assert live not in days


@pytest.mark.parametrize(
    ("start", "end", "refused"),
    [
        ("2026-05-12", "2026-05-14", "2026-05-14"),
        ("2026-06-01", "2026-06-01", "2026-06-01"),
        ("2026-07-21", "2026-07-22", "2026-07-21"),
        ("2026-09-04", "2026-09-08", "2026-09-08"),
    ],
)
def test_rebuild_refuses_days_outside_its_list(world: World, start: str, end: str, refused: str):
    code, out = world.run("rebuild", "--from", start, "--to", end)

    assert code == 3
    assert refused in out
    assert world.db.dsns == []
    assert not world.runs.exists()


def test_rebuild_with_no_range_works_the_rebuild_days(
    world: World, monkeypatch: pytest.MonkeyPatch
):
    # The list is the two ranges and the two edge days, and no live day is in it.
    days = tool.rebuild_days(None, None)
    assert days == list(tool.REBUILD_DAYS) and len(days) == 124
    assert all(tool.rebuild_kind(day) is not None for day in days)
    assert not {date(2026, 5, 14), date(2026, 6, 1), date(2026, 7, 21), date(2026, 9, 8)} & set(
        days
    )
    assert (days[0], days[-1]) == (date(2026, 1, 2), date(2026, 9, 4))

    # The command with no --from or --to plans exactly that list (cut to two days for the tapes).
    monkeypatch.setattr(tool, "REBUILD_DAYS", (FULL_A, FULL_A2))
    two_full_days(world)
    code, out = world.run("rebuild")
    assert code == 0, out
    (run,) = world.runs.glob("*")
    assert list(runs.load_plan(run)["days"]) == ["2026-03-10", "2026-03-11"]


def test_rebuild_with_one_end_given_still_refuses_a_span_that_holds_live_days(world: World):
    code, out = world.run("rebuild", "--to", "2026-09-04")

    assert code == 3
    assert "2026-05-14" in out
    assert world.db.dsns == [] and not world.runs.exists()


def edge_first_world(world: World) -> dict[str, Any]:
    """2026-05-13: live's first row at 15:55:37.500Z, which has a tape twin 0.3 s earlier."""
    d = EDGE_FIRST
    before, early = chain("SPY", "C", 670, d), chain("QQQ", "P", 590, d)
    twin, after = chain("SPY", "C", 680, d), chain("QQQ", "C", 600, d)
    alerts = {
        a.option_chain: a
        for a in world.tape(
            d,
            fires(
                d,
                ("14:00:00", before),
                ("15:55:30", early),
                ("15:55:37.200", twin),
                ("16:30:00", after),
            ),
        )
    }
    first_live = world.db.add(alerts[twin], source="live", fired_at=at(d, "15:55:37.500"))
    # Live ran another rule then (8 codes), so its rows need not equal the replay's.
    later_live = world.db.add(
        alerts[after], source="live", fired_at=at(d, "16:30:00.300"), trade_count=2
    )
    return {
        "alerts": alerts,
        "insert": {before, early},
        "twin": twin,
        "live": [first_live, later_live],
    }


def test_rebuild_on_05_13_inserts_only_before_first_live_row_and_skips_live_twins(world: World):
    setup = edge_first_world(world)
    live_before = copy.deepcopy([world.db.rows[i] for i in setup["live"]])

    code, out, run = world.dry_run(EDGE_FIRST)

    assert code == 0, out
    day_plan = json.loads((run / "days" / "2026-05-13.json").read_text(encoding="utf-8"))
    assert {a["option_chain"] for a in day_plan["inserts"]} == setup["insert"]
    assert day_plan["deletes"] == []
    assert [t["option_chain"] for t in day_plan["twins"]] == [setup["twin"]]
    report = (run / "report.md").read_text(encoding="utf-8")
    assert setup["twin"] in report and "twin" in report.lower()
    assert "| 2026-05-13 | before first live row | 2026-05-13T15:55:37.500000+00:00 |" in report
    assert runs.load_plan(run)["days"]["2026-05-13"]["twins"] == 1

    code, out = world.apply(run)

    assert code == 0, out
    assert {r["option_chain"] for r in world.db.day(EDGE_FIRST, "replay")} == setup["insert"]
    assert [world.db.rows[i] for i in setup["live"]] == live_before
    code, out = world.run("verify", "--from", "2026-05-13", "--to", "2026-05-13")
    assert code == 0, out


def edge_last_world(
    world: World, *, live_rows: int = 11, last: str = "14:52:46.500"
) -> dict[str, Any]:
    """2026-07-22: `live_rows` live rows, the last at `last` with a tape twin after it (spec 4
    has 11, the last at 14:52:46Z)."""
    d = EDGE_LAST
    early, missed = chain("SPY", "C", 670, d), chain("QQQ", "P", 590, d)
    twin, late, spxw = (
        chain("SPY", "C", 680, d),
        chain("QQQ", "C", 600, d),
        chain("SPXW", "P", 6600, d),
    )
    alerts = {
        a.option_chain: a
        for a in world.tape(
            d,
            fires(
                d,
                ("14:00:00", early),
                ("14:30:00", missed),
                ("14:52:47", twin),
                ("15:30:00", late),
                ("19:00:00", spxw),
            ),
        )
    }
    live = [world.db.add(alerts[early], source="live", fired_at=at(d, "14:00:00.250"))]
    for n in range(live_rows - 2):  # the morning's other live rows, at keys the tape lacks
        live.append(
            world.db.add(
                replace(alerts[early], option_chain=chain("SPY", "P", 600 + n, d)),
                source="live",
                fired_at=at(d, f"13:{40 + n}:00"),
            )
        )
    live.append(world.db.add(alerts[twin], source="live", fired_at=at(d, last)))
    return {"insert": {late, spxw}, "twin": twin, "live": live}


def test_rebuild_on_07_22_inserts_only_after_last_live_row_and_skips_live_twins(world: World):
    setup = edge_last_world(world)
    live_before = copy.deepcopy([world.db.rows[i] for i in setup["live"]])

    code, out, run = world.dry_run(EDGE_LAST)

    assert code == 0, out
    day_plan = json.loads((run / "days" / "2026-07-22.json").read_text(encoding="utf-8"))
    assert {a["option_chain"] for a in day_plan["inserts"]} == setup["insert"]
    assert [t["option_chain"] for t in day_plan["twins"]] == [setup["twin"]]
    report = (run / "report.md").read_text(encoding="utf-8")
    assert setup["twin"] in report
    assert "| 2026-07-22 | after last live row | 2026-07-22T14:52:46.500000+00:00 |" in report

    code, out = world.apply(run)

    assert code == 0, out
    assert {r["option_chain"] for r in world.db.day(EDGE_LAST, "replay")} == setup["insert"]
    assert [world.db.rows[i] for i in setup["live"]] == live_before


@pytest.mark.parametrize(
    ("day", "case"),
    [
        (EDGE_FIRST, "first live row a second late"),
        (EDGE_LAST, "ten live rows"),
        (EDGE_LAST, "last live row a second late"),
    ],
)
def test_edge_day_bound_must_be_the_specs(world: World, day: date, case: str):
    if day == EDGE_FIRST:
        setup = edge_first_world(world)
        world.db.rows[setup["live"][0]]["fired_at"] = at(EDGE_FIRST, "15:55:38.100")
    elif case == "ten live rows":
        edge_last_world(world, live_rows=10)
    else:
        edge_last_world(world, last="14:52:47.400")

    code, out, run = world.dry_run(day)

    assert code == 1
    assert day.isoformat() in out and "spec section 4" in out
    assert not (run / "plan.json").exists()


def test_rebuild_never_deletes_a_live_row(world: World):
    setup = edge_first_world(world)
    # A replay row from an earlier rebuild of the day, which this one replaces.
    stale = world.db.add(
        replace_alert(setup["alerts"][next(iter(setup["insert"]))], trade_count=9), source="replay"
    )

    code, out, run = world.dry_run(EDGE_FIRST)
    assert code == 0, out
    code, out = world.apply(run)

    assert code == 0, out
    (delete,) = world.db.writes_starting("DELETE")
    assert "a.source = 'replay'" in delete.sql
    assert "a.expiry = v.day" in delete.sql  # and only ever the day being applied
    assert "NOT a.acknowledged" in delete.sql  # nor a row someone acknowledged
    assert delete.params == [(stale, EDGE_FIRST)]
    assert all(i in world.db.rows for i in setup["live"])
    assert stale not in world.db.rows


@pytest.mark.parametrize("at_tape_key", [True, False])
def test_rebuild_stops_on_live_row_collision_on_a_full_rebuild_day(world: World, at_tape_key: bool):
    spy = chain("SPY", "C", 670, OUTAGE)
    (alert,) = world.tape(OUTAGE, fires(OUTAGE, ("15:00:00", spy)))
    live = (
        alert if at_tape_key else replace_alert(alert, option_chain=chain("SPY", "C", 700, OUTAGE))
    )
    world.db.add(live, source="live", fired_at=alert.fired_at + timedelta(seconds=0.2))

    code, out, run = world.dry_run(OUTAGE)

    assert code == 1
    assert "2026-08-04" in out and "live" in out
    if at_tape_key:
        assert spy in out
    assert not (run / "plan.json").exists()


@pytest.mark.parametrize(("inside", "outside", "flagged"), [(501, 0, True), (500, 2, False)])
def test_rebuild_dry_run_flags_a_day_over_500(
    world: World, inside: int, outside: int, flagged: bool
):
    # August is CDT: 08:30 CT is 13:30Z and 15:00 CT is 20:00Z (the window's end is exclusive).
    ticks = [
        tick(at(OUTAGE, "14:00:00"), chain("SPY", "C", 100 + n, OUTAGE)) for n in range(inside)
    ]
    ticks += [
        tick(at(OUTAGE, clock), chain("QQQ", "C", 100 + n, OUTAGE))
        for n, clock in enumerate(["13:29:59.999", "20:00:00"][:outside])
    ]
    world.tape(OUTAGE, ticks)

    code, out, run = world.dry_run(OUTAGE)

    plan = runs.load_plan(run)
    report = (run / "report.md").read_text(encoding="utf-8")
    assert plan["largest_day"] == {"day": "2026-08-04", "feed_rows": inside}
    assert plan["days"]["2026-08-04"]["insert"] == inside + outside
    if flagged:
        assert code == 1
        assert plan["over_feed_cap"] == ["2026-08-04"]
        assert "2026-08-04: 501 rows between 08:30 and 15:00 CT" in report
    else:
        assert code == 0, out
        assert plan["over_feed_cap"] == []
        assert "over the feed's 500-row cap" not in report


def test_report_has_before_after_per_ticker_and_month(world: World):
    old = world.tape(
        MARCH_END,
        fires(
            MARCH_END,
            ("15:00:00", chain("SPY", "C", 670, MARCH_END)),
            ("15:05:00", chain("SPY", "C", 671, MARCH_END)),
            ("15:10:00", chain("QQQ", "C", 600, MARCH_END)),
        ),
    )
    for alert in old:
        world.db.add(alert, source="replay", trade_count=5)
    world.tape(
        MARCH_END,
        fires(
            MARCH_END,
            ("15:00:00", chain("SPY", "C", 670, MARCH_END)),
            ("15:10:00", chain("QQQ", "C", 600, MARCH_END)),
            ("15:20:00", chain("QQQ", "P", 590, MARCH_END)),
        ),
    )
    (spxw_old,) = world.tape(
        APRIL_START, fires(APRIL_START, ("15:00:00", chain("SPXW", "C", 6700, APRIL_START)))
    )
    world.db.add(spxw_old, source="replay", trade_count=5)
    world.tape(
        APRIL_START,
        fires(
            APRIL_START,
            ("15:00:00", chain("SPXW", "C", 6700, APRIL_START)),
            ("15:30:00", chain("SPXW", "P", 6600, APRIL_START)),
            ("16:00:00", chain("SPY", "P", 660, APRIL_START)),
        ),
    )

    code, out, run = world.dry_run(MARCH_END, APRIL_START)

    assert code == 0, out
    report = (run / "report.md").read_text(encoding="utf-8")
    assert "| Month | Ticker | Before | After | Change |" in report
    for line in (
        "| 2026-03 | SPXW | 0 | 0 | 0 |",
        "| 2026-03 | SPY | 2 | 1 | -1 |",
        "| 2026-03 | QQQ | 1 | 2 | +1 |",
        "| 2026-04 | SPXW | 1 | 2 | +1 |",
        "| 2026-04 | SPY | 0 | 1 | +1 |",
        "| 2026-04 | QQQ | 0 | 0 | 0 |",
    ):
        assert line in report
    assert "| 2026-03-31 | full | - | 3 | 3 |" in report


def test_dry_run_stops_on_a_day_whose_tape_has_no_rows(world: World):
    # Only a print for another expiry: the replay keeps no row for the day.
    path = world.tmp / "tapes" / "2026-03-10-fulltape.parquet"
    write_tape(path, [tick(at(FULL_A, "15:00:00"), chain("SPY", "C", 670, FULL_A2))])
    world.tapes["2026-03-10"] = str(path)

    code, out, run = world.dry_run(FULL_A)

    assert code == 1
    assert "2026-03-10" in out and "ValueError" in out
    assert not (run / "plan.json").exists()


def test_rebuild_stops_rather_than_delete_an_acknowledged_replay_row(world: World):
    (alert,) = world.tape(FULL_A, fires(FULL_A, ("15:00:00", chain("SPY", "C", 670, FULL_A))))
    acked = world.db.add(alert, source="replay", acknowledged=True)

    code, out, run = world.dry_run(FULL_A)

    assert code == 1
    assert "acknowledg" in out and str(acked) in out
    assert not (run / "plan.json").exists()


def test_edge_day_with_no_live_rows_stops(world: World):
    world.tape(EDGE_FIRST, fires(EDGE_FIRST, ("14:00:00", chain("SPY", "C", 670, EDGE_FIRST))))

    code, out, run = world.dry_run(EDGE_FIRST)

    assert code == 1
    assert "2026-05-13" in out and "no live rows" in out
    assert not (run / "plan.json").exists()


# --- Apply and resume -------------------------------------------------------------------------


def two_full_days(world: World) -> dict[date, list[int]]:
    """03-10 and 03-11, each with one old backfill row and two tape alerts."""
    old: dict[date, list[int]] = {}
    for d in (FULL_A, FULL_A2):
        spy, qqq = chain("SPY", "C", 670, d), chain("QQQ", "P", 590, d)
        alerts = world.tape(d, fires(d, ("15:00:00", spy), ("15:10:00", qqq)))
        old[d] = [world.db.add(alerts[0], source="replay", trade_count=11)]
    return old


def test_apply_writes_the_plan_and_marks_each_day(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    assert plan_totals(run) == {"delete": 2, "insert": 4}

    code, out = world.apply(run)

    assert code == 0, out
    for d in (FULL_A, FULL_A2):
        assert old[d][0] not in world.db.rows
        assert keys(world.db.day(d, "replay")) == keys(world.alerts[d])
        marker = json.loads((run / f"{d.isoformat()}.applied").read_text(encoding="utf-8"))
        assert marker["deleted"] == 1 and marker["inserted"] == 2
    # Each day's write transaction is bounded before its first read.
    sql = [s.sql for s in world.db.statements]
    for at_delete in [i for i, text in enumerate(sql) if text.startswith("DELETE")]:
        assert sql[at_delete - 3] == "SET LOCAL statement_timeout = '60s'"
        assert sql[at_delete - 2] == "SET LOCAL lock_timeout = '5s'"
        assert sql[at_delete - 1].startswith("SELECT id, source, acknowledged")
    # One grouped count for the measured table, not a read of every row of every day.
    (grouped,) = [s for s in world.db.statements if "GROUP BY" in s.sql]
    assert grouped.params == ([FULL_A, FULL_A2],)
    report = (run / "report.md").read_text(encoding="utf-8")
    measured = report.split("## Measured after the apply")[1]
    assert "| 2026-03 | SPY | 2 | 2 | 0 |" in measured
    assert "| 2026-03 | QQQ | 0 | 2 | +2 |" in measured
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-11")
    assert code == 0, out


def test_connects_to_the_direct_host_never_the_pooler(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-11")
    assert code == 0, out

    assert len(world.db.dsns) == 3
    assert set(world.db.dsns) == {DIRECT_URL}
    assert all("-pooler" not in dsn for dsn in world.db.dsns)


@pytest.mark.parametrize("wrong", ["delete", "insert"])
def test_apply_refuses_expect_mismatch(world: World, wrong: str):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    totals = plan_totals(run)

    code, out = world.apply(run, **{wrong: totals[wrong] + 1})

    assert code == 3
    assert f"--expect-{wrong}" in out
    assert world.db.rows == rows_before
    assert world.db.writes() == [] and world.s3.puts == []
    assert not (run / "backup.jsonl").exists()


def test_resume_counts_only_unapplied_days(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    (run / "2026-03-10.applied").write_text("{}", encoding="utf-8")

    code, out = world.apply(run, delete=2, insert=4)
    assert code == 3
    assert world.db.writes() == []

    code, out = world.apply(run, delete=1, insert=2)
    assert code == 0, out
    assert old[FULL_A][0] in world.db.rows  # its marker says applied, so it is not redone
    assert old[FULL_A2][0] not in world.db.rows


@pytest.mark.parametrize("which", ["replay module", *runs.TOOL_FILES])
def test_apply_refuses_changed_module_hash(
    world: World, monkeypatch: pytest.MonkeyPatch, which: str
):
    # Each code file in turn is a copy the test can edit: the replay module, and every file of
    # the tool (the CLI, the shared machinery and the calendar it loads from nightly).
    copy_path = world.tmp / "code" / Path(which).name
    copy_path.parent.mkdir()
    if which == "replay module":
        shutil.copyfile(runs.MODULE_PATH, copy_path.with_suffix(".py"))
        copy_path = copy_path.with_suffix(".py")
        monkeypatch.setattr(runs, "MODULE_PATH", copy_path)
    else:
        shutil.copyfile(runs.TOOL_FILES[which], copy_path)
        monkeypatch.setitem(runs.TOOL_FILES, which, copy_path)
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    plan = runs.load_plan(run)
    assert (
        set(plan["tool_blobs"])
        == set(runs.TOOL_FILES)
        == {
            "scripts/interval_ba_tape.py",
            "scripts/interval_ba_tape_runs.py",
            "nightly/src/calendar_nyse.py",
        }
    )
    with copy_path.open("a", encoding="utf-8") as handle:
        handle.write("# changed\n")

    code, out = world.apply(run)

    assert code == 3
    assert "blob" in out
    if which != "replay module":
        assert which in out
    assert world.db.writes() == [] and world.s3.puts == []


@pytest.mark.parametrize("edit", ["write list", "whole file"])
def test_apply_refuses_an_edited_day_file(world: World, edit: str):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    path = run / "days" / "2026-03-10.json"
    day_plan = json.loads(path.read_text(encoding="utf-8"))
    if edit == "write list":  # the file no longer hashes to its own sha256
        day_plan["deletes"].append(999)
    else:  # a self-consistent file that is not the plan.json the owner saw
        day_plan["inserts"].pop()
        day_plan["sha256"] = tool.ibr._write_set_sha(
            FULL_A,
            [tool.ibr._alert_from_json(a) for a in day_plan["inserts"]],
            (old[FULL_A][0],),
            (),
            (),
        )
    path.write_text(json.dumps(day_plan), encoding="utf-8")

    code, out = world.apply(run)

    assert code == 3
    assert "2026-03-10" in out
    assert world.db.writes_starting("DELETE") == [] and world.db.writes_starting("INSERT") == []
    assert not (run / "2026-03-10.applied").exists()


def _drop(mapping: dict[str, Any], key: str) -> None:
    del mapping[key]


# (what is damaged, how) over a fresh dry run of 03-10; each is refused with exit 3.
_DAMAGES: list[tuple[str, Callable[[Path, dict[str, Any]], None]]] = [
    ("plan without module_blob", lambda run, plan: _drop(plan, "module_blob")),
    ("plan tool_blobs not a mapping", lambda run, plan: plan.update(tool_blobs=["x"])),
    ("plan day without insert", lambda run, plan: _drop(plan["days"]["2026-03-10"], "insert")),
    ("plan day delete not a count", lambda run, plan: plan["days"]["2026-03-10"].update(delete=[])),
    ("plan day not a date", lambda run, plan: plan["days"].update({"03/10": {}})),
    (
        "day file not JSON",
        lambda run, plan: (run / "days" / "2026-03-10.json").write_text("{", encoding="utf-8"),
    ),
    ("day file missing", lambda run, plan: (run / "days" / "2026-03-10.json").unlink()),
    (
        "day file without inserts",
        lambda run, plan: (run / "days" / "2026-03-10.json").write_text(
            '{"day": "2026-03-10"}', encoding="utf-8"
        ),
    ),
    # decimal.InvalidOperation is an ArithmeticError, not a ValueError.
    ("day file decimal not a number", lambda run, plan: _edit_insert(run, underlying_price="x")),
    # The measured report reads them after the writes, so they are checked before any.
    (
        "plan day tickers without after",
        lambda run, plan: _drop(plan["days"]["2026-03-10"]["tickers"]["SPY"], "after"),
    ),
    (
        "plan day tickers not a mapping",
        lambda run, plan: plan["days"]["2026-03-10"].update(tickers=[]),
    ),
]


def _edit_insert(run: Path, **changes: Any) -> None:
    path = run / "days" / "2026-03-10.json"
    day_plan = json.loads(path.read_text(encoding="utf-8"))
    day_plan["inserts"][0].update(changes)
    path.write_text(json.dumps(day_plan), encoding="utf-8")


@pytest.mark.parametrize(("damage", "how"), _DAMAGES, ids=[name for name, _ in _DAMAGES])
def test_apply_refuses_a_damaged_plan(
    world: World, damage: str, how: Callable[[Path, dict[str, Any]], None]
):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    totals = plan_totals(run)
    plan = runs.load_plan(run)
    how(run, plan)
    (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")

    code, out = world.apply(run, delete=totals["delete"], insert=totals["insert"])

    assert code == 3, out
    assert "REFUSED" in out
    assert len(world.db.dsns) == 1 and world.s3.puts == []  # the dry run's only


def test_apply_with_an_unparseable_plan_is_a_bad_argument(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    (run / "plan.json").write_text('{"mode": "rebuild", "days": {', encoding="utf-8")

    code, out = world.run(
        "rebuild", "--apply", "--run", str(run), "--expect-delete", "1", "--expect-insert", "2"
    )

    assert code == 2
    assert "does not parse" in out
    assert len(world.db.dsns) == 1  # the dry run's only


def test_apply_refuses_plan_counts_that_disagree_with_the_day_file(world: World):
    # plan.json's count is what --expect is checked against, and the day file's write lists
    # are what is written: an edit to the count alone must not pass the --expect check.
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    plan = runs.load_plan(run)
    plan["days"]["2026-03-10"]["insert"] = 1
    (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")

    code, out = world.apply(run, delete=1, insert=1)

    assert code == 3
    assert "2026-03-10" in out and "1 inserts" in out
    assert len(world.db.dsns) == 1  # the dry run's only


def test_day_already_in_end_state_is_marked_and_skipped_before_the_sha_check(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    # A run that committed 03-10 and died before its marker: the plan's end state is in the
    # table, so a fresh plan now would delete these rows and no longer hash to the plan's sha.
    del world.db.rows[old[FULL_A][0]]
    for alert in world.alerts[FULL_A]:
        world.db.add(alert, source="replay")

    code, out = world.apply(run, delete=2, insert=4)

    assert code == 0, out
    marker = json.loads((run / "2026-03-10.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "end state"
    assert all(s.params[0][1] == FULL_A2 for s in world.db.writes_starting("DELETE"))
    assert keys(world.db.day(FULL_A, "replay")) == keys(world.alerts[FULL_A])


def test_end_state_needs_the_planned_values_not_just_the_keys(world: World):
    # The old backfill fired the same buckets with other values (a 70% ratio, no gate): its
    # keys are the plan's, so only the values tell that the day still needs its rebuild.
    spy, qqq = chain("SPY", "C", 670, FULL_A), chain("QQQ", "P", 590, FULL_A)
    alerts = world.tape(FULL_A, fires(FULL_A, ("15:00:00", spy), ("15:10:00", qqq)))
    old = [world.db.add(alert, source="replay", trade_count=4) for alert in alerts]
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out

    code, out = world.apply(run)

    assert code == 0, out
    marker = json.loads((run / "2026-03-10.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "applied" and marker["deleted"] == 2 and marker["inserted"] == 2
    assert not set(old) & set(world.db.rows)
    assert {r["trade_count"] for r in world.db.day(FULL_A)} == {1}


@pytest.mark.parametrize("what_moved", ["rows", "tape"])
def test_apply_stops_when_a_days_fresh_sha_differs(world: World, what_moved: str):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    if what_moved == "rows":
        world.db.add(world.alerts[FULL_A2][1], source="replay", trade_count=3)
    else:
        world.tape(FULL_A2, fires(FULL_A2, ("15:00:00", chain("SPY", "C", 670, FULL_A2))))
    rows_before = {i: r for i, r in copy.deepcopy(world.db.rows).items() if r["expiry"] == FULL_A2}

    code, out = world.apply(run)

    assert code == 3
    assert "2026-03-11" in out and "PlanChanged" in out
    assert (run / "2026-03-10.applied").exists()
    assert old[FULL_A][0] not in world.db.rows
    assert not (run / "2026-03-11.applied").exists()
    assert {i: r for i, r in world.db.rows.items() if r["expiry"] == FULL_A2} == rows_before


def test_db_error_mid_day_rolls_back_and_writes_no_marker(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    world.db.fail_on = "INSERT INTO interval_ba_alerts"

    code, out = world.apply(run)

    assert code == 1
    assert "OperationalError" in out
    assert old[FULL_A][0] in world.db.rows  # the DELETE before the failure was rolled back
    assert not (run / "2026-03-10.applied").exists()


def test_apply_rolls_back_when_the_database_writes_other_than_the_plan(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    first = world.alerts[FULL_A][0]
    # Another writer lands a row at a planned key after the plan was re-checked.
    world.db.before_insert = lambda: (
        world.db.add(first, source="live"),
        setattr(world.db, "before_insert", None),
    )

    code, out = world.apply(run)

    assert code == 1
    assert "inserted 1 of 2" in out
    assert old[FULL_A][0] in world.db.rows
    assert not (run / "2026-03-10.applied").exists()


# --- Backup -----------------------------------------------------------------------------------


def test_first_apply_backs_up_every_row_locally_and_in_r2(world: World):
    old = two_full_days(world)
    november = date(2026, 11, 20)
    live_elsewhere = world.db.add(
        replace_alert(world.alerts[FULL_A][1], option_chain=chain("QQQ", "P", 590, november)),
        source="live",
        expiry=november,
    )
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)

    code, out = world.apply(run)

    assert code == 0, out
    lines = (run / "backup.jsonl").read_bytes().splitlines()
    backed_up = [json.loads(line) for line in lines]
    assert [r["id"] for r in backed_up] == sorted(rows_before)
    assert {r["id"] for r in backed_up} >= {old[FULL_A][0], live_elsewhere}
    assert backed_up[0]["source"] == rows_before[backed_up[0]["id"]]["source"]
    (key,) = world.s3.puts
    assert key.startswith("backups/interval-ba-alerts/") and key.endswith(".jsonl")
    body, metadata = world.s3.objects[("bucket-sekret", key)]
    assert body == (run / "backup.jsonl").read_bytes()
    assert metadata == {"sha256": hashlib.sha256(body).hexdigest(), "rows": str(len(lines))}
    assert json.loads((run / "backup.json").read_text(encoding="utf-8"))["r2_key"] == key
    (snapshot,) = [s for s in world.db.statements if s.sql.startswith("SET TRANSACTION")]
    assert "REPEATABLE READ" in snapshot.sql and "READ ONLY" in snapshot.sql
    at = world.db.statements.index(snapshot)
    assert [s.sql for s in world.db.statements[at + 1 : at + 4]] == [
        "SET LOCAL statement_timeout = '60s'",
        "SET LOCAL lock_timeout = '5s'",
        "SELECT count(*) FROM interval_ba_alerts",
    ]


@pytest.mark.parametrize("failure", ["table count", "file bytes"])
def test_backup_readback_failure_stops_before_any_write(
    world: World, monkeypatch: pytest.MonkeyPatch, failure: str
):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    if failure == "table count":
        world.db.count_skew = 1
    else:
        real = hashlib.file_digest
        monkeypatch.setattr(
            runs.hashlib,
            "file_digest",
            lambda handle, name: real(_Prefixed(handle), name),
        )

    code, out = world.apply(run)

    assert code == 1
    assert "backup" in out.lower()
    assert world.db.writes() == [] and world.db.rows == rows_before
    assert world.s3.puts == []
    assert not (run / "backup.json").exists()


class _Prefixed:
    """A file whose read-back gives one extra byte first: a disk that changed the backup."""

    def __init__(self, handle: Any) -> None:
        self._handle, self._sent = handle, False

    def readinto(self, buffer: Any) -> int:
        if not self._sent:
            self._sent = True
            buffer[0] = ord("x")
            return 1
        return self._handle.readinto(buffer)

    def readable(self) -> bool:
        return True


@pytest.mark.parametrize(
    ("tamper", "named"),
    [
        ({"Metadata": {"sha256": "0" * 64}}, "sha256 metadata"),
        ({"Metadata": {"rows": "999"}}, "rows metadata"),
        ({"ContentLength": 1}, "size"),
        ({"ETag": '"0123"'}, "ETag"),
    ],
)
def test_r2_metadata_mismatch_stops_before_any_write(
    world: World, tamper: dict[str, Any], named: str
):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    world.s3.tamper = tamper

    code, out = world.apply(run)

    assert code == 1
    assert "R2" in out and named in out
    assert world.db.writes() == [] and world.db.rows == rows_before
    assert not (run / "backup.json").exists()


@pytest.mark.parametrize("operation", ["put_object", "head_object"])
def test_r2_client_error_stops_before_any_write(world: World, operation: str):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    world.s3.fail[operation] = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied for bucket-sekret"}},
        "PutObject" if operation == "put_object" else "HeadObject",
    )

    code, out = world.apply(run)

    assert code == 1
    assert "ClientError" in out
    assert "AccessDenied" not in out and "denied for" not in out  # its text is not shown
    assert world.db.writes() == [] and world.db.rows == rows_before
    assert not (run / "backup.json").exists()


def test_database_error_during_the_backup_stream_stops_before_any_write(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    world.db.fail_on = "SELECT * FROM interval_ba_alerts"

    code, out = world.apply(run)

    assert code == 1
    assert "FAILED: OperationalError" in out
    assert "server closed" not in out
    assert world.db.writes() == [] and world.db.rows == rows_before
    assert not (run / "backup.json").exists() and world.s3.puts == []
    (conn,) = world.db.conns[-1:]
    assert not conn.in_transaction


def test_resume_takes_no_new_backup(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    world.db.add(world.alerts[FULL_A2][1], source="replay", trade_count=3)  # 03-11 moves
    code, out = world.apply(run)
    assert code == 3
    assert (run / "2026-03-10.applied").exists() and len(world.s3.puts) == 1
    backup = (run / "backup.jsonl").read_bytes()
    # The owner takes the extra row back out, and applies the rest of the same run.
    (extra,) = [r["id"] for r in world.db.day(FULL_A2, "replay") if r["trade_count"] == 3]
    del world.db.rows[extra]
    reads = len(world.db.backup_reads())

    code, out = world.apply(run)

    assert code == 0, out
    assert len(world.s3.puts) == 1
    assert len(world.db.backup_reads()) == reads
    assert (run / "backup.jsonl").read_bytes() == backup
    assert (run / "2026-03-11.applied").exists()


def test_resume_stops_when_the_runs_backup_changed(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    (run / "2026-03-10.applied").write_text("{}", encoding="utf-8")
    code, out = world.apply(run)  # takes the backup and applies 03-11
    assert code == 0, out
    (run / "2026-03-11.applied").unlink()
    world.db.rows.clear()
    world.db.add(world.alerts[FULL_A2][0], source="replay", trade_count=11)  # back to the plan
    old_id = max(world.db.rows)
    with (run / "backup.jsonl").open("ab") as handle:
        handle.write(b'{"id": 1}\n')

    code, out = world.apply(run, delete=1, insert=2)

    assert code == 1
    assert "backup.jsonl no longer matches" in out
    assert old_id in world.db.rows and old[FULL_A2][0] not in world.db.rows
    assert not (run / "2026-03-11.applied").exists()


def test_day_file_round_trips_and_refuses_an_edit(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    stored = json.loads((run / "days" / "2026-03-10.json").read_text(encoding="utf-8"))

    day_plan = tool.RebuildDay.from_json(stored)

    assert day_plan.to_json() == stored
    assert [a.key for a in day_plan.inserts] == [a.key for a in world.alerts[FULL_A]]
    stored["inserts"][0]["trade_count"] = 2
    with pytest.raises(ValueError, match="do not match its sha256"):
        tool.RebuildDay.from_json(stored)


def test_env_file_missing_a_name_is_a_bad_argument(world: World):
    world.env_file.write_text(
        "".join(f"{k}={v}\n" for k, v in SECRETS.items() if k != "R2_BUCKET_FULLTAPE"),
        encoding="utf-8",
    )

    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")

    assert code == 2
    assert "R2_BUCKET_FULLTAPE" in out
    assert world.db.dsns == []


# --- Windows and secrets ----------------------------------------------------------------------


def ct(day: date, clock: str) -> datetime:
    return datetime.fromisoformat(f"{day.isoformat()}T{clock}").replace(tzinfo=CT)


TUESDAY, SATURDAY = date(2026, 11, 24), date(2026, 11, 28)


@pytest.mark.parametrize(
    ("now", "allow", "code"),
    [
        (ct(TUESDAY, "08:14:59"), False, 0),
        (ct(TUESDAY, "08:15:00"), False, 3),
        (ct(TUESDAY, "12:00:00"), False, 3),
        (ct(TUESDAY, "15:59:59"), False, 3),
        (ct(TUESDAY, "16:00:00"), False, 0),
        (ct(SATURDAY, "10:00:00"), False, 0),
        (ct(TUESDAY, "12:00:00"), True, 0),
    ],
)
def test_refuses_weekday_0815_to_1600_ct(world: World, now: datetime, allow: bool, code: int):
    world.tape(FULL_A, fires(FULL_A, ("15:00:00", chain("SPY", "C", 670, FULL_A))))
    world.clock = lambda: now
    extra = ["--allow-market-hours"] if allow else []

    got, out = world.run("rebuild", "--from", "2026-03-10", "--to", "2026-03-10", *extra)

    assert got == code, out
    if code == 3:
        assert "08:15" in out and world.db.dsns == []


def test_apply_refuses_to_start_in_market_hours(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    world.clock = lambda: ct(TUESDAY, "10:00:00")

    code, out = world.apply(run)

    assert code == 3
    assert world.db.writes() == [] and world.s3.puts == []


@pytest.mark.parametrize(
    ("now", "code"),
    [
        (datetime(2026, 11, 29, 7, 14, 59, tzinfo=UTC), 0),
        (datetime(2026, 11, 29, 7, 15, tzinfo=UTC), 3),
        (datetime(2026, 11, 29, 10, 0, tzinfo=UTC), 3),
        (datetime(2026, 11, 25, 12, 29, 59, tzinfo=UTC), 3),
        (datetime(2026, 11, 29, 12, 30, tzinfo=UTC), 0),
    ],
)
def test_refuses_0715_to_1230_utc_even_with_allow_market_hours(
    world: World, now: datetime, code: int
):
    world.tape(FULL_A, fires(FULL_A, ("15:00:00", chain("SPY", "C", 670, FULL_A))))
    world.clock = lambda: now

    got, out = world.run(
        "rebuild", "--from", "2026-03-10", "--to", "2026-03-10", "--allow-market-hours"
    )

    assert got == code, out
    if code == 3:
        assert "07:15" in out and world.db.dsns == []


def test_window_rechecked_before_each_days_write(world: World):
    old = two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    # The run reaches the nightly window once 03-10 is done.
    world.clock = lambda: (
        datetime(2026, 11, 26, 7, 20, tzinfo=UTC)
        if (run / "2026-03-10.applied").exists()
        else SAFE_NOW
    )

    code, out = world.apply(run)

    assert code == 3
    assert "07:15" in out and "2026-03-11" in out
    assert old[FULL_A][0] not in world.db.rows
    assert old[FULL_A2][0] in world.db.rows
    assert not (run / "2026-03-11.applied").exists()
    assert all(s.params[0][1] == FULL_A for s in world.db.writes_starting("DELETE"))


def test_never_prints_secrets(world: World, monkeypatch: pytest.MonkeyPatch):
    two_full_days(world)
    outputs: list[str] = []
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    outputs.append(out)
    assert code == 0, out
    code, out = world.apply(run)
    outputs.append(out)
    assert code == 0, out
    outputs.append(world.run("verify", "--from", "2026-03-10", "--to", "2026-03-11")[1])
    assert world.db.dsns and set(world.db.dsns) == {DIRECT_URL}

    # A tape the tape reader cannot find, at a path that names the bucket and the endpoint.
    monkeypatch.setattr(
        runs,
        "r2_url",
        lambda day: str(
            world.tmp / "acct-sekret.r2.cloudflarestorage.com" / "bucket-sekret" / f"{day}.parquet"
        ),
    )
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")
    outputs.append(out)
    assert code == 1 and "<redacted>" in out

    # A connect error and an unexpected error, each with secrets in its text.
    def refuse(dsn: str, **kwargs: Any):
        raise psycopg2.DatabaseError(
            f"could not connect to {SECRETS['DATABASE_URL']} as owner-sekret"
        )

    monkeypatch.setattr(psycopg2, "connect", refuse)
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")
    outputs.append(out)
    assert code == 1 and "DatabaseError" in out
    # Its text is not shown at all: it can name a resolved address that no env value holds.
    assert "could not connect" not in out
    monkeypatch.setattr(psycopg2, "connect", world.db.connect)

    def broken(**kwargs: Any):
        raise RuntimeError(
            f"endpoint {SECRETS['R2_ENDPOINT_URL']} key {SECRETS['R2_SECRET_ACCESS_KEY']}"
            " for account acct-sekret, database at db-sekret.example.neon.tech"
        )

    monkeypatch.setattr(runs, "fulltape_connection", broken)
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")
    outputs.append(out)
    assert code == 1 and "RuntimeError" in out

    files = [p.read_text(encoding="utf-8") for p in world.runs.rglob("*") if p.is_file()]
    for text in [*outputs, *files]:
        for secret in SECRET_PARTS:
            assert secret not in text


def test_apply_without_a_plan_is_a_bad_argument(world: World):
    (world.tmp / "empty").mkdir()

    code, out = world.run(
        "rebuild",
        "--apply",
        "--run",
        str(world.tmp / "empty"),
        "--expect-delete",
        "0",
        "--expect-insert",
        "0",
    )

    assert code == 2
    assert "plan.json" in out


# --- heal -------------------------------------------------------------------------------------

JUNE, JUNE2 = date(2026, 6, 2), date(2026, 6, 3)  # live days on the old rule (CDT)
OCT28, OCT29, OCT30 = date(2026, 10, 28), date(2026, 10, 29), date(2026, 10, 30)
FULL_A3 = date(2026, 3, 12)
HELD_NO_RECORD = "no live settings record"
HEAL_COUNTS = ("inserted", "removed", "flags_changed", "spot_filled")


def settings_row(
    booted_at: datetime, *, tickers: Sequence[str] = ("QQQ", "SPXW", "SPY"), enabled: bool = True
) -> tuple[Any, ...]:
    """An interval_ba_live_settings row with this rule's values, as psycopg2 returns it."""
    return (
        booted_at,
        enabled,
        list(tickers),
        Decimal("0.7500"),
        Decimal("250000.00"),
        ibr.WINDOW_SEC,
        Decimal("0.5000"),
        sorted(ibr.MULTI_LEG_CODES),
        ibr.CONFLUENCE_WINDOW_SEC,
    )


def add_live(world: World, alert: Any, **changes: Any) -> int:
    """The live row for a tape alert as live wrote it: a wall-clock fired_at, both flags false
    and, on SPXW, no spot."""
    values: dict[str, Any] = {
        "fired_at": alert.fired_at + timedelta(milliseconds=150),
        "top_trade_is_sweep": False,
        "top_trade_is_floor": False,
    }
    if alert.ticker == "SPXW":
        values["underlying_price"] = None
    values.update(changes)
    return world.db.add(alert, source="live", **values)


def live_day(world: World, day: date) -> dict[str, Any]:
    """A live day: an SPY call whose top trade is an intermarket sweep (live's flags are false),
    an SPXW call with no spot (live writes none), and a QQQ put and an SPXW put live missed."""
    sweep, spxw = chain("SPY", "C", 670, day), chain("SPXW", "C", 6700, day)
    qqq_put, spxw_put = chain("QQQ", "P", 590, day), chain("SPXW", "P", 6600, day)
    alerts = {
        a.option_chain: a
        for a in world.tape(
            day,
            [
                tick(at(day, "15:00:00"), sweep, flags=("intermarket_sweep",)),
                tick(at(day, "15:10:00"), spxw, spot=6701.25),
                tick(at(day, "15:20:00"), qqq_put),
                tick(at(day, "15:30:00"), spxw_put),
            ],
        )
    }
    return {
        "alerts": alerts,
        "flag_row": add_live(world, alerts[sweep]),
        "spot_row": add_live(world, alerts[spxw]),
        "missed": {qqq_put, spxw_put},
    }


@pytest.mark.parametrize(
    ("start", "end"), [("2026-05-12", "2026-05-13"), ("2026-03-10", "2026-03-11")]
)
def test_heal_refuses_day_before_live_start(world: World, start: str, end: str):
    code, out = world.run("heal", "--from", start, "--to", end)

    assert code == 3
    assert start in out and "2026-05-13" in out
    assert world.db.dsns == []
    assert not world.runs.exists()


def test_heal_insert_missed_only_from_10_29(world: World):
    days = {d: live_day(world, d) for d in (OCT28, OCT29)}
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))  # this rule, all three on

    code, out, run = world.dry_run(OCT28, OCT29, command="heal")

    assert code == 0, out
    assert world.db.writes() == []
    plan = runs.load_plan(run)
    before, after = plan["days"]["2026-10-28"], plan["days"]["2026-10-29"]
    assert before["insert_missed"] is False and before["settings"] == "not consulted"
    assert (before["insert"], before["live_missed"]) == (0, 2)
    assert after["insert_missed"] is True and after["settings"] == "live"
    assert (after["insert"], after["live_missed"]) == (2, 2)
    for entry in (before, after):
        assert (entry["remove"], entry["flags"], entry["spot"]) == (0, 1, 1)
    assert plan["totals"] == {"insert": 2, "remove": 0, "flags": 2, "spot": 2}
    day_file = json.loads((run / "days" / "2026-10-29.json").read_text(encoding="utf-8"))
    assert {a["option_chain"] for a in day_file["inserts"]} == days[OCT29]["missed"]
    # Only the day that may insert reads the settings.
    assert len([s for s in world.db.statements if "interval_ba_live_settings" in s.sql]) == 1
    report = (run / "report.md").read_text(encoding="utf-8")
    assert "--expect-insert 2 --expect-remove 0 --expect-flags 2 --expect-spot 2" in report
    assert "| 2026-10 | SPXW | 2 | 3 | +1 |" in report

    code, out = world.apply(run, command="heal")

    assert code == 0, out
    assert world.db.day(OCT28, "replay") == []
    assert {r["option_chain"] for r in world.db.day(OCT29, "replay")} == days[OCT29]["missed"]
    for d, setup in days.items():
        assert world.db.rows[setup["flag_row"]]["top_trade_is_sweep"] is True
        assert world.db.rows[setup["spot_row"]]["underlying_price"] == Decimal("6701.25")
        assert world.db.tape_days[d]["inserted"] == (2 if d == OCT29 else 0)
    measured = (run / "report.md").read_text(encoding="utf-8").split("## Measured after")[1]
    assert "| 2026-10 | SPXW | 2 | 3 | +1 |" in measured


@pytest.mark.parametrize("assume", [True, False])
def test_assume_default_settings_applies_only_to_uncovered_days(world: World, assume: bool):
    days = {d: live_day(world, d) for d in (OCT29, OCT30)}
    # The first settings row boots before 10-30's session, with SPXW off; none covers 10-29.
    world.db.settings.append(settings_row(ct(OCT30, "07:00:00"), tickers=("QQQ", "SPY")))
    qqq_put = chain("QQQ", "P", 590, OCT30)

    code, out, run = world.dry_run(
        OCT29, OCT30, command="heal", extra=["--assume-default-settings"] if assume else []
    )

    plan = runs.load_plan(run)
    uncovered, covered = plan["days"]["2026-10-29"], plan["days"]["2026-10-30"]
    covered_file = json.loads((run / "days" / "2026-10-30.json").read_text(encoding="utf-8"))
    # The covered day runs on its own row, SPXW off, with the flag or without it.
    assert covered["settings"] == "live" and covered["inserts_held"] is None
    assert [a["option_chain"] for a in covered_file["inserts"]] == [qqq_put]
    if assume:
        assert code == 0, out
        assert uncovered["settings"] == "assumed default" and uncovered["inserts_held"] is None
        assert uncovered["insert"] == 2
        code, out = world.apply(run, command="heal")
        assert code == 0, out
        assert {r["option_chain"] for r in world.db.day(OCT29, "replay")} == days[OCT29]["missed"]
        assert [r["option_chain"] for r in world.db.day(OCT30, "replay")] == [qqq_put]
    else:
        assert code == 1
        assert "FLAG" in out and "2026-10-29" in out and HELD_NO_RECORD in out
        assert uncovered["settings"] == "none" and uncovered["inserts_held"] == HELD_NO_RECORD
        assert (uncovered["insert"], uncovered["flags"], uncovered["spot"]) == (0, 1, 1)
        assert HELD_NO_RECORD in (run / "report.md").read_text(encoding="utf-8")


def test_heal_apply_checks_expect_totals_and_fresh_sha(world: World):
    setup = live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    totals = plan_totals(run, EXPECTS["heal"])
    assert totals == {"insert": 2, "remove": 0, "flags": 1, "spot": 1}
    rows_before = copy.deepcopy(world.db.rows)

    for name in EXPECTS["heal"]:
        code, out = world.apply(run, command="heal", **{name: totals[name] + 1})
        assert code == 3
        assert f"--expect-{name}" in out
    assert world.db.writes() == [] and world.s3.puts == []

    # The day moves after the plan: something fills the SPXW spot first.
    world.db.rows[setup["spot_row"]]["underlying_price"] = Decimal("6650.00")
    code, out = world.apply(run, command="heal")
    assert code == 3
    assert "2026-10-29" in out and "PlanChanged" in out
    assert not (run / "2026-10-29.applied").exists() and OCT29 not in world.db.tape_days
    assert world.db.writes() == []

    world.db.rows[setup["spot_row"]]["underlying_price"] = None
    code, out = world.apply(run, command="heal")

    assert code == 0, out
    marker = json.loads((run / "2026-10-29.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "applied"
    assert [marker[name] for name in HEAL_COUNTS] == [2, 0, 1, 1]
    assert world.db.tape_days[OCT29]["inserted"] == 2
    # On the rows that were there, only the two flags and a blank SPXW spot changed.
    for row_id, before in rows_before.items():
        after = world.db.rows[row_id]
        changed = {name for name in before if before[name] != after[name]}
        assert changed <= {"top_trade_is_sweep", "top_trade_is_floor", "underlying_price"}
    assert len(world.s3.puts) == 1  # the run's one backup
    # Every session is bounded, heal_day's transaction (which the tool cannot open) included.
    assert world.db.connect_kwargs
    assert all("statement_timeout=60000" in kw["options"] for kw in world.db.connect_kwargs)


def test_heal_day_in_its_end_state_is_marked_and_not_rewritten(world: World):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    totals = plan_totals(run, EXPECTS["heal"])
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    # The run died between its commit and its marker.
    (run / "2026-10-29.applied").unlink()
    writes = len(world.db.writes())

    code, out = world.apply(run, command="heal", **totals)

    assert code == 0, out
    marker = json.loads((run / "2026-10-29.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "end state"
    assert len(world.db.writes()) == writes


def test_heal_day_with_nothing_to_change_still_records_the_day(world: World):
    (alert,) = world.tape(JUNE, fires(JUNE, ("15:00:00", chain("SPY", "C", 670, JUNE))))
    add_live(world, alert)  # flags already right, and live writes an SPY spot
    code, out, run = world.dry_run(JUNE, command="heal")
    assert code == 0, out
    assert plan_totals(run, EXPECTS["heal"]) == {"insert": 0, "remove": 0, "flags": 0, "spot": 0}

    code, out = world.apply(run, command="heal")

    assert code == 0, out
    marker = json.loads((run / "2026-06-02.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "applied"
    assert world.db.tape_days[JUNE]["live_rows"] == 1


def test_heal_apply_stops_after_marking_when_the_database_wrote_other_than_the_plan(world: World):
    setup = live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    # Another writer sets the sweep flag between heal_day's plan and its UPDATE.
    world.db.before_insert = lambda: (
        world.db.rows[setup["flag_row"]].update(top_trade_is_sweep=True),
        setattr(world.db, "before_insert", None),
    )

    code, out = world.apply(run, command="heal")

    assert code == 1
    assert "2026-10-29" in out and "the database reported" in out
    # The day committed, so it carries its marker with what the database wrote.
    marker = json.loads((run / "2026-10-29.applied").read_text(encoding="utf-8"))
    assert [marker[name] for name in HEAL_COUNTS] == [2, 0, 0, 1]


def test_heal_db_error_mid_day_rolls_back_and_writes_no_marker(world: World):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    world.db.fail_on = "SET underlying_price"  # the spot UPDATE, after the inserts and flags

    code, out = world.apply(run, command="heal")

    assert code == 1
    assert "OperationalError" in out and "server closed" not in out
    assert world.db.rows == rows_before  # the inserts and the flag before it rolled back
    assert OCT29 not in world.db.tape_days
    assert not (run / "2026-10-29.applied").exists()


def test_heal_window_rechecked_before_each_days_write(world: World):
    days = {d: live_day(world, d) for d in (JUNE, JUNE2)}
    code, out, run = world.dry_run(JUNE, JUNE2, command="heal")
    assert code == 0, out
    world.clock = lambda: (
        datetime(2026, 11, 26, 7, 20, tzinfo=UTC)
        if (run / "2026-06-02.applied").exists()
        else SAFE_NOW
    )

    code, out = world.apply(run, command="heal")

    assert code == 3
    assert "07:15" in out and "2026-06-03" in out
    assert world.db.rows[days[JUNE]["flag_row"]]["top_trade_is_sweep"] is True
    assert world.db.rows[days[JUNE2]["flag_row"]]["top_trade_is_sweep"] is False
    assert JUNE2 not in world.db.tape_days


# --- export -----------------------------------------------------------------------------------

EXPORT_KEY = "research/interval-ba/replay-2026-03-11.parquet"
_TZ = "TIMESTAMP WITH TIME ZONE"
EXPORT_SCHEMA = [
    ("option_chain", "VARCHAR"),
    ("ticker", "VARCHAR"),
    ("option_type", "VARCHAR"),
    ("strike", "DECIMAL(10,3)"),
    ("expiry", "DATE"),
    ("bucket_start", _TZ),
    ("bucket_end", _TZ),
    ("fired_at", _TZ),
    ("ratio_pct", "DECIMAL(5,2)"),
    ("ask_premium", "DECIMAL(14,2)"),
    ("total_premium", "DECIMAL(14,2)"),
    ("trade_count", "INTEGER"),
    ("top_trade_premium", "DECIMAL(14,2)"),
    ("top_trade_size", "INTEGER"),
    ("top_trade_executed_at", _TZ),
    ("top_trade_is_sweep", "BOOLEAN"),
    ("top_trade_is_floor", "BOOLEAN"),
    ("underlying_price", "DECIMAL(10,2)"),
    ("confluence_tickers", "VARCHAR[]"),
]
RULE = {
    "tickers": "SPXW,SPY,QQQ",
    "ratio-threshold": "0.75",
    "premium-floor-dollars": "250000",
    "window-sec": "300",
    "multi-leg-share-max": "0.5",
    "multi-leg-codes": "cbmo,masl,mctp,mesl,mfsl,mlat,mlct,mlet,mlft",
    "confluence-window-sec": "90",
    # The module's own pin (nightly/tests/test_interval_ba_replay.py) owns the value.
    "replay-version": ibr.REPLAY_VERSION,
}


def export_days(world: World) -> list[Any]:
    """03-10 and 03-11, each an SPY call and a QQQ call 30 s later (a confluence)."""
    alerts: list[Any] = []
    for d in (FULL_A, FULL_A2):
        alerts += world.tape(
            d,
            fires(
                d, ("15:00:00", chain("SPY", "C", 670, d)), ("15:00:30", chain("QQQ", "C", 600, d))
            ),
        )
    return alerts


def test_export_writes_no_neon_row_and_records_hash_and_constants(world: World):
    alerts = export_days(world)

    code, out, run = world.dry_run(FULL_A, FULL_A2, command="export")

    assert code == 0, out
    assert world.db.dsns == [] and world.db.statements == []
    assert world.s3.puts == [EXPORT_KEY]
    body, metadata = world.s3.objects[("bucket-sekret", EXPORT_KEY)]
    assert (run / "replay-2026-03-11.parquet").read_bytes() == body
    assert metadata == {
        "sha256": hashlib.sha256(body).hexdigest(),
        "rows": str(len(alerts)),
        "module-blob": runs.blob_hash(runs.MODULE_PATH),
        "from": "2026-03-10",
        "to": "2026-03-11",
        **RULE,
    }
    meta = json.loads(pq.read_schema(run / "replay-2026-03-11.parquet").metadata[b"interval_ba"])
    assert meta["module_blob"] == metadata["module-blob"]
    assert meta["tool_blobs"] == runs.code_blobs()["tool_blobs"]
    assert meta["rule"] == RULE
    assert (meta["from"], meta["to"]) == ("2026-03-10", "2026-03-11")
    record = json.loads((run / "export.json").read_text(encoding="utf-8"))
    assert record["rows"] == len(alerts) and record["r2_key"] == EXPORT_KEY
    assert record["sha256"] == metadata["sha256"]


def test_export_schema_matches_the_named_columns_and_types(world: World):
    no_spot = tick(at(FULL_A, "15:00:00"), chain("SPXW", "C", 6700, FULL_A))
    no_spot["underlying_price"] = None  # an SPXW crossing tick with no spot, and none after it
    alerts = world.tape(
        FULL_A, [no_spot, tick(at(FULL_A, "15:00:30"), chain("QQQ", "C", 600, FULL_A))]
    )
    assert [a.underlying_price for a in alerts] == [None, Decimal("670.00")]
    assert [a.confluence_tickers for a in alerts] == [(), ("SPXW",)]

    code, out, run = world.dry_run(FULL_A, command="export")

    assert code == 0, out
    path = str(run / "replay-2026-03-10.parquet")
    con = duckdb.connect()
    try:
        described = con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [path]).fetchall()
        assert [(row[0], row[1]) for row in described] == EXPORT_SCHEMA
        assert [name for name, _ in EXPORT_SCHEMA] == list(TAPE_FIELDS)
        got = con.execute(
            "SELECT option_chain, ticker, option_type, strike, expiry, epoch_us(bucket_start),"
            " epoch_us(bucket_end), epoch_us(fired_at), ratio_pct, ask_premium, total_premium,"
            " trade_count, top_trade_premium, top_trade_size, epoch_us(top_trade_executed_at),"
            " top_trade_is_sweep, top_trade_is_floor, underlying_price, confluence_tickers"
            " FROM read_parquet(?)",
            [path],
        ).fetchall()
    finally:
        con.close()
    epoch = datetime(1970, 1, 1, tzinfo=UTC)

    def us(t: datetime) -> int:
        return (t - epoch) // timedelta(microseconds=1)

    assert got == [
        tuple(
            us(value)
            if isinstance(value, datetime)
            else list(value)
            if isinstance(value, tuple)
            else value
            for value in (getattr(alert, name) for name in TAPE_FIELDS)
        )
        for alert in alerts
    ]
    assert {f.name for f in pq.read_schema(path) if f.nullable} == {"underlying_price"}


def test_export_refuses_to_overwrite_an_object(world: World):
    export_days(world)
    world.s3.objects[("bucket-sekret", EXPORT_KEY)] = (b"an earlier export", {})

    code, out = world.run("export", "--from", "2026-03-10", "--to", "2026-03-11")

    assert code == 3
    assert EXPORT_KEY in out and "overwrite" in out
    assert world.s3.puts == [] and not world.runs.exists()  # refused before any replay
    assert world.s3.objects[("bucket-sekret", EXPORT_KEY)] == (b"an earlier export", {})


@pytest.mark.parametrize(
    ("tamper", "named"),
    [({"Metadata": {"rows": "1"}}, "rows metadata"), ({"ETag": '"0123"'}, "ETag")],
)
def test_export_upload_that_does_not_verify_stops(world: World, tamper: dict[str, Any], named: str):
    export_days(world)
    world.s3.tamper = tamper

    code, out, run = world.dry_run(FULL_A, FULL_A2, command="export")

    assert code == 1
    assert "R2" in out and named in out
    assert not (run / "export.json").exists()


def test_export_stops_on_a_day_it_cannot_replay(world: World):
    export_days(world)
    write_tape(Path(world.tapes["2026-03-11"]), [filler(FULL_A)])  # holds no 03-11 row

    code, out, _ = world.dry_run(FULL_A, FULL_A2, command="export")

    assert code == 1
    assert "2026-03-11" in out and "ValueError" in out
    assert world.s3.puts == []


@pytest.mark.parametrize("command", ["heal", "export"])
def test_heal_and_export_refuse_the_nightly_window(world: World, command: str):
    live_day(world, OCT29)
    world.clock = lambda: datetime(2026, 11, 29, 8, 0, tzinfo=UTC)

    code, out = world.run(
        command, "--from", "2026-10-29", "--to", "2026-10-29", "--allow-market-hours"
    )

    assert code == 3
    assert "07:15" in out
    assert world.db.dsns == [] and world.s3.puts == [] and not world.runs.exists()


# --- export --per-day -------------------------------------------------------------------------

DAYS_PREFIX = "research/interval-ba/replay/"
IN_THE_NIGHTLY_WINDOW = datetime(2026, 11, 26, 7, 20, tzinfo=UTC)


def day_key(day: date) -> str:
    return f"{DAYS_PREFIX}{day.isoformat()}.parquet"


def per_day(world: World, start: date, end: date | None = None, *extra: str):
    """`export --per-day` over start..end: the code, the output and the run folder it made."""
    return world.dry_run(start, end, command="export", extra=["--per-day", *extra])


def stored_day(world: World, day: date) -> tuple[pa.Table, dict[str, str]]:
    """A day file as R2 holds it: the table with its footer, and the object's user metadata."""
    body, user_metadata = world.s3.objects[("bucket-sekret", day_key(day))]
    return pq.read_table(io.BytesIO(body)), user_metadata


def test_export_per_day_writes_one_file_per_day_and_overwrites(world: World):
    export_days(world)

    code, out, run = per_day(world, FULL_A, FULL_A2)

    assert code == 0, out
    assert world.guard_calls == 1
    assert world.db.dsns == [] and world.db.statements == []  # never Neon
    assert world.s3.puts == [day_key(FULL_A), day_key(FULL_A2)]
    for day in (FULL_A, FULL_A2):
        table, user_metadata = stored_day(world, day)
        footer = {
            "day": day.isoformat(),
            "rows": len(world.alerts[day]),
            "rule": RULE,
            "created_at": SAFE_NOW.isoformat(),
        }
        # The nightly step's file: the module's own table and footer, and no object metadata.
        assert user_metadata == {}
        assert json.loads(table.schema.metadata[b"interval_ba"]) == footer
        assert table.equals(ibr.export_table(world.alerts[day], footer))  # schema and values
    assert not list(run.glob("*.parquet"))  # no local copy, unlike the snapshot
    record = json.loads((run / "export.json").read_text(encoding="utf-8"))
    assert (record["per_day"], record["from"], record["to"]) == (True, "2026-03-10", "2026-03-11")
    first, second = record["days"]
    body = world.s3.objects[("bucket-sekret", day_key(FULL_A))][0]
    assert first == {
        "day": "2026-03-10",
        "key": day_key(FULL_A),
        "rows": len(world.alerts[FULL_A]),
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "root_label_mismatch": 0,
    }
    assert second["day"] == "2026-03-11"

    # A second run over 03-10, on a tape that changed, rewrites its file and no other.
    kept = world.s3.objects[("bucket-sekret", day_key(FULL_A2))]
    changed = world.tape(FULL_A, fires(FULL_A, ("14:00:00", chain("SPY", "P", 640, FULL_A))))
    code, out, _ = per_day(world, FULL_A)
    assert code == 0, out
    assert world.s3.puts == [day_key(FULL_A), day_key(FULL_A2), day_key(FULL_A)]
    table, _ = stored_day(world, FULL_A)
    assert table.column("option_chain").to_pylist() == [a.option_chain for a in changed]
    assert world.s3.objects[("bucket-sekret", day_key(FULL_A2))] == kept


def test_export_per_day_ignores_an_existing_snapshot_key(world: World):
    export_days(world)
    world.s3.objects[("bucket-sekret", EXPORT_KEY)] = (b"the snapshot", {})

    code, out, _ = per_day(world, FULL_A, FULL_A2)

    assert code == 0, out
    assert world.s3.puts == [day_key(FULL_A), day_key(FULL_A2)]
    assert world.s3.objects[("bucket-sekret", EXPORT_KEY)] == (b"the snapshot", {})


def test_export_per_day_rechecks_the_windows_before_each_put(world: World):
    export_days(world)
    # The run reaches the nightly window once 03-10's file is put.
    world.clock = lambda: IN_THE_NIGHTLY_WINDOW if world.s3.puts else SAFE_NOW

    code, out = world.run("export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-11")

    assert code == 3
    assert "07:15" in out and "2026-03-11" in out
    assert world.s3.puts == [day_key(FULL_A)]
    assert ("bucket-sekret", day_key(FULL_A2)) not in world.s3.objects
    assert not world.runs.exists()  # no record of a run that did not finish


@pytest.mark.parametrize(
    ("now", "allow", "code"),
    [
        (ct(TUESDAY, "10:00:00"), False, 3),
        (ct(TUESDAY, "10:00:00"), True, 0),
        (IN_THE_NIGHTLY_WINDOW, True, 3),
    ],
)
def test_export_per_day_refuses_the_windows_at_the_start(
    world: World, now: datetime, allow: bool, code: int
):
    world.tape(FULL_A, fires(FULL_A, ("15:00:00", chain("SPY", "C", 670, FULL_A))))
    world.clock = lambda: now
    extra = ["--allow-market-hours"] if allow else []

    got, out = world.run(
        "export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-10", *extra
    )

    assert got == code, out
    if code == 3:
        assert ("07:15" in out) or ("08:15" in out)
        # Refused at the start, before any tape is opened, not after the first replay.
        assert world.tape_connections == 0
        assert world.s3.puts == [] and not world.runs.exists()
    else:
        assert world.s3.puts == [day_key(FULL_A)]


def test_export_per_day_flags_a_day_that_fired_nothing(world: World):
    world.tape(FULL_A, [])  # a tape with a kept print and no alert

    code, out, run = per_day(world, FULL_A)

    # A zero-row file is written, so "no alerts" and "not written" stay apart, but it is a
    # fault (every session fires at least 19): the run says so and exits 1.
    assert code == 1
    assert "FLAG" in out and "2026-03-10" in out and "no alerts" in out
    table, _ = stored_day(world, FULL_A)
    assert table.num_rows == 0
    assert json.loads(table.schema.metadata[b"interval_ba"])["rows"] == 0
    assert (run / "export.json").exists()


def test_export_per_day_stops_on_a_day_it_cannot_replay(world: World):
    export_days(world)
    write_tape(Path(world.tapes["2026-03-11"]), [filler(FULL_A)])  # holds no 03-11 row

    code, out = world.run("export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-11")

    assert code == 1
    assert "2026-03-11" in out and "ValueError" in out
    # The day before it is written; running again over both resumes, as every put overwrites.
    assert world.s3.puts == [day_key(FULL_A)]
    assert not world.runs.exists()


def test_export_per_day_names_a_failed_put_by_its_class_alone(world: World):
    export_days(world)
    world.s3.fail["put_object"] = ClientError(
        {"Error": {"Code": "403", "Message": "Forbidden for bucket-sekret"}}, "PutObject"
    )

    code, out = world.run("export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-10")

    assert code == 1
    assert "ClientError" in out and "Forbidden" not in out and "bucket-sekret" not in out
    assert world.s3.puts == [] and not world.runs.exists()


@pytest.mark.parametrize(
    ("tamper", "named"), [({"ETag": '"0123"'}, "ETag"), ({"ContentLength": 1}, "size")]
)
def test_export_per_day_upload_that_does_not_verify_stops(
    world: World, tamper: dict[str, Any], named: str
):
    export_days(world)
    world.s3.tamper = tamper

    code, out = world.run("export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-11")

    assert code == 1
    assert "R2" in out and named in out and "2026-03-10" in out
    assert world.s3.puts == [day_key(FULL_A)]  # stopped at the first day
    assert not world.runs.exists()


# The replay module the tool loads, as a checkout holds it: an `origin` and a clone with its
# `origin/main`. The guard reads git, so these are real repositories in tmp_path.
_GIT = ("git", "-c", "user.name=Test", "-c", "user.email=test@example.com")
_MODULE_RELATIVE = "nightly/src/interval_ba_replay.py"


def git(repo: Path, *args: str) -> None:
    subprocess.run([*_GIT, "-C", str(repo), *args], check=True, capture_output=True)


@dataclass
class Checkout:
    tmp: Path
    origin: Path
    repo: Path
    module: Path


@pytest.fixture
def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Checkout:
    origin, repo = tmp_path / "origin.git", tmp_path / "repo"
    subprocess.run(
        [*_GIT, "init", "--bare", "-b", "main", str(origin)], check=True, capture_output=True
    )
    repo.mkdir()
    git(repo, "init", "-b", "main")
    module = repo / _MODULE_RELATIVE
    module.parent.mkdir(parents=True)
    module.write_bytes(b"REPLAY_VERSION = '1'\n")
    git(repo, "add", "--", _MODULE_RELATIVE)
    git(repo, "commit", "-m", "the replay module")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "origin", "main")
    monkeypatch.setattr(runs, "REPO_ROOT", repo)
    monkeypatch.setattr(runs, "MODULE_PATH", module)
    return Checkout(tmp_path, origin, repo, module)


def _edit(c: Checkout) -> None:
    c.module.write_bytes(b"REPLAY_VERSION = '2'\n")


def _stage(c: Checkout) -> None:
    _edit(c)
    git(c.repo, "add", "--", _MODULE_RELATIVE)


def _commit(c: Checkout) -> None:
    _stage(c)
    git(c.repo, "commit", "-m", "a local change nobody pushed")


def _origin_moved_on(c: Checkout) -> None:
    other = c.tmp / "other"
    subprocess.run(
        [*_GIT, "clone", "--quiet", str(c.origin), str(other)], check=True, capture_output=True
    )
    (other / _MODULE_RELATIVE).write_bytes(b"REPLAY_VERSION = '3'\n")
    git(other, "commit", "-a", "-m", "the deployed module moved on")
    git(other, "push", "origin", "main")


def _no_origin(c: Checkout) -> None:
    git(c.repo, "remote", "remove", "origin")


@pytest.mark.parametrize(
    ("change", "refused"),
    [
        pytest.param(lambda c: None, None, id="clean"),
        pytest.param(_edit, "uncommitted", id="an uncommitted edit"),
        pytest.param(_stage, "uncommitted", id="a staged edit"),
        pytest.param(_commit, "not origin/main's", id="a commit that is not on origin/main"),
        pytest.param(_origin_moved_on, "not origin/main's", id="an origin/main that moved on"),
        pytest.param(_no_origin, "fetch", id="no origin to fetch"),
    ],
)
def test_a_per_day_write_refuses_unless_the_replay_module_is_origin_mains(
    world: World,
    checkout: Checkout,
    monkeypatch: pytest.MonkeyPatch,
    change: Callable[[Checkout], None],
    refused: str | None,
):
    export_days(world)
    monkeypatch.setattr(runs, "refuse_unless_deployed_code", REAL_DEPLOYED_CODE_GUARD)
    change(checkout)

    code, out = world.run("export", "--per-day", "--from", "2026-03-10", "--to", "2026-03-10")

    if refused is None:
        assert code == 0, out
        assert world.s3.puts == [day_key(FULL_A)]
        return
    assert code == 3, out
    assert refused in out and "checkout at origin/main" in out
    # Refused before any tape is opened or object put.
    assert world.tape_connections == 0 and world.s3.puts == [] and not world.runs.exists()


# --- undo -------------------------------------------------------------------------------------


def test_undo_rebuild_day_restores_replay_rows_with_original_ids(world: World):
    two_full_days(world)
    rows_before = copy.deepcopy(world.db.rows)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    assert world.db.rows != rows_before

    code, out = world.undo(run)

    assert code == 0, out
    assert world.db.rows == rows_before
    for d in (FULL_A, FULL_A2):
        marker = json.loads((run / f"{d}.undone").read_text(encoding="utf-8"))
        assert (marker["deleted"], marker["reinserted"]) == (2, 1)
    # Re-inserted under their own ids, not given new ones.
    restores = world.db.writes_starting("INSERT INTO interval_ba_alerts (id,")
    assert sorted(row[0] for s in restores for row in s.params) == sorted(rows_before)
    # A second undo of the run leaves its days alone, even ones that moved since.
    later = world.db.add(world.alerts[FULL_A][1], source="replay", trade_count=5)
    writes = len(world.db.writes())
    code, out = world.undo(run)
    assert code == 0, out
    assert later in world.db.rows and len(world.db.writes()) == writes


def test_undo_heal_day_restores_flags_and_spot_only_where_unchanged_since(world: World):
    days = {d: live_day(world, d) for d in (JUNE, JUNE2)}
    code, out, run = world.dry_run(JUNE, JUNE2, command="heal")
    assert code == 0, out
    rows_before = copy.deepcopy(world.db.rows)
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    # Since the heal, someone set 06-02's floor flag and wrote 06-03's spot.
    world.db.rows[days[JUNE]["flag_row"]]["top_trade_is_floor"] = True
    world.db.rows[days[JUNE2]["spot_row"]]["underlying_price"] = Decimal("6650.00")
    changed = {
        i: copy.deepcopy(world.db.rows[i])
        for i in (days[JUNE]["flag_row"], days[JUNE2]["spot_row"])
    }

    code, out = world.undo(run)

    assert code == 0, out
    for row_id, row in changed.items():
        assert world.db.rows[row_id] == row  # left as the later writer left it
    for row_id in (days[JUNE]["spot_row"], days[JUNE2]["flag_row"]):
        assert world.db.rows[row_id] == rows_before[row_id]  # back to the backup's values
    one = json.loads((run / "2026-06-02.undone").read_text(encoding="utf-8"))
    two = json.loads((run / "2026-06-03.undone").read_text(encoding="utf-8"))
    assert (one["flags_restored"], one["spot_restored"], one["left"]) == (0, 1, 1)
    assert (two["flags_restored"], two["spot_restored"], two["left"]) == (1, 0, 1)
    assert "left" in out


@pytest.mark.parametrize("changed_since", [False, True])
def test_undo_heal_day_deletes_only_the_replay_rows_it_inserted(world: World, changed_since: bool):
    setup = live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    qqq_put, spxw_put = chain("QQQ", "P", 590, OCT29), chain("SPXW", "P", 6600, OCT29)
    # An earlier pass inserted the QQQ put, so the heal inserts only the SPXW put.
    earlier = world.db.add(setup["alerts"][qqq_put], source="replay")
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    assert runs.load_plan(run)["days"]["2026-10-29"]["insert"] == 1
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    (inserted,) = [r["id"] for r in world.db.day(OCT29, "replay") if r["option_chain"] == spxw_put]
    # After the run another writer adds a replay row of its own.
    later = world.db.add(
        replace_alert(setup["alerts"][qqq_put], option_chain=chain("QQQ", "P", 591, OCT29)),
        source="replay",
    )
    if changed_since:
        world.db.rows[inserted]["trade_count"] = 9

    code, out = world.undo(run)

    assert code == 0, out
    assert earlier in world.db.rows and later in world.db.rows
    assert (inserted in world.db.rows) is changed_since
    marker = json.loads((run / "2026-10-29.undone").read_text(encoding="utf-8"))
    assert marker["deleted"] == (0 if changed_since else 1)
    # The flags and the spot it wrote are restored either way.
    assert world.db.rows[setup["flag_row"]]["top_trade_is_sweep"] is False
    assert world.db.rows[setup["spot_row"]]["underlying_price"] is None


def test_undo_never_deletes_or_reinserts_a_live_row(world: World):
    setup = edge_first_world(world)
    code, out, run = world.dry_run(EDGE_FIRST)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    kept, gone = setup["live"]
    kept_row = copy.deepcopy(world.db.rows[kept])
    del world.db.rows[gone]  # a live row goes missing after the run, not by the tool's hand
    applied = len(world.db.statements)

    code, out = world.undo(run)

    assert code == 0, out
    assert gone not in world.db.rows
    assert world.db.rows[kept] == kept_row
    assert world.db.day(EDGE_FIRST, "replay") == []  # the backup held no replay row that day
    undo_writes = [s for s in world.db.statements[applied:] if s in world.db.writes()]
    assert undo_writes
    for statement in undo_writes:
        if statement.sql.startswith("DELETE"):
            assert "a.source = 'replay'" in statement.sql
        if statement.sql.startswith("INSERT INTO interval_ba_alerts"):
            columns = _INSERT_COLUMNS.match(statement.sql)["columns"].split(", ")
            assert all(
                dict(zip(columns, row, strict=True))["source"] == "replay"
                for row in statement.params
            )


def resign_heal_day(run: Path, day: date, edit: Callable[[dict[str, Any]], None]) -> None:
    """Edit days/<day>.json of a heal run, then make its sha256 and plan.json's agree with it:
    a forged plan that passes every hash check."""
    path = run / "days" / f"{day}.json"
    day_plan = json.loads(path.read_text(encoding="utf-8"))
    edit(day_plan)
    day_plan["sha256"] = ibr._write_set_sha(
        day,
        [ibr._alert_from_json(a) for a in day_plan["inserts"]],
        tuple(day_plan["removes"]),
        tuple(tuple(u) for u in day_plan["flag_updates"]),
        tuple((i, Decimal(p)) for i, p in day_plan["spot_updates"]),
    )
    path.write_text(json.dumps(day_plan), encoding="utf-8")
    plan = runs.load_plan(run)
    plan["days"][day.isoformat()].update(
        sha256=day_plan["sha256"],
        insert=len(day_plan["inserts"]),
        remove=len(day_plan["removes"]),
        flags=len(day_plan["flag_updates"]),
        spot=len(day_plan["spot_updates"]),
    )
    (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")


@pytest.mark.parametrize(
    "forgery",
    [
        "removes a live row",
        "removes a row the backup lacks",
        "updates a row the backup lacks",
        "updates a replay row's flags",
        "updates a replay row's spot",
        "updates a live SPY row's spot",
    ],
)
def test_undo_stops_on_a_heal_plan_the_run_did_not_apply(world: World, forgery: str):
    setup = live_day(world, JUNE)
    # Replay rows at two keys the tape fires (from an earlier pass): the heal leaves them be.
    qqq, spxw = (
        world.db.add(setup["alerts"][chain(*spec, JUNE)], source="replay")
        for spec in (("QQQ", "P", 590), ("SPXW", "P", 6600))
    )
    code, out, run = world.dry_run(JUNE, command="heal")
    assert code == 0, out
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    if forgery == "removes a live row":
        resign_heal_day(run, JUNE, lambda d: d.update(removes=[setup["flag_row"]]))
        named: tuple[str, ...] = (str(setup["flag_row"]), "live")
    elif forgery == "removes a row the backup lacks":  # on a day this run's apply wrote
        resign_heal_day(run, JUNE, lambda d: d.update(removes=[999999]))
        named = ("999999", "does not hold")
    elif forgery == "updates a row the backup lacks":
        resign_heal_day(run, JUNE, lambda d: d["flag_updates"].append([999999, True, False]))
        named = ("999999", "does not hold")
    else:
        # The UPDATEs' SQL writes only a live row's flags and a live SPXW row's spot, so each of
        # these touches nothing and fails the count check.
        target, update = {
            "updates a replay row's flags": (qqq, "flag_updates"),
            "updates a replay row's spot": (spxw, "spot_updates"),
            "updates a live SPY row's spot": (setup["flag_row"], "spot_updates"),
        }[forgery]
        row = world.db.rows[target]
        value = (
            [target, row["top_trade_is_sweep"], row["top_trade_is_floor"]]
            if update == "flag_updates"
            else [target, str(row["underlying_price"])]
        )
        resign_heal_day(run, JUNE, lambda d: d[update].append(value))
        named = ("2026-06-02", "another writer")
    rows_before = copy.deepcopy(world.db.rows)

    code, out = world.undo(run)

    assert code == 1
    assert all(text in out for text in named)
    assert world.db.rows == rows_before
    assert not (run / "2026-06-02.undone").exists()


def test_undo_touches_only_the_runs_applied_or_end_state_days(world: World):
    old: dict[date, int] = {}
    for d in (FULL_A, FULL_A2, FULL_A3):
        spy, qqq = chain("SPY", "C", 670, d), chain("QQQ", "P", 590, d)
        alerts = world.tape(d, fires(d, ("15:00:00", spy), ("15:10:00", qqq)))
        old[d] = world.db.add(alerts[0], source="replay", trade_count=11)
    code, out, run = world.dry_run(FULL_A, FULL_A3)
    assert code == 0, out
    # 03-11 moves after the plan, so the apply stops there with 03-10 done.
    moved = world.db.add(world.alerts[FULL_A2][1], source="replay", trade_count=3)
    code, out = world.apply(run)
    assert code == 3
    # 03-12 reached its planned end state some other way, and has no marker.
    del world.db.rows[old[FULL_A3]]
    for alert in world.alerts[FULL_A3]:
        world.db.add(alert, source="replay")
    day_two = copy.deepcopy(world.db.day(FULL_A2))

    code, out = world.undo(run)

    assert code == 0, out
    assert (run / "2026-03-10.undone").exists() and (run / "2026-03-12.undone").exists()
    assert not (run / "2026-03-11.undone").exists()
    assert world.db.day(FULL_A2) == day_two and moved in world.db.rows
    for d in (FULL_A, FULL_A3):
        assert [r["id"] for r in world.db.day(d)] == [old[d]]
    assert "2026-03-11" in out and "not applied" in out


def test_undo_refuses_a_run_with_no_backup(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out

    code, out = world.undo(run)

    assert code == 3
    assert "backup" in out
    assert len(world.db.dsns) == 1  # the dry run's only


def test_undo_stops_when_the_runs_backup_changed(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    with (run / "backup.jsonl").open("ab") as handle:
        handle.write(b'{"id": 1}\n')
    writes = len(world.db.writes())

    code, out = world.undo(run)

    assert code == 1
    assert "backup.jsonl no longer matches" in out
    assert len(world.db.writes()) == writes and not (run / "2026-03-10.undone").exists()


def test_undo_db_error_rolls_back_and_writes_no_marker(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    rows_after_apply = copy.deepcopy(world.db.rows)
    world.db.fail_on = "INSERT INTO interval_ba_alerts (id,"

    code, out = world.undo(run)

    assert code == 1
    assert "OperationalError" in out
    assert world.db.rows == rows_after_apply  # the DELETE before the failure was rolled back
    assert not (run / "2026-03-10.undone").exists()


def test_undo_stops_rather_than_delete_an_acknowledged_row(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    acked = world.db.day(FULL_A, "replay")[0]["id"]
    world.db.rows[acked]["acknowledged"] = True
    writes = len(world.db.writes())

    code, out = world.undo(run)

    assert code == 1
    assert "acknowledg" in out and str(acked) in out
    assert len(world.db.writes()) == writes and not (run / "2026-03-10.undone").exists()


def test_undo_refuses_market_hours_unless_allowed_and_rechecks_each_day(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    world.clock = lambda: ct(TUESDAY, "10:00:00")
    writes = len(world.db.writes())

    code, out = world.undo(run)
    assert code == 3 and "08:15" in out
    assert len(world.db.writes()) == writes

    # Allowed in market hours, it stops at the nightly window, which opens after 03-10.
    world.clock = lambda: (
        datetime(2026, 11, 26, 7, 20, tzinfo=UTC)
        if (run / "2026-03-10.undone").exists()
        else ct(TUESDAY, "10:00:00")
    )
    code, out = world.undo(run, "--allow-market-hours")

    assert code == 3
    assert "07:15" in out and "2026-03-11" in out
    assert (run / "2026-03-10.undone").exists() and not (run / "2026-03-11.undone").exists()


def test_apply_refuses_a_run_that_was_undone(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    moved = world.db.add(world.alerts[FULL_A2][1], source="replay", trade_count=3)
    code, out = world.apply(run)
    assert code == 3  # 03-10 applied, 03-11 moved
    code, out = world.undo(run)
    assert code == 0, out
    del world.db.rows[moved]
    writes = len(world.db.writes())

    code, out = world.apply(run)

    assert code == 3
    assert "undone" in out
    assert len(world.db.writes()) == writes


def test_undo_of_an_export_run_is_a_bad_argument(world: World):
    export_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2, command="export")
    assert code == 0, out

    code, out = world.undo(run)

    assert code == 2
    assert "wrote nothing to Neon" in out
    assert world.db.dsns == []


@pytest.mark.parametrize(
    "args",
    [
        ["heal", "--from", "2026-10-29"],
        ["heal", "--apply", "--run", "x", "--expect-insert", "0"],
        ["heal", "--from", "2026-10-29", "--to", "2026-10-29", "--expect-flags", "1"],
        [
            "heal",
            "--apply",
            "--run",
            "x",
            *("--expect-insert", "0", "--expect-remove", "0"),
            *("--expect-flags", "0", "--expect-spot", "0"),
            "--assume-default-settings",
        ],
        ["export", "--from", "2026-03-10"],
        ["undo"],
        ["rebuild", "--expect-remove", "1"],
    ],
)
def test_bad_arguments_exit_2(world: World, args: list[str]):
    code, out = world.run(*args)

    assert code == 2, out
    assert world.db.dsns == [] and not world.runs.exists()


def test_heal_export_and_undo_never_print_secrets(world: World):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    outputs: list[str] = []
    code, out, run = world.dry_run(OCT29, command="heal")
    outputs.append(out)
    code, out = world.apply(run, command="heal")
    outputs.append(out)
    code, out = world.undo(run)
    outputs.append(out)
    assert code == 0, out
    export_days(world)
    code, out, _ = world.dry_run(FULL_A, FULL_A2, command="export")
    outputs.append(out)
    assert code == 0, out
    code, out, _ = per_day(world, FULL_A, FULL_A2)
    outputs.append(out)
    assert code == 0, out

    files = [p.read_bytes() for p in world.runs.rglob("*") if p.is_file()]
    for secret in SECRET_PARTS:
        assert all(secret not in text for text in outputs)
        assert all(secret.encode() not in data for data in files)


def stale_replay_row(world: World, setup: dict[str, Any], day: date) -> int:
    """A replay row at a key the tape does not fire (an earlier tape's): the heal removes it."""
    alert = setup["alerts"][chain("QQQ", "P", 590, day)]
    return world.db.add(
        replace_alert(alert, option_chain=chain("QQQ", "P", 595, day)), source="replay"
    )


@pytest.mark.parametrize(
    "undone", ["nothing", "an insert's values", "an insert", "a flag", "a spot", "a removal"]
)
def test_heal_end_state_needs_every_planned_write(world: World, undone: str):
    setup = live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    stale = stale_replay_row(world, setup, OCT29)
    stale_row = copy.deepcopy(world.db.rows[stale])
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    plan = ibr.DayPlan.from_json(
        json.loads((run / "days" / "2026-10-29.json").read_text(encoding="utf-8"))
    )
    assert plan.removes == (stale,) and len(plan.inserts) == 2
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    inserted = next(r["id"] for r in world.db.day(OCT29, "replay"))
    if undone == "an insert's values":
        world.db.rows[inserted]["trade_count"] = 7
    elif undone == "an insert":
        del world.db.rows[inserted]
    elif undone == "a flag":
        world.db.rows[setup["flag_row"]]["top_trade_is_sweep"] = False
    elif undone == "a spot":
        world.db.rows[setup["spot_row"]]["underlying_price"] = None
    elif undone == "a removal":
        world.db.rows[stale] = stale_row

    rows = tool.read_day_rows(world.db.connect("unused"), OCT29)

    assert tool.heal_end_state(rows, plan) is (undone == "nothing")


@pytest.mark.parametrize("edit", ["day file", "day file decimal", "plan counts", "settings source"])
def test_heal_apply_refuses_an_edited_plan(world: World, edit: str):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    totals = plan_totals(run, EXPECTS["heal"])
    path = run / "days" / "2026-10-29.json"
    if edit == "day file":  # same counts, one value changed, re-hashed: not plan.json's plan
        day_plan = json.loads(path.read_text(encoding="utf-8"))
        day_plan["inserts"][0]["trade_count"] = 2
        day_plan["sha256"] = ibr._write_set_sha(
            OCT29,
            [ibr._alert_from_json(a) for a in day_plan["inserts"]],
            tuple(day_plan["removes"]),
            tuple(tuple(u) for u in day_plan["flag_updates"]),
            tuple((i, Decimal(p)) for i, p in day_plan["spot_updates"]),
        )
        path.write_text(json.dumps(day_plan), encoding="utf-8")
    elif edit == "day file decimal":  # decimal.InvalidOperation is not a ValueError
        day_plan = json.loads(path.read_text(encoding="utf-8"))
        day_plan["spot_updates"][0][1] = "x"
        path.write_text(json.dumps(day_plan), encoding="utf-8")
    else:
        plan = runs.load_plan(run)
        if edit == "plan counts":  # --expect is checked against these
            plan["days"]["2026-10-29"]["insert"] = totals["insert"] = 1
        else:
            plan["days"]["2026-10-29"]["settings"] = "bogus"
        (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")

    code, out = world.apply(run, command="heal", **totals)

    assert code == 3
    assert "2026-10-29" in out and "REFUSED" in out
    assert world.db.writes() == [] and world.s3.puts == []


def test_undo_rolls_back_when_the_database_writes_other_than_planned(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    rows_after_apply = copy.deepcopy(world.db.rows)
    # Another writer takes the old row's key between the undo's DELETE and its re-insert.
    world.db.before_insert = lambda: (
        world.db.add(world.alerts[FULL_A][0], source="live"),
        setattr(world.db, "before_insert", None),
    )

    code, out = world.undo(run)

    assert code == 1
    assert "2026-03-10" in out and "another writer" in out
    assert world.db.rows == rows_after_apply
    assert not (run / "2026-03-10.undone").exists()


@pytest.mark.parametrize("key_taken", [False, True])
def test_undo_heal_day_puts_back_the_replay_rows_it_removed(world: World, key_taken: bool):
    setup = live_day(world, JUNE)
    stale = stale_replay_row(world, setup, JUNE)
    stale_row = copy.deepcopy(world.db.rows[stale])
    code, out, run = world.dry_run(JUNE, command="heal")
    assert code == 0, out
    assert runs.load_plan(run)["days"]["2026-06-02"]["remove"] == 1
    # The removed replay row is a QQQ row: the day's QQQ count goes from 1 to 0.
    assert "| 2026-06 | QQQ | 1 | 0 | -1 |" in (run / "report.md").read_text(encoding="utf-8")
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    assert stale not in world.db.rows
    other = None
    if key_taken:  # a later writer put a row of its own at the removed row's key
        other = world.db.add(
            replace_alert(
                setup["alerts"][chain("QQQ", "P", 590, JUNE)],
                option_chain=stale_row["option_chain"],
            ),
            source="replay",
        )

    code, out = world.undo(run)

    assert code == 0, out
    marker = json.loads((run / "2026-06-02.undone").read_text(encoding="utf-8"))
    if key_taken:
        assert stale not in world.db.rows and other in world.db.rows
        assert (marker["reinserted"], marker["left"]) == (0, 1)
    else:
        assert world.db.rows[stale] == stale_row  # back with its own id
        assert (marker["reinserted"], marker["left"]) == (1, 0)


@pytest.mark.parametrize("moved", ["flag", "spot"])
def test_undo_never_overwrites_a_value_that_moved_during_it(world: World, moved: str):
    setup = live_day(world, JUNE)
    stale_replay_row(world, setup, JUNE)
    code, out, run = world.dry_run(JUNE, command="heal")
    assert code == 0, out
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    rows_after_apply = copy.deepcopy(world.db.rows)

    def move() -> None:
        """Another writer, between the undo's read and its UPDATEs (at its re-insert)."""
        if moved == "flag":
            world.db.rows[setup["flag_row"]]["top_trade_is_floor"] = True
        else:
            world.db.rows[setup["spot_row"]]["underlying_price"] = Decimal("6650.00")
        world.db.before_insert = None

    world.db.before_insert = move

    code, out = world.undo(run)

    assert code == 1
    assert "2026-06-02" in out and "another writer" in out
    assert world.db.rows == rows_after_apply  # rolled back, the other writer's change with it
    assert not (run / "2026-06-02.undone").exists()


def test_undo_leaves_rows_the_backup_already_held(world: World):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    plan = ibr.DayPlan.from_json(
        json.loads((run / "days" / "2026-10-29.json").read_text(encoding="utf-8"))
    )
    # Before the apply another writer (the nightly, say) makes the plan's writes itself: the
    # apply finds the day in its end state, and the backup holds those rows.
    for alert in plan.inserts:
        world.db.add(alert, source="replay")
    for row_id, sweep, floor in plan.flag_updates:
        world.db.rows[row_id].update(top_trade_is_sweep=sweep, top_trade_is_floor=floor)
    for row_id, price in plan.spot_updates:
        world.db.rows[row_id]["underlying_price"] = price
    world.db.tape_days[OCT29] = {"day": OCT29}
    rows_before = copy.deepcopy(world.db.rows)
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    assert json.loads((run / "2026-10-29.applied").read_text(encoding="utf-8"))["how"] == (
        "end state"
    )

    code, out = world.undo(run)

    assert code == 0, out
    assert world.db.rows == rows_before  # nothing the run did not write is taken away
    marker = json.loads((run / "2026-10-29.undone").read_text(encoding="utf-8"))
    assert (marker["deleted"], marker["left"]) == (0, 2)


@pytest.mark.parametrize(
    ("change", "named"),
    [
        (lambda row: row.update(strike="x"), "InvalidOperation"),
        (lambda row: row.update(fired_at="2026-03-10T15:00:00"), "offset"),
        (lambda row: row.update(id="1"), "id holds a str"),
        (lambda row: row.update(extra=1), "columns"),
    ],
)
def test_undo_refuses_a_backup_row_it_cannot_restore(
    world: World, change: Callable[[dict[str, Any]], None], named: str
):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    # A backup row edited, and backup.json made to agree, so only the row itself is wrong.
    lines = (run / "backup.jsonl").read_bytes().splitlines()
    first = json.loads(lines[0])
    assert first["expiry"] == "2026-03-10"
    change(first)
    data = b"\n".join([json.dumps(first).encode("utf-8"), *lines[1:]]) + b"\n"
    (run / "backup.jsonl").write_bytes(data)
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    record["sha256"] = hashlib.sha256(data).hexdigest()
    (run / "backup.json").write_text(json.dumps(record), encoding="utf-8")
    writes = len(world.db.writes())

    code, out = world.undo(run)

    assert code == 3
    assert "backup.jsonl line 1" in out and named in out
    assert len(world.db.writes()) == writes and not (run / "2026-03-10.undone").exists()


def test_export_refuses_an_object_that_appeared_during_the_run(world: World):
    export_days(world)
    # Another export lands the key after the start check.
    world.s3.after_head = lambda: world.s3.objects.update(
        {("bucket-sekret", EXPORT_KEY): (b"another export", {})}
    )

    code, out, run = world.dry_run(FULL_A, FULL_A2, command="export")

    assert code == 3
    assert "overwrite" in out
    assert world.s3.puts == []
    assert world.s3.objects[("bucket-sekret", EXPORT_KEY)] == (b"another export", {})
    assert not (run / "export.json").exists()


# --- Fix round 1 ------------------------------------------------------------------------------


def test_heal_dry_run_flags_a_stale_replay_row_that_holds_an_acknowledgement(world: World):
    setup = live_day(world, JUNE)
    stale = stale_replay_row(world, setup, JUNE)
    world.db.rows[stale]["acknowledged"] = True

    code, out, run = world.dry_run(JUNE, command="heal")

    assert code == 1
    assert "FLAG" in out and "2026-06-02" in out and "acknowledgement" in out
    plan = runs.load_plan(run)
    entry = plan["days"]["2026-06-02"]
    assert (entry["remove"], entry["acknowledged_kept"]) == (0, 1)
    assert plan["acknowledged_kept"] == {"2026-06-02": 1}
    report = (run / "report.md").read_text(encoding="utf-8")
    assert "2026-06-02: 1 stale replay row(s) hold an acknowledgement" in report
    # The plan applies, and the acknowledged row stays as it was.
    kept = copy.deepcopy(world.db.rows[stale])
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    assert world.db.rows[stale] == kept


def test_undo_leaves_a_removal_another_writer_made_before_the_backup(world: World):
    setup = live_day(world, JUNE)
    stale = stale_replay_row(world, setup, JUNE)
    code, out, run = world.dry_run(JUNE, command="heal")
    assert code == 0, out
    plan = ibr.DayPlan.from_json(
        json.loads((run / "days" / "2026-06-02.json").read_text(encoding="utf-8"))
    )
    assert plan.removes == (stale,)
    # Before the apply another writer makes every write of the plan, the removal included, so
    # the backup never holds the removed row and the apply finds the day in its end state.
    del world.db.rows[stale]
    for row_id, sweep, floor in plan.flag_updates:
        world.db.rows[row_id].update(top_trade_is_sweep=sweep, top_trade_is_floor=floor)
    for row_id, price in plan.spot_updates:
        world.db.rows[row_id]["underlying_price"] = price
    world.db.tape_days[JUNE] = {"day": JUNE}
    rows_before = copy.deepcopy(world.db.rows)
    code, out = world.apply(run, command="heal")
    assert code == 0, out
    marker = json.loads((run / "2026-06-02.applied").read_text(encoding="utf-8"))
    assert marker["how"] == "end state"

    code, out = world.undo(run)

    assert code == 0, out
    assert world.db.rows == rows_before
    undone = json.loads((run / "2026-06-02.undone").read_text(encoding="utf-8"))
    assert (undone["reinserted"], undone["left"]) == (0, 1)


def test_heal_apply_stops_when_the_tape_cannot_be_read(world: World):
    live_day(world, OCT29)
    world.db.settings.append(settings_row(ct(OCT28, "07:00:00")))
    code, out, run = world.dry_run(OCT29, command="heal")
    assert code == 0, out
    write_tape(Path(world.tapes["2026-10-29"]), [filler(OCT28)])  # holds no 10-29 row
    rows_before = copy.deepcopy(world.db.rows)

    code, out = world.apply(run, command="heal")

    assert code == 1
    assert "2026-10-29" in out and "ValueError" in out
    assert world.db.writes() == [] and world.db.rows == rows_before
    assert OCT29 not in world.db.tape_days
    assert not (run / "2026-10-29.applied").exists()


def test_export_stops_when_the_start_check_is_denied(world: World):
    export_days(world)
    world.s3.fail["head_object"] = ClientError(
        {"Error": {"Code": "403", "Message": "Forbidden for bucket-sekret"}}, "HeadObject"
    )

    code, out = world.run("export", "--from", "2026-03-10", "--to", "2026-03-11")

    assert code == 1
    assert "ClientError" in out and "Forbidden" not in out
    assert world.s3.puts == [] and not world.runs.exists()


def test_undo_stops_on_a_backup_line_that_does_not_parse(world: World):
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A)
    assert code == 0, out
    code, out = world.apply(run)
    assert code == 0, out
    data = (run / "backup.jsonl").read_bytes() + b"{not json\n"
    (run / "backup.jsonl").write_bytes(data)
    record = json.loads((run / "backup.json").read_text(encoding="utf-8"))
    record["sha256"] = hashlib.sha256(data).hexdigest()
    (run / "backup.json").write_text(json.dumps(record), encoding="utf-8")
    writes = len(world.db.writes())

    code, out = world.undo(run)

    assert code == 1
    assert "line 3 of backup.jsonl does not parse" in out
    assert len(world.db.writes()) == writes and not (run / "2026-03-10.undone").exists()


def test_undo_leaves_an_unmarked_day_with_nothing_to_put_back(world: World):
    live_day(world, JUNE)
    (alert,) = world.tape(JUNE2, fires(JUNE2, ("15:00:00", chain("SPY", "C", 670, JUNE2))))
    add_live(world, alert)  # nothing to change: an empty plan, so its rows are its end state
    code, out, run = world.dry_run(JUNE, JUNE2, command="heal")
    assert code == 0, out
    # The apply stops before 06-03 (the nightly window opens), so 06-03 has no marker.
    world.clock = lambda: (
        datetime(2026, 11, 26, 7, 20, tzinfo=UTC)
        if (run / "2026-06-02.applied").exists()
        else SAFE_NOW
    )
    code, out = world.apply(run, command="heal")
    assert code == 3
    world.clock = lambda: SAFE_NOW

    code, out = world.undo(run)

    assert code == 0, out
    assert (run / "2026-06-02.undone").exists()
    assert not (run / "2026-06-03.undone").exists()
    assert "2026-06-03: not applied by this run" in out
