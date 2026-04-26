"""Ichimoku Kinko Hyo engine — vectorized batch_state over an OHLCV frame.

The five canonical lines (Hosoda 1930s defaults: 9 / 26 / 52):

    Tenkan-sen   (Conversion)  =  (high.rolling(9).max  + low.rolling(9).min)  / 2
    Kijun-sen    (Base)        =  (high.rolling(26).max + low.rolling(26).min) / 2
    Senkou Span A (Lead 1)     =  ((Tenkan + Kijun) / 2).shift(+26)
    Senkou Span B (Lead 2)     =  ((high.rolling(52).max + low.rolling(52).min) / 2).shift(+26)
    Chikou Span  (Lagging)     =  close.shift(-26)

The cloud (Kumo) is the area between Senkou A and B at each bar. By
construction, both Senkou lines at index t depend only on data up to
index `t - 26` — strictly causal at chart-display position t.

The Chikou line is BACKWARD-shifted, so chikou[t] = close[t + 26]. It
is NOT directly usable as a feature at time t (would peek 26 bars
ahead). Instead, we emit `chikou_confirm` at time t = sign(close[t]
- close[t - 26]) — a causal proxy for the standard "Chikou above its
trailing price" rule.

## Causality contract

Every column at row t uses ONLY data from `bars[..t]`. The shift(+26)
on Senkou Spans means the *index* of the value is t, but the
*content* came from data at t-26 — that's the indicator's whole
point, and it's strictly causal as long as we never .shift(-N) into
features. Chikou is computed but only used in derived features that
are themselves causal (chikou_confirm above).

## Schema parity with PAC

To slot into the existing classifier pipeline without changes, this
engine emits these columns:

  Required by `pac_classifier`:
    ts_event, open, high, low, close, volume, symbol  (passthrough)
    BOS, CHOCH, CHOCHPlus  (mapped from Ichimoku events)
    atr_14                 (needed for label stop sizing)
    session_bucket         (required by features.py)

  Optional engine state for the trainer to use as features:
    tenkan_9, kijun_26, senkou_a_26, senkou_b_26
    cloud_top, cloud_bottom, cloud_thickness, cloud_color
    distance_from_cloud_atr  (signed, in ATR units)
    chikou_confirm           (sign of close[t] - close[t-26])
    z_close_vwap             (kept for parallel with PAC)
    minutes_from_rth_open, minutes_to_rth_close
    is_fomc, is_opex, is_event_day  (default False — populated by upstream)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Hosoda's original parameters. Despite being designed for daily
# charts, these are the universal defaults across every Ichimoku
# implementation, so we use them as the canonical test.
TENKAN_PERIOD = 9
KIJUN_PERIOD = 26
SENKOU_B_PERIOD = 52
CLOUD_DISPLACEMENT = 26  # both Senkou lines shifted forward by this many bars
CHIKOU_LOOKBACK = 26  # close vs close[-26] for causal "chikou confirmation"

ATR_PERIOD = 14  # match PAC engine for label stop-sizing parity


@dataclass(frozen=True)
class IchimokuParams:
    """Parameter bundle. Keep defaults; non-default sweeps are out of
    scope for the first null-test pass."""

    tenkan: int = TENKAN_PERIOD
    kijun: int = KIJUN_PERIOD
    senkou_b: int = SENKOU_B_PERIOD
    displacement: int = CLOUD_DISPLACEMENT
    chikou_lookback: int = CHIKOU_LOOKBACK


class IchimokuEngine:
    """Compute Ichimoku state + events over an OHLCV frame.

    Mirrors the PAC engine interface: `batch_state(df) -> DataFrame`.
    """

    def __init__(self, params: IchimokuParams | None = None) -> None:
        self.params = params or IchimokuParams()

    def batch_state(self, df: pd.DataFrame) -> pd.DataFrame:
        """Return enriched DataFrame matching PAC schema + Ichimoku state.

        `df` must contain ts_event, open, high, low, close, volume,
        symbol — same shape as `pac.archive_loader.load_bars()` output.
        """
        if len(df) == 0:
            return df.copy()

        out = df.copy().reset_index(drop=True)
        high = out["high"].to_numpy(dtype=np.float64)
        low = out["low"].to_numpy(dtype=np.float64)
        close = out["close"].to_numpy(dtype=np.float64)

        # --- Ichimoku lines ------------------------------------------------
        tenkan = _midpoint_rolling(high, low, self.params.tenkan)
        kijun = _midpoint_rolling(high, low, self.params.kijun)
        senkou_a_raw = (tenkan + kijun) / 2.0
        senkou_b_raw = _midpoint_rolling(high, low, self.params.senkou_b)
        # Forward-shift the lead spans by `displacement` bars. At bar t
        # the cloud value reflects data from t - displacement, which is
        # the whole point of Ichimoku's leading span.
        senkou_a = _shift_forward(senkou_a_raw, self.params.displacement)
        senkou_b = _shift_forward(senkou_b_raw, self.params.displacement)

        cloud_top = np.fmax(senkou_a, senkou_b)
        cloud_bottom = np.fmin(senkou_a, senkou_b)
        cloud_thickness = senkou_a - senkou_b  # signed: + when A above B (bullish cloud)
        cloud_color = np.where(cloud_thickness > 0, 1.0, np.where(cloud_thickness < 0, -1.0, 0.0))

        # --- ATR (parity with PAC for label stop-sizing) -------------------
        atr_14 = _atr(high, low, close, ATR_PERIOD)

        # Distance from cloud in ATR units — positive when above cloud,
        # negative when below, ~0 when inside.
        distance_from_cloud_atr = _distance_from_cloud_atr(close, cloud_top, cloud_bottom, atr_14)

        # --- Chikou confirmation (causal proxy) ----------------------------
        chikou_confirm = _chikou_confirm(close, self.params.chikou_lookback)

        # --- Events: TK cross + cloud break --------------------------------
        # tk_sign[t] = sign(tenkan[t] - kijun[t]).  TK cross at t = sign change.
        tk_diff = tenkan - kijun
        tk_sign = np.sign(tk_diff)
        tk_cross_up, tk_cross_dn = _detect_sign_change(tk_sign, up_threshold=0)

        # Cloud break: close was below cloud_top last bar and is above
        # this bar (cloud_break_up), or symmetric for down.
        cloud_break_up = _detect_cross(close, cloud_top, direction="up")
        cloud_break_dn = _detect_cross(close, cloud_bottom, direction="dn")

        # Map to PAC schema:
        #   BOS       = TK cross  (most frequent signal)
        #   CHOCH     = cloud break
        #   CHOCHPlus = TK cross with price-vs-cloud agreement (TK up + close above cloud)
        n = len(out)
        bos = np.full(n, np.nan, dtype=np.float64)
        bos[tk_cross_up] = 1.0
        bos[tk_cross_dn] = -1.0

        choch = np.full(n, np.nan, dtype=np.float64)
        choch[cloud_break_up] = 1.0
        choch[cloud_break_dn] = -1.0

        # CHOCHPlus: TK cross AND close on the agreeing side of cloud.
        # Bullish: tk_cross_up && close > cloud_top
        # Bearish: tk_cross_dn && close < cloud_bottom
        # Otherwise NaN. (NOT cumulative — emits at the bar the TK
        # cross occurs, conditional on cloud position THAT bar.)
        choch_plus = np.full(n, np.nan, dtype=np.float64)
        bull_strong = tk_cross_up & (close > cloud_top) & np.isfinite(cloud_top)
        bear_strong = tk_cross_dn & (close < cloud_bottom) & np.isfinite(cloud_bottom)
        choch_plus[bull_strong] = 1.0
        choch_plus[bear_strong] = -1.0

        # --- Engine state columns ------------------------------------------
        out["BOS"] = bos
        out["CHOCH"] = choch
        out["CHOCHPlus"] = choch_plus
        out["atr_14"] = atr_14
        out["tenkan_9"] = tenkan
        out["kijun_26"] = kijun
        out["senkou_a_26"] = senkou_a
        out["senkou_b_26"] = senkou_b
        out["cloud_top"] = cloud_top
        out["cloud_bottom"] = cloud_bottom
        out["cloud_thickness"] = cloud_thickness
        out["cloud_color"] = cloud_color
        out["distance_from_cloud_atr"] = distance_from_cloud_atr
        out["chikou_confirm"] = chikou_confirm

        # --- Required+optional columns for features.py compat --------------
        # session_bucket is required by features.py:139. We don't have
        # session detection wired here — emit "any" as the universal
        # bucket so the trainer treats time-of-day as unknown rather
        # than crashing. (The minutes_* columns below carry the actual
        # session information.)
        if "session_bucket" not in out.columns:
            out["session_bucket"] = "any"
        # Time-of-day: minutes from/to RTH if ts_event is tz-aware UTC.
        out["minutes_from_rth_open"], out["minutes_to_rth_close"] = _minutes_to_rth(
            pd.to_datetime(out["ts_event"], utc=True)
        )
        # Causal z-score of close vs trailing-30 mean — mirrors PAC's
        # `z_close_vwap` slot (PAC uses session_vwap; we approximate
        # with a rolling mean since we don't have session VWAP here).
        out["z_close_vwap"] = _rolling_zscore(close, window=30)
        # Macro flags — default False; would be populated by an
        # upstream calendar enricher in production.
        for flag in ("is_fomc", "is_opex", "is_event_day"):
            if flag not in out.columns:
                out[flag] = False

        return out


# ---------------------------------------------------------------------------
# Pure helpers — kept module-level so they're independently testable.
# ---------------------------------------------------------------------------


def _midpoint_rolling(high: np.ndarray, low: np.ndarray, n: int) -> np.ndarray:
    """(rolling-max(high, n) + rolling-min(low, n)) / 2 — vectorized."""
    h = pd.Series(high).rolling(n, min_periods=n).max().to_numpy()
    l_ = pd.Series(low).rolling(n, min_periods=n).min().to_numpy()
    return (h + l_) / 2.0


def _shift_forward(arr: np.ndarray, n: int) -> np.ndarray:
    """Shift an array forward by n bars (NaN-fill the leading slots).

    `arr_shifted[t]` = `arr[t - n]` for t >= n, NaN otherwise. This is
    the standard pandas .shift(+n) behavior expressed on numpy arrays.
    """
    if n <= 0:
        return arr.copy()
    out = np.full_like(arr, np.nan, dtype=np.float64)
    out[n:] = arr[:-n]
    return out


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> np.ndarray:
    """Wilder's ATR — same conventions as `pac.engine`. EMA of true range."""
    if len(high) == 0:
        return high.astype(np.float64)
    prev_close = np.r_[close[0], close[:-1]]
    tr = np.maximum.reduce(
        [
            high - low,
            np.abs(high - prev_close),
            np.abs(low - prev_close),
        ]
    )
    # Wilder smoothing: alpha = 1/n
    atr = np.full(len(tr), np.nan, dtype=np.float64)
    if len(tr) >= n:
        atr[n - 1] = float(np.mean(tr[:n]))
        for i in range(n, len(tr)):
            atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    return atr


def _distance_from_cloud_atr(
    close: np.ndarray,
    cloud_top: np.ndarray,
    cloud_bottom: np.ndarray,
    atr: np.ndarray,
) -> np.ndarray:
    """Signed distance from cloud, in ATR units.

    > 0 when above cloud_top, < 0 when below cloud_bottom, 0 when
    inside cloud. NaN where atr or cloud bounds are NaN.
    """
    out = np.full(len(close), np.nan, dtype=np.float64)
    safe = np.isfinite(cloud_top) & np.isfinite(cloud_bottom) & np.isfinite(atr) & (atr > 0)
    above = safe & (close > cloud_top)
    below = safe & (close < cloud_bottom)
    inside = safe & ~above & ~below
    out[above] = (close[above] - cloud_top[above]) / atr[above]
    out[below] = (close[below] - cloud_bottom[below]) / atr[below]
    out[inside] = 0.0
    return out


def _chikou_confirm(close: np.ndarray, lookback: int) -> np.ndarray:
    """Causal Chikou Span proxy: sign(close[t] - close[t - lookback]).

    The standard Ichimoku Chikou rule says "Chikou above its
    corresponding price 26 bars back is bullish, below is bearish."
    Translated to indices we can compute at time t WITHOUT peeking
    forward: chikou[t-26] = close[t]; the "price 26 bars back at
    that position" is close[t - 26 - 26] = close[t - 52]. But the
    common interpretation conflates the two and just compares
    close[t] vs close[t - 26]. We use that simpler form.
    """
    out = np.full(len(close), np.nan, dtype=np.float64)
    if len(close) > lookback:
        diff = close[lookback:] - close[:-lookback]
        out[lookback:] = np.sign(diff)
    return out


def _detect_sign_change(
    series: np.ndarray,
    up_threshold: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Boolean masks for sign(series) crossing up / crossing down.

    A "cross up" at t means series[t-1] < threshold and series[t] > threshold.
    A "cross down" at t means series[t-1] > threshold and series[t] < threshold.
    Strict inequalities — a tie at the threshold doesn't fire either way.
    """
    n = len(series)
    cross_up = np.zeros(n, dtype=bool)
    cross_dn = np.zeros(n, dtype=bool)
    if n < 2:
        return cross_up, cross_dn
    prev = series[:-1]
    curr = series[1:]
    cross_up[1:] = (prev < up_threshold) & (curr > up_threshold) & np.isfinite(prev) & np.isfinite(curr)
    cross_dn[1:] = (prev > up_threshold) & (curr < up_threshold) & np.isfinite(prev) & np.isfinite(curr)
    return cross_up, cross_dn


def _detect_cross(price: np.ndarray, level: np.ndarray, *, direction: str) -> np.ndarray:
    """Boolean mask: price crossed `level` in `direction` at index t.

    For "up": price[t-1] <= level[t-1] AND price[t] > level[t].
    For "dn": price[t-1] >= level[t-1] AND price[t] < level[t].
    """
    n = len(price)
    out = np.zeros(n, dtype=bool)
    if n < 2:
        return out
    valid = np.isfinite(level[:-1]) & np.isfinite(level[1:])
    if direction == "up":
        out[1:] = valid & (price[:-1] <= level[:-1]) & (price[1:] > level[1:])
    elif direction == "dn":
        out[1:] = valid & (price[:-1] >= level[:-1]) & (price[1:] < level[1:])
    else:
        raise ValueError(f"direction must be 'up' or 'dn', got {direction!r}")
    return out


def _rolling_zscore(arr: np.ndarray, *, window: int) -> np.ndarray:
    """Rolling z-score of `arr` over trailing `window` bars."""
    series = pd.Series(arr)
    mean = series.rolling(window, min_periods=window).mean()
    std = series.rolling(window, min_periods=window).std()
    z = (series - mean) / std
    return z.to_numpy()


def _minutes_to_rth(ts: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Minutes-from-RTH-open and minutes-to-RTH-close for each ts.

    RTH is 13:30 → 20:00 UTC (9:30 AM → 4:00 PM ET, ignoring DST). We
    don't bother with DST adjustments — the resulting features are
    used as continuous numerics and the model can learn the offset.
    Negative values pre-open / post-close. NaN for tz-naive input.
    """
    if not isinstance(ts.dtype, pd.DatetimeTZDtype):
        return (
            np.full(len(ts), np.nan, dtype=np.float64),
            np.full(len(ts), np.nan, dtype=np.float64),
        )
    minute_of_day = ts.dt.hour * 60.0 + ts.dt.minute
    rth_open = 13 * 60 + 30  # 810
    rth_close = 20 * 60  # 1200
    minutes_from = (minute_of_day - rth_open).to_numpy(dtype=np.float64)
    minutes_to = (rth_close - minute_of_day).to_numpy(dtype=np.float64)
    return minutes_from, minutes_to
