"""Canonical metrics module — DO NOT define win rates anywhere else.

All multi-phase analyses must import from here. Adding or changing a
metric requires editing this file and announcing the change in the
session before re-running.

Three families of metrics, with explicit names that prevent confusion:

1. PEAK CEILINGS (no stop loss, perfect-timing exit) — diagnostic only
   * peak_above_entry        — chain ever > entry (typically ~85-95% of all fires)
   * peak_ge_2x              — chain ever ≥ 2× entry
   * peak_ge_5x              — chain ever ≥ 5× entry

2. REALIZED EXITS (under a stated exit policy) — the only decision-making numbers
   * exit_trail_act30_trail10  — trailing stop, activate at +30%, trail 10% off peak
   * exit_hard_stop_30m        — exit at minute 30 regardless
   * exit_hold_to_eod          — hold until session close

3. THRESHOLD AGGREGATES (% of trades clearing a threshold under a policy)
   * win_rate(returns, threshold=0)   — % positive
   * win_rate(returns, threshold=25)  — % ≥ +25%
   * win_rate(returns, threshold=50)  — % ≥ +50%

When reporting in a table:
  * NEVER write "win rate" alone
  * Use the qualified label, e.g. "exit_trail30_10 win%" or "peak ≥ 2× rate"
  * If both peak ceiling AND realized exit are shown, label them separately
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# ============================================================
# Canonical exit policy parameters
# ============================================================
TRAIL_ACTIVATION_PCT = 30.0   # wait until peak ≥ +30% from entry
TRAIL_DROP_PCT = 10.0          # exit when current drops 10% off peak
HARD_STOP_MIN = 30             # alternate: hard time-stop at minute 30


# ============================================================
# Realized exit calculators (per trade)
# ============================================================
def realized_exit_trail(price_series: np.ndarray, entry: float,
                        activation_pct: float = TRAIL_ACTIVATION_PCT,
                        trail_pct: float = TRAIL_DROP_PCT) -> float:
    """Return % realized return under activated trailing stop.

    - Walks `price_series` minute-by-minute (price arr, no time gaps)
    - Activates trail when running return ≥ activation_pct
    - After activation, exits when current return drops trail_pct below
      the running peak return
    - If never activates, returns the last known return (= held to end of series)
    - If never triggers a trail exit after activation, returns the last return

    `price_series` must be a 1-D numpy array of post-entry prices in time order.
    Entry is the original entry price (not in the series). Returns return % (e.g. +25.5).
    """
    if entry <= 0 or len(price_series) == 0:
        return 0.0
    rets = (price_series - entry) / entry * 100.0
    activated_mask = rets >= activation_pct
    if not activated_mask.any():
        return float(rets[-1])  # never activated, hold to end
    act_idx = int(activated_mask.argmax())
    post_act = rets[act_idx:]
    cum_peak = np.maximum.accumulate(post_act)
    drop_mask = post_act <= (cum_peak - trail_pct)
    if drop_mask.any():
        first_drop = int(drop_mask.argmax())
        return float(post_act[first_drop])
    return float(post_act[-1])


def realized_exit_hard_time_stop(price_series: np.ndarray, entry: float,
                                  ts_minutes: np.ndarray, stop_min: int = HARD_STOP_MIN) -> float:
    """Return % realized return at hard time stop at `stop_min` minutes after entry.

    `ts_minutes` is the per-row minutes-after-entry (same length as price_series).
    Returns the return at the last price <= stop_min, or last price if all <= stop_min.
    """
    if entry <= 0 or len(price_series) == 0:
        return 0.0
    mask = ts_minutes <= stop_min
    if not mask.any():
        return 0.0
    last_in_window = int(np.where(mask)[0][-1])
    return float((price_series[last_in_window] - entry) / entry * 100.0)


def realized_exit_hold_to_eod(price_series: np.ndarray, entry: float) -> float:
    """Return % realized return at last price of session."""
    if entry <= 0 or len(price_series) == 0:
        return 0.0
    return float((price_series[-1] - entry) / entry * 100.0)


# ============================================================
# Peak ceiling calculators (no stop loss — diagnostic only)
# ============================================================
def peak_ceiling_pct(price_series: np.ndarray, entry: float) -> float:
    """Return peak return as % (best-case hold-to-peak with no stop)."""
    if entry <= 0 or len(price_series) == 0:
        return 0.0
    return float((price_series.max() - entry) / entry * 100.0)


# ============================================================
# Threshold aggregators (operate on Series of returns)
# ============================================================
def win_rate_above(returns: pd.Series, threshold: float = 0.0) -> float:
    """% of returns clearing the threshold. Returns 0-100."""
    if len(returns) == 0:
        return 0.0
    return float((returns > threshold).mean() * 100.0)


def loss_rate_below(returns: pd.Series, threshold: float = -25.0) -> float:
    """% of returns below the threshold (e.g. < -25%). Returns 0-100."""
    if len(returns) == 0:
        return 0.0
    return float((returns < threshold).mean() * 100.0)


# ============================================================
# Standard report blocks (format consistently across scripts)
# ============================================================
def realized_summary(returns: pd.Series, label: str = '') -> dict:
    """Returns a standard summary dict for a Series of REALIZED EXIT RETURNS.
    All callers should use this — never hand-roll the columns."""
    if len(returns) == 0:
        return {
            'label': label, 'n': 0, 'median_pct': 0.0, 'mean_pct': 0.0,
            'win_pct_above_0': 0.0, 'win_pct_above_25': 0.0,
            'win_pct_above_50': 0.0, 'loss_pct_below_neg25': 0.0,
        }
    return {
        'label': label,
        'n': len(returns),
        'median_pct': float(returns.median()),
        'mean_pct': float(returns.mean()),
        'win_pct_above_0': win_rate_above(returns, 0),
        'win_pct_above_25': win_rate_above(returns, 25),
        'win_pct_above_50': win_rate_above(returns, 50),
        'loss_pct_below_neg25': loss_rate_below(returns, -25),
    }


def peak_summary(peak_returns: pd.Series, label: str = '') -> dict:
    """Returns a standard summary dict for PEAK CEILING returns.
    Use this only when you need the ceiling reference — never as a primary metric.
    Distinguishes itself from realized_summary by including '_PEAK_CEILING' tag."""
    if len(peak_returns) == 0:
        return {
            'label': f'{label} [PEAK CEILING]', 'n': 0, 'median_peak_pct': 0.0,
            'peak_above_entry_pct': 0.0, 'peak_ge_2x_pct': 0.0, 'peak_ge_5x_pct': 0.0,
        }
    return {
        'label': f'{label} [PEAK CEILING — NO STOP, perfect-timing exit]',
        'n': len(peak_returns),
        'median_peak_pct': float(peak_returns.median()),
        'peak_above_entry_pct': win_rate_above(peak_returns, 0),
        'peak_ge_2x_pct': win_rate_above(peak_returns, 100),  # 2× = +100%
        'peak_ge_5x_pct': win_rate_above(peak_returns, 400),  # 5× = +400%
    }
