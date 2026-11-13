"""Tests for scripts/calendar_context_analysis.py.

The script tags each trade with the macro days around it, so its calendar must
hold every FOMC, CPI and NFP day. Unusual Whales renamed all three events in
2026, so the table holds two name eras:

- rate decision: "U.S. interest rate decision" from 2026-09-16 (FOMC days now
  come from the Fed schedule, not from these rows);
- CPI: "Consumer price index" until 2026-07-14, then "CPI", "CPI, Y/Y%" from
  2026-09-11;
- NFP: "U.S. employment report" until 2026-07-02, then "Employment Report"
  from 2026-10-02, next to ADP rows (event_type JOBS) that come out on other
  days.

The fake database is a DuckDB table behind a patched psycopg2.connect, so the
script's real SQL runs against rows from both eras.

Run from the repo root so scripts/conftest.py (the no-database guard) loads:

    ml/.venv/Scripts/python -m pytest scripts/test_calendar_context_analysis.py -q
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import duckdb
import psycopg2
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent
ML_SRC = SCRIPTS_DIR.parent / 'ml' / 'src'
sys.path.insert(0, str(SCRIPTS_DIR))
if str(ML_SRC) not in sys.path:
    sys.path.append(str(ML_SRC))

import calendar_context_analysis as cca  # noqa: E402
from options_features.calendar import FOMC_DATES  # noqa: E402

# (date, event_type, event_name): both name eras plus the rows that must not match.
EVENT_ROWS = [
    # FOMC rows. The schedule decides the FOMC days, not these rows, so the
    # Powell row on a day with no meeting must stay out of cal['fomc'].
    ('2026-09-16', 'OTHER', 'U.S. interest rate decision'),
    ('2026-10-28', 'FOMC', 'U.S. interest rate decision'),
    ('2026-08-05', 'FOMC', 'Powell press conference'),
    # CPI: old name, then the renamed rows (headline and core on one day).
    ('2026-06-10', 'CPI', 'Consumer price index'),
    ('2026-07-14', 'CPI', 'Consumer price index'),
    ('2026-09-11', 'CPI', 'CPI'),
    ('2026-10-14', 'CPI', 'CPI, Y/Y%'),
    ('2026-10-14', 'CPI', 'Core CPI, Y/Y%'),
    ('2026-10-15', 'PPI', 'PPI, Y/Y%'),
    # NFP: old name, new name, ADP on its own days (one of them is named
    # "employment report" too), a JOBS row that is not the report, and the
    # report's name under another event_type.
    ('2026-07-02', 'JOBS', 'U.S. employment report'),
    ('2026-10-02', 'JOBS', 'Employment Report'),
    ('2026-09-30', 'JOBS', 'ADP National Employment Report'),
    ('2026-10-01', 'JOBS', 'ADP employment change'),
    ('2026-10-08', 'JOBS', 'Initial jobless claims'),
    ('2026-10-22', 'OTHER', 'Employment Report'),
]

FAKE_URL = 'postgresql://fake-user:fake-pass@localhost:1/fake'


class _DuckCursor:
    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con
        self._rows: list[tuple] = []

    def execute(self, sql: str) -> None:
        # The script passes no parameters, so the SQL runs as written.
        self._rows = self._con.execute(sql).fetchall()

    def fetchall(self) -> list[tuple]:
        return self._rows


class _DuckConnection:
    """What psycopg2.connect returns, over an in-memory DuckDB table."""

    def __init__(self, rows: list[tuple], *, create_table: bool = True) -> None:
        self._con = duckdb.connect(':memory:')
        if create_table:
            self._con.execute(
                'CREATE TABLE economic_events '
                '(date DATE, event_type VARCHAR, event_name VARCHAR)'
            )
            if rows:
                self._con.executemany(
                    'INSERT INTO economic_events VALUES (?, ?, ?)', rows
                )
        self.closed = False

    def cursor(self) -> _DuckCursor:
        return _DuckCursor(self._con)

    def close(self) -> None:
        self.closed = True
        self._con.close()


@pytest.fixture
def db_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fake DATABASE_URL, and no read of the real .env.local."""
    monkeypatch.setattr(cca, 'load_env_file', lambda _path: None)
    monkeypatch.setenv('DATABASE_URL', FAKE_URL)


@pytest.fixture
def connections(
    db_env: None, monkeypatch: pytest.MonkeyPatch
) -> list[_DuckConnection]:
    """psycopg2.connect returns the fake over EVENT_ROWS; the list holds each one."""
    handed_out: list[_DuckConnection] = []

    def connect(url: str) -> _DuckConnection:
        assert url == FAKE_URL
        conn = _DuckConnection(EVENT_ROWS)
        handed_out.append(conn)
        return conn

    monkeypatch.setattr(psycopg2, 'connect', connect)
    return handed_out


# ----- load_calendar_events -----


def test_fomc_days_come_from_the_fed_schedule(connections) -> None:
    cal = cca.load_calendar_events()

    assert date(2026, 9, 16) in cal['fomc']
    assert date(2026, 10, 28) in cal['fomc']
    assert cal['fomc'] == set(FOMC_DATES)
    # A table row is not a meeting: Powell on a day the Fed did not meet.
    assert date(2026, 8, 5) not in cal['fomc']


def test_cpi_days_cover_both_name_eras(connections) -> None:
    cal = cca.load_calendar_events()

    assert cal['cpi'] == {
        date(2026, 6, 10),
        date(2026, 7, 14),
        date(2026, 9, 11),
        date(2026, 10, 14),
    }


def test_nfp_days_cover_both_name_eras_and_leave_out_adp(connections) -> None:
    cal = cca.load_calendar_events()

    assert cal['nfp'] == {date(2026, 7, 2), date(2026, 10, 2)}
    assert date(2026, 9, 30) not in cal['nfp']  # ADP National Employment Report
    assert date(2026, 10, 1) not in cal['nfp']  # ADP employment change
    assert date(2026, 10, 8) not in cal['nfp']  # jobless claims
    assert date(2026, 10, 22) not in cal['nfp']  # not a JOBS row


def test_no_hardcoded_fallback_dates_are_added(
    db_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An empty table gives empty CPI and NFP sets. The old fallback list put
    # March to May 2026 dates in them whatever the table held.
    monkeypatch.setattr(
        psycopg2, 'connect', lambda _url: _DuckConnection([])
    )

    cal = cca.load_calendar_events()

    assert cal['cpi'] == set()
    assert cal['nfp'] == set()


def test_connection_is_closed_after_the_queries(connections) -> None:
    cca.load_calendar_events()

    assert [c.closed for c in connections] == [True]


def test_connect_error_stops_the_script_with_the_cause(
    db_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(_url: str):
        raise psycopg2.OperationalError('connection refused')

    monkeypatch.setattr(psycopg2, 'connect', refuse)

    with pytest.raises(SystemExit) as stopped:
        cca.load_calendar_events()

    message = str(stopped.value.code)
    assert 'economic_events' in message
    assert 'connection refused' in message


def test_query_error_stops_the_script_and_closes_the_connection(
    db_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = _DuckConnection([], create_table=False)  # no economic_events table
    monkeypatch.setattr(psycopg2, 'connect', lambda _url: broken)

    with pytest.raises(SystemExit) as stopped:
        cca.load_calendar_events()

    assert 'economic_events' in str(stopped.value.code)
    assert broken.closed is True


def test_missing_database_url_stops_the_script_before_connecting(
    db_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv('DATABASE_URL')
    monkeypatch.delenv('DATABASE_URL_UNPOOLED', raising=False)
    attempts: list[str] = []
    monkeypatch.setattr(psycopg2, 'connect', attempts.append)

    with pytest.raises(SystemExit) as stopped:
        cca.load_calendar_events()

    assert 'DATABASE_URL' in str(stopped.value.code)
    assert attempts == []


def test_main_writes_no_findings_when_the_database_is_down(
    db_env: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    trades_csv = tmp_path / 'trades.csv'
    trades_csv.write_text('anchor_ts,trade_type\n2026-10-14T14:00:00Z,long_call_e1\n')
    findings = tmp_path / 'findings.md'
    monkeypatch.setattr(cca, 'TRADES_CSV', trades_csv)
    monkeypatch.setattr(cca, 'FINDINGS_MD', findings)
    monkeypatch.setattr(cca, 'TMP_DIR', tmp_path)

    def refuse(_url: str):
        raise psycopg2.OperationalError('connection refused')

    monkeypatch.setattr(psycopg2, 'connect', refuse)

    with pytest.raises(SystemExit):
        cca.main()

    assert not findings.exists()
    assert list(tmp_path.glob('*_tagged.csv')) == []


# ----- calendar primitives -----


@pytest.mark.parametrize(
    ('year', 'month', 'expected'),
    [
        (2024, 3, date(2024, 3, 15)),  # the 1st is a Friday
        (2026, 1, date(2026, 1, 16)),
        (2026, 2, date(2026, 2, 20)),  # the 1st is a Sunday
        (2026, 5, date(2026, 5, 15)),  # the 1st is a Friday
        (2026, 10, date(2026, 10, 16)),
        (2026, 12, date(2026, 12, 18)),
    ],
)
def test_third_friday_table(year: int, month: int, expected: date) -> None:
    assert cca.third_friday(year, month) == expected


def test_third_friday_is_a_friday_between_the_15th_and_the_21st() -> None:
    for year in range(2024, 2029):
        for month in range(1, 13):
            d = cca.third_friday(year, month)
            assert (d.year, d.month) == (year, month)
            assert d.weekday() == 4
            assert 15 <= d.day <= 21


def test_opex_dates_in_range_crosses_the_new_year() -> None:
    assert cca.opex_dates_in_range(date(2026, 11, 1), date(2027, 2, 28)) == [
        date(2026, 11, 20),
        date(2026, 12, 18),
        date(2027, 1, 15),
        date(2027, 2, 19),
    ]


def test_opex_dates_in_range_leaves_out_a_third_friday_outside_the_range() -> None:
    assert cca.opex_dates_in_range(date(2026, 10, 17), date(2026, 11, 19)) == []


@pytest.mark.parametrize(
    ('d', 'n', 'expected'),
    [
        (date(2026, 10, 30), 2, True),  # Oct 31 is a Saturday: Fri 30th is last
        (date(2026, 10, 29), 2, True),
        (date(2026, 10, 28), 2, False),
        (date(2026, 10, 31), 2, False),  # the Saturday itself
        (date(2026, 10, 30), 1, True),
        (date(2026, 10, 29), 1, False),
        (date(2026, 12, 31), 2, True),  # December: the next month is January
        (date(2026, 12, 30), 2, True),
        (date(2026, 12, 29), 2, False),
        (date(2026, 9, 30), 2, True),
    ],
)
def test_is_last_business_day_of_month(d: date, n: int, expected: bool) -> None:
    assert cca.is_last_business_day_of_month(d, n=n) is expected


# ----- tag_calendar -----

OPEX_SET = {date(2026, 10, 16), date(2026, 11, 20)}
CAL = {
    'fomc': {date(2026, 10, 28)},
    'cpi': {date(2026, 10, 14)},
    'nfp': {date(2026, 10, 2)},
}


def test_tag_calendar_on_opex_day() -> None:
    tags = cca.tag_calendar(date(2026, 10, 16), OPEX_SET, CAL)

    assert tags['days_to_opex'] == 0
    assert tags['is_opex_day'] is True
    assert tags['is_opex_week'] is True
    assert tags['is_fomc_day'] is False
    assert tags['is_cpi_day'] is False
    assert tags['is_nfp_day'] is False
    assert (tags['dom'], tags['dow']) == (16, 4)


def test_tag_calendar_on_a_cpi_day_in_opex_week() -> None:
    tags = cca.tag_calendar(date(2026, 10, 14), OPEX_SET, CAL)

    assert tags['is_cpi_day'] is True
    assert tags['is_opex_week'] is True  # Mon Oct 12 to Fri Oct 16
    assert tags['is_opex_day'] is False
    assert tags['days_to_opex'] == 2


def test_tag_calendar_on_an_fomc_day_outside_opex_week() -> None:
    tags = cca.tag_calendar(date(2026, 10, 28), OPEX_SET, CAL)

    assert tags['is_fomc_day'] is True
    assert tags['is_opex_week'] is False
    assert tags['days_to_opex'] == 23  # the next OPEX is Nov 20
    assert tags['is_eom'] is False


def test_tag_calendar_on_an_nfp_day() -> None:
    tags = cca.tag_calendar(date(2026, 10, 2), OPEX_SET, CAL)

    assert tags['is_nfp_day'] is True
    assert tags['days_to_opex'] == 14


def test_tag_calendar_marks_quarter_end_as_month_end_too() -> None:
    tags = cca.tag_calendar(date(2026, 9, 30), OPEX_SET, CAL)

    assert tags['is_eoq'] is True
    assert tags['is_eom'] is True


def test_tag_calendar_after_the_last_opex_has_no_days_to_opex() -> None:
    tags = cca.tag_calendar(date(2026, 11, 23), OPEX_SET, CAL)

    assert tags['days_to_opex'] is None
    assert tags['is_opex_week'] is False
