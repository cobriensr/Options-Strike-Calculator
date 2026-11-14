"""The window in which option trades must be flowing (pipeline diagnostics, Task 7).

``stuck_sockets`` alerts when every copy of a trade feed has gone silent. That is
only an alarm inside the hours when trades arrive, so it asks ``in_trade_window``.

The window is a trading day (Monday to Friday, not a NYSE closure), from 09:31 ET
up to, but not including, one minute before the close. The close is 16:00 ET, or
13:00 ET on an early-close day. Both margins are deliberate: the minute after the
open lets trading start, and the minute before the close stays clear of the equity
options' 16:00 close, after which the shard that carries them has no trades.

The two collections are a copy of ``src/data/marketHours.ts`` (the daemon has no
other calendar and no way to read the TypeScript at runtime).
``tests/test_market_calendar.py`` reads that file and fails when the copies
differ, so an edit to one has to go to the other. A holiday that is in neither
list reads as a trading day, and the alert would fire once for it: the TS file's
own test forces a yearly update, and the parity test carries it here.

Pure: no I/O, no state. A date in both lists counts as closed, as ``isHalfDay``
treats it in TypeScript.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, time, timedelta
from types import MappingProxyType
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

# Trades are expected from this ET time on, one minute after the open.
_WINDOW_OPEN_ET = time(9, 31)
# The window ends this long before the close.
_CLOSE_MARGIN = timedelta(minutes=1)
_FULL_DAY_CLOSE_HOUR_ET = 16

# NYSE full-day closures, as ISO dates. Copied from MARKET_CLOSED_DATES in
# src/data/marketHours.ts.
MARKET_CLOSED_DATES: frozenset[str] = frozenset(
    {
        # 2025
        "2025-04-18",  # Good Friday
        "2025-05-26",  # Memorial Day
        "2025-06-19",  # Juneteenth
        "2025-07-04",  # Independence Day
        "2025-09-01",  # Labor Day
        "2025-11-27",  # Thanksgiving
        "2025-12-25",  # Christmas
        # 2026
        "2026-01-01",  # New Year's Day
        "2026-01-19",  # MLK Day
        "2026-02-16",  # Presidents Day
        "2026-04-03",  # Good Friday
        "2026-05-25",  # Memorial Day
        "2026-06-19",  # Juneteenth
        "2026-07-03",  # Independence Day (observed)
        "2026-09-07",  # Labor Day
        "2026-11-26",  # Thanksgiving
        "2026-12-25",  # Christmas
        # 2027
        "2027-01-01",  # New Year's Day
        "2027-01-18",  # MLK Day
        "2027-02-15",  # Washington's Birthday
        "2027-03-26",  # Good Friday
        "2027-05-31",  # Memorial Day
        "2027-06-18",  # Juneteenth (observed)
        "2027-07-05",  # Independence Day (observed)
        "2027-09-06",  # Labor Day
        "2027-11-25",  # Thanksgiving
        "2027-12-24",  # Christmas (observed)
        # 2028
        "2028-01-17",  # MLK Day
        "2028-02-21",  # Washington's Birthday
        "2028-04-14",  # Good Friday
        "2028-05-29",  # Memorial Day
        "2028-06-19",  # Juneteenth
        "2028-07-04",  # Independence Day
        "2028-09-04",  # Labor Day
        "2028-11-23",  # Thanksgiving
        "2028-12-25",  # Christmas
    }
)

# NYSE early-close days: ISO date -> close hour in ET (24 h). Copied from
# EARLY_CLOSE_DATES in src/data/marketHours.ts.
EARLY_CLOSE_DATES: Mapping[str, int] = MappingProxyType(
    {
        "2025-07-03": 13,  # Day before July 4th
        "2025-11-28": 13,  # Black Friday
        "2025-12-24": 13,  # Christmas Eve
        "2026-11-27": 13,  # Black Friday
        "2026-12-24": 13,  # Christmas Eve
        "2027-11-26": 13,  # Black Friday
        "2028-07-03": 13,  # Day before Independence Day
        "2028-11-24": 13,  # Black Friday
    }
)


def in_trade_window(now_utc: datetime) -> bool:
    """Whether ``now_utc`` (a UTC-aware instant) is inside the trade window.

    True on a trading day from 09:31 ET up to, not including, one minute before the
    close (15:59 ET, or 12:59 ET on an early-close day). The Eastern offset is the
    one in force on that date, so daylight saving needs no handling here.
    """
    et = now_utc.astimezone(_ET)
    day = et.date().isoformat()
    if et.weekday() >= 5 or day in MARKET_CLOSED_DATES:
        return False
    close_hour = EARLY_CLOSE_DATES.get(day, _FULL_DAY_CLOSE_HOUR_ET)
    close = et.replace(hour=close_hour, minute=0, second=0, microsecond=0)
    return et.time() >= _WINDOW_OPEN_ET and et < close - _CLOSE_MARGIN
