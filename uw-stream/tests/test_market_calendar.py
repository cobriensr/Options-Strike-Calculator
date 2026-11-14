"""Tests for market_calendar: the trade window the all-copies-silent alert runs in (Task 7).

``in_trade_window`` says when option trades must be flowing: a trading day, from
09:31 ET up to one minute before the close (16:00 ET, 13:00 on an early-close
day). The holiday data is a copy of ``src/data/marketHours.ts``, and the parity
test below reads that file, so an edit to one calendar without the other fails here.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

import market_calendar
from market_calendar import EARLY_CLOSE_DATES, MARKET_CLOSED_DATES, in_trade_window

_ET = ZoneInfo("America/New_York")
# uw-stream/tests/test_market_calendar.py -> the repo root is two levels up.
_MARKET_HOURS_TS = Path(__file__).resolve().parents[2] / "src" / "data" / "marketHours.ts"


def _et(year: int, month: int, day: int, hour: int, minute: int, second: int = 0) -> datetime:
    """An Eastern wall-clock time, as the UTC instant the caller passes in."""
    return datetime(year, month, day, hour, minute, second, tzinfo=_ET).astimezone(UTC)


# --- the window ------------------------------------------------------------------


class TestOrdinaryDay:
    """Friday 2026-11-13: a full trading day, closing at 16:00 ET."""

    @pytest.mark.parametrize(
        ("hour", "minute", "second", "expected"),
        [
            (9, 30, 59, False),  # the minute after the open lets trading start
            (9, 31, 0, True),
            (12, 0, 0, True),
            (15, 58, 59, True),
            (15, 59, 0, False),  # the minute before the close is left out
            (16, 0, 0, False),
            (16, 10, 0, False),
            (3, 0, 0, False),
        ],
    )
    def test_the_window_edges(self, hour, minute, second, expected):
        assert in_trade_window(_et(2026, 11, 13, hour, minute, second)) is expected


class TestEarlyCloseDay:
    """Friday 2026-11-27, the day after Thanksgiving: the close is 13:00 ET."""

    @pytest.mark.parametrize(
        ("hour", "minute", "second", "expected"),
        [
            (9, 30, 59, False),
            (9, 31, 0, True),
            (12, 58, 59, True),
            (12, 59, 0, False),
            (13, 0, 0, False),
            (15, 0, 0, False),  # an ordinary day's afternoon is outside on a half day
        ],
    )
    def test_the_window_closes_an_hour_before_one_pm(self, hour, minute, second, expected):
        assert in_trade_window(_et(2026, 11, 27, hour, minute, second)) is expected


class TestNoTradingDay:
    def test_a_holiday_is_outside_the_window(self):
        assert in_trade_window(_et(2026, 11, 26, 10, 0)) is False  # Thanksgiving

    def test_an_observed_holiday_on_a_weekday_is_outside_the_window(self):
        # July 4, 2026 is a Saturday; the closure falls on Friday the 3rd.
        assert in_trade_window(_et(2026, 7, 3, 10, 0)) is False

    @pytest.mark.parametrize("day", [14, 15])  # Saturday, Sunday
    def test_a_weekend_is_outside_the_window(self, day):
        assert in_trade_window(_et(2026, 11, day, 10, 0)) is False

    def test_a_date_in_both_lists_counts_as_closed(self, monkeypatch):
        # As ``isHalfDay`` treats it in TS: a holiday, never a half day.
        monkeypatch.setattr(
            market_calendar, "EARLY_CLOSE_DATES", {**EARLY_CLOSE_DATES, "2026-11-26": 13}
        )

        assert "2026-11-26" in MARKET_CLOSED_DATES
        assert in_trade_window(_et(2026, 11, 26, 10, 0)) is False


class TestDaylightSaving:
    """The offset is Eastern's for that date, so the same wall-clock edge is a different UTC instant."""

    @pytest.mark.parametrize(
        ("utc", "expected"),
        [
            # 2026-03-09, the Monday after the spring-forward: EDT, UTC-4.
            (datetime(2026, 3, 9, 13, 30, 59, tzinfo=UTC), False),
            (datetime(2026, 3, 9, 13, 31, 0, tzinfo=UTC), True),
            (datetime(2026, 3, 9, 19, 58, 59, tzinfo=UTC), True),
            (datetime(2026, 3, 9, 19, 59, 0, tzinfo=UTC), False),
            # 2026-11-02, the Monday after the fall-back: EST, UTC-5.
            (datetime(2026, 11, 2, 14, 30, 59, tzinfo=UTC), False),
            (datetime(2026, 11, 2, 14, 31, 0, tzinfo=UTC), True),
            (datetime(2026, 11, 2, 20, 58, 59, tzinfo=UTC), True),
            (datetime(2026, 11, 2, 20, 59, 0, tzinfo=UTC), False),
        ],
    )
    def test_the_edges_follow_the_offset_in_force(self, utc, expected):
        assert in_trade_window(utc) is expected


# --- the data ----------------------------------------------------------------------


class TestTheData:
    def test_every_date_is_a_real_iso_date(self):
        for text in [*MARKET_CLOSED_DATES, *EARLY_CLOSE_DATES]:
            assert date.fromisoformat(text).isoformat() == text

    def test_the_collections_are_the_shapes_the_spec_names(self):
        assert isinstance(MARKET_CLOSED_DATES, frozenset)
        assert all(isinstance(hour, int) for hour in EARLY_CLOSE_DATES.values())

    def test_an_early_close_is_a_weekday_that_is_not_also_a_closure(self):
        for text in EARLY_CLOSE_DATES:
            assert date.fromisoformat(text).weekday() < 5, text
            assert text not in MARKET_CLOSED_DATES, text


# --- parity with src/data/marketHours.ts ---------------------------------------------

_DATE = r"(\d{4}-\d{2}-\d{2})"


def _block(source: str, name: str, constructor: str) -> str:
    """The text between ``new Map([`` / ``new Set([`` and its closing ``]);`` for ``export const name``.

    The closing bracket is the first one at the start of a line, so the ``],`` that
    ends each Map entry does not stop it.
    """
    match = re.search(
        rf"export const {name}\b[^=]*=\s*new {constructor}\(\[(.*?)^\]\);",
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match, f"{name} not found in marketHours.ts: the parity extraction needs updating"
    # Comments name dates too ("2027-12-31") and contain apostrophes ("New Year's").
    return re.sub(r"//[^\n]*", "", match.group(1))


def ts_closed_dates(source: str) -> frozenset[str]:
    return frozenset(
        re.findall(rf"['\"]{_DATE}['\"]", _block(source, "MARKET_CLOSED_DATES", "Set"))
    )


def ts_early_close_dates(source: str) -> dict[str, int]:
    pairs = re.findall(
        rf"\[\s*['\"]{_DATE}['\"]\s*,\s*(\d+)\s*\]", _block(source, "EARLY_CLOSE_DATES", "Map")
    )
    return {day: int(hour) for day, hour in pairs}


def read_typescript_calendar(path: Path) -> str:
    """The calendar's source. A missing file fails the test: drift must not hide behind a skip."""
    assert path.is_file(), (
        f"{path} is missing: the parity test must read the TypeScript calendar "
        "(the uw-stream CI job checks out the whole repo)"
    )
    return path.read_text(encoding="utf-8")


class TestParityWithTheTypeScriptCalendar:
    """Fails, rather than skips, when the TypeScript file is missing or the two differ."""

    def test_the_closed_dates_equal_the_typescript_set(self):
        extracted = ts_closed_dates(read_typescript_calendar(_MARKET_HOURS_TS))

        assert len(extracted) > 20, "the extraction found too few dates; update the regex"
        assert extracted == MARKET_CLOSED_DATES, (
            f"only in TS: {sorted(extracted - MARKET_CLOSED_DATES)}; "
            f"only in Python: {sorted(MARKET_CLOSED_DATES - extracted)}"
        )

    def test_the_early_close_dates_equal_the_typescript_map(self):
        extracted = ts_early_close_dates(read_typescript_calendar(_MARKET_HOURS_TS))

        assert len(extracted) > 3, "the extraction found too few dates; update the regex"
        assert extracted == dict(EARLY_CLOSE_DATES)

    def test_a_missing_file_fails_the_test_instead_of_skipping_it(self):
        with pytest.raises(AssertionError, match="is missing"):
            read_typescript_calendar(_MARKET_HOURS_TS.with_name("nope.ts"))


class TestTheExtraction:
    """The extraction ignores what is not data: comments with dates and apostrophes."""

    _SOURCE = """
export const EARLY_CLOSE_DATES: ReadonlyMap<string, number> = new Map([
  // 2025
  ['2025-07-03', 13], // Day before July 4th (Thursday)
  // NOTE: 2026-07-03 is NOT a half-day. It's a closure.
  // ['2026-07-03', 13], was here before it became a closure
  ["2026-11-27", 12], // Black Friday
]);

export const MARKET_CLOSED_DATES: ReadonlySet<string> = new Set([
  '2026-01-01', // New Year's Day
  // 2027: NYSE does not observe 2028-01-01 on 2027-12-31.
  // '2026-07-04', // taken out
  '2027-01-01',
]);
"""

    def test_the_map_yields_its_entries_only(self):
        assert ts_early_close_dates(self._SOURCE) == {"2025-07-03": 13, "2026-11-27": 12}

    def test_the_set_yields_its_entries_only(self):
        assert ts_closed_dates(self._SOURCE) == {"2026-01-01", "2027-01-01"}

    def test_a_collection_that_is_not_there_fails_loudly(self):
        with pytest.raises(AssertionError, match="EARLY_CLOSE_DATES not found"):
            ts_early_close_dates("export const SOMETHING_ELSE = new Set([]);")
