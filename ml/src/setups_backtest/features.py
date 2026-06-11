"""Point-in-time feature functions for the futures-setups backtest.

All functions are pure: input pandas DataFrames/Series, output scalar values
or new Series/DataFrames. **No DB access here** — that lives in
``data_loaders``.

Look-ahead discipline: every function takes an explicit ``end_ts`` (or implicit
end via the input frame's tail) and uses only data with ``ts <= end_ts``.
Callers are responsible for slicing inputs to the decision window.

Session conventions:
  - All timestamps are tz-aware UTC.
  - "RTH" = 13:30-20:00 UTC (09:30-16:00 ET, ignoring DST; equity-index futures
    have continuous trading but RTH is the high-volume window).
  - "ETH" = 21:00 prior day -> 13:30 UTC current day (17:00 ET prior ->
    09:30 ET).
  - DST: We accept the small drift for backtest purposes. A future refinement
    could use ``zoneinfo`` to compute exact ET boundaries per-date; current
    pass uses fixed UTC offsets matching standard time.
"""

from __future__ import annotations

from datetime import time, timedelta

import numpy as np
import pandas as pd

# RTH/ETH session boundaries in UTC (fixed offset; see DST note above).
RTH_OPEN_UTC = time(13, 30)  # 09:30 ET (standard time)
RTH_CLOSE_UTC = time(20, 0)  # 16:00 ET
ETH_OPEN_UTC = time(21, 0)  # 17:00 ET prior day


# ---------------------------------------------------------------------------
# OFI
# ---------------------------------------------------------------------------


def ofi_window(
    tbbo_minute: pd.DataFrame,
    end_ts: pd.Timestamp,
    window_minutes: int,
) -> float:
    """OFI over the trailing ``window_minutes`` ending at ``end_ts`` (exclusive).

    OFI = (buy_vol - sell_vol) / (buy_vol + sell_vol), bounded [-1, +1].
    Returns ``np.nan`` if no trades in window.

    ``tbbo_minute`` must have columns ``minute``, ``buy_vol``, ``sell_vol``.
    """
    if tbbo_minute.empty:
        return float("nan")
    start_ts = end_ts - timedelta(minutes=window_minutes)
    mask = (tbbo_minute["minute"] >= start_ts) & (tbbo_minute["minute"] < end_ts)
    slice_ = tbbo_minute.loc[mask, ["buy_vol", "sell_vol"]]
    if slice_.empty:
        return float("nan")
    buy = float(slice_["buy_vol"].sum())
    sell = float(slice_["sell_vol"].sum())
    denom = buy + sell
    if denom <= 0:
        return float("nan")
    return (buy - sell) / denom


# ---------------------------------------------------------------------------
# CVD
# ---------------------------------------------------------------------------


def cvd_session(
    tbbo_minute: pd.DataFrame,
    session_start: pd.Timestamp,
    end_ts: pd.Timestamp,
) -> float:
    """Cumulative volume delta from ``session_start`` (incl) to ``end_ts`` (excl).

    CVD = sum(buy_vol - sell_vol). Returns ``np.nan`` for an empty window so
    callers can distinguish "no data" from "perfectly balanced flow" — Setup 6
    (CVD divergence) needs this distinction.
    """
    if tbbo_minute.empty:
        return float("nan")
    mask = (tbbo_minute["minute"] >= session_start) & (tbbo_minute["minute"] < end_ts)
    s = tbbo_minute.loc[mask]
    if s.empty:
        return float("nan")
    return float((s["buy_vol"] - s["sell_vol"]).sum())


def cvd_series(
    tbbo_minute: pd.DataFrame,
    session_start: pd.Timestamp,
    end_ts: pd.Timestamp | None = None,
) -> pd.Series:
    """Per-minute cumulative CVD across the session.

    Index is ``minute`` (tz-aware UTC). Used for divergence detection in
    Setup 6 (CVD divergence fade).

    ``end_ts`` (exclusive) upper-bounds the window so the series is
    point-in-time safe: callers evaluating at minute ``now`` must pass
    ``end_ts=now`` or the ``.iloc[-1]`` / ``.idxmax()`` reads see end-of-day
    (future) flow. Omitting it returns the full session (back-compat).
    """
    if tbbo_minute.empty:
        return pd.Series(dtype="float64")
    mask = tbbo_minute["minute"] >= session_start
    if end_ts is not None:
        mask &= tbbo_minute["minute"] < end_ts
    s = tbbo_minute.loc[mask].copy()
    if s.empty:
        return pd.Series(dtype="float64")
    s["delta"] = s["buy_vol"].astype("float64") - s["sell_vol"].astype("float64")
    return s.set_index("minute")["delta"].cumsum()


# ---------------------------------------------------------------------------
# ATR
# ---------------------------------------------------------------------------


def atr(ohlcv: pd.DataFrame, window: int = 14) -> pd.Series:
    """ATR computed from 1m bars.

    Uses Wilder-style true range: max(high-low, |high - prev_close|,
    |low - prev_close|). Returns a Series aligned to ``ohlcv['ts']`` with NaN
    for the first ``window`` bars.

    ``ohlcv`` must have columns ``ts``, ``high``, ``low``, ``close``.
    """
    if ohlcv.empty:
        return pd.Series(dtype="float64")
    df = ohlcv.sort_values("ts").reset_index(drop=True)
    prev_close = df["close"].shift(1)
    tr1 = df["high"] - df["low"]
    tr2 = (df["high"] - prev_close).abs()
    tr3 = (df["low"] - prev_close).abs()
    true_range = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    atr_series = true_range.rolling(window=window, min_periods=window).mean()
    atr_series.index = df["ts"]
    return atr_series


# ---------------------------------------------------------------------------
# Session VWAP
# ---------------------------------------------------------------------------


def session_vwap(
    ohlcv: pd.DataFrame,
    session_start: pd.Timestamp,
    end_ts: pd.Timestamp,
) -> float:
    """Cumulative VWAP from ``session_start`` to ``end_ts`` (both treated as ts bounds).

    VWAP uses typical price ``(high + low + close) / 3``. Returns NaN if no
    bars match or total volume is zero.
    """
    if ohlcv.empty:
        return float("nan")
    mask = (ohlcv["ts"] >= session_start) & (ohlcv["ts"] < end_ts)
    s = ohlcv.loc[mask]
    if s.empty:
        return float("nan")
    typ = (s["high"] + s["low"] + s["close"]) / 3.0
    vol = s["volume"].astype("float64")
    total_vol = float(vol.sum())
    if total_vol <= 0:
        return float("nan")
    return float((typ * vol).sum() / total_vol)


# ---------------------------------------------------------------------------
# Volume profile
# ---------------------------------------------------------------------------


_VOLUME_PROFILE_NAN = {"poc": float("nan"), "vah": float("nan"), "val": float("nan")}
_VOLUME_PROFILE_MIN_BARS = 3


def volume_profile(
    ohlcv: pd.DataFrame,
    n_bins: int = 50,
    value_area_pct: float = 0.70,
) -> dict[str, float]:
    """POC / VAH / VAL for a session.

    Returns dict with keys ``poc``, ``vah``, ``val``. NaN if input is empty,
    has fewer than 3 bars (insufficient to form a profile), or has zero
    price range.
    """
    if ohlcv.empty or len(ohlcv) < _VOLUME_PROFILE_MIN_BARS:
        return dict(_VOLUME_PROFILE_NAN)

    lo = float(ohlcv["low"].min())
    hi = float(ohlcv["high"].max())
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        return dict(_VOLUME_PROFILE_NAN)

    # Distribute each bar's volume across the price range it touched.
    edges = np.linspace(lo, hi, n_bins + 1)
    centers = (edges[:-1] + edges[1:]) / 2.0
    bin_vol = np.zeros(n_bins, dtype="float64")

    bar_lows = ohlcv["low"].to_numpy()
    bar_highs = ohlcv["high"].to_numpy()
    bar_vols = ohlcv["volume"].to_numpy(dtype="float64")

    for blo, bhi, vol in zip(bar_lows, bar_highs, bar_vols):
        if not np.isfinite(blo) or not np.isfinite(bhi) or vol <= 0:
            continue
        # Bins overlapping this bar's [low, high] range share vol equally.
        first = max(0, int(np.searchsorted(edges, blo, side="right") - 1))
        last = min(n_bins - 1, int(np.searchsorted(edges, bhi, side="left")))
        if last < first:
            continue
        span = last - first + 1
        bin_vol[first : last + 1] += vol / span

    if bin_vol.sum() <= 0:
        return {"poc": float("nan"), "vah": float("nan"), "val": float("nan")}

    poc_idx = int(np.argmax(bin_vol))
    poc = float(centers[poc_idx])

    # Value area: expand symmetrically from POC until value_area_pct of vol covered.
    target = bin_vol.sum() * value_area_pct
    lo_idx = poc_idx
    hi_idx = poc_idx
    covered = bin_vol[poc_idx]
    while covered < target and (lo_idx > 0 or hi_idx < n_bins - 1):
        next_lo = bin_vol[lo_idx - 1] if lo_idx > 0 else -1
        next_hi = bin_vol[hi_idx + 1] if hi_idx < n_bins - 1 else -1
        if next_lo >= next_hi and lo_idx > 0:
            lo_idx -= 1
            covered += bin_vol[lo_idx]
        elif hi_idx < n_bins - 1:
            hi_idx += 1
            covered += bin_vol[hi_idx]
        else:
            break

    return {
        "poc": poc,
        "vah": float(centers[hi_idx]),
        "val": float(centers[lo_idx]),
    }


# ---------------------------------------------------------------------------
# Sessions / ETH extremes
# ---------------------------------------------------------------------------


def eth_session_bounds(rth_date) -> tuple[pd.Timestamp, pd.Timestamp]:
    """Return (eth_start, rth_open) UTC for the ETH session preceding ``rth_date``.

    Accepts ``datetime.date``, ``datetime.datetime``, or ``pd.Timestamp``
    (tz-naive or tz-aware). Normalizes to UTC-midnight before computing the
    window. ETH starts at 21:00 UTC of the previous calendar day and ends at
    13:30 UTC of ``rth_date``.
    """
    ts = pd.Timestamp(rth_date)
    ts = ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")
    d = ts.normalize()
    eth_start = d - pd.Timedelta(hours=3)  # 21:00 UTC prior day
    rth_open = d + pd.Timedelta(hours=13, minutes=30)
    return eth_start, rth_open


def eth_extremes(
    ohlcv: pd.DataFrame,
    rth_date: pd.Timestamp,
) -> dict[str, float]:
    """Overnight (ETH) high/low for the session preceding ``rth_date``.

    Returns dict with ``eth_high``, ``eth_low``. NaN if no bars in window.
    """
    eth_start, rth_open = eth_session_bounds(rth_date)
    mask = (ohlcv["ts"] >= eth_start) & (ohlcv["ts"] < rth_open)
    s = ohlcv.loc[mask]
    if s.empty:
        return {"eth_high": float("nan"), "eth_low": float("nan")}
    return {
        "eth_high": float(s["high"].max()),
        "eth_low": float(s["low"].min()),
    }


# ---------------------------------------------------------------------------
# Cross-asset
# ---------------------------------------------------------------------------


def returns_minute(ohlcv: pd.DataFrame) -> pd.Series:
    """Minute-over-minute log returns from close prices.

    Index is ts; first bar is NaN.
    """
    if ohlcv.empty:
        return pd.Series(dtype="float64")
    s = ohlcv.sort_values("ts").set_index("ts")["close"]
    return np.log(s / s.shift(1))


def rolling_correlation(
    a: pd.Series,
    b: pd.Series,
    window_minutes: int,
) -> pd.Series:
    """Pearson correlation of two return series in a rolling window.

    Both inputs should be indexed by ts; they're aligned via index intersection.
    Returns NaN where fewer than ``window_minutes`` valid pairs are present.
    """
    aligned = pd.concat([a.rename("a"), b.rename("b")], axis=1).dropna()
    if aligned.empty:
        return pd.Series(dtype="float64")
    return aligned["a"].rolling(window=window_minutes, min_periods=window_minutes).corr(
        aligned["b"]
    )


# ---------------------------------------------------------------------------
# Rolling OFI percentile (Setup 1 threshold)
# ---------------------------------------------------------------------------


def trailing_p95(values: pd.Series, lookback_days: int = 252) -> float:
    """95th percentile of the last ``lookback_days`` values, or NaN if too few.

    Used for the "is today's NQ 1h OFI at or above the 95th percentile of the
    trailing year" check in Setup 1.
    """
    clean = values.dropna()
    if len(clean) < lookback_days:
        return float("nan")
    tail = clean.iloc[-lookback_days:]
    return float(np.percentile(tail.to_numpy(), 95))


# ---------------------------------------------------------------------------
# Macro stress regime (Setup 1 disqualifier)
# ---------------------------------------------------------------------------


def fractal_pivots(
    bars: pd.DataFrame,
    lookback: int = 3,
) -> tuple[list[int], list[int]]:
    """Identify fractal swing highs / lows in a 1m OHLCV bar frame.

    A bar at index i is a **swing high** if its ``high`` is strictly greater
    than the ``high`` of all bars in [i-lookback, i-1] AND [i+1, i+lookback].
    Symmetric for swing lows on ``low``.

    Returns ``(high_indices, low_indices)`` — lists of integer positions into
    ``bars`` (which should be reset_index(drop=True) by the caller). Pivots
    can only be confirmed once ``lookback`` bars have printed AFTER them, so
    the latest possible confirmed pivot is at index ``len(bars) - 1 -
    lookback``.

    Used by Setup 6b (CVD swing-divergence) to detect real price swings
    instead of just monotonic moves — the failure mode of Setup 6.
    """
    if len(bars) < 2 * lookback + 1:
        return [], []
    highs = bars["high"].to_numpy()
    lows = bars["low"].to_numpy()
    swing_highs: list[int] = []
    swing_lows: list[int] = []
    n = len(bars)
    # Only bars in [lookback, n-1-lookback] can be pivots (need bars on both sides).
    for i in range(lookback, n - lookback):
        h = highs[i]
        l_ = lows[i]
        # Strict inequality on both sides — equal-high "double tops" don't qualify.
        if (
            (highs[i - lookback : i] < h).all()
            and (highs[i + 1 : i + lookback + 1] < h).all()
        ):
            swing_highs.append(i)
        if (
            (lows[i - lookback : i] > l_).all()
            and (lows[i + 1 : i + lookback + 1] > l_).all()
        ):
            swing_lows.append(i)
    return swing_highs, swing_lows


def macro_stress_30m(
    cl_ohlcv: pd.DataFrame,
    end_ts: pd.Timestamp,
    pct_threshold: float = 2.0,
) -> bool:
    """True if CL (crude oil) absolute return over the trailing 30 min exceeds threshold.

    Mirrors the existing analyze-context rule ``CL 30m move > 2% → MACRO-STRESS``.
    """
    if cl_ohlcv.empty:
        return False
    start_ts = end_ts - pd.Timedelta(minutes=30)
    mask = (cl_ohlcv["ts"] >= start_ts) & (cl_ohlcv["ts"] < end_ts)
    s = cl_ohlcv.loc[mask]
    if len(s) < 2:
        return False
    first = float(s.iloc[0]["close"])
    last = float(s.iloc[-1]["close"])
    if first <= 0:
        return False
    return abs((last - first) / first) * 100.0 >= pct_threshold
