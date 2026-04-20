"""Market structure extensions on top of `smartmoneyconcepts`.

Upstream `smc.bos_choch()` emits plain BOS and CHoCH events. LuxAlgo's paid
Price Action Concepts® indicator additionally distinguishes **CHoCH+** —
a "supported" change-of-character where a prior failed extreme gave an early
reversal warning before the CHoCH fired. That distinction is not in the
open-source library.

This module consumes upstream swing-highs-lows and bos_choch output and
tags each CHoCH event as plain or supported (+).

Operational definition (derived from LuxAlgo docs, which describe CHoCH+
as "price shows early reversal signs such as failed extremes before the
reversal"):

- **Bearish CHoCH+** (downward break confirming uptrend reversal):
  promoted if, within the prior `lookback_swings` swings, a **failed
  higher high** occurred — i.e., two consecutive swing highs where the
  second was *below* the first (uptrend losing steam).
- **Bullish CHoCH+** (upward break confirming downtrend reversal):
  promoted if, within the prior `lookback_swings` swings, a **failed
  lower low** occurred — i.e., two consecutive swing lows where the
  second was *above* the first (downtrend losing steam).

Plain CHoCH without that warning stays tagged as plain CHoCH. Design
choice: we do not re-detect BOS — upstream handles that — we only enrich
CHoCH output with the + distinction.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def tag_choch_plus(
    swing_highs_lows: pd.DataFrame,
    bos_choch: pd.DataFrame,
    lookback_swings: int = 6,
) -> pd.Series:
    """Return a Series of CHoCH+ tags aligned to `bos_choch`.

    Parameters
    ----------
    swing_highs_lows:
        Output of `smc.swing_highs_lows()`. Columns `HighLow` (1 = HH,
        -1 = LL, NaN elsewhere) and `Level`.
    bos_choch:
        Output of `smc.bos_choch()`. Column `CHOCH` (1 = bullish CHoCH,
        -1 = bearish, NaN elsewhere).
    lookback_swings:
        How many prior swing points to scan for a failed extreme.
        Default 6 matches LuxAlgo's observed behavior on 1m intraday
        charts — enough to include the last few swings without drifting
        into the previous session's structure.

    Returns
    -------
    pd.Series of dtype int32 aligned to `bos_choch.index`, where
        +1 = bullish CHoCH+ (supported by a failed lower low)
        -1 = bearish CHoCH+ (supported by a failed higher high)
         0 = plain CHoCH (failed extreme absent) or not a CHoCH bar

    Callers can then mask their `bos_choch['CHOCH']` column against this
    series to distinguish the two flavors.
    """
    if "HighLow" not in swing_highs_lows.columns:
        raise KeyError("swing_highs_lows must have 'HighLow' column")
    if "Level" not in swing_highs_lows.columns:
        raise KeyError("swing_highs_lows must have 'Level' column")
    if "CHOCH" not in bos_choch.columns:
        raise KeyError("bos_choch must have 'CHOCH' column")
    if lookback_swings < 2:
        raise ValueError("lookback_swings must be >= 2 to detect failed extremes")

    hl = swing_highs_lows["HighLow"].to_numpy()
    lv = swing_highs_lows["Level"].to_numpy()
    choch = bos_choch["CHOCH"].to_numpy()

    # Pre-index the confirmed swings: list of (bar_idx, hl, level) tuples.
    # A swing is any bar where HighLow is non-NaN and non-zero.
    swings: list[tuple[int, int, float]] = []
    for i in range(len(hl)):
        if not np.isnan(hl[i]) and hl[i] != 0:
            swings.append((i, int(hl[i]), float(lv[i])))

    out = np.zeros(len(choch), dtype=np.int32)

    for i in range(len(choch)):
        val = choch[i]
        if np.isnan(val) or val == 0:
            continue

        # Prior swings strictly before bar i
        prior = [s for s in swings if s[0] < i][-lookback_swings:]

        if val == -1:
            # Bearish CHoCH: look for failed HH (consecutive HHs, 2nd lower than 1st)
            highs = [s for s in prior if s[1] == 1]
            for j in range(len(highs) - 1):
                if highs[j + 1][2] < highs[j][2]:
                    out[i] = -1
                    break
        elif val == 1:
            # Bullish CHoCH: look for failed LL (consecutive LLs, 2nd higher than 1st)
            lows = [s for s in prior if s[1] == -1]
            for j in range(len(lows) - 1):
                if lows[j + 1][2] > lows[j][2]:
                    out[i] = 1
                    break

    return pd.Series(out, index=bos_choch.index, name="CHOCHPlus")


def describe_structure_events(
    swing_highs_lows: pd.DataFrame,
    bos_choch: pd.DataFrame,
    choch_plus: pd.Series,
) -> pd.DataFrame:
    """Flatten structure output into a human-readable events DataFrame.

    One row per bar that has a non-null HighLow, BOS, or CHOCH. Useful for
    sanity-checking detection output against LuxAlgo screenshots or for
    regression testing against the manual journal CSV.

    Returns DataFrame with columns:
        bar_idx : int positional index into the source OHLC frame
        event   : string describing what fired at that bar
                  ('HH', 'LL', 'BOS_up', 'BOS_dn', 'CHOCH_up', 'CHOCH_dn',
                   'CHOCH+_up', 'CHOCH+_dn')
        level   : float price level associated with the event
    """
    rows: list[dict] = []
    hl = swing_highs_lows["HighLow"].to_numpy()
    lv = swing_highs_lows["Level"].to_numpy()
    bos = bos_choch["BOS"].to_numpy()
    ch = bos_choch["CHOCH"].to_numpy()
    level_bc = bos_choch["Level"].to_numpy() if "Level" in bos_choch.columns else lv
    cp = choch_plus.to_numpy()

    def _nz(x: float) -> bool:
        return not np.isnan(x) and x != 0

    for i in range(len(hl)):
        if _nz(hl[i]):
            rows.append(
                {
                    "bar_idx": i,
                    "event": "HH" if hl[i] == 1 else "LL",
                    "level": float(lv[i]),
                }
            )
        if _nz(bos[i]):
            rows.append(
                {
                    "bar_idx": i,
                    "event": "BOS_up" if bos[i] == 1 else "BOS_dn",
                    "level": float(level_bc[i]) if not np.isnan(level_bc[i]) else float("nan"),
                }
            )
        if _nz(ch[i]):
            plus = cp[i] != 0
            direction = "up" if ch[i] == 1 else "dn"
            label = f"CHOCH+_{direction}" if plus else f"CHOCH_{direction}"
            rows.append(
                {
                    "bar_idx": i,
                    "event": label,
                    "level": float(level_bc[i]) if not np.isnan(level_bc[i]) else float("nan"),
                }
            )

    return pd.DataFrame(rows)
