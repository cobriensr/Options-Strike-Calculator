"""Fill model — converts a signal timestamp into a simulated fill price.

Phase 1 model: next-bar-open fill with configurable slippage in ticks.
This is the standard "close on signal, fill on next open" convention that
avoids lookahead while remaining realistic for 1m futures in liquid hours.

The fill direction matters: when going long, slippage pushes the entry
price *up* (worse for the buyer). When going short, slippage pushes entry
*down* (worse for the seller). On exits, symmetric but opposite.

Phase 2 will add L1 tick refinement: look up the actual bid/ask at the
signal bar's close from the TBBO archive, cross the spread, and apply
residual slippage for queue uncertainty. Uses the 1-year TBBO data in
`ml/data/archive/tbbo/`.
"""

from __future__ import annotations

from typing import Literal

import pandas as pd

from pac_backtest.params import StrategyParams

FillSide = Literal["entry_long", "entry_short", "exit_long", "exit_short"]


def next_bar_open_price(
    bars: pd.DataFrame,
    signal_bar_idx: int,
) -> float | None:
    """Return the open price of the bar immediately after `signal_bar_idx`.

    Returns None if `signal_bar_idx` is the last bar in `bars` — no
    next-bar-open available, so the signal cannot be filled.
    """
    next_idx = signal_bar_idx + 1
    if next_idx >= len(bars):
        return None
    return float(bars.iloc[next_idx]["open"])


def apply_slippage(
    raw_price: float,
    side: FillSide,
    slippage_ticks: float,
    tick_size: float = 0.25,
) -> float:
    """Adjust a raw fill price for cross-spread slippage.

    - **Entry long / exit short**: fills push price UP (buying into the spread
      or covering short)
    - **Entry short / exit long**: fills push price DOWN

    `tick_size` defaults to 0.25 (NQ / ES quarter-point tick).
    """
    shift = slippage_ticks * tick_size
    if side in ("entry_long", "exit_short"):
        return raw_price + shift
    elif side in ("entry_short", "exit_long"):
        return raw_price - shift
    raise ValueError(f"Unknown fill side: {side}")


def compute_fill_price(
    bars: pd.DataFrame,
    signal_bar_idx: int,
    side: FillSide,
    params: StrategyParams,
    tick_size: float = 0.25,
) -> float | None:
    """End-to-end fill price for a signal at a given bar index.

    Returns the filled price or None if no next bar exists (signal at EOD).
    """
    raw = next_bar_open_price(bars, signal_bar_idx)
    if raw is None:
        return None
    return apply_slippage(raw, side, params.slippage_ticks, tick_size=tick_size)
