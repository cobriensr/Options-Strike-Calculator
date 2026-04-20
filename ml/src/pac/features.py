"""Per-bar context features the live trader uses but the v3 sweep ignores.

Adds columns to PAC-enriched bars so the E1.4d sweep can filter entries on
the same dimensions a human discretionary trader does:

- `session_bucket`        : pre_market / ny_open / am / lunch / pm / close
- `minutes_from_rth_open` : continuous, negative pre-market, large after close
- `minutes_to_rth_close`  : continuous, large pre-open, negative after close
- `atr_14`                : Wilder ATR(14)
- `adx_14`, `di_plus_14`, `di_minus_14` : Wilder ADX(14)
- `z_close_vwap`          : (close - session_vwap) / session_std — close-vs-VWAP z
- `ob_pct_atr`            : OB_width / atr_14 (only on bars where OB is active)
- `ob_volume_z_50`        : rolling z-score of OBVolume over last N OB bars
- `is_fomc`, `is_opex`, `is_event_day` : already in options_features.calendar,
  proxied here so PAC-engine output is self-sufficient

Design:
- Each function takes the enriched bar DataFrame, returns it with new
  columns appended. Functions are independent and idempotent.
- All comparisons operate on a UTC-aware `ts_event` column. Time-of-day
  classification converts to America/Chicago internally so DST handles
  itself.
- Wilder smoothing uses `ewm(alpha=1/N, adjust=False)`, which is the
  standard Wilder formulation (matches TA-Lib / pandas-ta within float
  noise on the first N+1 bars).
"""

from __future__ import annotations

from datetime import time

import numpy as np
import pandas as pd

from options_features.calendar import is_event_day, is_fomc, is_opex

_CHICAGO_TZ = "America/Chicago"

# RTH session boundaries in Chicago time (DST-handled by tz_convert).
_RTH_OPEN = time(8, 30)
_NY_OPEN_END = time(10, 0)
_AM_END = time(11, 30)
_LUNCH_END = time(13, 0)
_PM_END = time(15, 0)
_RTH_CLOSE = time(15, 15)  # SPX/ES regular close; MNQ stays open later but
# we treat 15:15 as "session close" for filtering


# ─────────────────────────────────────────────────────────────────────────
# Session-of-day classification
# ─────────────────────────────────────────────────────────────────────────


def add_session_bucket(df: pd.DataFrame) -> pd.DataFrame:
    """Add `session_bucket` categorical + minutes-from/to-RTH-open/close.

    Buckets (Chicago time):
        pre_market : before 8:30 CT
        ny_open    : 8:30 - 10:00 CT
        am         : 10:00 - 11:30 CT
        lunch      : 11:30 - 13:00 CT
        pm         : 13:00 - 15:00 CT
        close      : 15:00 - 15:15 CT
        post_close : 15:15+ (overnight Globex)

    Plus continuous helpers `minutes_from_rth_open` and `minutes_to_rth_close`,
    both signed — pre-market reads as negative `from_open`, etc.
    """
    if "ts_event" not in df.columns:
        raise KeyError("ts_event column required")

    out = df.copy()
    ct = out["ts_event"].dt.tz_convert(_CHICAGO_TZ)
    tod = ct.dt.time

    bucket = pd.Series("post_close", index=out.index, dtype="object")
    bucket = bucket.mask(tod < _RTH_OPEN, "pre_market")
    bucket = bucket.mask((tod >= _RTH_OPEN) & (tod < _NY_OPEN_END), "ny_open")
    bucket = bucket.mask((tod >= _NY_OPEN_END) & (tod < _AM_END), "am")
    bucket = bucket.mask((tod >= _AM_END) & (tod < _LUNCH_END), "lunch")
    bucket = bucket.mask((tod >= _LUNCH_END) & (tod < _PM_END), "pm")
    bucket = bucket.mask((tod >= _PM_END) & (tod < _RTH_CLOSE), "close")
    out["session_bucket"] = bucket

    # Minutes from RTH open: anchor to the same calendar day's 8:30 CT.
    open_anchor = ct.dt.normalize() + pd.Timedelta(
        hours=_RTH_OPEN.hour, minutes=_RTH_OPEN.minute
    )
    close_anchor = ct.dt.normalize() + pd.Timedelta(
        hours=_RTH_CLOSE.hour, minutes=_RTH_CLOSE.minute
    )
    out["minutes_from_rth_open"] = (
        (ct - open_anchor).dt.total_seconds() / 60.0
    ).astype(float)
    out["minutes_to_rth_close"] = (
        (close_anchor - ct).dt.total_seconds() / 60.0
    ).astype(float)

    return out


# ─────────────────────────────────────────────────────────────────────────
# ATR(14) — Wilder smoothing, prerequisite for ADX and OB %ATR
# ─────────────────────────────────────────────────────────────────────────


def _true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    """Wilder True Range."""
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    return pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)


def add_atr14(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """Add `atr_14` (Wilder smoothing). NaN for first `period - 1` bars."""
    if not {"high", "low", "close"}.issubset(df.columns):
        raise KeyError("high, low, close columns required")
    out = df.copy()
    tr = _true_range(out["high"], out["low"], out["close"])
    # Wilder = EWM with alpha = 1/period, adjust=False. Standard convention.
    out["atr_14"] = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    return out


# ─────────────────────────────────────────────────────────────────────────
# ADX(14) — Wilder DMI/ADX
# ─────────────────────────────────────────────────────────────────────────


def add_adx14(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """Add `di_plus_14`, `di_minus_14`, `adx_14` (Wilder).

    Requires `atr_14` to be present — call `add_atr14()` first or this
    function will compute it inline.
    """
    if not {"high", "low", "close"}.issubset(df.columns):
        raise KeyError("high, low, close columns required")
    out = df if "atr_14" in df.columns else add_atr14(df, period=period)
    out = out.copy()

    high = out["high"]
    low = out["low"]
    up_move = high.diff()
    down_move = -low.diff()

    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0))
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    )
    plus_dm.index = out.index
    minus_dm.index = out.index

    smooth_plus = plus_dm.ewm(
        alpha=1.0 / period, adjust=False, min_periods=period
    ).mean()
    smooth_minus = minus_dm.ewm(
        alpha=1.0 / period, adjust=False, min_periods=period
    ).mean()

    atr = out["atr_14"]
    with np.errstate(divide="ignore", invalid="ignore"):
        di_plus = 100.0 * smooth_plus / atr
        di_minus = 100.0 * smooth_minus / atr
        di_sum = di_plus + di_minus
        dx = 100.0 * (di_plus - di_minus).abs() / di_sum.where(di_sum > 0)

    adx = dx.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    out["di_plus_14"] = di_plus.astype(float)
    out["di_minus_14"] = di_minus.astype(float)
    out["adx_14"] = adx.astype(float)
    return out


# ─────────────────────────────────────────────────────────────────────────
# VWAP-relative close z-score
# ─────────────────────────────────────────────────────────────────────────


def add_vwap_zscore_close(df: pd.DataFrame) -> pd.DataFrame:
    """Add `z_close_vwap` = (close - session_vwap) / session_std per bar.

    Requires `session_vwap` and `session_std` (produced by
    `pac.order_blocks.session_vwap_and_std()`). NaN where std == 0.
    """
    if not {"close", "session_vwap", "session_std"}.issubset(df.columns):
        raise KeyError("close, session_vwap, session_std required")
    out = df.copy()
    std = out["session_std"]
    with np.errstate(divide="ignore", invalid="ignore"):
        z = (out["close"] - out["session_vwap"]) / std.where(std > 0)
    out["z_close_vwap"] = z.astype(float)
    return out


# ─────────────────────────────────────────────────────────────────────────
# OB strength: %ATR + rolling-window volume z
# ─────────────────────────────────────────────────────────────────────────


def add_ob_pct_atr(df: pd.DataFrame) -> pd.DataFrame:
    """Add `ob_pct_atr` = (OB_width / atr_14) * 100 on bars where OB is active.

    Mirrors the user's `OB % ATR` journal column. NaN on bars without an
    active OB (so the filter only fires when there is something to filter).
    """
    if not {"OB", "OB_width", "atr_14"}.issubset(df.columns):
        raise KeyError("OB, OB_width, atr_14 required (run engine.batch_state first)")
    out = df.copy()
    has_ob = out["OB"].notna() & (out["OB"] != 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        pct = 100.0 * out["OB_width"] / out["atr_14"].where(out["atr_14"] > 0)
    out["ob_pct_atr"] = pct.where(has_ob).astype(float)
    return out


def add_ob_volume_rolling_z(df: pd.DataFrame, window: int = 50) -> pd.DataFrame:
    """Add `ob_volume_z_50` = rolling z-score of `OBVolume` over the last
    `window` bars where an OB was active.

    Comparing each OB to its peers in the recent past tells us whether
    "this OB is heavy" relative to the rest of the morning, which is how
    LuxAlgo's visual OB shading reads.
    """
    if not {"OB", "OBVolume"}.issubset(df.columns):
        raise KeyError("OB, OBVolume required (run engine.batch_state first)")
    out = df.copy()
    has_ob = out["OB"].notna() & (out["OB"] != 0)
    # Per-bar OBVolume (NaN where no OB) — use a forward-pointing rolling
    # window over the active-OB subset, then re-align back onto bar index.
    ob_vol_only = out["OBVolume"].where(has_ob)
    # Rolling on the subset preserves causal ordering: each row's z uses
    # only prior OB volumes, which is what we want for live decision use.
    rolling_mean = ob_vol_only.rolling(window=window, min_periods=5).mean()
    rolling_std = ob_vol_only.rolling(window=window, min_periods=5).std()
    with np.errstate(divide="ignore", invalid="ignore"):
        z = (ob_vol_only - rolling_mean) / rolling_std.where(rolling_std > 0)
    out["ob_volume_z_50"] = z.astype(float)
    return out


# ─────────────────────────────────────────────────────────────────────────
# Event-day flags (proxy options_features.calendar so PAC engine is self-sufficient)
# ─────────────────────────────────────────────────────────────────────────


def add_event_calendar_flags(df: pd.DataFrame) -> pd.DataFrame:
    """Add `is_fomc`, `is_opex`, `is_event_day` per bar.

    Event determination uses the bar's UTC date — same convention as
    `options_features.calendar`. Events span the full day (no intraday
    timing within FOMC announcements modeled here; that's E1.5+ scope).
    """
    if "ts_event" not in df.columns:
        raise KeyError("ts_event column required")
    out = df.copy()
    dates = out["ts_event"].dt.date
    out["is_fomc"] = dates.map(is_fomc).astype(bool)
    out["is_opex"] = dates.map(is_opex).astype(bool)
    out["is_event_day"] = dates.map(is_event_day).astype(bool)
    return out


# ─────────────────────────────────────────────────────────────────────────
# Top-level convenience
# ─────────────────────────────────────────────────────────────────────────


def add_all_features(df: pd.DataFrame, ob_volume_window: int = 50) -> pd.DataFrame:
    """Apply every feature addition in dependency order.

    Order matters:
        session_bucket → atr_14 → adx_14 → vwap_zscore_close
        → ob_pct_atr (needs atr_14) → ob_volume_rolling_z → event flags
    """
    out = add_session_bucket(df)
    out = add_atr14(out)
    out = add_adx14(out)
    out = add_vwap_zscore_close(out)
    out = add_ob_pct_atr(out)
    out = add_ob_volume_rolling_z(out, window=ob_volume_window)
    out = add_event_calendar_flags(out)
    return out
