"""Epoch-ms / ISO-8601 timestamp parsing shared by the futures handlers.

UW's futures channels stamp times as epoch MILLISECONDS (int), verified
against the live ``futures_trades`` feed on 2026-09-08 (1788847011311
decoded to 2026-09-08T05:56:51.311Z; read as seconds it lands in 1970).
A numeric string and an offset-aware ISO-8601 string are accepted too:
the REST block-trade probe of 2026-10-28 sent ISO for the same fields,
and UW uses ISO on ``off_lit_trades``, so a format flip should degrade
rather than black a channel out.

Every path converges on one plausibility window,
[``MIN_PLAUSIBLE_MS``, now + ``MAX_FUTURE_SKEW_MS``], because a single
bad stamp poisons state that is never revised:

- a far-future ``futures_trades`` print pins the handler's newest minute,
  so every later real minute flushes as a one-print partial bar that
  ON CONFLICT DO NOTHING keeps forever, and the UTC session date freezes,
  disabling the front-month roll;
- a far-future ``futures_blocks`` ``reported_at`` wins every later upsert
  guard comparison and freezes the row against real updates.

The upper bound therefore tracks the wall clock, not a fixed far-future
constant.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime
from typing import Any

# 2000-01-01 in epoch ms. Its real job is catching a units flip: epoch
# SECONDS read as ms lands in 1970 and falls below this.
MIN_PLAUSIBLE_MS = 946_684_800_000

# Allowed lead over the wall clock. Sized for clock skew between UW's
# stamp and ours, nothing more; a genuine trade is never minutes ahead.
MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

# A bare integer string, for when UW quotes the epoch the way it already
# quotes prices. ``[0-9]`` rather than ``\d``, which matches any Unicode
# digit. Checked before the ISO parse.
_EPOCH_MS_RE = re.compile(r"[+-]?[0-9]+")


def parse_timestamp(v: Any) -> datetime | None:
    """Parse epoch ms or an offset-aware ISO-8601 string to a UTC datetime.

    Accepts an int, a finite float or an integer string (epoch ms), or an
    ISO-8601 string with an offset. Returns None for anything else: absent,
    unparseable, naive, non-finite, or outside the plausibility window.
    Callers decide whether None means "absent" or "reject".
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        ms = v
    elif isinstance(v, float):
        # int() raises on NaN (ValueError) and on infinity (OverflowError).
        if not math.isfinite(v):
            return None
        ms = int(v)
    elif isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        if not _EPOCH_MS_RE.fullmatch(s):
            return _parse_iso(s)
        ms = int(s)
    else:
        return None

    if not _plausible(ms):
        return None
    # Integer arithmetic, so a millisecond stamp converts exactly.
    return datetime.fromtimestamp(ms // 1000, UTC).replace(microsecond=(ms % 1000) * 1000)


def _parse_iso(s: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    # A naive time has no defensible zone: guessing UTC vs exchange-local
    # would shift it by hours.
    if dt.tzinfo is None:
        return None
    try:
        dt = dt.astimezone(UTC)
        ms = int(dt.timestamp() * 1000)
    except OverflowError:  # e.g. year 1 with a positive offset
        return None
    return dt if _plausible(ms) else None


def _plausible(ms: int) -> bool:
    return MIN_PLAUSIBLE_MS <= ms <= _now_ms() + MAX_FUTURE_SKEW_MS


def _now_ms() -> int:
    """Wall clock as epoch ms, for the future-skew bound."""
    return int(datetime.now(UTC).timestamp() * 1000)
