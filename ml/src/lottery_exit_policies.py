"""Exit policy calculations for lottery finder outcomes.

Implements the four exit policies:
1. Trail Act-30 Trail-10: Activate 30% trailing stop at +30%, trail at 10%
2. Hard Stop 30m: -30% stop loss OR hold to EoD (whichever comes first)
3. Tier-50 Hold EoD: -50% stop OR hold to EoD
4. EoD: Hold to end of day (last tick)

Plus peak metrics: peak ceiling % and minutes to peak.
"""

from __future__ import annotations


def realized_trail_act30_trail10(prices: list[float], entry_price: float) -> float:
    """Trail Act-30 Trail-10: Activate trailing stop at +30%, trail at 10%.

    Returns realized exit % from entry.
    """
    if not prices:
        return 0.0

    peak = entry_price
    activated = False

    for price in prices:
        pct_from_entry = ((price - entry_price) / entry_price) * 100

        # Activate trailing stop at +30%
        if not activated and pct_from_entry >= 30:
            activated = True
            peak = price

        # Once activated, trail at 10%
        if activated:
            if price > peak:
                peak = price

            pct_from_peak = ((price - peak) / peak) * 100
            if pct_from_peak <= -10:
                # Stopped out
                return ((price - entry_price) / entry_price) * 100

    # Held to end
    return ((prices[-1] - entry_price) / entry_price) * 100


def realized_hard_stop_30m(
    prices: list[float],
    entry_price: float,
    minutes_since_entry: list[float],
) -> float:
    """Hard Stop 30m: -30% stop loss OR hold to EoD.

    Returns realized exit % from entry.
    """
    if not prices:
        return 0.0

    for price, _minutes in zip(prices, minutes_since_entry):
        pct_from_entry = ((price - entry_price) / entry_price) * 100

        # Stop out at -30%
        if pct_from_entry <= -30:
            return pct_from_entry

    # Held to end
    return ((prices[-1] - entry_price) / entry_price) * 100


def realized_tier50_hold_eod(prices: list[float], entry_price: float) -> float:
    """Tier-50 Hold EoD: -50% stop OR hold to EoD.

    Returns realized exit % from entry.
    """
    if not prices:
        return 0.0

    for price in prices:
        pct_from_entry = ((price - entry_price) / entry_price) * 100

        # Stop out at -50%
        if pct_from_entry <= -50:
            return pct_from_entry

    # Held to end
    return ((prices[-1] - entry_price) / entry_price) * 100


def peak_ceiling(prices: list[float], entry_price: float) -> float:
    """Peak ceiling: highest % gain from entry reached during the session.

    Returns peak % from entry.
    """
    if not prices:
        return 0.0

    peak_price = max(prices)
    return ((peak_price - entry_price) / entry_price) * 100


def minutes_to_peak(
    prices: list[float], minutes_since_entry: list[float]
) -> float | None:
    """Minutes to peak: time from entry to peak price.

    Returns minutes to peak, or None if peak was at entry.
    """
    if not prices:
        return None

    peak_idx = prices.index(max(prices))
    return minutes_since_entry[peak_idx]
