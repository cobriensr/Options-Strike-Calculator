"""heal_day, live_spot and the live-settings check (spec 6.3 and 6.4).

Each test runs the real replay over a small tape in tmp_path (tests/_interval_ba_tape.py). The
database side is a fake psycopg2 connection, the module boundary: SELECTs return the rows a test
gives it, and every other statement is recorded with the autocommit state it ran under.
psycopg2's own execute_values runs against the fake cursor, so each page of a batched write
arrives as one statement with its rows. No test opens a database.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, fields, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import duckdb
import psycopg2
import pytest

from interval_ba_replay import (
    INSERT_MISSED_FROM,
    LIVE_START,
    MULTI_LEG_CODES,
    DayPlan,
    LiveRow,
    LiveSettings,
    TapeAlert,
    default_settings,
    heal_day,
    live_spot,
    read_covering_settings,
    read_live_rows,
    replay_day,
)
from tests._interval_ba_tape import (
    DAY,
    QQQ_C,
    QQQ_P,
    SPXW_C,
    SPXW_P,
    SPY_C,
    SPY_P,
    Layout,
    _at,
    _chain,
    _tick,
    _write_tape,
)

SPXW_P2 = _chain("SPXW", "P", 6650)
SPY_LIVE_ONLY = _chain("SPY", "C", 680)
SPY_STALE = _chain("SPY", "C", 690)

HELD_NO_RECORD = "no live settings record"
HELD_OTHER_RULE = "live settings differ from the tape rule"
HELD_OFF = "live detector off"


@pytest.fixture(params=["naive", "tz"])
def layout(request: pytest.FixtureRequest) -> Layout:
    return request.param


@pytest.fixture
def con():
    connection = duckdb.connect()
    yield connection
    connection.close()


# --- The fake connection ------------------------------------------------------------------------


@dataclass
class _Statement:
    sql: str
    params: object  # a dict for an execute, the page's rows for an execute_values page
    autocommit: bool


class _FakeConn:
    """Just enough of a psycopg2 connection for heal_day and its readers.

    As in psycopg2, a statement with autocommit off opens a transaction that only commit or
    rollback ends, and autocommit cannot change inside one. A page's RETURNING gives one id per
    row: the row's own id for an UPDATE or a DELETE, a new one for an INSERT. `fail_on` makes
    the first statement whose SQL contains it raise.
    """

    encoding = "UTF8"  # execute_values encodes its SQL with the connection's encoding

    def __init__(
        self,
        rows: Sequence[LiveRow] = (),
        settings: Sequence[tuple[object, ...]] = (),
        *,
        fail_on: str | None = None,
    ):
        self.in_transaction = False
        self._autocommit = True
        self.closed = 0
        self.rows = [tuple(getattr(row, f.name) for f in fields(LiveRow)) for row in rows]
        self.settings = list(settings)
        self.fail_on = fail_on
        self.statements: list[_Statement] = []
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

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1
        self.in_transaction = False

    def rollback(self) -> None:
        self.rollbacks += 1
        self.in_transaction = False

    def writes(self) -> list[_Statement]:
        return [s for s in self.statements if not s.sql.lstrip().startswith("SELECT")]

    def write(self, prefix: str) -> _Statement:
        (statement,) = [s for s in self.writes() if s.sql.lstrip().startswith(prefix)]
        return statement


class _FakeCursor:
    def __init__(self, conn: _FakeConn):
        self.connection = conn
        self._page: list[tuple[object, ...]] = []
        self._result: list[tuple[object, ...]] = []
        self._next_id = 9001

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def mogrify(self, template: bytes, args: tuple[object, ...]) -> bytes:
        self._page.append(tuple(args))
        return b"(...)"

    def execute(self, sql: str | bytes, params: object = None) -> None:
        conn = self.connection
        text = sql.decode() if isinstance(sql, bytes) else sql
        if isinstance(sql, bytes):
            params, self._page = self._page, []
        if not conn.autocommit:
            conn.in_transaction = True
        if conn.fail_on is not None and conn.fail_on in text:
            raise psycopg2.OperationalError("server closed the connection unexpectedly")
        conn.statements.append(_Statement(text, params, conn.autocommit))
        if "FROM interval_ba_live_settings" in text:
            self._result = list(conn.settings)
        elif text.lstrip().startswith("SELECT"):
            self._result = list(conn.rows)
        elif text.startswith("INSERT INTO interval_ba_alerts"):
            assert isinstance(params, list)
            self._result = [(self._next_id + n,) for n in range(len(params))]
            self._next_id += len(params)
        elif "RETURNING" in text:
            assert isinstance(params, list)
            self._result = [(row[0],) for row in params]
        else:
            self._result = []

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._result


def _settings_row(settings: LiveSettings) -> tuple[object, ...]:
    """A settings row as psycopg2 returns it: lists for the arrays, NUMERIC at its scale."""
    return (
        settings.booted_at,
        settings.enabled,
        list(settings.tickers),
        Decimal(settings.ratio_threshold).quantize(Decimal("0.0001")),
        Decimal(settings.premium_floor).quantize(Decimal("0.01")),
        settings.window_sec,
        Decimal(settings.multi_leg_share_max).quantize(Decimal("0.0001")),
        sorted(settings.multi_leg_codes),
        settings.confluence_window_sec,
    )


# --- The day the heal tests share ---------------------------------------------------------------


def _day_tape(tmp_path, layout: Layout = "tz") -> str:
    return _write_tape(
        tmp_path,
        [
            # A: an SPY call whose top trade is an intermarket sweep. Live has it, flag unset.
            _tick(_at("14:31:00.250"), SPY_C, "25.00", 100, flags=("intermarket_sweep",)),
            # B: a QQQ call. Live has it with another ratio.
            _tick(_at("14:31:10"), QQQ_C, "25.00", 100),
            # C: an SPXW call whose crossing tick has no spot: the next SPXW print's spot.
            _tick(_at("14:32:00"), SPXW_C, "30.00", 100, spot=None),
            _tick(_at("14:32:01"), SPXW_P, "1.00", 1, side="bid", spot="6701.25"),
            # D: an SPY put live missed, which an earlier pass inserted.
            _tick(_at("14:41:00"), SPY_P, "25.00", 100),
            # E: a QQQ put live missed.
            _tick(_at("14:42:00"), QQQ_P, "25.00", 100),
            # F: an SPXW put live has, spot and all.
            _tick(_at("14:50:00"), SPXW_P2, "30.00", 100, spot="6702.00"),
        ],
        layout=layout,
    )


def _live(alert: TapeAlert, row_id: int, **changes: object) -> LiveRow:
    """The live row for a tape alert, as live writes it: its own wall-clock fired_at, both flags
    false, and no spot on an SPXW row."""
    row = LiveRow(
        id=row_id,
        option_chain=alert.option_chain,
        ticker=alert.ticker,
        bucket_start=alert.bucket_start,
        fired_at=alert.fired_at + timedelta(milliseconds=150),
        trade_count=alert.trade_count,
        ratio_pct=alert.ratio_pct,
        ask_premium=alert.ask_premium,
        total_premium=alert.total_premium,
        top_trade_premium=alert.top_trade_premium,
        top_trade_size=alert.top_trade_size,
        top_trade_executed_at=alert.top_trade_executed_at,
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=None if alert.ticker == "SPXW" else alert.underlying_price,
        source="live",
    )
    return replace(row, **changes)  # type: ignore[arg-type]


def _unfired(row_id: int, chain: str, *, source: str = "live") -> LiveRow:
    """A row at a key the tape does not fire, whose top trade is not on the tape."""
    return LiveRow(
        id=row_id,
        option_chain=chain,
        ticker=chain[:-15],
        bucket_start=_at("14:30:00"),
        fired_at=_at("14:31:30.100"),
        trade_count=1,
        ratio_pct=Decimal("100.00"),
        ask_premium=Decimal("250000.00"),
        total_premium=Decimal("250000.00"),
        top_trade_premium=Decimal("250000.00"),
        top_trade_size=7,
        top_trade_executed_at=_at("14:31:30"),
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=Decimal("670.00"),
        source=source,
    )


def _scenario(con, tape: str) -> tuple[dict[str, TapeAlert], list[LiveRow]]:
    alerts = {a.option_chain: a for a in replay_day(con, tape, DAY).alerts}
    rows = [
        _live(alerts[SPY_C], 101),
        _live(alerts[QQQ_C], 102, ratio_pct=Decimal("99.00")),
        _live(alerts[SPXW_C], 103),
        _unfired(104, SPY_LIVE_ONLY),
        _live(alerts[SPXW_P2], 105, underlying_price=Decimal("6702.00")),
        _live(alerts[SPY_P], 201, source="replay"),
        _unfired(202, SPY_STALE, source="replay"),
    ]
    return alerts, rows


def _counts(plan: DayPlan) -> dict[str, object]:
    names = (
        "root_label_mismatch",
        "tape_alerts",
        "live_rows",
        "live_missed",
        "live_only",
        "value_mismatched",
        "inserted",
        "inserts_held",
        "removed",
        "flags_changed",
        "flags_unmatched",
        "spot_filled",
        "matched",
    )
    return {name: getattr(plan, name) for name in names}


# All three tickers on. Six tape alerts (A-F), five live rows (101-105), four keys in both (A, B,
# C, F); D and E have no live row, 104 has no tape alert, and B differs in its ratio. E is the
# one insert (D has a replay row), 202 the one removal, 101 the one flag change, 104's top trade
# is not on the tape, and 103 the one spot.
BASE_COUNTS: dict[str, object] = {
    "root_label_mismatch": 0,
    "tape_alerts": 6,
    "live_rows": 5,
    "live_missed": 2,
    "live_only": 1,
    "value_mismatched": 1,
    "inserted": 1,
    "inserts_held": None,
    "removed": 1,
    "flags_changed": 1,
    "flags_unmatched": 1,
    "spot_filled": 1,
    "matched": 4,
}


def _heal(db: _FakeConn, con, tape: str, settings, *, insert_missed=True, apply=False, day=DAY):
    return heal_day(db, con, tape, day, settings, insert_missed=insert_missed, apply=apply)


def _set_columns(sql: str) -> set[str]:
    (assignments,) = re.findall(r"\bSET\s+(.*?)\s+FROM\b", sql, flags=re.DOTALL)
    return {part.split("=")[0].strip() for part in assignments.split(",")}


def _updated_columns(db: _FakeConn) -> list[list[str]]:
    """The columns each UPDATE sets, one sorted list per statement."""
    updates = [s for s in db.writes() if s.sql.lstrip().startswith("UPDATE")]
    return sorted(sorted(_set_columns(s.sql)) for s in updates)


def _assert_held(db: _FakeConn, plan: DayPlan, reason: str) -> None:
    """Held inserts: none planned or sent, and the flags and spot still planned and written."""
    assert plan.inserts_held == reason
    assert plan.inserts == ()
    assert plan.inserted == 0
    assert plan.flag_updates == ((101, True, False),)
    assert plan.spot_updates == ((103, Decimal("6701.25")),)
    assert not [s for s in db.writes() if s.sql.startswith("INSERT INTO interval_ba_alerts")]
    assert _updated_columns(db) == [
        ["top_trade_is_floor", "top_trade_is_sweep"],
        ["underlying_price"],
    ]
    marker = db.write("INSERT INTO interval_ba_tape_days").params
    assert isinstance(marker, dict)
    assert (marker["inserts_held"], marker["inserted"]) == (reason, 0)
    assert db.commits == 1


# --- The dry run and what may be written --------------------------------------------------------


def test_dry_run_writes_nothing_and_sha_is_stable(tmp_path, layout, con):
    tape = _day_tape(tmp_path, layout)
    alerts, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    first = _heal(db, con, tape, [default_settings()])
    second = _heal(db, con, tape, [default_settings()])

    assert first == second
    assert re.fullmatch(r"[0-9a-f]{64}", first.sha256)
    assert db.writes() == []
    assert db.commits == 0
    assert db.autocommit is True
    assert first.day == DAY
    assert _counts(first) == BASE_COUNTS
    assert first.inserts == (alerts[QQQ_P],)
    assert first.removes == (202,)
    assert first.flag_updates == ((101, True, False),)
    assert first.spot_updates == ((103, Decimal("6701.25")),)


def test_updates_touch_only_flags_and_null_spxw_spot_on_live_rows(tmp_path, con):
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert _counts(plan) == BASE_COUNTS
    writes = db.writes()
    assert all(s.autocommit is False for s in db.statements)
    assert db.commits == 1
    assert db.autocommit is True

    updates = [s for s in writes if s.sql.lstrip().startswith("UPDATE")]
    assert _updated_columns(db) == [
        ["top_trade_is_floor", "top_trade_is_sweep"],
        ["underlying_price"],
    ]
    for update in updates:
        assert "a.source = 'live'" in update.sql
        assert "acknowledged" not in update.sql
    (flags,) = [s for s in updates if "top_trade_is_sweep" in _set_columns(s.sql)]
    assert "IS DISTINCT FROM" in flags.sql
    assert flags.params == [(101, True, False)]
    (spot,) = [s for s in updates if _set_columns(s.sql) == {"underlying_price"}]
    assert "a.ticker = 'SPXW'" in spot.sql
    assert "a.underlying_price IS NULL" in spot.sql
    assert spot.params == [(103, Decimal("6701.25"))]

    delete = db.write("DELETE")
    assert "a.source = 'replay'" in delete.sql
    assert delete.params == [(202,)]
    live_ids = {row.id for row in rows if row.source == "live"}
    assert not live_ids & {params[0] for params in delete.params}  # type: ignore[union-attr]

    insert = db.write("INSERT INTO interval_ba_alerts")
    assert [params[0] for params in insert.params] == [alerts[QQQ_P].option_chain]  # type: ignore[union-attr]

    marker = db.write("INSERT INTO interval_ba_tape_days")
    assert writes[-1] is marker
    assert "ON CONFLICT (day) DO UPDATE" in marker.sql
    assert marker.params == {
        "day": DAY,
        "tape_alerts": 6,
        "live_rows": 5,
        "live_missed": 2,
        "live_only": 1,
        "value_mismatched": 1,
        "inserted": 1,
        "inserts_held": None,
        "removed": 1,
        "flags_changed": 1,
        "flags_unmatched": 1,
        "spot_filled": 1,
    }
    assert {s.sql.split()[0] for s in writes} == {"INSERT", "DELETE", "UPDATE"}


def test_applied_counts_are_what_the_database_reports(tmp_path, con, monkeypatch):
    # A write the database skips (another writer got there first) is not counted as written.
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)
    real_fetchall = _FakeCursor.fetchall

    def nothing_returned(self: _FakeCursor) -> list[tuple[object, ...]]:
        last = self.connection.statements[-1].sql
        return [] if "RETURNING" in last else real_fetchall(self)

    monkeypatch.setattr(_FakeCursor, "fetchall", nothing_returned)

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert (plan.inserted, plan.removed, plan.flags_changed, plan.spot_filled) == (0, 0, 0, 0)
    assert plan.inserts and plan.removes and plan.flag_updates and plan.spot_updates
    marker = db.write("INSERT INTO interval_ba_tape_days").params
    assert isinstance(marker, dict)
    assert (marker["inserted"], marker["removed"], marker["flags_changed"]) == (0, 0, 0)
    assert marker["spot_filled"] == 0


def test_spot_stays_blank_when_the_tape_has_none(tmp_path, con):
    # The crossing tick has no spot and no SPXW print with one follows: nothing to write.
    tape = _write_tape(
        tmp_path, [_tick(_at("14:31:00"), SPXW_C, "30.00", 100, spot=None)], layout="tz"
    )
    (alert,) = replay_day(con, tape, DAY).alerts
    db = _FakeConn([_live(alert, 103)])

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert (plan.spot_updates, plan.spot_filled) == ((), 0)
    assert not [s for s in db.writes() if "SET underlying_price" in s.sql]


# --- live_spot ----------------------------------------------------------------------------------


def _spot_row(row_id: int, chain: str, bucket: str, trade_count: int, fired: str) -> LiveRow:
    return replace(
        _unfired(row_id, chain),
        bucket_start=_at(bucket),
        trade_count=trade_count,
        fired_at=_at(fired),
        underlying_price=None,
    )


def test_live_spot_uses_trade_count_th_tick_counting_canceled(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            _tick(_at("14:31:00"), SPXW_C, "1.00", 1, spot="6700.00"),
            _tick(_at("14:31:01"), SPXW_C, "1.00", 1, spot="6700.50", canceled=True),
            # Not ticks of the bucket: a zero-price print, another contract, the next bucket.
            _tick(_at("14:31:01.500"), SPXW_C, "0", 1, spot="6799.00"),
            _tick(_at("14:31:01.700"), SPXW_P, "1.00", 1, spot="6798.00"),
            _tick(_at("14:35:00"), SPXW_C, "1.00", 1, spot="6797.00"),
            _tick(_at("14:31:02"), SPXW_C, "1.00", 1, spot="6701.00"),
            _tick(_at("14:31:03"), SPXW_C, "1.00", 1, spot="6701.50"),
        ],
        layout=layout,
    )
    rows = [
        _spot_row(1, SPXW_C, "14:30:00", 1, "14:31:04"),
        _spot_row(2, SPXW_C, "14:30:00", 2, "14:31:04"),
        _spot_row(3, SPXW_C, "14:30:00", 3, "14:31:04"),
    ]

    assert live_spot(con, tape, DAY, rows) == {
        1: Decimal("6700.00"),
        2: Decimal("6700.50"),
        3: Decimal("6701.00"),
    }


def test_live_spot_falls_back_to_asof_when_bucket_is_short(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            # The bucket has two ticks; every row below says three or more.
            _tick(_at("14:31:00"), SPXW_C, "1.00", 1, spot="6700.00"),
            _tick(_at("14:31:01"), SPXW_C, "1.00", 1, spot="6700.25"),
            _tick(_at("14:31:05"), SPXW_P, "1.00", 1, spot="6701.00"),
            # Spots the as-of must skip: no spot, another root, a non-0DTE SPXW contract.
            _tick(_at("14:31:05.200"), SPXW_P, "1.00", 1, spot=None),
            _tick(_at("14:31:05.300"), SPY_C, "1.00", 1, spot="671.00"),
            _tick(
                _at("14:31:05.400"),
                _chain("SPXW", "C", 6700, DAY + timedelta(days=1)),
                "1.00",
                1,
                spot="6799.00",
            ),
            # At a row's fired_at to the microsecond: in. One microsecond after: out.
            _tick(_at("14:31:06.000123"), SPXW_P, "1.00", 1, spot="6701.50"),
            _tick(_at("14:31:06.000124"), SPXW_P, "1.00", 1, spot="6702.00"),
        ],
        layout=layout,
    )
    rows = [
        _spot_row(1, SPXW_C, "14:30:00", 3, "14:31:06.000123"),
        _spot_row(2, SPXW_C, "14:30:00", 5, "14:31:05.500"),
        # Before any SPXW print with a spot: none to take.
        _spot_row(3, SPXW_C, "14:30:00", 9, "14:30:59"),
    ]

    assert live_spot(con, tape, DAY, rows) == {
        1: Decimal("6701.50"),
        2: Decimal("6701.00"),
        3: None,
    }


def test_live_spot_forward_fills_opening_seconds(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            # An SPXW print with a spot before the crossing tick: never a backward fill.
            _tick(_at("13:30:00.100"), SPXW_P, "1.00", 1, spot="6698.00"),
            _tick(_at("13:30:00.200"), SPXW_C, "30.00", 100, spot=None),
            # Spots the fill must skip: another root, an SPX-root row, a non-0DTE SPXW row, and
            # a kept SPXW print with no spot either.
            _tick(_at("13:30:00.300"), SPY_C, "1.00", 1, spot="670.00"),
            _tick(
                _at("13:30:00.400"),
                _chain("SPX", "C", 6700),
                "1.00",
                1,
                spot="6699.99",
                label="SPX",
            ),
            _tick(
                _at("13:30:00.500"),
                _chain("SPXW", "C", 6700, DAY + timedelta(days=1)),
                "1.00",
                1,
                spot="6699.98",
            ),
            _tick(_at("13:30:00.600"), SPXW_P, "1.00", 1, spot=None),
            # The first kept SPXW print with a spot after it, canceled or not.
            _tick(_at("13:30:00.700"), SPXW_P, "1.00", 1, spot="6700.125", canceled=True),
            _tick(_at("13:30:01"), SPXW_P, "1.00", 1, spot="6701.00"),
            # A crossing tick with no spot and no SPXW spot after it keeps none.
            _tick(_at("13:40:00"), SPXW_P2, "30.00", 100, spot=None),
        ],
        layout=layout,
    )
    rows = [
        _spot_row(1, SPXW_C, "13:30:00", 1, "13:30:00.300"),
        _spot_row(2, SPXW_P2, "13:40:00", 1, "13:40:00.100"),
    ]

    assert live_spot(con, tape, DAY, rows) == {1: Decimal("6700.13"), 2: None}


def test_live_spot_ignores_spy_and_qqq_rows(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            _tick(_at("14:31:00"), SPY_C, "25.00", 100, spot="670.00"),
            _tick(_at("14:31:00"), QQQ_C, "25.00", 100, spot="600.00"),
            _tick(_at("14:31:00"), SPXW_C, "25.00", 100, spot="6700.00"),
        ],
        layout=layout,
    )
    spy = _spot_row(1, SPY_C, "14:30:00", 1, "14:31:01")
    qqq = _spot_row(2, QQQ_C, "14:30:00", 1, "14:31:01")
    spxw = _spot_row(3, SPXW_C, "14:30:00", 1, "14:31:01")

    assert live_spot(con, tape, DAY, [spy, qqq, spxw]) == {3: Decimal("6700.00")}
    # With no SPXW row the tape is not read at all.
    assert live_spot(con, str(tmp_path / "absent-fulltape.parquet"), DAY, [spy, qqq]) == {}


# --- Inserts and the settings check -------------------------------------------------------------


def test_insert_missed_false_inserts_nothing_and_counts_all_three_tickers(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)
    # Settings that would hold the inserts and switch two tickers off: not consulted.
    other = replace(default_settings(), tickers=("SPY",), multi_leg_codes=frozenset({"mfto"}))

    plan = _heal(db, con, tape, [other], insert_missed=False, apply=True)

    assert _counts(plan) == {**BASE_COUNTS, "inserted": 0}
    assert plan.inserts == ()
    assert plan.flag_updates == ((101, True, False),)
    assert plan.spot_updates == ((103, Decimal("6701.25")),)
    assert plan.removes == (202,)
    assert not [s for s in db.writes() if s.sql.startswith("INSERT INTO interval_ba_alerts")]
    assert db.commits == 1


def test_held_without_settings_record(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    plan = _heal(db, con, tape, [], apply=True)

    _assert_held(db, plan, HELD_NO_RECORD)
    # With no record every ticker counts.
    assert _counts(plan) == {**BASE_COUNTS, "inserted": 0, "inserts_held": HELD_NO_RECORD}


def test_held_when_codes_differ(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)
    # The eight codes live ran from 05-13 to 10-28.
    old_codes = (MULTI_LEG_CODES - {"cbmo", "mctp"}) | {"mfto"}

    plan = _heal(
        db, con, tape, [replace(default_settings(), multi_leg_codes=old_codes)], apply=True
    )

    _assert_held(db, plan, HELD_OTHER_RULE)
    assert _counts(plan) == {**BASE_COUNTS, "inserted": 0, "inserts_held": HELD_OTHER_RULE}


def test_held_when_detector_off(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    plan = _heal(db, con, tape, [replace(default_settings(), enabled=False)], apply=True)

    _assert_held(db, plan, HELD_OFF)
    # With the detector off no ticker was on: the comparison counts nothing.
    assert _counts(plan) == {
        **BASE_COUNTS,
        "tape_alerts": 0,
        "live_rows": 0,
        "live_missed": 0,
        "live_only": 0,
        "value_mismatched": 0,
        "matched": 0,
        "inserted": 0,
        "inserts_held": HELD_OFF,
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("ratio_threshold", Decimal("0.7")),
        ("premium_floor", Decimal("200000")),
        ("window_sec", 60),
        ("multi_leg_share_max", Decimal("0.6")),
        ("multi_leg_codes", MULTI_LEG_CODES | {"mfto"}),
        ("confluence_window_sec", 120),
    ],
)
def test_held_when_any_rule_setting_differs(tmp_path, con, field, value):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    # Only the mid-day row differs; the one before 00:00 CT runs the tape rule.
    settings = [default_settings(), replace(default_settings(), **{field: value})]

    plan = _heal(_FakeConn(rows), con, tape, settings)

    assert plan.inserts_held == HELD_OTHER_RULE
    assert plan.inserts == ()


def test_held_reason_precedence(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    off = replace(default_settings(), enabled=False)
    off_other_rule = replace(off, window_sec=60)

    def held(settings: list[LiveSettings]) -> str | None:
        return _heal(_FakeConn(rows), con, tape, settings).inserts_held

    assert held([off, off_other_rule]) == HELD_OTHER_RULE
    assert held([off, off]) == HELD_OFF
    # One row on is enough not to hold for "off".
    assert held([off, default_settings()]) is None


def test_settings_as_the_database_returns_them_are_the_tape_rule(tmp_path, con):
    # NUMERIC(6,4) gives 0.7500 and 0.5000, NUMERIC(14,2) 250000.00, TEXT[] a sorted list.
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    booted = replace(default_settings(), booted_at=datetime(2026, 11, 16, 23, 0, tzinfo=UTC))
    db = _FakeConn(rows, [_settings_row(booted)])

    plan = _heal(db, con, tape, read_covering_settings(db, DAY))

    assert plan.inserts_held is None
    assert plan.inserts == (alerts[QQQ_P],)


def test_ticker_off_in_settings_is_not_inserted_or_counted(tmp_path, con):
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    # No replay row at D this time, so the SPY put is inserted; the QQQ put is not.
    rows = [row for row in rows if row.id != 201]
    rows = [replace(row, top_trade_is_sweep=True) if row.id == 102 else row for row in rows]
    no_qqq = replace(default_settings(), tickers=("SPXW", "SPY"))

    plan = _heal(_FakeConn(rows), con, tape, [no_qqq])

    assert _counts(plan) == {
        **BASE_COUNTS,
        "tape_alerts": 4,  # A, C, D, F
        "live_rows": 4,  # 101, 103, 104, 105
        "live_missed": 1,  # D
        "value_mismatched": 0,  # B is QQQ
        "matched": 3,
        "flags_changed": 2,
    }
    assert plan.inserts == (alerts[SPY_P],)
    # A QQQ live row's flags are still corrected.
    assert plan.flag_updates == ((101, True, False), (102, False, False))


def test_on_tickers_are_on_in_every_covering_row(tmp_path, con):
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    rows = [row for row in rows if row.id != 201]
    morning = default_settings()
    no_spxw_after_noon = replace(default_settings(), tickers=("QQQ", "SPY"))

    plan = _heal(_FakeConn(rows), con, tape, [morning, no_spxw_after_noon])

    assert (plan.tape_alerts, plan.live_rows, plan.matched) == (
        4,
        3,
        2,
    )  # A, B, D, E; 101, 102, 104
    assert plan.inserts == (alerts[SPY_P], alerts[QQQ_P])

    # A row with the detector off has no ticker on, so nothing is counted or inserted.
    plan = _heal(_FakeConn(rows), con, tape, [morning, replace(morning, enabled=False)])

    assert plan.inserts_held is None
    assert (plan.tape_alerts, plan.live_rows, plan.inserts) == (0, 0, ())
    assert plan.flag_updates == ((101, True, False),)


def test_mid_day_boot_with_other_codes_holds_inserts(tmp_path, con):
    # Review Focus 3: a second live boot during the session is a covering row.
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    before = replace(default_settings(), booted_at=datetime(2026, 11, 16, 23, 0, tzinfo=UTC))
    mid_day = replace(
        default_settings(),
        booted_at=datetime(2026, 11, 17, 17, 0, tzinfo=UTC),
        multi_leg_codes=MULTI_LEG_CODES | {"mfto"},
    )
    db = _FakeConn(rows, [_settings_row(before), _settings_row(mid_day)])

    settings = read_covering_settings(db, DAY)
    plan = _heal(db, con, tape, settings)

    assert [s.booted_at for s in settings] == [before.booted_at, mid_day.booted_at]
    assert plan.inserts_held == HELD_OTHER_RULE
    assert plan.inserts == ()


def test_outage_day_with_no_live_rows_is_not_held(tmp_path, con):
    tape = _day_tape(tmp_path)
    db = _FakeConn([])

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert plan.inserts_held is None
    assert plan.inserts == replay_day(con, tape, DAY).alerts
    assert (plan.tape_alerts, plan.live_rows, plan.live_missed, plan.inserted) == (6, 0, 6, 6)
    assert (plan.flags_changed, plan.flags_unmatched, plan.spot_filled, plan.removed) == (
        0,
        0,
        0,
        0,
    )
    assert len(db.write("INSERT INTO interval_ba_alerts").params) == 6  # type: ignore[arg-type]


# --- Removals -----------------------------------------------------------------------------------


def test_stale_replay_rows_removed_live_rows_kept(tmp_path, con):
    # Review Focus 4: a re-landed tape no longer fires 202 (replay) or 104 (live).
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert plan.removes == (202,)
    assert plan.removed == 1
    assert db.write("DELETE").params == [(202,)]
    # The replay row the tape still fires stays, and is not inserted again.
    assert alerts[SPY_P] not in plan.inserts
    assert plan.live_only == 1


def test_empty_replay_removes_nothing(tmp_path, con):
    # Kept prints, no fire: an empty replay with rows present is a broken read, not a quiet day.
    tape = _write_tape(tmp_path, [_tick(_at("14:31:00"), SPY_C, "1.00", 1)], layout="tz")
    rows = [_unfired(104, SPY_LIVE_ONLY), _unfired(202, SPY_STALE, source="replay")]
    db = _FakeConn(rows)

    plan = _heal(db, con, tape, [default_settings()], apply=True)

    assert plan.removes == ()
    assert (plan.tape_alerts, plan.live_rows, plan.live_only) == (0, 1, 1)
    assert not [s for s in db.writes() if s.sql.startswith("DELETE")]


# --- Errors and bounds --------------------------------------------------------------------------


def test_db_error_mid_day_rolls_back_and_writes_no_marker(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows, fail_on="SET underlying_price")

    with pytest.raises(psycopg2.OperationalError, match="server closed the connection"):
        _heal(db, con, tape, [default_settings()], apply=True)

    assert db.commits == 0
    assert db.rollbacks == 1
    assert db.autocommit is True
    # The writes before it ran inside the transaction the rollback undid; the marker never ran.
    assert [s.sql.split()[0] for s in db.writes()] == ["INSERT", "DELETE", "UPDATE"]
    assert all(s.autocommit is False for s in db.writes())
    assert not [s for s in db.writes() if "interval_ba_tape_days" in s.sql]


def test_failed_rollback_keeps_the_original_error(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows, fail_on="SET underlying_price")

    def dead_rollback() -> None:
        db.closed = 2
        raise psycopg2.InterfaceError("connection already closed")

    db.rollback = dead_rollback  # type: ignore[method-assign]

    with pytest.raises(psycopg2.OperationalError, match="server closed the connection"):
        _heal(db, con, tape, [default_settings()], apply=True)

    assert db.commits == 0
    assert db.autocommit is False  # a closed connection is left alone


def test_tape_without_the_day_raises_and_writes_nothing(tmp_path, con):
    # replay_day refuses a tape with no kept row for the day; that is a failed day, not zero
    # alerts, and nothing may be written for it.
    tape = _write_tape(
        tmp_path,
        [_tick(_at("14:31:00"), _chain("SPY", "C", 670, DAY + timedelta(days=1)), "25.00", 100)],
        layout="tz",
    )
    db = _FakeConn([_unfired(202, SPY_STALE, source="replay")])

    with pytest.raises(ValueError, match="no 0DTE SPXW/SPY/QQQ rows"):
        _heal(db, con, tape, [default_settings()], apply=True)

    assert db.writes() == []
    assert db.commits == 0
    assert db.autocommit is True


def test_day_before_live_start_is_refused(tmp_path, con):
    db = _FakeConn([])
    absent = str(tmp_path / "absent-fulltape.parquet")

    with pytest.raises(ValueError, match="2026-05-12 is before the first live day 2026-05-13"):
        _heal(db, con, absent, [], insert_missed=False, day=LIVE_START - timedelta(days=1))

    assert db.statements == []
    assert db.autocommit is True
    # LIVE_START itself passes the check and goes on to read the (absent) tape.
    with pytest.raises(duckdb.IOException):
        _heal(db, con, absent, [], insert_missed=False, day=LIVE_START)


def test_insert_missed_before_live_ran_todays_rule_is_refused(tmp_path, con):
    db = _FakeConn([])
    absent = str(tmp_path / "absent-fulltape.parquet")

    with pytest.raises(ValueError, match="2026-10-28 is before 2026-10-29"):
        _heal(db, con, absent, [default_settings()], day=INSERT_MISSED_FROM - timedelta(days=1))

    assert db.statements == []
    with pytest.raises(duckdb.IOException):
        _heal(db, con, absent, [default_settings()], day=INSERT_MISSED_FROM)


def test_dayplan_json_round_trips(tmp_path, con):
    tape = _day_tape(tmp_path)
    alerts, rows = _scenario(con, tape)
    plan = _heal(_FakeConn(rows), con, tape, [default_settings()])
    # Every write list is filled, and the insert carries a confluence partner (D, 60 s before).
    assert plan.inserts == (alerts[QQQ_P],)
    assert plan.inserts[0].confluence_tickers == ("SPY",)
    assert plan.removes and plan.flag_updates and plan.spot_updates

    stored = json.loads(json.dumps(plan.to_json()))

    assert DayPlan.from_json(stored) == plan
    # The sha256 covers each of the four write lists: a changed list is refused.
    for name, other in [
        ("inserts", []),
        ("removes", [203]),
        ("flag_updates", [[101, True, True]]),
        ("spot_updates", [[103, "6701.26"]]),
    ]:
        with pytest.raises(ValueError, match="sha256"):
            DayPlan.from_json({**stored, name: other})

    # An insert with no spot to take crosses too.
    bare = _write_tape(
        tmp_path, [_tick(_at("14:31:00"), SPXW_C, "30.00", 100, spot=None)], layout="tz"
    )
    no_spot = _heal(_FakeConn([]), con, bare, [default_settings()])
    assert no_spot.inserts[0].underlying_price is None

    assert DayPlan.from_json(json.loads(json.dumps(no_spot.to_json()))) == no_spot


# --- The readers --------------------------------------------------------------------------------


def test_read_live_rows_reads_the_days_rows_of_both_sources(tmp_path, con):
    tape = _day_tape(tmp_path)
    _, rows = _scenario(con, tape)
    db = _FakeConn(rows)

    assert read_live_rows(db, DAY) == rows
    (select,) = db.statements
    columns = ", ".join(f.name for f in fields(LiveRow))
    assert select.sql.startswith(f"SELECT {columns} FROM interval_ba_alerts WHERE expiry = ")
    assert "source" not in select.sql.split("WHERE", 1)[1]
    assert select.params == {"day": DAY}


@pytest.mark.parametrize(
    ("day", "start", "end"),
    [
        (
            date(2026, 11, 17),
            datetime(2026, 11, 17, 6, tzinfo=UTC),
            datetime(2026, 11, 18, 6, tzinfo=UTC),
        ),
        # CDT begins at 02:00 on 03-08: a 23-hour day.
        (
            date(2026, 3, 8),
            datetime(2026, 3, 8, 6, tzinfo=UTC),
            datetime(2026, 3, 9, 5, tzinfo=UTC),
        ),
        # CST returns at 02:00 on 11-01: a 25-hour day.
        (
            date(2026, 11, 1),
            datetime(2026, 11, 1, 5, tzinfo=UTC),
            datetime(2026, 11, 2, 6, tzinfo=UTC),
        ),
    ],
)
def test_read_covering_settings_bounds_the_ct_day_across_dst(day, start, end):
    row = replace(default_settings(), booted_at=start - timedelta(hours=3))
    db = _FakeConn([], [_settings_row(row)])

    settings = read_covering_settings(db, day)

    (select,) = db.statements
    assert select.params == {"start": start, "end": end}
    # The latest row before 00:00 CT, then every row of the day.
    assert "max(booted_at)" in select.sql
    assert "booted_at < %(start)s" in select.sql
    assert "booted_at < %(end)s" in select.sql
    assert select.sql.rstrip().endswith("ORDER BY booted_at")
    assert settings == [row]
    assert type(settings[0].tickers) is tuple
    assert type(settings[0].multi_leg_codes) is frozenset


def test_read_covering_settings_is_empty_before_the_first_row():
    assert read_covering_settings(_FakeConn([], []), DAY) == []


def test_default_settings_are_the_tape_rule_with_every_ticker_on():
    settings = default_settings()

    assert settings == LiveSettings(
        booted_at=None,
        enabled=True,
        tickers=("QQQ", "SPXW", "SPY"),
        ratio_threshold=Decimal("0.75"),
        premium_floor=Decimal("250000"),
        window_sec=300,
        multi_leg_share_max=Decimal("0.5"),
        multi_leg_codes=MULTI_LEG_CODES,
        confluence_window_sec=90,
    )
