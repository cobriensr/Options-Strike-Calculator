"""Event-day calendars: monthly OPEX, FOMC, and the is_event_day OR.

OPEX (monthly options expiration) is the **third Friday** of every calendar
month. Computable deterministically from the date alone.

FOMC meeting dates are a published calendar the Fed releases annually. We
maintain a static frozenset for 2024 through 2026 — extend when the Fed
releases 2027 dates. A missed FOMC flag is safe (the day just doesn't get
tagged); a wrong flag is noisy, so prefer omission over invention.

These flags feed the backtest's `event_day_filter` param so the sweep can
test whether event days contribute to or detract from strategy edge.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

import pandas as pd

# FOMC meeting dates (Fed decision day — announcement is typically 13:00 CT).
# Source: federalreserve.gov/monetarypolicy/fomccalendars.htm, manually
# transcribed. Extend annually when the Fed publishes the next year's dates.
# Flag policy: include only the decision-day date itself. Day-before "start
# of meeting" is a media term, not a market event, and we don't tag it.
FOMC_DATES: frozenset[date] = frozenset(
    {
        # 2024
        date(2024, 1, 31),
        date(2024, 3, 20),
        date(2024, 5, 1),
        date(2024, 6, 12),
        date(2024, 7, 31),
        date(2024, 9, 18),
        date(2024, 11, 7),
        date(2024, 12, 18),
        # 2025
        date(2025, 1, 29),
        date(2025, 3, 19),
        date(2025, 5, 7),
        date(2025, 6, 18),
        date(2025, 7, 30),
        date(2025, 9, 17),
        date(2025, 10, 29),
        date(2025, 12, 17),
        # 2026
        date(2026, 1, 28),
        date(2026, 3, 18),
        date(2026, 5, 6),
        date(2026, 6, 17),
        date(2026, 7, 29),
        date(2026, 9, 16),
        date(2026, 10, 28),
        date(2026, 12, 9),
    }
)


def is_opex(d: date) -> bool:
    """True if `d` is the 3rd Friday of its month (monthly options expiry).

    Computed rather than tabulated: the 3rd Friday falls on dates 15 through
    21 of the month. A Friday with day-of-month in [15..21] is unambiguously
    the third Friday.
    """
    return d.weekday() == 4 and 15 <= d.day <= 21


def is_quarterly_opex(d: date) -> bool:
    """True if `d` is the 3rd Friday of March, June, September, or December.

    Quarterly OPEX is a meaningfully larger event than monthly — index futures
    and options on index futures both settle, which compounds pinning behavior.
    """
    return is_opex(d) and d.month in (3, 6, 9, 12)


def is_fomc(d: date) -> bool:
    """True if `d` is a published Fed FOMC decision day."""
    return d in FOMC_DATES


def is_event_day(d: date) -> bool:
    """OR of OPEX + FOMC. Expand this if more event types are added later."""
    return is_opex(d) or is_fomc(d)


def calendar_features(dates: Iterable[pd.Timestamp]) -> pd.DataFrame:
    """Produce a per-date DataFrame of calendar feature flags.

    Parameters
    ----------
    dates:
        Unique calendar dates (typically from `bar_df.ts_event.dt.date.unique()`).
        Must be UTC-aware Timestamps or plain date objects.

    Returns
    -------
    DataFrame with columns:
        day (date): the calendar date
        is_opex (bool): monthly OPEX flag
        is_quarterly_opex (bool): quarterly OPEX flag (stricter subset)
        is_fomc (bool): Fed decision day flag
        is_event_day (bool): OR of is_opex + is_fomc
    """
    rows: list[dict] = []
    for ts in dates:
        # Accept either pd.Timestamp or plain date
        d: date
        if isinstance(ts, pd.Timestamp):
            d = ts.date()
        elif isinstance(ts, date):
            d = ts
        else:
            raise TypeError(f"Unsupported date type: {type(ts)}")
        rows.append(
            {
                "day": d,
                "is_opex": is_opex(d),
                "is_quarterly_opex": is_quarterly_opex(d),
                "is_fomc": is_fomc(d),
                "is_event_day": is_event_day(d),
            }
        )
    return pd.DataFrame(rows)
