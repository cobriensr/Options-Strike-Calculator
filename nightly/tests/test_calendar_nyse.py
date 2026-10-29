"""Tests for the vendored NYSE calendar, including checks ported from UW's selftest."""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import pytest

import calendar_nyse
from calendar_nyse import (
    TABLE_LAST_YEAR,
    CalendarExhausted,
    is_trading_day,
    last_completed_session,
    previous_trading_day,
    table_expiry_warning,
    trading_days,
)

EASTERN = ZoneInfo("America/New_York")


def test_2026_holidays():
    for md in [
        (1, 1),
        (1, 19),
        (2, 16),
        (4, 3),
        (5, 25),
        (6, 19),
        (7, 3),
        (9, 7),
        (11, 26),
        (12, 25),
    ]:
        assert not is_trading_day(date(2026, *md)), md
    assert is_trading_day(date(2026, 11, 27))
    assert is_trading_day(date(2026, 12, 24))


def test_trading_days_skips_weekends_and_holidays():
    assert trading_days(date(2026, 7, 1), date(2026, 7, 7)) == [
        date(2026, 7, 1),
        date(2026, 7, 2),
        date(2026, 7, 6),
        date(2026, 7, 7),
    ]


@pytest.mark.parametrize(
    ("now_utc", "expected"),
    [
        (datetime(2026, 10, 30, 7, 15, tzinfo=UTC), date(2026, 10, 29)),  # EDT
        (datetime(2026, 11, 3, 7, 15, tzinfo=UTC), date(2026, 11, 2)),  # EST
        (datetime(2026, 11, 2, 7, 15, tzinfo=UTC), date(2026, 10, 30)),  # Monday
        (datetime(2026, 11, 27, 7, 15, tzinfo=UTC), date(2026, 11, 25)),  # after Thanksgiving
        # Near the 20:00 ET boundary, where a fixed -4 or -5 offset gives a different date.
        (datetime(2026, 10, 30, 23, 30, tzinfo=UTC), date(2026, 10, 29)),  # 19:30 EDT
        (datetime(2026, 10, 31, 0, 30, tzinfo=UTC), date(2026, 10, 30)),  # 20:30 EDT
        (datetime(2026, 11, 3, 0, 30, tzinfo=UTC), date(2026, 10, 30)),  # 19:30 EST Mon 11-02
        (datetime(2026, 11, 3, 1, 30, tzinfo=UTC), date(2026, 11, 2)),  # 20:30 EST
    ],
)
def test_last_completed_session_across_dst(now_utc, expected):
    assert last_completed_session(now_utc) == expected


def test_last_completed_session_20_et_boundary():
    before = datetime(2026, 7, 31, 19, 0, tzinfo=EASTERN)
    after = datetime(2026, 7, 31, 20, 30, tzinfo=EASTERN)
    sunday = datetime(2026, 8, 2, 21, 0, tzinfo=EASTERN)
    assert last_completed_session(before.astimezone(UTC)) == date(2026, 7, 30)
    assert last_completed_session(after.astimezone(UTC)) == date(2026, 7, 31)
    assert last_completed_session(sunday.astimezone(UTC)) == date(2026, 7, 31)


def test_last_completed_session_rejects_naive_datetime():
    with pytest.raises(ValueError):
        last_completed_session(datetime(2026, 7, 31, 12, 0))


def test_past_table_raises():
    with pytest.raises(CalendarExhausted):
        is_trading_day(date(TABLE_LAST_YEAR + 1, 1, 5))


def test_before_table_raises():
    with pytest.raises(CalendarExhausted):
        is_trading_day(date(2024, 6, 3))


def test_expiry_warning_window():
    assert table_expiry_warning(date(TABLE_LAST_YEAR, 9, 30)) is None
    warning = table_expiry_warning(date(TABLE_LAST_YEAR, 10, 1))
    assert isinstance(warning, str)
    assert str(TABLE_LAST_YEAR) in warning
    assert table_expiry_warning(date(TABLE_LAST_YEAR + 1, 1, 2)) is not None


def test_table_shape():
    years = sorted(calendar_nyse.MARKET_HOLIDAYS)
    assert years == list(range(years[0], years[-1] + 1))
    assert years[-1] == TABLE_LAST_YEAR
    for y in years:
        hs = calendar_nyse.MARKET_HOLIDAYS[y]
        assert all(d.weekday() < 5 for d in hs), y
        assert all(d.year == y for d in hs), y
        assert 9 <= len(hs) <= 11, y


def test_observed_and_adhoc_closures():
    assert not is_trading_day(date(2026, 7, 3))
    assert not is_trading_day(date(2025, 1, 9))


def test_weekend_holiday_and_weekday():
    assert not is_trading_day(date(2026, 7, 4))
    assert is_trading_day(date(2026, 7, 31))
    assert not is_trading_day(date(2026, 12, 25))


def test_trading_week_and_ranges():
    assert len(trading_days(date(2026, 7, 27), date(2026, 7, 31))) == 5
    span = trading_days(date(2026, 7, 1), date(2026, 7, 10))
    assert not {date(2026, 7, 3), date(2026, 7, 4), date(2026, 7, 5)} & set(span)
    assert trading_days(date(2026, 7, 31), date(2026, 7, 1)) == []


def test_previous_trading_day():
    assert previous_trading_day(date(2026, 7, 31)) == date(2026, 7, 31)
    assert previous_trading_day(date(2026, 8, 2)) == date(2026, 7, 31)
    assert previous_trading_day(date(2026, 7, 4)) == date(2026, 7, 2)


@pytest.mark.parametrize(
    ("session", "prior"),
    [(date(2026, 7, 31), date(2026, 7, 30)), (date(2026, 11, 2), date(2026, 10, 30))],  # EDT, EST
)
def test_cutoff_is_inclusive_at_exactly_20_et(session, prior):
    at = datetime(session.year, session.month, session.day, 20, 0, 0, tzinfo=EASTERN)
    just_before = datetime(session.year, session.month, session.day, 19, 59, 59, tzinfo=EASTERN)
    assert last_completed_session(at.astimezone(UTC)) == session
    assert last_completed_session(just_before.astimezone(UTC)) == prior
