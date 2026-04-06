"""Contract roll logic and ES options strike discovery/re-centering.

Handles:
- Quarterly rolls for ES, NQ, ZN, RTY (Mar/Jun/Sep/Dec)
- Monthly rolls for VXM, CL
- ES options ATM +/-10 strike discovery using Databento Definition schema
- Re-centering when ES price moves +/-50 pts from last center
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING

from logger_setup import log

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Month codes for CME/CBOT/NYMEX/CFE futures
# ---------------------------------------------------------------------------

MONTH_CODES = {
    1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
    7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
}

QUARTERLY_MONTHS = [3, 6, 9, 12]


# ---------------------------------------------------------------------------
# Databento parent symbols for continuous front-month contracts
# ---------------------------------------------------------------------------

# For OHLCV-1m subscriptions, we use parent symbology (stype_in='parent')
# which automatically resolves to the active front-month contract.
FUTURES_PARENT_SYMBOLS = {
    "ES": "ES.FUT",    # E-mini S&P 500
    "NQ": "NQ.FUT",    # E-mini Nasdaq 100
    "ZN": "ZN.FUT",    # 10-Year Treasury Note
    "RTY": "RTY.FUT",  # E-mini Russell 2000
    "CL": "CL.FUT",    # WTI Crude Oil
}

# VX (full-size VIX futures) — two months for term structure
VX_FRONT = "VX.FUT"      # Front month
VX_SECOND = "VX.FUT.1"   # Second month (for contango/backwardation)

# Datasets by exchange
DATASET_CME = "GLBX.MDP3"   # CME, CBOT, NYMEX, COMEX
DATASET_XCBF = "XCBF.PITCH"  # CBOE Futures Exchange (VX)

# Internal symbol -> display name mapping
SYMBOL_DISPLAY = {
    "ES": "/ES",
    "NQ": "/NQ",
    "VX1": "/VX (front)",
    "VX2": "/VX (2nd)",
    "ZN": "/ZN",
    "RTY": "/RTY",
    "CL": "/CL",
}

# Strike spacing for ES options (5-point increments)
ES_STRIKE_SPACING = 5
ES_RECENTER_THRESHOLD = 50  # Re-center when ES moves +/-50 pts
ES_STRIKES_EACH_SIDE = 10   # ATM +/-10 strikes = ~20 contracts


@dataclass
class OptionsStrikeSet:
    """Tracks the currently subscribed ES option strikes."""

    center_price: float = 0.0
    strikes: list[float] = field(default_factory=list)
    call_symbols: list[str] = field(default_factory=list)
    put_symbols: list[str] = field(default_factory=list)
    nearest_expiry: date | None = None
    last_recentered_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    @property
    def all_symbols(self) -> list[str]:
        return self.call_symbols + self.put_symbols

    def needs_recenter(self, current_es_price: float) -> bool:
        """Check if ES has moved enough to warrant re-centering strikes."""
        if self.center_price == 0.0:
            return True
        return abs(current_es_price - self.center_price) >= ES_RECENTER_THRESHOLD


def compute_atm_strikes(es_price: float) -> list[float]:
    """Compute ATM +/-10 strike prices for ES options.

    ES options have 5-point strike spacing. Round to nearest 5, then
    generate 10 strikes above and 10 below.
    """
    atm = round(es_price / ES_STRIKE_SPACING) * ES_STRIKE_SPACING
    strikes = []
    for i in range(-ES_STRIKES_EACH_SIDE, ES_STRIKES_EACH_SIDE + 1):
        strikes.append(atm + i * ES_STRIKE_SPACING)
    return sorted(strikes)


def build_es_option_symbols(
    strikes: list[float],
    expiry: date,
) -> tuple[list[str], list[str]]:
    """Build Databento raw symbols for ES option strikes.

    ES option symbols on CME follow the pattern:
    ES + expiry code + C/P + strike
    e.g., ESM5 C5850, ESM5 P5800

    For Databento with parent symbology, we use the raw symbol format.
    The exact format depends on the venue; for live streaming we'll
    use instrument IDs discovered via the Definition schema instead.

    Returns (call_symbols, put_symbols) -- these are placeholder names
    used for logging. Actual subscription uses instrument IDs from
    Definition records.
    """
    month_code = MONTH_CODES[expiry.month]
    year_digit = expiry.year % 10
    prefix = f"ES{month_code}{year_digit}"

    calls = [f"{prefix} C{int(s)}" for s in strikes]
    puts = [f"{prefix} P{int(s)}" for s in strikes]
    return calls, puts


def get_all_futures_subscriptions() -> dict[str, dict]:
    """Return subscription configs for all futures symbols.

    Returns a dict keyed by internal symbol name with:
    - parent_symbol: Databento parent symbol for subscription
    - dataset: Databento dataset
    - db_symbol: Symbol stored in futures_bars table
    """
    subs = {}

    # CME products
    for sym, parent in FUTURES_PARENT_SYMBOLS.items():
        subs[sym] = {
            "parent_symbol": parent,
            "dataset": DATASET_CME,
            "db_symbol": sym,
        }

    # VX front month (CFE)
    subs["VX1"] = {
        "parent_symbol": VX_FRONT,
        "dataset": DATASET_XCBF,
        "db_symbol": "VX1",
    }

    # VX second month (CFE)
    subs["VX2"] = {
        "parent_symbol": VX_SECOND,
        "dataset": DATASET_XCBF,
        "db_symbol": "VX2",
    }

    return subs


def third_friday(year: int, month: int) -> date:
    """Calculate the third Friday of a given month (options expiry)."""
    from calendar import monthrange

    first_day_weekday = date(year, month, 1).weekday()
    # weekday(): Monday=0, Friday=4
    first_friday = 1 + (4 - first_day_weekday) % 7
    third = first_friday + 14
    # Sanity check
    _, last_day = monthrange(year, month)
    if third > last_day:
        third -= 7
    return date(year, month, third)


def get_nearest_es_expiry(now: date | None = None) -> date:
    """Find the nearest ES options expiry (third Friday of quarterly month).

    ES options expire on the third Friday of Mar, Jun, Sep, Dec.
    For 0DTE/weekly options, the nearest Friday is used, but for
    this sidecar we track the quarterly cycle for the main chain.
    """
    if now is None:
        now = date.today()

    year = now.year
    candidates = []
    for m in QUARTERLY_MONTHS:
        candidates.append(third_friday(year, m))
    # Also check next year's first quarter
    candidates.append(third_friday(year + 1, 3))

    for exp in sorted(candidates):
        if exp >= now:
            return exp

    # Fallback
    return third_friday(year + 1, 3)
