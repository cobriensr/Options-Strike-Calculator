"""Per-event feature snapshot for the PAC classifier.

For each event row from `pac_classifier.events.extract_events`, build
a feature vector of engine state + derived rolling metrics + static
fields at the event timestamp.

Causality invariant: every feature value at row T uses ONLY data with
timestamp ≤ T. The PAC engine's columns are already strictly causal
(verified in `test_pac_engine_causality.py`); the rolling features
added here use trailing windows (`bars[..i]`) only. We never reach
forward.

Phase 1a is NQ-only. Cross-asset features (SPY/QQQ/VIX) are deferred
to Phase 1b — the schema here is designed to accept them as
additional columns later without restructuring.

Feature taxonomy emitted (target: 25-35 cols):

  Engine snapshot (causally-correct, taken from enriched DataFrame):
    atr_14, adx_14, di_plus_14, di_minus_14
    z_close_vwap, ob_pct_atr, ob_volume_z_50
    session_bucket, minutes_from_rth_open, minutes_to_rth_close
    is_fomc, is_opex, is_event_day

  Rolling derivatives (computed inline from bars):
    ret_5b, ret_30b, ret_60b, ret_240b — log returns over N trailing bars
    rv_30b — annualized realized vol over 30 trailing bars
    bos_density_60b — count of BOS events in last 60 bars

  Static / event-shape:
    signal_type, signal_direction (passed through from events)
    day_of_week — derived from ts_event (UTC)
"""

from __future__ import annotations

import numpy as np
import pandas as pd


_ENGINE_PASSTHROUGH_COLS = (
    "atr_14",
    "adx_14",
    "di_plus_14",
    "di_minus_14",
    "z_close_vwap",
    "ob_pct_atr",
    "ob_volume_z_50",
    "minutes_from_rth_open",
    "minutes_to_rth_close",
)

_ENGINE_BOOL_COLS = (
    "is_fomc",
    "is_opex",
    "is_event_day",
)

# Bar counts for rolling derivatives. These are calibrated for 5m
# bars (5b = 25min, 30b = 2.5h, 60b = 5h, 240b = full RTH session).
# For 1m use, multiply each by 5 — caller's choice via the parameter.
DEFAULT_RETURN_LOOKBACKS = (5, 30, 60, 240)
DEFAULT_RV_WINDOW = 30
DEFAULT_BOS_DENSITY_WINDOW = 60


def build_features(
    enriched: pd.DataFrame,
    events: pd.DataFrame,
    *,
    return_lookbacks: tuple[int, ...] = DEFAULT_RETURN_LOOKBACKS,
    rv_window: int = DEFAULT_RV_WINDOW,
    bos_density_window: int = DEFAULT_BOS_DENSITY_WINDOW,
) -> pd.DataFrame:
    """Snapshot features at every event row.

    `enriched` is the output of `PACEngine.batch_state` — must contain
    the structure event columns + engine features. `events` is the
    output of `pac_classifier.events.extract_events`.

    Returns a DataFrame indexed positionally with `events`, with
    `bar_idx` as the join key + one column per feature.
    """
    if len(events) == 0:
        return _empty_features_frame()

    # Pre-compute rolling derivatives ONCE over the full enriched
    # frame, then index into them by bar_idx. Avoids O(events × bars)
    # work — instead it's O(bars + events).
    closes = enriched["close"].to_numpy(dtype=np.float64)
    log_closes = np.log(closes)

    # Trailing log return over N bars: log(close_t) - log(close_{t-N}).
    # First N rows get NaN.
    rolling_returns: dict[int, np.ndarray] = {}
    for n_bars in return_lookbacks:
        ret = np.full(len(enriched), np.nan, dtype=np.float64)
        if len(enriched) > n_bars:
            ret[n_bars:] = log_closes[n_bars:] - log_closes[:-n_bars]
        rolling_returns[n_bars] = ret

    # Realized vol: rolling stddev of 1-bar log returns × √(252 × bars/day).
    # We don't try to annualize precisely — the model just needs a
    # comparable scale across rows. Plain rolling-stddev of log returns
    # is fine for ranking purposes.
    bar_returns = np.full(len(enriched), np.nan, dtype=np.float64)
    if len(enriched) > 1:
        bar_returns[1:] = log_closes[1:] - log_closes[:-1]
    rv = pd.Series(bar_returns).rolling(rv_window, min_periods=rv_window).std().to_numpy()

    # BOS density: rolling count of non-zero BOS events in trailing N bars.
    bos_arr = enriched["BOS"].to_numpy(dtype=np.float64, na_value=np.nan)
    bos_present = (~np.isnan(bos_arr) & (bos_arr != 0)).astype(np.float64)
    bos_density = (
        pd.Series(bos_present).rolling(bos_density_window, min_periods=1).sum().to_numpy()
    )

    # Day-of-week: derive once from ts_event, index into by bar_idx.
    ts_series = pd.to_datetime(enriched["ts_event"], utc=True, errors="coerce")
    day_of_week = ts_series.dt.dayofweek.to_numpy(dtype=np.int64)

    # session_bucket may be a string column or a categorical-encoded
    # int. Pass through as-is — model preprocessor handles encoding.
    session_bucket = enriched["session_bucket"].to_numpy(dtype=object)

    rows: list[dict] = []
    for _, evt in events.iterrows():
        idx = int(evt["bar_idx"])
        if idx >= len(enriched):
            continue
        row: dict = {
            "bar_idx": idx,
            "signal_type": evt["signal_type"],
            "signal_direction": evt["signal_direction"],
            "session_bucket": session_bucket[idx],
            "day_of_week": int(day_of_week[idx]) if not pd.isna(day_of_week[idx]) else -1,
            "rv_30b": float(rv[idx]) if np.isfinite(rv[idx]) else np.nan,
            "bos_density_60b": float(bos_density[idx]),
        }
        for col in _ENGINE_PASSTHROUGH_COLS:
            if col in enriched.columns:
                v = enriched[col].iloc[idx]
                row[col] = float(v) if pd.notna(v) else np.nan
            else:
                row[col] = np.nan
        for col in _ENGINE_BOOL_COLS:
            if col in enriched.columns:
                v = enriched[col].iloc[idx]
                row[col] = bool(v) if pd.notna(v) else False
            else:
                row[col] = False
        for n_bars in return_lookbacks:
            ret_arr = rolling_returns[n_bars]
            v = ret_arr[idx]
            row[f"ret_{n_bars}b"] = float(v) if np.isfinite(v) else np.nan
        rows.append(row)

    return pd.DataFrame(rows)


def _empty_features_frame() -> pd.DataFrame:
    cols: dict[str, pd.Series] = {
        "bar_idx": pd.Series([], dtype=np.int64),
        "signal_type": pd.Series([], dtype=object),
        "signal_direction": pd.Series([], dtype=object),
        "session_bucket": pd.Series([], dtype=object),
        "day_of_week": pd.Series([], dtype=np.int64),
        "rv_30b": pd.Series([], dtype=np.float64),
        "bos_density_60b": pd.Series([], dtype=np.float64),
    }
    for col in _ENGINE_PASSTHROUGH_COLS:
        cols[col] = pd.Series([], dtype=np.float64)
    for col in _ENGINE_BOOL_COLS:
        cols[col] = pd.Series([], dtype=bool)
    for n_bars in DEFAULT_RETURN_LOOKBACKS:
        cols[f"ret_{n_bars}b"] = pd.Series([], dtype=np.float64)
    return pd.DataFrame(cols)
