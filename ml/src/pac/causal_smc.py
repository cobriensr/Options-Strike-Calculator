"""Causal reimplementations of smartmoneyconcepts primitives.

The upstream `smartmoneyconcepts` library has a handful of non-causal
operations that mutate previously-written state based on later bars.
These don't create lookahead peeks (you can't trade a signal that was
erased in hindsight), but they DO cause under-counting in backtests
relative to what a live trader would see.

This module provides drop-in replacements whose output at bar T is a
pure function of input rows 0..T. Detection rules match smc.* exactly;
only the retroactive cleanup steps are removed.

See docs/superpowers/specs/pac-residual-causality-fix-2026-04-24.md.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Causal order-block tracker
# ---------------------------------------------------------------------------
#
# Upstream smc.ob has TWO retroactive cleanup steps (smc.py lines 427-439
# for bullish, 474-486 for bearish) that zero out an OB's detection row
# when a future bar's high/low crosses back past the OB boundary. This
# causes the LIVE-visible OB to vanish from the post-hoc output — a live
# trader between detection and mitigation would have seen it.
#
# We keep detection, OB-bar selection, volume calculation, percentage,
# and mitigation-time bookkeeping identical to smc.ob. The cleanup
# ("reset") blocks are removed. MitigatedIndex is set when the OB is
# mitigated and then never touched again.


def causal_order_blocks(
    ohlc: pd.DataFrame,
    swing_highs_lows: pd.DataFrame,
    close_mitigation: bool = False,
) -> pd.DataFrame:
    """Causal drop-in replacement for `smc.ob`.

    Detection semantics match upstream bar-for-bar. The only behavioral
    difference: an OB's detection row is NEVER zeroed out by future price
    action. The OB's raw column values (OB, Top, Bottom, OBVolume,
    Percentage) are set once at detection time and remain. MitigatedIndex
    is updated the bar mitigation occurs and then frozen.

    Parameters match smc.ob so this function can be swapped in with no
    caller-side changes. See smc.py docstring for field semantics.
    """
    n = len(ohlc)
    _open = ohlc["open"].values
    _high = ohlc["high"].values
    _low = ohlc["low"].values
    _close = ohlc["close"].values
    _volume = ohlc["volume"].values
    swing_hl = swing_highs_lows["HighLow"].values

    crossed = np.full(n, False, dtype=bool)
    ob = np.zeros(n, dtype=np.int32)
    top_arr = np.zeros(n, dtype=np.float32)
    bottom_arr = np.zeros(n, dtype=np.float32)
    obVolume = np.zeros(n, dtype=np.float32)
    lowVolume = np.zeros(n, dtype=np.float32)
    highVolume = np.zeros(n, dtype=np.float32)
    percentage = np.zeros(n, dtype=np.float32)
    mitigated_index = np.zeros(n, dtype=np.int32)
    breaker = np.full(n, False, dtype=bool)

    swing_high_indices = np.flatnonzero(swing_hl == 1)
    swing_low_indices = np.flatnonzero(swing_hl == -1)

    # ─── Bullish pass ───
    active_bullish: list[int] = []
    for close_index in range(n):
        # Mitigation check on existing bullish OBs. No reset step.
        for idx in active_bullish.copy():
            if breaker[idx]:
                # Upstream would zero this OB out here if _high[close_index]
                # crosses back above top_arr[idx]. Causal version leaves it
                # alone — a live trader between detection and mitigation
                # would have seen it.
                continue
            mitigated = (
                (not close_mitigation and _low[close_index] < bottom_arr[idx])
                or (
                    close_mitigation
                    and min(_open[close_index], _close[close_index]) < bottom_arr[idx]
                )
            )
            if mitigated:
                breaker[idx] = True
                mitigated_index[idx] = close_index - 1

        # Detection: close breaks above last uncrossed swing high.
        pos = int(np.searchsorted(swing_high_indices, close_index))
        last_top_index = int(swing_high_indices[pos - 1]) if pos > 0 else None
        if last_top_index is None or crossed[last_top_index]:
            continue
        if _close[close_index] <= _high[last_top_index]:
            continue

        crossed[last_top_index] = True
        default_index = close_index - 1
        obBtm = float(_high[default_index])
        obTop = float(_low[default_index])
        obIndex = default_index

        # Look for a lower low between the swing and the break; if found,
        # the OB is anchored there instead.
        if close_index - last_top_index > 1:
            start = last_top_index + 1
            end = close_index
            if end > start:
                segment = _low[start:end]
                min_val = segment.min()
                candidates = np.nonzero(segment == min_val)[0]
                if candidates.size:
                    candidate_index = start + int(candidates[-1])
                    obBtm = float(_low[candidate_index])
                    obTop = float(_high[candidate_index])
                    obIndex = candidate_index

        ob[obIndex] = 1
        top_arr[obIndex] = obTop
        bottom_arr[obIndex] = obBtm
        vol_cur = float(_volume[close_index])
        vol_prev1 = float(_volume[close_index - 1]) if close_index >= 1 else 0.0
        vol_prev2 = float(_volume[close_index - 2]) if close_index >= 2 else 0.0
        obVolume[obIndex] = vol_cur + vol_prev1 + vol_prev2
        lowVolume[obIndex] = vol_prev2
        highVolume[obIndex] = vol_cur + vol_prev1
        max_vol = max(highVolume[obIndex], lowVolume[obIndex])
        percentage[obIndex] = (
            (min(highVolume[obIndex], lowVolume[obIndex]) / max_vol * 100.0)
            if max_vol != 0
            else 100.0
        )
        active_bullish.append(obIndex)

    # ─── Bearish pass ───
    active_bearish: list[int] = []
    for close_index in range(n):
        for idx in active_bearish.copy():
            if breaker[idx]:
                # No reset; same rationale as the bullish branch above.
                continue
            mitigated = (
                (not close_mitigation and _high[close_index] > top_arr[idx])
                or (
                    close_mitigation
                    and max(_open[close_index], _close[close_index]) > top_arr[idx]
                )
            )
            if mitigated:
                breaker[idx] = True
                mitigated_index[idx] = close_index

        pos = int(np.searchsorted(swing_low_indices, close_index))
        last_btm_index = int(swing_low_indices[pos - 1]) if pos > 0 else None
        if last_btm_index is None or crossed[last_btm_index]:
            continue
        if _close[close_index] >= _low[last_btm_index]:
            continue

        crossed[last_btm_index] = True
        default_index = close_index - 1
        obTop = float(_high[default_index])
        obBtm = float(_low[default_index])
        obIndex = default_index

        if close_index - last_btm_index > 1:
            start = last_btm_index + 1
            end = close_index
            if end > start:
                segment = _high[start:end]
                max_val = segment.max()
                candidates = np.nonzero(segment == max_val)[0]
                if candidates.size:
                    candidate_index = start + int(candidates[-1])
                    obTop = float(_high[candidate_index])
                    obBtm = float(_low[candidate_index])
                    obIndex = candidate_index

        ob[obIndex] = -1
        top_arr[obIndex] = obTop
        bottom_arr[obIndex] = obBtm
        vol_cur = float(_volume[close_index])
        vol_prev1 = float(_volume[close_index - 1]) if close_index >= 1 else 0.0
        vol_prev2 = float(_volume[close_index - 2]) if close_index >= 2 else 0.0
        obVolume[obIndex] = vol_cur + vol_prev1 + vol_prev2
        lowVolume[obIndex] = vol_cur + vol_prev1
        highVolume[obIndex] = vol_prev2
        max_vol = max(highVolume[obIndex], lowVolume[obIndex])
        percentage[obIndex] = (
            (min(highVolume[obIndex], lowVolume[obIndex]) / max_vol * 100.0)
            if max_vol != 0
            else 100.0
        )
        active_bearish.append(obIndex)

    # Match smc.ob's NaN masking: convert zero-sentinel slots to NaN.
    ob_out = np.where(ob != 0, ob, np.nan).astype(np.float64)
    mask = ~np.isnan(ob_out)
    top_out = np.where(mask, top_arr, np.nan).astype(np.float64)
    bottom_out = np.where(mask, bottom_arr, np.nan).astype(np.float64)
    obVolume_out = np.where(mask, obVolume, np.nan).astype(np.float64)
    mitigated_out = np.where(mask, mitigated_index, np.nan).astype(np.float64)
    percentage_out = np.where(mask, percentage, np.nan).astype(np.float64)

    return pd.concat(
        [
            pd.Series(ob_out, name="OB"),
            pd.Series(top_out, name="Top"),
            pd.Series(bottom_out, name="Bottom"),
            pd.Series(obVolume_out, name="OBVolume"),
            pd.Series(mitigated_out, name="MitigatedIndex"),
            pd.Series(percentage_out, name="Percentage"),
        ],
        axis=1,
    )
