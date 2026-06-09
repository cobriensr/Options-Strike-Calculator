"""Parametric generalization of the shipped exits (trail + hard time-stop).
Search its knobs on train folds; it's the bar the model must beat."""
from __future__ import annotations

import itertools

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


def grid() -> list[dict]:
    """Default search grid for the rule knobs."""
    activates = [20.0, 30.0, 50.0, 75.0]
    givebacks = [10.0, 15.0, 25.0, 40.0]
    hard_stops = [30, 60, 120, 100000]  # last == effectively no time stop
    return [
        {"activate_pct": a, "giveback_pct": g, "hard_stop_min": h}
        for a, g, h in itertools.product(activates, givebacks, hard_stops)
    ]
