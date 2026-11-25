"""scripts/interval_ba_tape.py, part 1: verify, run folders, the backup and rebuild (spec 6.5).

Each test runs the real replay module over a small tape written in tmp_path. The boundaries are
patched (R3):

- DuckDB's R2 side: `fulltape_connection` returns a local DuckDB connection and `r2_url` the
  local tape's path;
- psycopg2.connect returns a fake connection over an in-memory `interval_ba_alerts`. Its
  transactions snapshot and restore the table, and psycopg2's own execute_values runs against
  its cursor, so each page of a batched write arrives as one statement with its rows;
- boto3.client returns a fake R2 client.

No test opens a database or R2. Run from the repo root with ml/.venv:

    ml/.venv/Scripts/python -m pytest scripts/test_interval_ba_tape.py -q
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, fields, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import interval_ba_tape as tool
import psycopg2
import psycopg2.errors
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

ibr = sys.modules["interval_ba_replay"]

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
    "DATABASE_URL": (
        "postgresql://owner-sekret:pw-sekret-123@db-sekret.example.neon.tech/neondb?sslmode=require"
    ),
    "R2_ACCESS_KEY_ID": "akid-sekret-456",
    "R2_SECRET_ACCESS_KEY": "sak-sekret-789",
    "R2_ENDPOINT_URL": "https://acct-sekret.r2.cloudflarestorage.com",
    "R2_BUCKET_FULLTAPE": "bucket-sekret",
}
SECRET_PARTS = (
    *SECRETS.values(),
    "owner-sekret",
    "pw-sekret-123",
    "db-sekret.example.neon.tech",
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
    """`interval_ba_alerts` in memory, behind fake psycopg2 connections.

    A statement with autocommit off opens a transaction; rollback restores the table as it was
    when the transaction began. The DELETE applies only the predicates its SQL text names, so a
    dropped `source = 'replay'` would show. `fail_on` makes the first statement whose SQL
    contains it raise; `count_skew` makes the backup's count(*) disagree with its rows; and
    `before_insert` runs just before an INSERT page lands (a concurrent writer).
    """

    def __init__(self) -> None:
        self.rows: dict[int, dict[str, Any]] = {}
        self.next_id = 1
        self.statements: list[Statement] = []
        self.conns: list[FakeConn] = []
        self.dsns: list[str] = []
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
        return [
            s
            for s in self.statements
            if not s.sql.lstrip().startswith(("SELECT", "SET TRANSACTION"))
        ]

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
        self._snapshot: tuple[dict[int, dict[str, Any]], int] | None = None
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

    def cursor(self, name: str | None = None) -> FakeCursor:
        return FakeCursor(self)

    def begin(self) -> None:
        if not self._autocommit and not self.in_transaction:
            self.in_transaction = True
            self._snapshot = (copy.deepcopy(self.db.rows), self.db.next_id)

    def commit(self) -> None:
        self.commits += 1
        self.in_transaction = False
        self._snapshot = None

    def rollback(self) -> None:
        self.rollbacks += 1
        if self._snapshot is not None:
            self.db.rows, self.db.next_id = self._snapshot
        self.in_transaction = False
        self._snapshot = None

    def close(self) -> None:
        self.closed = 1


_DAY_SELECT = re.compile(
    r"^SELECT (?P<columns>.+) FROM interval_ba_alerts WHERE expiry = %\(day\)s ORDER BY id$"
)


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
        writes = not text.lstrip().startswith(("SELECT", "SET TRANSACTION"))
        if writes and conn.readonly:
            raise psycopg2.errors.ReadOnlySqlTransaction("cannot write in a read-only transaction")
        db.statements.append(Statement(text, params, conn.readonly))
        self._result, self.description = [], None
        if text.startswith("SET TRANSACTION"):
            return
        if text == "SELECT count(*) FROM interval_ba_alerts":
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
            self._result = self._insert(params)
        else:
            raise AssertionError(f"unexpected SQL: {text}")

    def _delete(self, text: str, page: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
        db = self.connection.db
        gone: list[tuple[object, ...]] = []
        for row_id, day in page:
            row = db.rows.get(row_id)
            if row is None:
                continue
            if "a.expiry = v.day" in text and row["expiry"] != day:
                continue
            if "a.source = 'replay'" in text and row["source"] != "replay":
                continue
            del db.rows[row_id]
            gone.append((row_id,))
        return gone

    def _insert(self, page: list[tuple[object, ...]]) -> list[tuple[object, ...]]:
        db = self.connection.db
        if db.before_insert is not None:
            db.before_insert()
        landed: list[tuple[object, ...]] = []
        for values in page:
            row = dict(zip(ibr.ALERT_INSERT_COLUMNS, values, strict=True))
            key = (row["option_chain"], row["bucket_start"])
            if any((r["option_chain"], r["bucket_start"]) == key for r in db.rows.values()):
                continue  # ON CONFLICT DO NOTHING
            row.update(id=db.next_id, acknowledged=False)
            db.rows[db.next_id] = row
            landed.append((db.next_id,))
            db.next_id += 1
        return landed

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
    "Metadata" merges into the object's metadata, any other key replaces that field."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, dict[str, str]]] = {}
        self.puts: list[str] = []
        self.tamper: dict[str, Any] = {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, Metadata: dict[str, str], **_: Any):  # noqa: N803
        self.puts.append(Key)
        self.objects[(Bucket, Key)] = (bytes(Body), dict(Metadata))
        return {}

    def head_object(self, *, Bucket: str, Key: str):  # noqa: N803
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

    def dry_run(self, start: date, end: date | None = None) -> tuple[int, str, Path]:
        before = set(self.runs.glob("*")) if self.runs.exists() else set()
        code, out = self.run(
            "rebuild", "--from", start.isoformat(), "--to", (end or start).isoformat()
        )
        (run,) = set(self.runs.glob("*")) - before
        return code, out, run

    def apply(
        self, run: Path, *, delete: int | None = None, insert: int | None = None
    ) -> tuple[int, str]:
        """`rebuild --apply` with the plan's totals over the unapplied days, unless given."""
        totals = plan_totals(run)
        return self.run(
            "rebuild",
            "--apply",
            "--run",
            str(run),
            "--expect-delete",
            str(totals["delete"] if delete is None else delete),
            "--expect-insert",
            str(totals["insert"] if insert is None else insert),
        )


def plan_totals(run: Path) -> dict[str, int]:
    """The plan's delete and insert totals over the days with no marker yet."""
    plan = tool.load_plan(run)
    days = [entry for day, entry in plan["days"].items() if not (run / f"{day}.applied").exists()]
    return {
        "delete": sum(entry["delete"] for entry in days),
        "insert": sum(entry["insert"] for entry in days),
    }


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
    monkeypatch.setattr(tool, "RUNS_DIR", w.runs)
    monkeypatch.setattr(tool, "fulltape_connection", lambda **kwargs: duckdb.connect())
    monkeypatch.setattr(tool, "r2_url", lambda day: w.tapes[day])
    monkeypatch.setattr(psycopg2, "connect", w.db.connect)
    monkeypatch.setattr(tool.boto3, "client", lambda *a, **k: w.s3)
    monkeypatch.setattr(tool, "_utc_now", lambda: w.clock())
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
    assert conn.readonly and conn.autocommit
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
    assert tool.load_plan(run)["days"]["2026-05-13"]["twins"] == 1

    code, out = world.apply(run)

    assert code == 0, out
    assert {r["option_chain"] for r in world.db.day(EDGE_FIRST, "replay")} == setup["insert"]
    assert [world.db.rows[i] for i in setup["live"]] == live_before
    code, out = world.run("verify", "--from", "2026-05-13", "--to", "2026-05-13")
    assert code == 0, out


def test_rebuild_on_07_22_inserts_only_after_last_live_row_and_skips_live_twins(world: World):
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
    world.db.add(alerts[early], source="live", fired_at=at(d, "14:00:00.250"))
    world.db.add(alerts[twin], source="live", fired_at=at(d, "14:52:46.500"))

    code, out, run = world.dry_run(d)

    assert code == 0, out
    day_plan = json.loads((run / "days" / "2026-07-22.json").read_text(encoding="utf-8"))
    assert {a["option_chain"] for a in day_plan["inserts"]} == {late, spxw}
    assert [t["option_chain"] for t in day_plan["twins"]] == [twin]
    assert twin in (run / "report.md").read_text(encoding="utf-8")

    code, out = world.apply(run)

    assert code == 0, out
    assert {r["option_chain"] for r in world.db.day(d, "replay")} == {late, spxw}
    assert {r["option_chain"] for r in world.db.day(d, "live")} == {early, twin}


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

    plan = tool.load_plan(run)
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
    assert "| 2026-03-31 | full | 3 | 3 |" in report


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
    assert "Measured after the apply" in (run / "report.md").read_text(encoding="utf-8")
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-11")
    assert code == 0, out


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


@pytest.mark.parametrize("which", ["MODULE_PATH", "TOOL_PATH"])
def test_apply_refuses_changed_module_hash(
    world: World, monkeypatch: pytest.MonkeyPatch, which: str
):
    copy_path = world.tmp / "code" / f"{which}.py"
    copy_path.parent.mkdir()
    shutil.copyfile(getattr(tool, which), copy_path)
    monkeypatch.setattr(tool, which, copy_path)
    two_full_days(world)
    code, out, run = world.dry_run(FULL_A, FULL_A2)
    assert code == 0, out
    with copy_path.open("a", encoding="utf-8") as handle:
        handle.write("# changed\n")

    code, out = world.apply(run)

    assert code == 3
    assert "blob" in out
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
            tool.hashlib,
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
    assert world.db.dsns and set(world.db.dsns) == {SECRETS["DATABASE_URL"]}

    # A tape the tape reader cannot find, at a path that names the bucket and the endpoint.
    monkeypatch.setattr(
        tool,
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
            " for account acct-sekret"
        )

    monkeypatch.setattr(tool, "fulltape_connection", broken)
    code, out = world.run("verify", "--from", "2026-03-10", "--to", "2026-03-10")
    outputs.append(out)
    assert code == 1 and "RuntimeError" in out

    files = [p.read_text(encoding="utf-8") for p in world.runs.rglob("*") if p.is_file()]
    for text in [*outputs, *files]:
        for secret in SECRET_PARTS:
            assert secret not in text


@pytest.mark.parametrize("command", ["heal", "export", "undo"])
def test_part_two_modes_exit_2_not_yet(world: World, command: str):
    code, out = world.run(command, "--from", "2026-05-13")

    assert code == 2
    assert "not yet" in out
    assert world.db.dsns == []


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
