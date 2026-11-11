"""Tests for scripts/strike_exposures_backup.py (day reader and Parquet writer).

Run:

    ml/.venv/Scripts/pytest scripts/test_strike_exposures_backup.py -q

No test reaches a database. The connection and cursor are fakes that hold a
list of rows and serve count and keyset pages from it, reading the same
parameters the module sends, so a page query that forgets its key or its LIMIT
shows up as wrong data and not just as a wrong string.
"""

from __future__ import annotations

import hashlib
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import strike_exposures_backup as sbk  # noqa: E402

DAY = date(2026, 11, 2)
UTC = timezone.utc
KEY_NAMES = ("timestamp", "ticker", "strike", "expiry")
GREEKS = (
    "call_gamma_oi",
    "put_gamma_oi",
    "call_gamma_ask",
    "call_gamma_bid",
    "put_gamma_ask",
    "put_gamma_bid",
    "call_charm_oi",
    "put_charm_oi",
    "call_charm_ask",
    "call_charm_bid",
    "put_charm_ask",
    "put_charm_bid",
    "call_delta_oi",
    "put_delta_oi",
    "call_vanna_oi",
    "put_vanna_oi",
)
PAGE_SQL_TAIL = 'ORDER BY date, "timestamp", ticker, strike, expiry LIMIT %s'


def make_row(**overrides) -> tuple:
    """One table row in COLUMNS order, with the values psycopg2 returns."""
    row = {
        "id": 1,
        "date": DAY,
        "timestamp": datetime(2026, 11, 2, 15, 0, tzinfo=UTC),
        "ticker": "SPX",
        "expiry": date(2026, 11, 2),
        "strike": Decimal("5500.00"),
        "price": Decimal("5512.25"),
        **{name: Decimal("1.5000") for name in GREEKS},
        "created_at": datetime(2026, 11, 2, 22, 30, 54, 123456, tzinfo=UTC),
    }
    unknown = set(overrides) - set(row)
    assert not unknown, unknown
    row.update(overrides)
    return tuple(row[name] for name in sbk.COLUMNS)


def key_of(row: tuple) -> tuple:
    return tuple(row[sbk.COLUMNS.index(name)] for name in KEY_NAMES)


def plain_rows(n: int) -> list[tuple]:
    """n ordinary rows with distinct timestamps and ids that do not follow key order."""
    start = datetime(2026, 11, 2, 15, 0, tzinfo=UTC)
    return [
        make_row(id=100 - i, timestamp=start + timedelta(minutes=i)) for i in range(n)
    ]


class FakeCursor:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn
        self._result: list[tuple] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def execute(self, sql: str, params: tuple | None = None) -> None:
        text = " ".join(sql.split())
        self.conn.statements.append((text, params))
        if text.startswith("SELECT count(*)"):
            self._result = [(self.conn.count,)]
        elif text.startswith("SELECT ") and "LIMIT %s" in text:
            self._result = self.conn.serve_page(params, keyed="> (%s" in text)
        else:
            self._result = []

    def fetchone(self) -> tuple:
        return self._result[0]

    def fetchall(self) -> list[tuple]:
        return self._result


class FakeConnection:
    """A psycopg2 connection over a list of rows.

    `count` is what the snapshot count query says; it defaults to the number
    of rows. `stuck` makes every page the first page again, as a keyset that
    never advances would, and gives up after 10 page queries so a missing
    guard fails instead of hanging.
    """

    def __init__(
        self, rows: list[tuple], count: int | None = None, stuck: bool = False
    ) -> None:
        self.rows = sorted(rows, key=key_of)
        self.count = len(rows) if count is None else count
        self.stuck = stuck
        self.autocommit = False
        self.statements: list[tuple[str, tuple | None]] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    @property
    def page_queries(self) -> list[tuple[str, tuple]]:
        return [(t, p) for t, p in self.statements if "LIMIT %s" in t]

    def serve_page(self, params: tuple, keyed: bool) -> list[tuple]:
        assert len(self.page_queries) <= 10, "paging did not stop"
        day, *after, limit = params
        if self.stuck:
            return self.rows[:limit]
        day_rows = [r for r in self.rows if r[sbk.COLUMNS.index("date")] == day]
        if keyed:
            day_rows = [r for r in day_rows if key_of(r) > tuple(after)]
        return day_rows[:limit]


def assert_same_cell(got: object, want: object) -> None:
    """Same Python type and value; a Decimal must also keep its exponent."""
    assert type(got) is type(want)
    if isinstance(want, Decimal):
        assert got.as_tuple() == want.as_tuple()
    else:
        assert got == want


def test_schema_matches_table_ddl() -> None:
    # Pinned by hand against migration #8, #17 (created_at NOT NULL) and #191
    # (greeks widened to NUMERIC(30,4)).
    want = {
        "id": ("int32", False),
        "date": ("date32[day]", False),
        "timestamp": ("timestamp[us, tz=UTC]", False),
        "ticker": ("string", False),
        "expiry": ("date32[day]", True),
        "strike": ("decimal128(10, 2)", False),
        "price": ("decimal128(10, 2)", True),
        **{name: ("decimal128(30, 4)", True) for name in GREEKS},
        "created_at": ("timestamp[us, tz=UTC]", False),
    }
    got = {f.name: (str(f.type), f.nullable) for f in sbk.ARROW_SCHEMA}
    assert got == want
    assert list(want) == list(sbk.COLUMNS)
    assert len(sbk.COLUMNS) == 24


def test_round_trip_exact_values(tmp_path: Path) -> None:
    rows = [
        # 01:30 EDT on the fall-back night, as a New York session returns it
        # (05:30Z), with every nullable column NULL and the all-expiry sentinel.
        make_row(
            id=1,
            timestamp=datetime(2026, 11, 1, 1, 30, tzinfo=timezone(timedelta(hours=-4))),
            expiry=date(1970, 1, 1),
            price=None,
            **{name: None for name in GREEKS},
        ),
        # The second 01:30 that night, on EST (06:30Z): a different instant.
        make_row(
            id=2,
            timestamp=datetime(2026, 11, 1, 1, 30, tzinfo=timezone(timedelta(hours=-5))),
            call_gamma_oi=Decimal("12345678901234567890123456.1234"),
            put_gamma_oi=Decimal("-0.0001"),
            call_charm_oi=Decimal("-12345678901234567890123456.1234"),
            put_charm_oi=Decimal("0.0000"),
        ),
        make_row(
            id=3,
            strike=Decimal("99999999.99"),
            price=Decimal("0.00"),
            created_at=datetime(2026, 11, 2, 22, 30, 54, 1, tzinfo=UTC),
        ),
        make_row(id=4, ticker="SPXW", put_delta_oi=None),
    ]
    conn = FakeConnection(rows)

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None
    want = sorted(rows, key=key_of)
    got = pq.read_table(result.path).to_pylist()
    assert len(got) == len(want)
    for got_row, want_row in zip(got, want):
        assert list(got_row) == list(sbk.COLUMNS)
        for name, value in zip(sbk.COLUMNS, want_row):
            assert_same_cell(got_row[name], value)
    assert pq.read_schema(result.path).equals(sbk.ARROW_SCHEMA)
    # One row group per page: 4 rows in pages of 2.
    assert pq.ParquetFile(result.path).metadata.num_row_groups == 2


def test_count_mismatch_raises_and_leaves_no_file(tmp_path: Path) -> None:
    conn = FakeConnection(plain_rows(2), count=3)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert str(raised.value) == "2026-11-02: row count mismatch (snapshot 3, wrote 2)"
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == "ROLLBACK"


def test_more_rows_than_the_count_raises_early(tmp_path: Path) -> None:
    # Pages that keep coming after the snapshot count is passed stop the
    # export at the page that passes it, before the rest is read.
    conn = FakeConnection(plain_rows(6), count=3)

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert str(raised.value) == "2026-11-02: row count mismatch (snapshot 3, wrote 4)"
    assert len(conn.page_queries) == 2
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == "ROLLBACK"


def test_paging_that_never_advances_is_stopped(tmp_path: Path) -> None:
    conn = FakeConnection(plain_rows(2), count=3, stuck=True)

    with pytest.raises(sbk.BackupError):
        sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert list(tmp_path.iterdir()) == []


def test_zero_row_day_returns_none(tmp_path: Path) -> None:
    conn = FakeConnection([])

    assert sbk.write_day_parquet(conn, DAY, tmp_path) is None

    assert list(tmp_path.iterdir()) == []
    assert conn.page_queries == []
    assert conn.statements[-1][0] == "ROLLBACK"


def test_unconvertible_cell_raises_without_the_value(tmp_path: Path) -> None:
    secret = "SECRET-CELL-VALUE"
    conn = FakeConnection([make_row(id=secret)])

    with pytest.raises(sbk.BackupError) as raised:
        sbk.write_day_parquet(conn, DAY, tmp_path)

    shown = "".join(traceback.format_exception(raised.value))
    assert secret not in str(raised.value)
    assert secret not in shown
    assert str(raised.value).startswith("2026-11-02:")
    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == "ROLLBACK"


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"id": 2**40}, id="id-overflows-int32"),
        pytest.param({"id": None}, id="null-in-not-null-column"),
        pytest.param({"put_vanna_oi": Decimal(10**26)}, id="decimal-too-wide"),
        pytest.param({"strike": 5500.0}, id="float-for-numeric"),
    ],
)
def test_cell_outside_the_schema_raises_backup_error(tmp_path: Path, bad: dict) -> None:
    conn = FakeConnection([make_row(**bad)])

    with pytest.raises(sbk.BackupError, match="did not fit the Parquet schema"):
        sbk.write_day_parquet(conn, DAY, tmp_path)

    assert list(tmp_path.iterdir()) == []
    assert conn.statements[-1][0] == "ROLLBACK"


def test_keyset_sql(tmp_path: Path) -> None:
    rows = plain_rows(5)
    conn = FakeConnection(rows)

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None and result.rows == 5
    assert conn.autocommit is True  # psycopg2 must not open its own transaction
    texts = [text for text, _ in conn.statements]
    assert texts[0] == "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert texts[1] == "SET LOCAL statement_timeout = '60s'"
    assert texts[2] == "SELECT count(*) FROM strike_exposures WHERE date = %s"
    assert conn.statements[2][1] == (DAY,)
    assert texts[-1] == "ROLLBACK"

    pages = conn.page_queries
    assert len(pages) == 3  # 2 + 2 + 1: the short page ends the day without a 4th query
    assert len(conn.statements) == 3 + len(pages) + 1
    for text, _ in pages:
        assert text.endswith(PAGE_SQL_TAIL)
        assert "OFFSET" not in text.upper()
    ordered = sorted(rows, key=key_of)
    first_text, first_params = pages[0]
    assert "> (" not in first_text
    assert first_params == (DAY, 2)
    key_clause = 'AND ("timestamp", ticker, strike, expiry) > (%s, %s, %s, %s)'
    for (text, params), previous_last in zip(pages[1:], (ordered[1], ordered[3])):
        assert key_clause in text
        assert params == (DAY, *key_of(previous_last), 2)


def test_dayfile_fields(tmp_path: Path) -> None:
    # Ids 100, 99, 98 in key order, in pages of 2: the max is on the first page
    # and the min on the second, so both bounds must span pages.
    conn = FakeConnection(plain_rows(3))

    result = sbk.write_day_parquet(conn, DAY, tmp_path, page_rows=2)

    assert result is not None
    assert result.day == DAY
    assert result.path == tmp_path / "2026-11-02.parquet"
    assert result.rows == 3
    assert (result.min_id, result.max_id) == (98, 100)
    assert result.size == result.path.stat().st_size
    assert result.sha256 == hashlib.sha256(result.path.read_bytes()).hexdigest()
