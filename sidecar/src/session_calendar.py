"""CME trade-date convention for ES/SPX session bucketing.

The Globex ES/SPX session runs from ~17:00 CT (T-1) to 16:00 CT (T). CME
dates a session by its *close*, so a timestamp at or after 17:00 CT belongs
to the NEXT calendar day's trade date (e.g. Sunday 17:00 CT → Monday).

User decision (2026-05-28 red-team hardening): use a 17:00 CT roll that is
DST-aware via zoneinfo, NOT a fixed UTC offset. CT is UTC-5 in summer DST
and UTC-6 in winter, so a fixed offset would mis-bucket sessions twice a
year around the DST transitions.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

_CHICAGO = ZoneInfo("America/Chicago")


def cme_session_date(ts_ns: int) -> date:
    """Map an exchange nanosecond timestamp (ts_event) to its CME trade date.

    ES/SPX Globex session runs ~17:00 CT (T-1) -> 16:00 CT (T); CME dates a
    session by its close, so a timestamp at/after 17:00 CT belongs to the NEXT
    calendar day's session (Sun 17:00 CT -> Monday). DST-aware via zoneinfo.
    """
    ct = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc).astimezone(_CHICAGO)
    if ct.hour >= 17:
        return (ct + timedelta(days=1)).date()
    return ct.date()
