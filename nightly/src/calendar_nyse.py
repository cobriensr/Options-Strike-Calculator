"""NYSE trading calendar for the nightly tape job.

The holiday table and trading-day logic are adapted from Unusual Whales'
``uw-options-data-lake`` skill, https://unusualwhales.com/skills/uw-options-data-lake-skill.md,
fetched 2026-10-28, sha256 a99ecce6361a295d7ded72e804e9ec77e4fbec94cdace1c0b24c02551596f8bb.
No license is stated; vendored by owner decision 2026-10-28.

The holiday set is a hand-maintained TABLE, not a computation, so it is checkable
against the NYSE page in a couple of minutes and can carry ad-hoc closures.
Time-zone math is delegated to zoneinfo/tzdata, never hand-rolled.

Source: https://www.nyse.com/markets/hours-calendars, transcribed 2026-07-15.
Each row is MM-DD in date order. A Saturday New Year's drops the January entry
(the NYSE does not close the preceding Friday); ad-hoc closures appear inline.
Running past the last year is a loud failure by design: a guessed holiday is
indistinguishable from a real one at the call site and would silently request a
closed day. Add the next year from the NYSE page each year.
"""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")

# A day's tape is complete once the ~20:00 ET daily boundary has passed.
TAPE_AVAILABLE_HOUR_ET = 20

_MARKET_HOLIDAYS: dict[int, str] = {
    2025: "01-01 01-09 01-20 02-17 04-18 05-26 06-19 07-04 09-01 11-27 12-25",
    2026: "01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25",
    2027: "01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24",
    2028: "01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25",
}

MARKET_HOLIDAYS: dict[int, frozenset[date]] = {
    y: frozenset(date(y, int(md[:2]), int(md[3:])) for md in mds.split())
    for y, mds in _MARKET_HOLIDAYS.items()
}

TABLE_FIRST_YEAR = min(MARKET_HOLIDAYS)
TABLE_LAST_YEAR = max(MARKET_HOLIDAYS)


class CalendarExhausted(Exception):  # noqa: N818 - name fixed by the task interface
    """The date falls outside the years the holiday table covers."""


def _market_holidays(year: int) -> frozenset[date]:
    try:
        return MARKET_HOLIDAYS[year]
    except KeyError:
        raise CalendarExhausted(
            f"the NYSE holiday table does not cover {year}; it runs "
            f"{TABLE_FIRST_YEAR}-{TABLE_LAST_YEAR}. Refusing to guess, because a missing "
            "holiday silently requests a closed day that returns no tape. Add the year to "
            "_MARKET_HOLIDAYS from https://www.nyse.com/markets/hours-calendars."
        ) from None


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in _market_holidays(d.year)


def previous_trading_day(d: date) -> date:
    """The latest trading day on or before ``d``."""
    for _ in range(15):
        if is_trading_day(d):
            return d
        d -= timedelta(days=1)
    raise ValueError(f"no trading day found on or before {d}")


def trading_days(start: date, end: date) -> list[date]:
    """Every NYSE trading day in [start, end] inclusive, ascending."""
    days: list[date] = []
    d = start
    while d <= end:
        if is_trading_day(d):
            days.append(d)
        d += timedelta(days=1)
    return days


def last_completed_session(now_utc: datetime) -> date:
    """The latest trading day whose 20:00 America/New_York has already passed."""
    if now_utc.tzinfo is None:
        raise ValueError("now_utc must be timezone-aware")
    now_et = now_utc.astimezone(EASTERN)
    d = now_et.date()
    if not (is_trading_day(d) and now_et.hour >= TAPE_AVAILABLE_HOUR_ET):
        d -= timedelta(days=1)
    return previous_trading_day(d)


def table_expiry_warning(today: date) -> str | None:
    """A warning string from Oct 1 of the table's last year onward, else None."""
    if today < date(TABLE_LAST_YEAR, 10, 1):
        return None
    return (
        f"NYSE holiday table ends in {TABLE_LAST_YEAR}; add {TABLE_LAST_YEAR + 1} from "
        "https://www.nyse.com/markets/hours-calendars before the new year or the "
        "nightly job will refuse to run."
    )
