"""Strictly-causal per-minute features. Every value at row t depends only on
mid[:t+1]; verified by the append-future-row leak test."""
from __future__ import annotations

import numpy as np
import pandas as pd


def build_features(
    path: pd.DataFrame, entry_price: float, minutes_to_close: list[float]
) -> pd.DataFrame:
    """Return a causal feature frame aligned 1:1 with path rows."""
    mid = path["mid"].to_numpy(dtype="float64")
    out = pd.DataFrame(index=path.index)
    out["minutes_since_entry"] = path["minutes_since_entry"].to_numpy()
    out["minutes_to_close"] = np.asarray(minutes_to_close, dtype="float64")
    out["ret_from_entry_pct"] = (mid - entry_price) / entry_price * 100.0
    running_peak = np.maximum.accumulate(mid)
    out["running_peak_pct"] = (running_peak - entry_price) / entry_price * 100.0
    out["drawdown_from_peak_pct"] = np.where(
        running_peak > 0, (mid - running_peak) / running_peak * 100.0, 0.0
    )
    out["spread_pct"] = np.where(mid > 0, path["spread"].to_numpy() / mid * 100.0, 0.0)
    out["slope_3m"] = _trailing_slope(mid, 3)
    out["slope_5m"] = _trailing_slope(mid, 5)
    out["slope_10m"] = _trailing_slope(mid, 10)
    out["realized_vol_5m"] = _trailing_vol(mid, 5)
    if "implied_volatility" in path.columns:
        iv = path["implied_volatility"].to_numpy(dtype="float64")
        out["iv_level"] = iv
        out["iv_change_5m"] = _trailing_slope(iv, 5)
        out["iv_change_10m"] = _trailing_slope(iv, 10)
        out["delta"] = path["delta"].to_numpy(dtype="float64")
        out["gamma"] = path["gamma"].to_numpy(dtype="float64")
        under = path["underlying_price"].to_numpy(dtype="float64")
        strike = float(path["strike"].iloc[0])
        is_call = str(path["option_type"].iloc[0]).lower().startswith("c")
        if is_call:
            otm = np.where(under > 0, (under - strike) / under * 100.0, 0.0)
        else:
            otm = np.where(under > 0, (strike - under) / under * 100.0, 0.0)
        out["otm_distance_pct"] = otm
        u0 = under[0]
        out["underlying_ret_from_entry"] = (
            np.where(under > 0, (under - u0) / u0 * 100.0, 0.0) if u0 > 0 else np.zeros_like(under)
        )
    return out


def _trailing_slope(mid: np.ndarray, window: int) -> np.ndarray:
    """(mid[t] - mid[t-window]) / mid[t-window]; 0 before enough history."""
    out = np.zeros_like(mid)
    for t in range(len(mid)):
        j = t - window
        if j >= 0 and mid[j] > 0:
            out[t] = (mid[t] - mid[j]) / mid[j]
    return out


def _trailing_vol(mid: np.ndarray, window: int) -> np.ndarray:
    rets = np.zeros_like(mid)
    rets[1:] = np.where(mid[:-1] > 0, np.diff(mid) / mid[:-1], 0.0)
    out = np.zeros_like(mid)
    for t in range(len(mid)):
        lo = max(0, t - window + 1)
        out[t] = np.std(rets[lo : t + 1]) if t > lo else 0.0
    return out
