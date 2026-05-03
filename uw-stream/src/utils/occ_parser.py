"""Parse OCC option symbols into root/expiry/type/strike.

OCC symbol layout (right-anchored, since the root is variable width):
    <ROOT> <YYMMDD> <C|P> <STRIKE_8_DIGITS>

The trailing 15 characters are fixed-width:
- last 8 chars: strike, encoded as 5 dollar digits + 3 thousandths digits
- 9-from-last char: 'C' or 'P'
- 15-to-9-from-last chars: 6-digit YYMMDD

The portion before those 15 chars is the underlying root, e.g. "SPXW",
"SPY", "WMT". Roots are 1-6 chars in practice.

Example: ``SPXW260502C05900000``
    root   = "SPXW"
    expiry = 2026-05-02
    option_type = "C"
    strike = Decimal("5900.000")

Reference: https://en.wikipedia.org/wiki/Option_symbol#OCC_option_symbol
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

# Years before this two-digit threshold are interpreted as 2100s. UW
# has no listings near 2100, so any reasonable cutoff works; we pick
# the same convention OCC publications use (50 ⇒ 2050).
_YEAR_PIVOT = 50


@dataclass(frozen=True)
class ParsedOcc:
    """Decomposition of an OCC option symbol."""

    root: str
    expiry: date
    option_type: str  # 'C' or 'P'
    strike: Decimal


def parse(symbol: str) -> ParsedOcc:
    """Parse an OCC symbol string. Raises ValueError on malformed input.

    The full original ``symbol`` should still be persisted alongside the
    parsed fields — UW's ``/option-contract/{symbol}/...`` REST endpoints
    require the exact OCC string we received.
    """
    if not isinstance(symbol, str):
        raise ValueError(f"OCC symbol must be a string, got {type(symbol).__name__}")
    if len(symbol) < 16:
        # Minimum valid symbol = 1 root char + 6 date + 1 type + 8 strike = 16
        raise ValueError(f"OCC symbol too short: {symbol!r}")

    strike_str = symbol[-8:]
    option_type = symbol[-9]
    date_str = symbol[-15:-9]
    root = symbol[:-15]

    if not root:
        raise ValueError(f"OCC symbol has empty root: {symbol!r}")
    if option_type not in ("C", "P"):
        raise ValueError(f"OCC option_type must be C or P, got {option_type!r}")
    if not date_str.isdigit() or not strike_str.isdigit():
        raise ValueError(f"OCC date or strike not all digits: {symbol!r}")

    yy = int(date_str[0:2])
    century = 2000 if yy < _YEAR_PIVOT else 1900
    year = century + yy
    month = int(date_str[2:4])
    day = int(date_str[4:6])
    try:
        expiry = date(year, month, day)
    except ValueError as exc:
        raise ValueError(f"OCC date invalid in {symbol!r}: {exc}") from exc

    # Strike = 5 dollar digits + 3 thousandths digits.
    dollars = Decimal(strike_str[:5])
    thousandths = Decimal(strike_str[5:]) / Decimal(1000)
    strike = dollars + thousandths

    return ParsedOcc(root=root, expiry=expiry, option_type=option_type, strike=strike)
