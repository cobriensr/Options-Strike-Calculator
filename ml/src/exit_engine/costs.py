"""Cost model ported verbatim from
ml/experiments/lottery-net-flow-eda/exit_simulation.py (apply_costs).
Kept here so the engine never imports from experiments/."""
from __future__ import annotations

import math

COMMISSION_USD_PER_CONTRACT_RT = 0.65  # round-trip
SLIPPAGE_PCT_OF_SPREAD = 0.5  # cross half the bid-ask each leg


def apply_costs(pct: float, entry_price: float, spread_pct_of_price: float) -> float:
    """Strip commission + 2-leg slippage from a gross % return."""
    if pct is None or (isinstance(pct, float) and math.isnan(pct)) or entry_price <= 0:
        return pct
    comm_pct = (COMMISSION_USD_PER_CONTRACT_RT / (entry_price * 100)) * 100
    slip_pct = 2 * SLIPPAGE_PCT_OF_SPREAD * spread_pct_of_price
    return pct - comm_pct - slip_pct
