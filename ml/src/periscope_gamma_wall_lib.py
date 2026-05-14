"""Pure functions for the Periscope gamma-level edge experiment.

Imported by ml/src/periscope_eda/05_gamma_wall_reversal.py (runner)
and ml/tests/test_periscope_gamma_wall_lib.py (unit tests).

No DB I/O. No file I/O. No plotting. Pure data transforms.

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

from datetime import timedelta
from typing import Literal

import pandas as pd

TOUCH_TOLERANCE_PTS = 1.0
REVERSAL_THRESHOLD_PTS = 2.0
REVERSAL_WINDOW_MIN = 15
DISTANCE_BUCKET_EDGES = [0.0, 3.0, 7.0, 15.0]
PRIMARY_BUCKETS = {"3-7", "7-15"}
MAGNET_MIN_DISTANCE_PTS = 3.0
CHARM_ZERO_MIN_DISTANCE_PTS = 1.0

WallType = Literal["ceiling", "floor"]


def distance_bucket(distance: float) -> str:
    """Bucket a wall-to-spot distance into pre-registered ranges.

    Buckets: '0-3' (trivial), '3-7' (near), '7-15' (tactical), '15+' (far).
    Primary test pools 3-7 and 7-15 (see spec §"Primary tests").
    """
    if distance < 0:
        raise ValueError(f"distance must be non-negative, got {distance}")
    if distance < 3.0:
        return "0-3"
    if distance < 7.0:
        return "3-7"
    if distance < 15.0:
        return "7-15"
    return "15+"


def compute_wall_event(
    bars: pd.DataFrame,
    wall_strike: float,
    wall_type: WallType,
    spot_at_read: float,
) -> dict:
    """Measure how SPX behaves vs a single wall over the trading window.

    Args:
        bars: DataFrame with columns 'timestamp' (datetime64) and 'close' (float),
            sorted by timestamp ascending. Should already be filtered to bars
            between read_time and 15:00 CT, regular hours only.
        wall_strike: The gamma wall strike from periscope_analyses.key_levels.
        wall_type: 'ceiling' (above spot) or 'floor' (below spot).
        spot_at_read: SPX spot at read_time, anchor for distance and reversal.

    Returns dict with:
        distance_initial (float): |wall_strike - spot_at_read|.
        bucket (str): one of '0-3', '3-7', '7-15', '15+'.
        touched (bool): True if any bar.close came within +/-TOUCH_TOLERANCE_PTS.
        t_touch_idx (int | None): index of the first touching bar in `bars`.
        post_touch_price (float | None): close at +REVERSAL_WINDOW_MIN after t_touch,
            or None if never touched / censored.
        reversal_signed (float | None): signed reversal (positive = moved away
            from wall toward spot). None if never touched / censored.
        classification (str): 'held' / 'broken' / 'stalled' / 'never_touched' / 'censored'.
        breached_eod (bool): for ceiling, spx_close > wall; for floor, spx_close < wall.
        success (int): 1 if touched AND classification == 'held', else 0.
    """
    distance_initial = abs(wall_strike - spot_at_read)
    bucket = distance_bucket(distance_initial)

    if len(bars) == 0:
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": False,
            "t_touch_idx": None,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "never_touched",
            "breached_eod": False,
            "success": 0,
        }

    spx_close = float(bars["close"].iloc[-1])
    breached_eod = (
        spx_close > wall_strike if wall_type == "ceiling"
        else spx_close < wall_strike
    )

    touch_mask = (bars["close"] - wall_strike).abs() <= TOUCH_TOLERANCE_PTS
    if not touch_mask.any():
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": False,
            "t_touch_idx": None,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "never_touched",
            "breached_eod": breached_eod,
            "success": 0,
        }

    t_touch_idx = int(touch_mask.idxmax())
    t_touch = bars["timestamp"].iloc[t_touch_idx]
    window_end = t_touch + pd.Timedelta(minutes=REVERSAL_WINDOW_MIN)

    bars_in_window = bars[bars["timestamp"] <= window_end]
    if bars_in_window["timestamp"].iloc[-1] < window_end:
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": True,
            "t_touch_idx": t_touch_idx,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "censored",
            "breached_eod": breached_eod,
            "success": 0,
        }

    post_touch_price = float(bars_in_window["close"].iloc[-1])
    if wall_type == "ceiling":
        reversal_signed = spot_at_read - post_touch_price
    else:
        reversal_signed = post_touch_price - spot_at_read

    if reversal_signed >= REVERSAL_THRESHOLD_PTS:
        classification = "held"
    elif reversal_signed <= -REVERSAL_THRESHOLD_PTS:
        classification = "broken"
    else:
        classification = "stalled"

    return {
        "distance_initial": distance_initial,
        "bucket": bucket,
        "touched": True,
        "t_touch_idx": t_touch_idx,
        "post_touch_price": post_touch_price,
        "reversal_signed": reversal_signed,
        "classification": classification,
        "breached_eod": breached_eod,
        "success": 1 if classification == "held" else 0,
    }


def compute_magnet_event(
    spx_close: float,
    magnet: float,
    spot_at_read: float,
) -> dict | None:
    """Compare 'magnet as close predictor' vs 'spot as close predictor'.

    Returns None when |magnet - spot_at_read| < MAGNET_MIN_DISTANCE_PTS to
    avoid trivial wins (a magnet sitting on top of spot would always
    'predict' close just by being near spot).

    Otherwise returns:
        err_magnet (float): (spx_close - magnet)^2
        err_naive (float):  (spx_close - spot_at_read)^2
        delta (float):      err_magnet - err_naive (negative = magnet beat naive)
        magnet_won (bool):  delta < 0
        distance (float):   |magnet - spot_at_read|
    """
    distance = abs(magnet - spot_at_read)
    if distance < MAGNET_MIN_DISTANCE_PTS:
        return None
    err_magnet = (spx_close - magnet) ** 2
    err_naive = (spx_close - spot_at_read) ** 2
    delta = err_magnet - err_naive
    return {
        "err_magnet": err_magnet,
        "err_naive": err_naive,
        "delta": delta,
        "magnet_won": delta < 0,
        "distance": distance,
    }


def mirror_strike(spot: float, real_strike: float) -> float:
    """Return the strike mirrored across spot.

    mirror = 2*spot - real_strike, which sits at the same absolute
    distance from spot on the opposite side. Used to construct sham
    baselines (real wall above spot -> sham below at same distance).
    """
    return 2.0 * spot - real_strike


def compute_charm_zero_event(
    bars: pd.DataFrame,
    charm_zero: float,
    spot_at_read: float,
) -> dict | None:
    """Did SPX cross charm_zero (and its sham mirror) during the window?

    A 'cross' = the open-time and close-time sides of the strike differ
    in sign of (close - strike). Equivalent to: bars closed on different
    sides of the strike.

    Returns None if |charm_zero - spot| < CHARM_ZERO_MIN_DISTANCE_PTS
    (degenerate-pair filter -- sham would collide with real).

    Otherwise:
        crossed_real (bool)
        crossed_sham (bool)
        sham_strike (float)
        distance (float)
    """
    distance = abs(charm_zero - spot_at_read)
    if distance < CHARM_ZERO_MIN_DISTANCE_PTS:
        return None
    if len(bars) < 2:
        return None

    first_close = float(bars["close"].iloc[0])
    last_close = float(bars["close"].iloc[-1])

    def _crossed(strike: float) -> bool:
        return (first_close - strike) * (last_close - strike) < 0

    sham = mirror_strike(spot_at_read, charm_zero)
    return {
        "crossed_real": _crossed(charm_zero),
        "crossed_sham": _crossed(sham),
        "sham_strike": sham,
        "distance": distance,
    }
