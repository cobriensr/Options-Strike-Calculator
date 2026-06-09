"""Assemble per-fire decision rows and assign walk-forward folds by date."""
from __future__ import annotations

import numpy as np
import pandas as pd

from exit_engine.features import build_features
from exit_engine.labels import add_labels


def build_fire_rows(
    path: pd.DataFrame,
    fire_id: int,
    date: str,
    mode: str,
    entry_price: float,
    minutes_to_close: list[float],
    theta: float,
) -> pd.DataFrame:
    """One row per minute for a single fire: features + labels + identity."""
    if path.empty:
        return pd.DataFrame()
    feats = build_features(path, entry_price, minutes_to_close)
    labeled = add_labels(path, theta)
    rows = feats.reset_index(drop=True)
    rows["mid"] = path["mid"].to_numpy()
    rows["minute"] = path["minute"].to_numpy() if "minute" in path else np.nan
    rows["forward_ratio"] = labeled["forward_ratio"].to_numpy()
    rows["y_has_upside"] = labeled["y_has_upside"].to_numpy()
    rows["y_log_upside"] = labeled["y_log_upside"].to_numpy()
    rows["fire_id"] = fire_id
    rows["date"] = date
    rows["mode"] = mode
    rows["entry_price"] = entry_price
    return rows


def assign_walkforward_folds(
    dates: pd.Series, n_train_days: int, test_block_days: int
) -> pd.Series:
    """Map each row's date to a test-fold id. The first n_train_days distinct
    dates are train-only warmup (fold -1) -- n_train_days of history must be seen
    before any testing. Later dates are bucketed into forward test blocks of
    test_block_days each (0, 1, 2, ...)."""
    distinct = sorted(pd.to_datetime(dates).dt.normalize().unique())
    fold_for_date: dict = {}
    for i, d in enumerate(distinct):
        if i < n_train_days:
            fold_for_date[d] = -1
        else:
            fold_for_date[d] = (i - n_train_days) // test_block_days
    norm = pd.to_datetime(dates).dt.normalize()
    return norm.map(fold_for_date).astype("int64")
