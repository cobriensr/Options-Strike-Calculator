"""Tests for session_calendar.cme_session_date.

Uses known UTC instants and asserts the CME trade-date mapping. CT is
UTC-5 in summer DST and UTC-6 in winter, so each instant below is chosen
so its Chicago wall-clock time is the value named in the test. The
summer/winter pair verifies zoneinfo handling rather than a fixed offset.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from session_calendar import cme_session_date  # noqa: E402


def _ns(year: int, month: int, day: int, hour: int, minute: int) -> int:
    """Nanoseconds since epoch for a UTC wall-clock instant."""
    dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    return int(dt.timestamp() * 1e9)


def test_weekday_morning_maps_to_same_date() -> None:
    # 2024-07-15 09:00 CT (summer, UTC-5) == 14:00 UTC.
    assert cme_session_date(_ns(2024, 7, 15, 14, 0)) == date(2024, 7, 15)


def test_1659_ct_maps_to_same_date() -> None:
    # 16:59 CT is still before the 17:00 roll -> same calendar date.
    assert cme_session_date(_ns(2024, 7, 15, 21, 59)) == date(2024, 7, 15)


def test_1700_ct_rolls_to_next_date() -> None:
    # 17:00 CT exactly is the boundary -> NEXT calendar date's session.
    assert cme_session_date(_ns(2024, 7, 15, 22, 0)) == date(2024, 7, 16)


def test_sunday_evening_maps_to_monday() -> None:
    # 2024-07-14 is a Sunday; 18:00 CT (>= 17:00) -> Monday 2024-07-15.
    assert cme_session_date(_ns(2024, 7, 14, 23, 0)) == date(2024, 7, 15)


def test_dst_summer_instant_maps_correctly() -> None:
    # Summer (UTC-5): 16:59 CT same-day, 17:00 CT next-day. Verifies the
    # roll lands on the correct wall-clock hour under DST, not UTC.
    assert cme_session_date(_ns(2024, 7, 15, 21, 59)) == date(2024, 7, 15)
    assert cme_session_date(_ns(2024, 7, 15, 22, 0)) == date(2024, 7, 16)


def test_dst_winter_instant_maps_correctly() -> None:
    # Winter (UTC-6): the same wall-clock CT times shift by one UTC hour.
    # 16:59 CT == 22:59 UTC same-day; 17:00 CT == 23:00 UTC next-day.
    assert cme_session_date(_ns(2024, 1, 15, 22, 59)) == date(2024, 1, 15)
    assert cme_session_date(_ns(2024, 1, 15, 23, 0)) == date(2024, 1, 16)
