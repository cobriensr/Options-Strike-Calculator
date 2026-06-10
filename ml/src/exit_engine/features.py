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
    """(mid[t] - mid[t-window]) / mid[t-window]; 0 before enough history or non-positive base."""
    out = np.zeros_like(mid)
    if mid.shape[0] > window:
        prev = mid[:-window]
        cur = mid[window:]
        ok = prev > 0
        res = np.zeros_like(cur)
        res[ok] = (cur[ok] - prev[ok]) / prev[ok]
        out[window:] = res
    return out


def _trailing_vol(mid: np.ndarray, window: int) -> np.ndarray:
    """Population std (ddof=0) of per-minute returns over a trailing window; 0 for
    windows of size <= 1. Vectorized via cumulative sums (matches the np.std loop)."""
    rets = np.zeros_like(mid)
    if mid.shape[0] > 1:
        prev = mid[:-1]
        rets[1:] = np.where(prev > 0, np.diff(mid) / prev, 0.0)
    n = rets.shape[0]
    out = np.zeros_like(mid)
    if n == 0:
        return out
    csum = np.concatenate(([0.0], np.cumsum(rets)))
    csq = np.concatenate(([0.0], np.cumsum(rets * rets)))
    idx = np.arange(n)
    lo = np.maximum(0, idx - window + 1)
    cnt = (idx - lo + 1).astype("float64")
    s = csum[idx + 1] - csum[lo]
    sq = csq[idx + 1] - csq[lo]
    mean = s / cnt
    var = np.maximum(sq / cnt - mean * mean, 0.0)
    vol = np.sqrt(var)
    vol[cnt <= 1] = 0.0
    out[:] = vol
    return out
