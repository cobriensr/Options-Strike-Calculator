"""Parametric generalization of the shipped exits (trail + hard time-stop).
Search its knobs on train folds; it's the bar the model must beat."""
from __future__ import annotations

import itertools

import numpy as np
import pandas as pd


def decide_exit_index(
    rows: pd.DataFrame, activate_pct: float, giveback_pct: float, hard_stop_min: float
) -> int:
    """Index into rows at which the rule exits (else last index)."""
    ret = rows["ret_from_entry_pct"].to_numpy()
    mse = rows["minutes_since_entry"].to_numpy()
    activated = False
    peak = float("-inf")
    last_in_time = len(rows) - 1
    for i in range(len(rows)):
        if mse[i] > hard_stop_min:
            return max(0, i - 1)
        last_in_time = i
        r = ret[i]
        if not activated and r >= activate_pct:
            activated = True
            peak = r
        elif activated:
            if r > peak:
                peak = r
            elif r <= peak - giveback_pct:
                return i
    return last_in_time


def decide_exit_index_vec(
    ret: np.ndarray,
    mse: np.ndarray,
    activate_pct: float,
    giveback_pct: float,
    hard_stop_min: float,
) -> int:
    """Numpy-vectorized equivalent of decide_exit_index.

    Parameters mirror the scalar version but accept raw numpy arrays instead
    of a DataFrame so callers can avoid per-fire Series construction.
    Semantics are identical: hard-stop beats trail when both fire at the same row.
    """
    n = ret.shape[0]
    if n == 0:
        return 0

    # First row where mse exceeds hard_stop_min (scalar: return max(0, i-1)).
    over = np.nonzero(mse > hard_stop_min)[0]
    hard_iter = int(over[0]) if over.size else n  # row index of overrun, or sentinel n

    # First activation row, then first giveback row after it.
    act = np.nonzero(ret >= activate_pct)[0]
    trail_iter = n  # sentinel: no trail exit
    if act.size:
        a = int(act[0])
        sub = ret[a:]
        peak = np.maximum.accumulate(sub)
        trig = np.nonzero(sub <= peak - giveback_pct)[0]
        if trig.size:
            trail_iter = a + int(trig[0])

    # Neither triggered: return last index.
    if hard_iter == n and trail_iter == n:
        return n - 1

    # Hard stop at row hard_iter beats trail at the same row (scalar checks hard
    # first inside the loop), so use <= not < for the hard-wins condition.
    if hard_iter <= trail_iter:
        # hard_iter might be n only if trail also fired, but trail_iter < n here
        # means hard_iter is also < n (since hard_iter <= trail_iter < n).
        return max(0, hard_iter - 1)
    return trail_iter


def grid() -> list[dict]:
    """Default search grid for the rule knobs."""
    activates = [20.0, 30.0, 50.0, 75.0]
    givebacks = [10.0, 15.0, 25.0, 40.0]
    hard_stops = [30, 60, 120, 100000]  # last == effectively no time stop
    return [
        {"activate_pct": a, "giveback_pct": g, "hard_stop_min": h}
        for a, g, h in itertools.product(activates, givebacks, hard_stops)
    ]
